import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  finalizeArenaCycleExact,
  loadArenaScoreBase,
  type ArenaFinalizationRpcClient,
} from "../src/arena-finalization-repository.js";

const ids = Object.freeze({
  entry: "91000000-0000-8000-8000-000000000001",
  season: "92000000-0000-4000-8000-000000000001",
  entrant: "93000000-0000-4000-8000-000000000001",
  run: "94000000-0000-4000-8000-000000000001",
  decision: "95000000-0000-8000-8000-000000000001",
  submission: "96000000-0000-4000-8000-000000000001",
  account: "97000000-0000-4000-8000-000000000001",
  cycle: "98000000-0000-8000-8000-000000000001",
  event: "99000000-0000-8000-8000-000000000001",
  s1Plan: "9a000000-0000-8000-8000-000000000001",
  s2Plan: "9b000000-0000-8000-8000-000000000001",
  valuation: "9c000000-0000-8000-8000-000000000001",
  round: "9d000000-0000-4000-8000-000000000001",
  snapshot: "9e000000-0000-4000-8000-000000000001",
});
const cycleCanonicalJson = "{\"cycle\":\"exact\"}";
const cycleSha256 = createHash("sha256")
  .update(cycleCanonicalJson, "utf8").digest("hex");
const valuationCanonicalJson = "{\"valuation\":\"exact\"}";
const valuationSha256 = createHash("sha256")
  .update(valuationCanonicalJson, "utf8").digest("hex");

function client(dataByFunction: Readonly<Record<string, unknown>>): ArenaFinalizationRpcClient {
  return {
    rpc: vi.fn(async (name: string) => ({
      data: dataByFunction[name],
      error: null,
      status: 200,
    })),
  };
}

describe("Arena finalization repository", () => {
  it("loads only this entrant's immutable opening score base", async () => {
    const rpc = client({
      get_arena_leaderboard: [{
        schema: "twofold.arena_leaderboard_entry/v1",
        rank: "1",
        entrantId: ids.entrant,
        scoreBaseLiquidationNav: "18118.66",
      }],
    });
    await expect(loadArenaScoreBase(rpc, {
      seasonId: ids.season,
      entrantId: ids.entrant,
    })).resolves.toBe("18118.66");
    expect(rpc.rpc).toHaveBeenCalledWith("get_arena_leaderboard", {
      p_season_id: ids.season,
    });
  });

  it("publishes exact cycle and valuation bytes through the combined RPC", async () => {
    const rpc = client({
      finalize_arena_accepted_target_cycle: {
        schema: "twofold.arena_cycle_finalization_result/v1",
        cycle: {
          schema: "twofold.accepted_target_cycle_commit_result/v1",
          cycleId: ids.cycle,
          strategyAccountId: ids.account,
          runId: ids.run,
          decisionId: ids.decision,
          acceptedSubmissionId: ids.submission,
          s1FrozenOrderPlanId: ids.s1Plan,
          s2FrozenOrderPlanId: ids.s2Plan,
          cycleSha256,
          sourceEventId: ids.event,
          sourceStreamSeq: "4",
          projectionName: "dashboard.accepted_target_cycle",
          recordedBy: "worker",
          recordedAt: "2026-09-01T20:20:07.000Z",
        },
        valuation: {
          schema: "twofold.arena_valuation_result/v1",
          valuationId: ids.valuation,
          roundEntryId: ids.entry,
          roundId: ids.round,
          seasonId: ids.season,
          entrantId: ids.entrant,
          runId: ids.run,
          stage: "S2_CLOSE",
          snapshotId: ids.snapshot,
          valuationAt: "2026-09-01T20:20:06.000Z",
          valuationDate: "2026-09-01",
          ledgerSequence: "2",
          ledgerSha256: "b".repeat(64),
          brokerNav: "18150",
          taxReservedNav: "18150",
          liquidationNav: "18142.028",
          scoreBaseLiquidationNav: "18118.66",
          valuationSha256,
          recordedBy: "worker",
          recordedAt: "2026-09-01T20:20:07.000Z",
        },
      },
    });
    const result = await finalizeArenaCycleExact(rpc, {
      idempotencyKey: `arena:${ids.entry}:finalize`,
      roundEntryId: ids.entry,
      cycle: {
        decisionId: ids.decision,
        submissionId: ids.submission,
        canonicalJson: cycleCanonicalJson,
        contentSha256: cycleSha256,
      } as any,
      cycleId: ids.cycle,
      eventId: ids.event,
      completedAt: "2026-09-01T20:20:06.000Z",
      valuation: {
        stage: "S2_CLOSE",
        snapshotId: ids.snapshot,
        canonicalJson: valuationCanonicalJson,
        sha256: valuationSha256,
      } as any,
      expected: {
        strategyAccountId: ids.account,
        runId: ids.run,
        seasonId: ids.season,
        entrantId: ids.entrant,
      },
      recordedBy: "worker",
    });
    expect(result.cycleId).toBe(ids.cycle);
    expect(result.valuationId).toBe(ids.valuation);
    expect(rpc.rpc).toHaveBeenCalledWith(
      "finalize_arena_accepted_target_cycle",
      expect.objectContaining({
        p_cycle_canonical_json: "{\"cycle\":\"exact\"}",
        p_valuation_canonical_json: "{\"valuation\":\"exact\"}",
      }),
    );
  });
});
