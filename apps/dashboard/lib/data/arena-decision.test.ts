import { describe, expect, it } from "vitest";

import {
  validateArenaDecisionProjection,
  validateArenaDecisionProjectionEvidence,
} from "./arena-decision";

const DECISION_ID = "11111111-1111-4111-8111-111111111111";

function validProjection(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    decision: {
      decisionId: DECISION_ID,
      runId: "22222222-2222-4222-8222-222222222222",
      seasonId: "33333333-3333-4333-8333-333333333333",
      bundleId: "twofold-host",
      bundleSha256: "a".repeat(64),
      presetId: "twofold-orchestrator",
      status: "SUCCEEDED",
      decisionPacketId: "44444444-4444-4444-8444-444444444444",
      snapshotId: "55555555-5555-4555-8555-555555555555",
      packetSha256: "b".repeat(64),
      dataCutoffAt: "2026-08-21T20:00:00.000Z",
      startedAt: "2026-08-23T10:00:00.000Z",
      completedAt: "2026-08-23T10:01:00.000Z",
      failureCode: null,
      failureMessage: null,
    },
    rootSessionId: "root-session",
    agents: [
      {
        sessionId: "root-session",
        parentSessionId: null,
        agentPath: "root",
        displayName: "Twofold Orchestrator",
        origin: "root",
        delegationDepth: "0",
        status: "SUCCEEDED",
        provider: "deepseek-official",
        model: "deepseek-v4-pro",
        startedAt: "2026-08-23T10:00:00.000Z",
        completedAt: "2026-08-23T10:01:00.000Z",
        lastEventSeq: "12",
        usage: {
          providerRequestCount: "1",
          uncachedInputTokens: "10",
          cacheReadTokens: "2",
          cacheWriteTokens: "0",
          outputTokens: "5",
          reasoningTokens: "2",
          totalBillableTokens: "17",
          estimatedCostUsd: "0.001",
          costStatus: "ESTIMATED",
          pricingVersions: ["deepseek-v4-pro-2026-08"],
        },
      },
      {
        sessionId: "child-session",
        parentSessionId: "root-session",
        agentPath: "root/research-1",
        displayName: "Research 1",
        origin: "subagent",
        delegationDepth: "1",
        status: "SUCCEEDED",
        provider: "deepseek-official",
        model: "deepseek-v4-pro",
        startedAt: "2026-08-23T10:00:10.000Z",
        completedAt: "2026-08-23T10:00:30.000Z",
        lastEventSeq: "4",
        usage: {
          providerRequestCount: "1",
          uncachedInputTokens: "7",
          cacheReadTokens: "1",
          cacheWriteTokens: "0",
          outputTokens: "4",
          reasoningTokens: "1",
          totalBillableTokens: "12",
          estimatedCostUsd: "0.0003",
          costStatus: "ESTIMATED",
          pricingVersions: ["deepseek-v4-pro-2026-08"],
        },
      },
    ],
    treeUsage: {
      providerRequestCount: "2",
      uncachedInputTokens: "17",
      cacheReadTokens: "3",
      cacheWriteTokens: "0",
      outputTokens: "9",
      reasoningTokens: "3",
      totalBillableTokens: "29",
      estimatedCostUsd: "0.0013",
      costStatus: "ESTIMATED",
      pricingVersions: ["deepseek-v4-pro-2026-08"],
    },
    budget: {
      maxProviderRequests: "8",
      usedProviderRequests: "2",
      maxBillableTokens: "100000",
      usedBillableTokens: "29",
      maxEstimatedCostUsd: "1.00",
      usedEstimatedCostUsd: "0.0013",
      maxDescendants: "4",
      activeDescendants: "0",
      enforcementStatus: "WITHIN_LIMITS",
    },
    submission: {
      status: "ACCEPTED",
      acceptedSubmissionId: "66666666-6666-4666-8666-666666666666",
      acceptedAt: "2026-08-23T10:00:58.000Z",
      rejectionCode: null,
    },
    updatedAt: "2026-08-23T10:01:00.000Z",
  };
}

describe("arena decision projection validator", () => {
  it("accepts one internally consistent root/descendant projection", () => {
    expect(validateArenaDecisionProjection(validProjection(), DECISION_ID)).toMatchObject({
      ok: true,
    });
  });

  it("rejects a state that belongs to a different decision UUID", () => {
    const projection = validProjection();
    (projection.decision as Record<string, unknown>).decisionId =
      "77777777-7777-4777-8777-777777777777";
    const result = validateArenaDecisionProjection(projection, DECISION_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join("\n")).toContain("entity_id 不一致");
  });

  it("rejects broken tree totals instead of rendering partial usage", () => {
    const projection = validProjection();
    (projection.treeUsage as Record<string, unknown>).totalBillableTokens = "28";
    const result = validateArenaDecisionProjection(projection, DECISION_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join("\n")).toContain("不守恒");
  });

  it("accepts truthful token and cost overruns when enforcement is EXHAUSTED", () => {
    const projection = validProjection();
    const budget = projection.budget as Record<string, unknown>;
    budget.maxBillableTokens = "28";
    budget.maxEstimatedCostUsd = "0.0012";
    budget.enforcementStatus = "EXHAUSTED";

    expect(validateArenaDecisionProjection(projection, DECISION_ID)).toMatchObject({
      ok: true,
    });
  });

  it("rejects a token overrun while enforcement is not EXHAUSTED", () => {
    const projection = validProjection();
    (projection.budget as Record<string, unknown>).maxBillableTokens = "28";

    const result = validateArenaDecisionProjection(projection, DECISION_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join("\n")).toContain(
        "state.budget.usedBillableTokens 超过 maxBillableTokens",
      );
    }
  });

  it("rejects a cost overrun while enforcement is not EXHAUSTED", () => {
    const projection = validProjection();
    (projection.budget as Record<string, unknown>).maxEstimatedCostUsd = "0.0012";

    const result = validateArenaDecisionProjection(projection, DECISION_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join("\n")).toContain(
        "state.budget.usedEstimatedCostUsd 超过 maxEstimatedCostUsd",
      );
    }
  });

  it("returns validation issues for malformed counts without throwing", () => {
    const projection = validProjection();
    (projection.treeUsage as Record<string, unknown>).providerRequestCount = "2.5";
    expect(() => validateArenaDecisionProjection(projection, DECISION_ID)).not.toThrow();
    expect(validateArenaDecisionProjection(projection, DECISION_ID)).toMatchObject({
      ok: false,
    });
  });

  it("rejects unknown state keys for schemaVersion 1", () => {
    const projection = validProjection();
    projection.demo = true;
    const result = validateArenaDecisionProjection(projection, DECISION_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join("\n")).toContain("不属于 schemaVersion 1");
  });

  it("validates projection-row evidence independently from state", () => {
    expect(validateArenaDecisionProjectionEvidence({
      stateHash: "c".repeat(64),
      lastEventId: "88888888-8888-4888-8888-888888888888",
      projectionUpdatedAt: "2026-08-23T10:01:01.000Z",
    })).toMatchObject({ ok: true });
  });
});
