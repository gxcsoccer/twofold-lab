import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildArenaInputs } from "./arena-inputs.js";
import { SupabaseArenaRepository } from "./arena-repository.js";
import { createArenaRuntime } from "./arena-runtime.js";
import { loadWorkerConfig } from "./config.js";
import {
  createDogfoodAbortScope,
  dogfoodExitCode,
} from "./dogfood-control.js";
import { sanitizeFailureMessage } from "./failure-safety.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const harnessRoot = resolve(
  process.env.DSH_HARNESS_ROOT ?? resolve(repositoryRoot, "../../deepseek-ai/deepseek-harness"),
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
    const snapshot = await repository.latestMarketSnapshot();
    const inputs = await buildArenaInputs({ repositoryRoot, harnessRoot, snapshot });

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
      task:
        "完成这次真实、只读行情快照上的纸面组合决策。先读取绑定的 decision packet；委派恰好一个前台研究子 Agent 做独立风险复核，再由 root 综合证据，并在截止时间前提交且只提交一次目标权重。不要假设持仓、订单、成交、费用、税或 NAV。",
    });
    const projection = result.projection;
    process.stdout.write(`${JSON.stringify({
      decisionId: prepared.identity.decisionId,
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
