import { describe, expect, it } from "vitest";

import { createDeterministicBaselinePolicy } from "@twofold/core";

import { buildBaselineDecisionInputs } from "../src/arena-baseline-decision.js";
import {
  persistBaselineDecision,
  type BaselineDecisionPort,
} from "../src/arena-baseline-repository.js";
import type {
  ArenaMarketSnapshot,
  ArenaPortfolioState,
} from "../src/arena-inputs.js";
import type { ArenaRoundEntrantFence } from "../src/arena-repository.js";

const SNAPSHOT_ID = "e502936c-1c97-49d5-9351-deb16721cb5b";

const snapshot: ArenaMarketSnapshot = {
  snapshotId: SNAPSHOT_ID,
  sourceVersionId: "11111111-1111-4111-8111-111111111111",
  manifestSha256: "b".repeat(64),
  cutoffAt: "2026-08-28T20:20:00.000Z",
  targetSessionDate: "2026-08-28",
  selectionPolicy: "latest_completed_session",
  sealedAt: "2026-08-28T20:30:00.000Z",
  symbols: ["LULU"],
  bars: [{
    factId: "fact-LULU",
    symbol: "LULU",
    barStart: "2026-08-28T20:00:00.000Z",
    barDate: "2026-08-28",
    currency: "USD",
    openPrice: "120.7911",
    highPrice: "120.7911",
    lowPrice: "120.7911",
    closePrice: "120.7911",
    volume: "1000000",
    tradeCount: "5000",
    vwap: "120.7911",
    factSha256: "a".repeat(64),
  }],
};

const portfolioState: ArenaPortfolioState = {
  schema: "twofold.strategy_portfolio_state/v1",
  strategyAccountId: "22222222-2222-4222-8222-222222222222",
  runId: "ce2caf2a-a4f5-58fc-8794-16abb3d369aa",
  asOf: "2026-08-29T21:20:32.000Z",
  account: {
    accountCode: "baseline-hold",
    broker: "futu",
    brokerRegion: "HK",
    baseCurrency: "USD",
    liveTrading: false,
  },
  ledgerHead: {
    sequence: "1",
    sha256: "c".repeat(64),
    accountingTransactionCount: "2",
    lotOriginCount: "1",
    acquisitionFxBindingCount: "1",
    settlementCount: "0",
    corporateActionMutationCount: "0",
  },
  cash: { settled: "0", taxReserve: "0", buyingPower: "0" },
  positions: [{
    instrumentId: "122dd8f9-709a-5652-a27c-a3b5c32755de",
    symbol: "LULU",
    quantity: "150",
    grossCost: "18000.00",
    taxBasis: "18000.00",
    currency: "USD",
    lotCount: "1",
  }],
};

const fence: ArenaRoundEntrantFence = {
  roundId: "d83eff85-da7b-5e07-81d6-d4feaf4d9839",
  roundIndex: "1",
  decisionId: "33333333-3333-4333-8333-333333333333",
  decisionAt: "2026-08-29T21:28:55.699Z",
  submissionDeadlineAt: "2026-08-31T13:15:00.000Z",
  roundEntryId: "44444444-4444-4444-8444-444444444444",
  seasonId: "1486ba8e-47ae-5774-ba44-5c26f9359eeb",
  entrantId: "55555555-5555-4555-8555-555555555555",
  runId: "ce2caf2a-a4f5-58fc-8794-16abb3d369aa",
  snapshotId: SNAPSHOT_ID,
};

const built = buildBaselineDecisionInputs({
  policy: createDeterministicBaselinePolicy({
    policyId: "hold-genesis",
    rule: "HOLD_GENESIS",
    symbol: null,
  }),
  entrantCode: "baseline-hold-lulu",
  fence,
  snapshot,
  portfolioState,
  genesisSymbol: "LULU",
});

