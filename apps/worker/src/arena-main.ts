import { loadWorkerConfig } from "./config.js";
import {
  createArenaAgentDecisionRunner,
  hasArenaAgentCapability,
} from "./create-agent-decision-runner.js";
import { createArenaCycleRunner } from "./create-arena-cycle-runner.js";
import { createArenaMarketEvidenceRunner } from "./create-market-evidence-runner.js";
import { createCorporateActionScanner } from
  "./create-corporate-action-scanner.js";
import { createCorporateActionAccountReconciler } from
  "./create-corporate-action-account-reconciler.js";
import { createArenaNoTradeRecoveryRunner } from
  "./create-arena-no-trade-recovery-runner.js";
import { createArenaRoundProvisioningRunner } from
  "./create-arena-round-provisioning-runner.js";

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const agentRunner = createArenaAgentDecisionRunner(config);
  const cycleRunner = createArenaCycleRunner(config);
  const marketRunner = createArenaMarketEvidenceRunner(config);
  const corporateActionScanner = createCorporateActionScanner(config);
  const corporateActionAccountReconciler = createCorporateActionAccountReconciler(
    config,
  );
  const recoveryRunner = createArenaNoTradeRecoveryRunner(config);
  const seasonRunner = createArenaRoundProvisioningRunner(config);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("SIGINT")));
  process.once("SIGTERM", () => controller.abort(new Error("SIGTERM")));
  process.stdout.write(
    `[twofold-arena-worker] started id=${config.workerId} capabilities=${
      hasArenaAgentCapability()
        ? "agent-decision,cycle-settlement,market-evidence,corporate-actions,no-trade-recovery,season-provisioning"
        : "cycle-settlement,market-evidence,corporate-actions,no-trade-recovery,season-provisioning"
    }\n`,
  );
  while (!controller.signal.aborted) {
    const corporateActionOutcome = await corporateActionScanner.tick(
      controller.signal,
    );
    if (corporateActionOutcome === "failed") {
      process.stderr.write(
        "[twofold-arena-worker] corporate-action scan failed; contestant-local phases remain gated\n",
      );
    }
    const corporateActionAccountOutcome = await corporateActionAccountReconciler.tick(
      controller.signal,
    );
    if (corporateActionAccountOutcome === "failed") {
      process.stderr.write(
        "[twofold-arena-worker] corporate-action account reconciliation failed; contestant-local phases remain gated\n",
      );
    }
    await Promise.all([
      agentRunner.tick(controller.signal),
      cycleRunner.tick(controller.signal),
      marketRunner.tick(controller.signal),
      recoveryRunner.tick(controller.signal),
      seasonRunner.tick(controller.signal),
    ]);
    await wait(config.pollIntervalMs, controller.signal);
  }
}

void main().catch((error: unknown) => {
  if (error instanceof Error && (error.message === "SIGINT" || error.message === "SIGTERM")) {
    process.exitCode = 0;
    return;
  }
  process.stderr.write(`[twofold-arena-worker] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
