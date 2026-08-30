import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildArenaInputs } from "./arena-inputs.js";
import type {
  ArenaCompetitionIdentity,
  ArenaPresetId,
} from "./arena-inputs.js";
import { SupabaseArenaRepository } from "./arena-repository.js";
import { createArenaRuntime } from "./arena-runtime.js";
import { loadWorkerConfig } from "./config.js";
import {
  createDogfoodAbortScope,
  dogfoodExitCode,
} from "./dogfood-control.js";
import { sanitizeFailureMessage } from "./failure-safety.js";
import {
  loadLiquidUniverseReference,
  type LiquidUniverseReference,
  type LoadedLiquidUniverse,
} from "./liquid-universe-reference.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const harnessRoot = resolve(
  process.env.DSH_HARNESS_ROOT ?? resolve(repositoryRoot, "../deepseek-harness"),
);

function requiredSecret(name: string): void {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required for a real Agent dogfood run`);
  }
}

function safeError(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  return {
    code: error instanceof Error ? error.name : "Error",
    message: sanitizeFailureMessage(raw),
  };
}

interface DogfoodCompetitionContext {
  readonly identity: ArenaCompetitionIdentity;
  readonly entrantId: string;
  readonly roundId: string;
  readonly roundIndex: string;
  readonly decisionUniverse?: LoadedLiquidUniverse;
}

async function loadCompetitionContext(): Promise<DogfoodCompetitionContext> {
  const path = resolve(
    repositoryRoot,
    process.env.TWOFOLD_COMPETITION_CONFIG
      ?? "config/private-controlled-lab-s1.json",
  );
  const value = JSON.parse(await readFile(path, "utf8")) as {
    schema?: unknown;
    season?: { seasonId?: unknown };
    entrants?: Array<Record<string, unknown>>;
    rounds?: Array<Record<string, unknown>>;
    decisionUniverse?: LiquidUniverseReference | null;
  };
  if (value.schema !== "twofold.private_controlled_lab_config/v1") {
    throw new TypeError("unsupported competition config schema");
  }
  const requestedEntrant = process.argv.slice(2)
    .find((argument) => argument.startsWith("--entrant="))
    ?.slice("--entrant=".length)
    ?? process.env.TWOFOLD_ENTRANT_CODE?.trim()
    ?? "twofold-orchestrator";
  const entrant = value.entrants?.find(
    (candidate) => candidate.entrantCode === requestedEntrant,
  );
  const requestedRound = process.argv.slice(2)
    .find((argument) => argument.startsWith("--round="))
    ?.slice("--round=".length)
    ?? "1";
  const round = value.rounds?.find(
    (candidate) => candidate.roundIndex === requestedRound,
  );
  const fields = {
    seasonId: value.season?.seasonId,
    runId: entrant?.runId,
    entrantCode: entrant?.entrantCode,
    bundleId: entrant?.bundleId,
    bundleSha256: entrant?.bundleSha256,
    presetId: entrant?.presetId,
    executionClass: entrant?.executionClass,
  };
  if (
    Object.values(fields).some((field) => typeof field !== "string")
    || typeof entrant?.entrantId !== "string"
    || typeof round?.roundId !== "string"
    || typeof round?.roundIndex !== "string"
  ) {
    throw new TypeError(`competition config lacks entrant ${requestedEntrant}`);
  }
  if (fields.presetId !== "twofold" && fields.presetId !== "twofold-orchestrator") {
    throw new TypeError("competition entrant uses an unsupported trusted preset");
  }
  if (fields.executionClass !== "ROOT_ONLY" && fields.executionClass !== "ORCHESTRATED") {
    throw new TypeError("competition entrant uses an unsupported execution class");
  }
  const decisionUniverse = value.decisionUniverse == null
    ? undefined
    : await loadLiquidUniverseReference(repositoryRoot, value.decisionUniverse);
  return {
    identity: fields as ArenaCompetitionIdentity,
    entrantId: entrant.entrantId,
    roundId: round.roundId,
    roundIndex: round.roundIndex,
    ...(decisionUniverse === undefined ? {} : { decisionUniverse }),
  };
}

function taskForPreset(presetId: ArenaPresetId): string {
  const common =
    "完成这次真实、只读行情快照上的纸面组合决策。先读取绑定的 decision packet，并以其中账本头、现金和持仓为唯一账户状态；在截止时间前提交且只提交一次目标权重。不要虚构订单、成交、费用、税或 NAV。";
  return presetId === "twofold-orchestrator"
    ? `${common} 委派恰好一个前台研究子 Agent 做独立风险复核，再由 root 综合证据。`
    : `${common} 这是 root-only 参赛者，不要委派子 Agent。`;
}

async function main(): Promise<void> {
  requiredSecret("DEEPSEEK_API_KEY");
  const abortScope = createDogfoodAbortScope();
  let runtime: Awaited<ReturnType<typeof createArenaRuntime>> | undefined;
  try {
    await Promise.all([
      access(resolve(harnessRoot, "package.json")),
      access(resolve(repositoryRoot, "profiles/twofold/cordis.yml")),
    ]);

    const config = loadWorkerConfig();
    const repository = new SupabaseArenaRepository(
      config.supabaseUrl!,
      config.supabaseSecretKey!,
      config.workerId,
    );
    const competition = await loadCompetitionContext();
    const competitionIdentity = competition.identity;
    const roundFence = await repository.roundEntrantFence(
      competition.roundId,
      competition.entrantId,
    );
    if (
      roundFence.roundIndex !== competition.roundIndex
      || roundFence.seasonId !== competitionIdentity.seasonId
      || roundFence.runId !== competitionIdentity.runId
    ) {
      throw new TypeError("registered Round entry diverges from competition config");
    }
    const [snapshot, portfolioState] = await Promise.all([
      repository.marketSnapshot(roundFence.snapshotId),
      repository.portfolioState(competitionIdentity.runId),
    ]);
    const inputs = await buildArenaInputs({
      repositoryRoot,
      harnessRoot,
      snapshot,
      competitionIdentity,
      roundFence,
      portfolioState,
      ...(competition.decisionUniverse === undefined
        ? {}
        : { decisionUniverse: competition.decisionUniverse }),
    });

    process.env.DSH_HOME = repositoryRoot;
    process.env.DSH_PERMISSION_MODE = "read-only";
    runtime = await createArenaRuntime({ repositoryRoot, workerId: config.workerId });
    // Boot and validate Harness before creating a durable invocation. A preset
    // assembly failure must not leave a decision permanently QUEUED.
    const prepared = await repository.prepareInvocation(inputs);
    const result = await runtime.run({
      prepared,
      persistence: repository,
      signal: abortScope.signal,
      task: taskForPreset(competitionIdentity.presetId),
    });
    const projection = result.projection;
    process.stdout.write(`${JSON.stringify({
      decisionId: prepared.identity.decisionId,
      roundId: competition.roundId,
      roundIndex: competition.roundIndex,
      entrantCode: competitionIdentity.entrantCode,
      status: projection.decision.status,
      dashboardPath: `/arena/decisions/${prepared.identity.decisionId}`,
      marketSnapshotId: prepared.identity.snapshotId,
      packetSha256: prepared.identity.packetSha256,
      rootSessionId: prepared.identity.rootSessionId,
      agentCount: String(projection.agents.length),
      providerDispatchAttempts: projection.treeUsage.providerRequestCount,
      totalBillableTokens: projection.treeUsage.totalBillableTokens,
      estimatedCostUsd: projection.treeUsage.estimatedCostUsd,
      costStatus: projection.treeUsage.costStatus,
      submissionStatus: projection.submission.status,
    }, null, 2)}\n`);
    if (dogfoodExitCode(projection.decision.status) !== 0) process.exitCode = 1;
  } finally {
    abortScope.dispose();
    if (runtime !== undefined) await runtime.dispose();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
  process.exitCode = 1;
});
