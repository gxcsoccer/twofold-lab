import { describe, expect, it } from "vitest";

import type { PortfolioTargetsSubmission } from "@twofold-lab/dsh-twofold";

import { buildArenaDecisionAdmissionEvidence } from "../src/arena-decision-evidence.js";
import type { ArenaInvocationIdentity } from "../src/arena-types.js";

const snapshotId = "60000000-0000-4000-8000-000000000001";

const identity = Object.freeze({
  decisionId: "61000000-0000-4000-8000-000000000001",
  runId: "62000000-0000-4000-8000-000000000001",
  seasonId: "63000000-0000-4000-8000-000000000001",
  decisionPacketId: "64000000-0000-4000-8000-000000000001",
  rootSessionId: "twofold-root",
  snapshotId,
  packetSha256: "a".repeat(64),
  packetArtifactId: "65000000-0000-4000-8000-000000000001",
  bundleArtifactId: "66000000-0000-4000-8000-000000000001",
  bundleId: "twofold-orchestrator@0.1.0",
  bundleSha256: "b".repeat(64),
  presetId: "twofold-orchestrator",
  executionClass: "ORCHESTRATED",
  provider: "deepseek-official",
  model: "deepseek-v4-pro",
  decisionAt: "2026-08-30T00:00:00.000Z",
  dataCutoffAt: "2026-08-30T00:00:00.000Z",
  submissionDeadlineAt: "2026-08-30T00:15:00.000Z",
}) satisfies ArenaInvocationIdentity;

const packet = Object.freeze({
  status: "ready" as const,
  decision_packet_id: identity.decisionPacketId,
  packet_sha256: identity.packetSha256,
  available_at: identity.decisionAt,
  payload: {
    market_snapshot: {
      snapshot_id: snapshotId,
      cutoff_at: identity.dataCutoffAt,
      sealed_at: "2026-08-30T00:00:30.000Z",
      bars: [
        { symbol: "LULU", open_price: "100", close_price: "110" },
        { symbol: "SPY", open_price: "200", close_price: "198" },
      ],
    },
    portfolio_state: {
      status: "configured",
      cash: { settled: "0" },
      positions: [
        { symbol: "LULU", quantity: "100" },
      ],
    },
  },
});

const submission = Object.freeze({
  session_id: identity.rootSessionId,
  decision_packet_id: identity.decisionPacketId,
  packet_sha256: identity.packetSha256,
  targets: [
    { symbol: "LULU", target_weight_bps: "7000" },
    { symbol: "SPY", target_weight_bps: "2000" },
  ],
  cash_weight_bps: "1000",
  decision_summary: "Rebalance against the sealed close snapshot.",
}) satisfies PortfolioTargetsSubmission;

describe("Arena decision admission evidence", () => {
  it("derives freshness, jump, stability, target delta and cooldown from one packet", () => {
    const evidence = buildArenaDecisionAdmissionEvidence({
      identity,
      packet,
      submission,
      acceptedAt: "2026-08-30T00:10:00.000Z",
    });

    expect(evidence.evidenceSnapshotId).toBe(snapshotId);
    expect(evidence.decision.policyRef).toBe(`agent-bundle:${identity.bundleSha256}`);
    expect(evidence.metrics).toEqual({
      inputAgeMs: "600000",
      marketJumpBps: "1000",
      stableWindowMs: "570000",
      maxTargetDeltaBps: "3000",
      cooldownRemainingMs: "0",
    });
    expect(evidence.policy.maxInputAgeMs).toBe("900000");
    expect(evidence.guardAction).toBe("ALLOW");
  });

  it("turns a deadline violation into explicit blocking evidence", () => {
    const evidence = buildArenaDecisionAdmissionEvidence({
      identity,
      packet,
      submission,
      acceptedAt: "2026-08-30T00:16:00.000Z",
    });

    expect(evidence.guardAction).toBe("BLOCK");
    expect(evidence.reasons).toContain("INPUT_STALE");
  });
});
