import { access, cp, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  executeBaselineDecision,
  loadBaselineCompetitionSeat,
} from "./arena-baseline-runner.js";
import { buildArenaInputs, type ArenaCompetitionIdentity } from "./arena-inputs.js";
import { SupabaseArenaRepository } from "./arena-repository.js";
import { createArenaRuntime } from "./arena-runtime.js";
import type { ArenaDecisionStatus } from "./arena-types.js";
import type { ArenaWorkItem } from "./arena-work-repository.js";
import type {
  ArenaWorkHandler,
  ArenaWorkHandlers,
} from "./arena-work-runner.js";
import { ArenaTerminalWorkError } from "./arena-work-runner.js";
import type { WorkerConfig } from "./config.js";
import {
  loadLiquidUniverseReference,
  type LiquidUniverseReference,
  type LoadedLiquidUniverse,
} from "./liquid-universe-reference.js";

const DEFAULT_REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const stagedRuntimeHomes = new Map<string, Promise<string>>();

export interface ArenaAgentDecisionResult {
  readonly decisionId: string;
  readonly status: ArenaDecisionStatus;
  readonly acceptedSubmissionId: string | null;
  readonly agentCount: string;
  readonly providerDispatchAttempts: string;
  readonly totalBillableTokens: string;
  readonly estimatedCostUsd: string | null;
  readonly costStatus: string;
}

export type ArenaAgentDecisionExecution = (
  item: ArenaWorkItem,
  signal: AbortSignal,
) => Promise<ArenaAgentDecisionResult>;

export interface ArenaAgentFilesystem {
  readonly repositoryRoot: string;
  readonly harnessRoot: string;
  readonly harnessRevision: string | undefined;
}

/**
 * Harness persists session/query state below DSH_HOME. Serverless deployment
 * files are immutable, so each warm function isolate gets one writable copy
 * of the profile and reuses it for all sequential Arena invocations.
 */
export async function stageArenaRuntimeHome(
  deploymentRepositoryRoot: string,
): Promise<string> {
  const sourceRoot = resolve(deploymentRepositoryRoot);
  const runtimeRoot = await mkdtemp(join(tmpdir(), "twofold-arena-"));
  const profilesRoot = join(runtimeRoot, "profiles");
  await mkdir(profilesRoot, { recursive: true });
  await cp(
    join(sourceRoot, "profiles", "twofold"),
    join(profilesRoot, "twofold"),
    { recursive: true },
  );
  return runtimeRoot;
}

function stagedArenaRuntimeHome(repositoryRoot: string): Promise<string> {
  const key = resolve(repositoryRoot);
  let staged = stagedRuntimeHomes.get(key);
  if (staged === undefined) {
    staged = stageArenaRuntimeHome(key);
    stagedRuntimeHomes.set(key, staged);
  }
  return staged;
}

/**
 * Resolve deployment files without making a bundled function depend on its
 * build-time module path. A frozen revision is evidence identity only: the
 * published Harness packages remain ordinary application dependencies.
 */
export function resolveArenaAgentFilesystem(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly repositoryRoot?: string;
  readonly harnessRoot?: string;
  readonly processCwd?: string;
}): ArenaAgentFilesystem {
  const configuredRepositoryRoot = input.environment.TWOFOLD_REPOSITORY_ROOT
    ?.trim();
  const deploymentCwd = input.processCwd ?? process.cwd();
  const vercelRepositoryRoot = deploymentCwd.endsWith("/apps/dashboard")
    ? resolve(deploymentCwd, "../..")
    : deploymentCwd;
  const repositoryRoot = resolve(
    input.repositoryRoot
      ?? (configuredRepositoryRoot === undefined || configuredRepositoryRoot === ""
        ? input.environment.VERCEL === "1"
          ? vercelRepositoryRoot
          : DEFAULT_REPOSITORY_ROOT
        : configuredRepositoryRoot),
  );
  const harnessRoot = resolve(/* turbopackIgnore: true */
    input.harnessRoot
      ?? input.environment.DSH_HARNESS_ROOT
      ?? resolve(repositoryRoot, "../deepseek-harness"),
  );
  const configuredRevision = input.environment.TWOFOLD_HARNESS_REVISION?.trim();
  return Object.freeze({
    repositoryRoot,
    harnessRoot,
    harnessRevision: configuredRevision === undefined || configuredRevision === ""
      ? undefined
      : configuredRevision,
  });
}

export function createArenaAgentDecisionHandler(input: {
  readonly execute: ArenaAgentDecisionExecution;
}): ArenaWorkHandler {
  return async (item, signal) => {
    if (item.phase !== "RUN_AGENT_DECISION") {
      throw new TypeError(`Agent decision handler cannot execute ${item.phase}`);
    }
    const result = await input.execute(item, signal);
    if (result.status !== "SUCCEEDED" || result.acceptedSubmissionId === null) {
      throw new ArenaTerminalWorkError(
        result.status,
        `Arena Agent ended as ${result.status} without one accepted target`,
      );
    }
    return Object.freeze({ outcome: "ACCEPTED_TARGET", ...result });
  };
}

