import { describe, expect, it, vi } from "vitest";

import type { AlpacaMarketDataConfig } from "../src/market-data.js";
import {
  createArenaCloseSnapshotHandler,
  type ArenaCloseSnapshotStore,
} from "../src/arena-close-snapshot-handler.js";
import type { ArenaRoundCloseSnapshot } from "../src/arena-close-snapshot-repository.js";
import type { ArenaWorkItem } from "../src/arena-work-repository.js";

const config: AlpacaMarketDataConfig = {
  apiKeyId: "key",
  apiSecretKey: "secret",
  dataUrl: "https://data.alpaca.markets",
  // Symbols belong to the immutable Round schedule, not deployment config.
  symbols: ["STALE"],
  feed: "sip",
  lookbackDays: 3,
  sourceVersionKey: "alpaca-sip-raw-1day-v1",
  sourceEffectiveFrom: "2026-08-23T00:00:00.000Z",
  licenseScope: "private-research",
};

const item = {
  schema: "twofold.arena_work_item_result/v1",
  workItemId: "a1000000-0000-8000-8000-000000000001",
  roundEntryId: "a2000000-0000-8000-8000-000000000001",
  roundId: "a3000000-0000-4000-8000-000000000001",
  seasonId: "a4000000-0000-4000-8000-000000000001",
  entrantId: "a5000000-0000-4000-8000-000000000001",
  runId: "a6000000-0000-4000-8000-000000000001",
  phase: "CAPTURE_S1_CLOSE",
  predecessorWorkItemId: "a8000000-0000-8000-8000-000000000001",
  scheduledAt: "2026-08-31T20:20:00.000Z",
  deadlineAt: "2026-09-01T13:30:00.000Z",
  nextAttemptAt: "2026-08-31T20:20:00.000Z",
  status: "CLAIMED",
  attemptCount: "1",
  claimedBy: "worker-1",
  leaseToken: "a7000000-0000-4000-8000-000000000001",
  leaseExpiresAt: "2026-08-31T20:21:00.000Z",
  completedAt: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  retryable: null,
} as const satisfies ArenaWorkItem;

const existing = {
  schema: "twofold.arena_round_close_snapshot/v1",
  roundId: item.roundId,
  seasonId: item.seasonId,
  stage: "S1_CLOSE",
  snapshotId: "a9000000-0000-4000-8000-000000000001",
  sourceVersionId: "aa000000-0000-4000-8000-000000000001",
  manifestSha256: "1".repeat(64),
  sessionDate: "2026-08-31",
  cutoffAt: "2026-08-31T20:20:05.000Z",
  sealedAt: "2026-08-31T20:20:06.000Z",
  marks: [],
  boundBy: "worker-1",
  boundAt: "2026-08-31T20:20:07.000Z",
} as ArenaRoundCloseSnapshot;

function store(found: ArenaRoundCloseSnapshot | null): ArenaCloseSnapshotStore {
  return {
    load: vi.fn(async (_roundId, stage) => found === null
      ? null
      : { ...found, stage }),
    schedule: vi.fn(async () => ({
      roundId: item.roundId,
      symbols: ["LULU"],
      s1SessionDate: "2026-08-31",
      s1CloseAvailableAt: "2026-08-31T20:20:00.000Z",
      s2SessionDate: "2026-09-01",
      s2CloseAvailableAt: "2026-09-01T20:20:00.000Z",
    })),
    persist: vi.fn(async () => existing),
  };
}

describe("Arena close-snapshot phase handler", () => {
  it("reuses one shared close without another market request", async () => {
    const repository = store(existing);
    const fetchImplementation = vi.fn();
    const handler = createArenaCloseSnapshotHandler({
      config,
      store: repository,
      fetchImplementation: fetchImplementation as never,
    });

    await expect(handler(item, new AbortController().signal)).resolves.toEqual({
      outcome: "SHARED_CLOSE_SNAPSHOT_REUSED",
      snapshotId: existing.snapshotId,
      manifestSha256: existing.manifestSha256,
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(repository.persist).not.toHaveBeenCalled();
  });

  it("captures exactly the frozen S1 session close", async () => {
    const repository = store(null);
    const body = JSON.stringify({
      bars: { LULU: [{
        t: "2026-08-31T04:00:00Z", o: 120, h: 121, l: 118,
        c: 118.42, v: 100, n: 10, vw: 119.2,
      }] },
      next_page_token: null,
    });
    const fetchImplementation = vi.fn(async (_request: string | URL | Request) => new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const handler = createArenaCloseSnapshotHandler({
      config,
      store: repository,
      fetchImplementation: fetchImplementation as typeof fetch,
      now: () => new Date("2026-08-31T20:20:05.000Z"),
    });

    await expect(handler(item, new AbortController().signal)).resolves.toEqual({
      outcome: "SHARED_CLOSE_SNAPSHOT_CAPTURED",
      snapshotId: existing.snapshotId,
      manifestSha256: existing.manifestSha256,
    });
    expect(repository.persist).toHaveBeenCalledWith(
      item.roundId,
      "S1_CLOSE",
      expect.objectContaining({
        targetSessionDate: "2026-08-31",
        cutoffAt: "2026-08-31T20:20:05.000Z",
      }),
    );
    expect(new URL(fetchImplementation.mock.calls[0]![0] as URL).searchParams
      .get("symbols")).toBe("LULU");
  });

  it("binds the explicit S2 close phase to cycle-ready time", async () => {
    const repository = store(existing);
    const handler = createArenaCloseSnapshotHandler({ config, store: repository });
    await expect(handler({
      ...item,
      phase: "CAPTURE_S2_CLOSE",
      scheduledAt: "2026-09-01T20:20:00.000Z",
    }, new AbortController().signal)).resolves.toMatchObject({
      outcome: "SHARED_CLOSE_SNAPSHOT_REUSED",
    });
    expect(repository.load).toHaveBeenCalledWith(item.roundId, "S2_CLOSE");
  });
});