function recordingPort() {
  const calls: string[] = [];
  const seen: Record<string, unknown> = {};
  const port: BaselineDecisionPort = {
    async uploadArtifact(material) {
      calls.push(`upload:${material.objectPath.split("/")[0]}`);
    },
    async runStreamSequence() {
      calls.push("head");
      return "7";
    },
    async registerArtifact(input) {
      calls.push(`register:${input.artifactKind}`);
      seen[input.artifactKind] = input;
      return `artifact-${input.artifactKind}`;
    },
    async openInvocation(input) {
      calls.push("open");
      seen.open = input;
      return "8";
    },
    async acceptSubmission(input) {
      calls.push("accept");
      seen.accept = input;
      return { submissionId: input.submissionId, acceptedAt: input.acceptedAt };
    },
  };
  return { port, calls, seen };
}

describe("baseline decision persistence", () => {
  it("stores both artifacts before naming them in the invocation", async () => {
    const { port, calls } = recordingPort();
    await persistBaselineDecision(port, built);
    const firstRegister = calls.findIndex((call) => call.startsWith("register:"));
    const lastUpload = calls.map((call) => call.startsWith("upload:"))
      .lastIndexOf(true);
    expect(lastUpload).toBeLessThan(firstRegister);
    expect(calls.indexOf("open")).toBeLessThan(calls.indexOf("accept"));
  });

  it("binds the invocation to the packet and the frozen policy artifact", async () => {
    const { port, seen } = recordingPort();
    await persistBaselineDecision(port, built);
    const open = seen.open as { packetArtifactId: string; policyArtifactId: string };
    expect(open.packetArtifactId).toBe("artifact-baseline_decision_packet");
    expect(open.policyArtifactId).toBe("artifact-deterministic_baseline_policy");
  });

  it("chains the submission onto the invocation's run-stream sequence", async () => {
    const { port, seen } = recordingPort();
    await persistBaselineDecision(port, built);
    const open = seen.open as { expectedRunStreamSeq: string };
    const accept = seen.accept as { expectedRunStreamSeq: string };
    expect(open.expectedRunStreamSeq).toBe("7");
    expect(accept.expectedRunStreamSeq).toBe("8");
  });

  it("keeps the policy artifact Season-scoped so a later Season reuses it", async () => {
    const { port, seen } = recordingPort();
    await persistBaselineDecision(port, built);
    const policy = seen.deterministic_baseline_policy as { runScoped: boolean };
    const packet = seen.baseline_decision_packet as { runScoped: boolean };
    expect(policy.runScoped).toBe(false);
    expect(packet.runScoped).toBe(true);
  });

  it("returns the decision and submission identities", async () => {
    const { port } = recordingPort();
    const result = await persistBaselineDecision(port, built);
    expect(result.decisionId).toBe(fence.decisionId);
    expect(result.submissionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("baseline persistence idempotency", () => {
  it("opens and accepts with the frozen build timestamp, never a fresh clock", async () => {
    const { port, seen } = recordingPort();
    await persistBaselineDecision(port, built);
    const open = seen.open as { openedAt: string };
    const accept = seen.accept as { acceptedAt: string; submissionId: string };
    expect(open.openedAt).toBe(built.identity.observedAt);
    expect(accept.acceptedAt).toBe(built.identity.observedAt);
    expect(accept.submissionId).toBe(built.identity.submissionId);
  });

  it("re-presents identical content on a retry after the invocation is open", async () => {
    const first = recordingPort();
    await persistBaselineDecision(first.port, built);
    const retry = recordingPort();
    await persistBaselineDecision(retry.port, built);
    expect(retry.seen.open).toEqual(first.seen.open);
    expect(retry.seen.accept).toEqual(first.seen.accept);
  });

  it("binds the packet artifact to the sealed snapshot manifest", async () => {
    const { port, seen } = recordingPort();
    await persistBaselineDecision(port, built);
    const packet = seen.baseline_decision_packet as {
      metadata: Record<string, string>;
    };
    expect(packet.metadata.marketManifestSha256).toBe(snapshot.manifestSha256);
    expect(packet.metadata.decisionId).toBe(fence.decisionId);
  });
});