/** Missing provider credentials means no capability, so the queue is untouched. */
export function arenaAgentHandlers(
  environment: Readonly<Record<string, string | undefined>>,
  handler: ArenaWorkHandler,
): ArenaWorkHandlers {
  const key = environment.DEEPSEEK_API_KEY;
  return key === undefined || key.trim() === ""
    ? Object.freeze({})
    : Object.freeze({ RUN_AGENT_DECISION: handler });
}

export interface CompetitionSeat {
  readonly identity: ArenaCompetitionIdentity;
  readonly roundIndex: string;
  readonly decisionUniverse?: LoadedLiquidUniverse;
}

export function createRealArenaAgentDecisionExecution(input: {
  readonly worker: WorkerConfig;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly repositoryRoot?: string;
  readonly harnessRoot?: string;
}): ArenaAgentDecisionExecution {
  const environment = input.environment ?? process.env;
  const { repositoryRoot, harnessRoot, harnessRevision } =
    resolveArenaAgentFilesystem({
      environment,
      ...(input.repositoryRoot === undefined
        ? {}
        : { repositoryRoot: input.repositoryRoot }),
      ...(input.harnessRoot === undefined ? {} : { harnessRoot: input.harnessRoot }),
    });
  return async (item, signal) => {
    // A deterministic baseline shares the decision phase but not the execution
    // path, so it is dispatched before the credential check and never reads the
    // provider key. Note this does NOT make the Worker credential-free:
    // arenaAgentHandlers below still advertises RUN_AGENT_DECISION only when a
    // key is present, so a keyless Worker claims no decision work at all. That
    // is acceptable while baselines share a Round with Agent entrants - such a
    // Round needs the key regardless - but a baseline-only Season would need
    // its own work phase before it could run without one.
    const baselineSeat = await loadBaselineCompetitionSeat(
      repositoryRoot,
      environment.TWOFOLD_COMPETITION_CONFIG
        ?? "config/private-controlled-lab-s1.json",
      item,
    );
    if (baselineSeat !== null) {
      const baseline = await executeBaselineDecision({
        worker: input.worker,
        seat: baselineSeat,
        item,
      });
      return Object.freeze({
        decisionId: baseline.decisionId,
        status: "SUCCEEDED" as const,
        acceptedSubmissionId: baseline.acceptedSubmissionId,
        agentCount: "0",
        providerDispatchAttempts: "0",
        totalBillableTokens: "0",
        estimatedCostUsd: "0",
        costStatus: "ESTIMATED",
      });
    }

    const key = environment.DEEPSEEK_API_KEY;
    if (key === undefined || key.trim() === "") {
      throw new Error("DEEPSEEK_API_KEY is required for real Agent execution");
    }
    await Promise.all([
      access(resolve(repositoryRoot, "profiles/twofold/cordis.yml")),
      ...(harnessRevision === undefined
        ? [access(resolve(harnessRoot, "package.json"))]
        : []),
    ]);
    const repository = new SupabaseArenaRepository(
      input.worker.supabaseUrl!,
      input.worker.supabaseSecretKey!,
      input.worker.workerId,
    );
    const fence = await repository.roundEntrantFence(
      item.roundId,
      item.entrantId,
    );
    const seat = await loadCompetitionSeat(
      repositoryRoot,
      environment.TWOFOLD_COMPETITION_CONFIG
        ?? "config/private-controlled-lab-s1.json",
      item,
      fence.roundIndex,
    );
    if (
      fence.roundEntryId !== item.roundEntryId
      || fence.roundIndex !== seat.roundIndex
      || fence.seasonId !== item.seasonId
      || fence.entrantId !== item.entrantId
      || fence.runId !== item.runId
      || fence.decisionAt !== item.scheduledAt
      || fence.submissionDeadlineAt !== item.deadlineAt
    ) {
      throw new TypeError("claimed Agent work diverges from its immutable Round seat");
    }
    const [snapshot, portfolioState] = await Promise.all([
      repository.marketSnapshot(fence.snapshotId),
      repository.portfolioState(item.runId),
    ]);
    const inputs = await buildArenaInputs({
      repositoryRoot,
      harnessRoot,
      ...(harnessRevision === undefined ? {} : { harnessRevision }),
      snapshot,
      competitionIdentity: seat.identity,
      roundFence: fence,
      portfolioState,
      ...(seat.decisionUniverse === undefined
        ? {}
        : { decisionUniverse: seat.decisionUniverse }),
    });

    // Harness reads these process-scoped values. One Agent runner handles one
    // claimed invocation at a time; market evidence runs in a separate runner.
    const serverless = environment.VERCEL === "1";
    const runtimeRoot = serverless
      ? await stagedArenaRuntimeHome(repositoryRoot)
      : repositoryRoot;
    process.env.DSH_HOME = runtimeRoot;
    process.env.DSH_PERMISSION_MODE = "read-only";
    const runtime = await createArenaRuntime({
      repositoryRoot: runtimeRoot,
      workerId: input.worker.workerId,
      ...(serverless
        ? {
            installAnchor: resolve(repositoryRoot, "apps/worker/package.json"),
            profileBundlePatchPaths: [
              resolve(
                repositoryRoot,
                "apps/worker/dist/serverless-profile/dsh-base.cordis.patch.yml",
              ),
              resolve(repositoryRoot, "packages/dsh-twofold/cordis.patch.yml"),
            ],
            profileDirectory: resolve(runtimeRoot, "profiles/twofold"),
            runtimePackageManifest: true,
          }
        : {}),
      profileModuleHealing: !serverless,
    });
    try {
      // Runtime boot happens before durable invocation creation. A broken
      // Harness profile therefore cannot leave the decision permanently open.
      const prepared = await repository.prepareInvocation(inputs);
      const execution = await runtime.run({
        prepared,
        persistence: repository,
        signal,
        task: taskForPreset(seat.identity.presetId),
      });
      const projection = execution.projection;
      return Object.freeze({
        decisionId: prepared.identity.decisionId,
        status: projection.decision.status,
        acceptedSubmissionId: projection.submission.acceptedSubmissionId,
        agentCount: String(projection.agents.length),
        providerDispatchAttempts: projection.treeUsage.providerRequestCount,
        totalBillableTokens: projection.treeUsage.totalBillableTokens,
        estimatedCostUsd: projection.treeUsage.estimatedCostUsd,
        costStatus: projection.treeUsage.costStatus,
      });
    } finally {
      await runtime.dispose();
    }
  };
}

