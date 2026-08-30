import { describe, expect, it, vi } from "vitest";

import {
  getArenaRoundCloseSnapshot,
  registerArenaRoundCloseSnapshotExact,
  type ArenaCloseSnapshotRpcClient,
} from "../src/arena-close-snapshot-repository.js";

const ids = {
  round: "a1000000-0000-4000-8000-000000000001",
  season: "a2000000-0000-4000-8000-000000000001",
  snapshot: "a3000000-0000-4000-8000-000000000001",
  source: "a4000000-0000-4000-8000-000000000001",
  fact: "a5000000-0000-4000-8000-000000000001",
  delivery: "a6000000-0000-4000-8000-000000000001",
  artifact: "a7000000-0000-4000-8000-000000000001",
} as const;

function result(overrides: Record<string, unknown> = {}) {
  return {
    schema: "twofold.arena_round_close_snapshot/v1",
    roundId: ids.round,
    seasonId: ids.season,
    stage: "S1_CLOSE",
    snapshotId: ids.snapshot,
    sourceVersionId: ids.source,
    manifestSha256: "1".repeat(64),
    sessionDate: "2026-08-31",
    cutoffAt: "2026-08-31T20:20:05.000Z",
    sealedAt: "2026-08-31T20:20:06.000Z",
    marks: [{
      factId: ids.fact,
      symbol: "LULU",
      barStart: "2026-08-31T04:00:00.000Z",
      sessionDate: "2026-08-31",
      currency: "USD",
      value: "118.42",
      factSha256: "2".repeat(64),
      deliveryId: ids.delivery,
      observedAt: "2026-08-31T20:20:05.000Z",
      sourceArtifactId: ids.artifact,
      sourceContentSha256: "3".repeat(64),
    }],
    boundBy: "worker-1",
    boundAt: "2026-08-31T20:20:07.000Z",
    ...overrides,
  };
}

function client(data: unknown): ArenaCloseSnapshotRpcClient {
  return { rpc: vi.fn(async () => ({ data, error: null, status: 200 })) };
}

describe("Arena close-snapshot repository", () => {
  it("registers and verifies a Round-shared close snapshot", async () => {
    const rpc = client(result());
    const arguments_ = {
      p_idempotency_key: "round:1:s1-close",
      p_round_id: ids.round,
      p_stage: "S1_CLOSE" as const,
      p_snapshot_id: ids.snapshot,
      p_recorded_by: "worker-1",
    };

    await expect(registerArenaRoundCloseSnapshotExact(rpc, arguments_, {
      seasonId: ids.season,
      manifestSha256: "1".repeat(64),
      sessionDate: "2026-08-31",
    })).resolves.toMatchObject({
      stage: "S1_CLOSE",
      marks: [{ symbol: "LULU", value: "118.42" }],
    });
    expect(rpc.rpc).toHaveBeenCalledWith(
      "register_arena_round_close_snapshot",
      arguments_,
    );
  });

  it("reads absence without inventing evidence", async () => {
    await expect(getArenaRoundCloseSnapshot(
      client(null), ids.round, "S2_CLOSE",
    )).resolves.toBeNull();
  });

  it("rejects numeric tokens and changed snapshot identity", async () => {
    const arguments_ = {
      p_idempotency_key: "round:1:s1-close",
      p_round_id: ids.round,
      p_stage: "S1_CLOSE" as const,
      p_snapshot_id: ids.snapshot,
      p_recorded_by: "worker-1",
    };
    await expect(registerArenaRoundCloseSnapshotExact(
      client(result({ marks: [{ value: 118.42 }] })), arguments_, {
        seasonId: ids.season,
        manifestSha256: "1".repeat(64),
        sessionDate: "2026-08-31",
      },
    )).rejects.toThrow("numeric token");
    await expect(registerArenaRoundCloseSnapshotExact(
      client(result({ snapshotId: "a3000000-0000-4000-8000-000000000099" })),
      arguments_, {
        seasonId: ids.season,
        manifestSha256: "1".repeat(64),
        sessionDate: "2026-08-31",
      },
    )).rejects.toThrow("inconsistent");
  });
});