export async function loadCompetitionSeat(
  repositoryRoot: string,
  configPath: string,
  item: ArenaWorkItem,
  registeredRoundIndex?: string,
): Promise<CompetitionSeat> {
  const configuredPath = resolve(repositoryRoot, configPath);
  const registryRoot = resolve(repositoryRoot, "config");
  const entries = await readdir(registryRoot, { withFileTypes: true });
  const paths = [...new Set([
    configuredPath,
    ...entries
      .filter((entry) => entry.isFile()
        && entry.name.startsWith("private-")
        && entry.name.endsWith(".json"))
      .map((entry) => resolve(registryRoot, entry.name))
      .sort((left, right) => left.localeCompare(right, "en")),
  ])];
  for (const path of paths) {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
    schema?: unknown;
    season?: { seasonId?: unknown };
    entrants?: Array<Record<string, unknown>>;
    rounds?: Array<Record<string, unknown>>;
    decisionUniverse?: LiquidUniverseReference | null;
    };
    if (
      raw.schema !== "twofold.private_controlled_lab_config/v1"
      || raw.season?.seasonId !== item.seasonId
    ) continue;
    const entrant = raw.entrants?.find(
      (candidate) => candidate.entrantId === item.entrantId,
    );
    const round = raw.rounds?.find(
      (candidate) => candidate.roundId === item.roundId,
    );
    const roundIndex = round?.roundIndex ?? registeredRoundIndex;
    if (
      entrant?.runId !== item.runId
      || typeof roundIndex !== "string"
      || !/^[1-9]\d*$/.test(roundIndex)
      || (registeredRoundIndex !== undefined
        && round?.roundIndex !== undefined
        && round.roundIndex !== registeredRoundIndex)
      || typeof entrant?.entrantCode !== "string"
      || typeof entrant.bundleId !== "string"
      || typeof entrant.bundleSha256 !== "string"
      || (entrant.executionClass !== "ROOT_ONLY"
        && entrant.executionClass !== "ORCHESTRATED")
      || (entrant.presetId !== "twofold"
        && entrant.presetId !== "twofold-orchestrator")
      || entrant.provider !== "deepseek-official"
      || entrant.model !== "deepseek-v4-pro"
    ) {
      throw new TypeError("competition config does not match claimed Agent work");
    }
    const decisionUniverse = raw.decisionUniverse == null
      ? undefined
      : await loadLiquidUniverseReference(repositoryRoot, raw.decisionUniverse);
    return Object.freeze({
      identity: Object.freeze({
        seasonId: item.seasonId,
        runId: item.runId,
        entrantCode: entrant.entrantCode,
        bundleId: entrant.bundleId,
        bundleSha256: entrant.bundleSha256,
        presetId: entrant.presetId,
        executionClass: entrant.executionClass,
      }),
      roundIndex,
      ...(decisionUniverse === undefined ? {} : { decisionUniverse }),
    });
  }
  throw new TypeError("no competition config matches claimed Agent work");
}

function taskForPreset(presetId: ArenaCompetitionIdentity["presetId"]): string {
  const common =
    "完成这次真实、只读行情快照上的纸面组合决策。先读取绑定的 decision packet，并以其中账本头、现金和持仓为唯一账户状态；在截止时间前提交且只提交一次目标权重。不要虚构订单、成交、费用、税或 NAV。";
  return presetId === "twofold-orchestrator"
    ? `${common} 委派恰好一个前台研究子 Agent 做独立风险复核，再由 root 综合证据。`
    : `${common} 这是 root-only 参赛者，不要委派子 Agent。`;
}
