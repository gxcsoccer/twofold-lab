import { describe, expect, it, vi } from "vitest";

import type { AlpacaOpenReferenceConfig } from "../src/alpaca-open-reference.js";
import {
  createArenaOpenReferenceHandler,
  type ArenaOpenReferenceStore,
} from "../src/arena-open-reference-handler.js";
import type { ArenaOpenReference } from "../src/arena-open-reference-repository.js";
import type { ArenaWorkItem } from "../src/arena-work-repository.js";

const config: AlpacaOpenReferenceConfig = {
  apiKeyId: "key",
  apiSecretKey: "secret",
  dataUrl: "https://data.alpaca.markets",
  // Provider credentials are deployment-scoped; symbols are Round-scoped.
  // Keeping a stale value here proves the handler uses its durable schedule.
  symbols: ["STALE"],
  feed: "sip",
  sourceVersionKey: "alpaca-sip-raw-1min-open-v1",
  liquiditySourceVersionKey: "alpaca-sip-raw-1min-vwap-volume-v2",
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
  phase: "CAPTURE_S1_OPEN_REFERENCE",
  predecessorWorkItemId: null,
  scheduledAt: "2026-08-31T13:32:00.000Z",
  deadlineAt: "2026-08-31T20:00:00.000Z",
  nextAttemptAt: "2026-08-31T13:32:00.000Z",
  status: "CLAIMED",
  attemptCount: "1",
  claimedBy: "worker-1",
  leaseToken: "a7000000-0000-4000-8000-000000000001",
  leaseExpiresAt: "2026-08-31T13:33:00.000Z",
  completedAt: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  retryable: null,
} as const satisfies ArenaWorkItem;

const existing = {
  schema: "twofold.arena_round_open_reference/v1",
  roundId: item.roundId,
  seasonId: item.seasonId,
  stage: "S1_OPEN_REFERENCE",
  referenceSnapshotId: "a8000000-0000-8000-8000-000000000001",
  sourceVersionId: "a9000000-0000-4000-8000-000000000001",
  sourceArtifactId: "aa000000-0000-4000-8000-000000000001",
  sourceContentSha256: "1".repeat(64),
  requestFingerprint: "2".repeat(64),
  method: "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE",
  sessionDate: "2026-08-31",
  expectedOpenAt: "2026-08-31T13:30:00.000Z",
  observedAt: "2026-08-31T13:32:05.000Z",
  contentSha256: "3".repeat(64),
  references: [],
  boundBy: "worker-1",
  boundAt: "2026-08-31T13:32:06.000Z",
} as unknown as ArenaOpenReference;

function store(
  found: ArenaOpenReference | null,
  openReferenceMethod:
    | "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE"
    | "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE"
    = "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE",
): ArenaOpenReferenceStore {
  return {
    load: vi.fn(async () => found),
    schedule: vi.fn(async () => ({
      roundId: item.roundId,
      symbols: ["LULU"],
      openReferenceMethod,
      s1SessionDate: "2026-08-31",
      s1OpenAt: "2026-08-31T13:30:00.000Z",
      s1ReferenceAvailableAt: "2026-08-31T13:32:00.000Z",
      s2SessionDate: "2026-09-01",
      s2OpenAt: "2026-09-01T13:30:00.000Z",
      s2ReferenceAvailableAt: "2026-09-01T13:32:00.000Z",
    })),
    persist: vi.fn(async () => existing),
  };
}

describe("Arena open-reference phase handler", () => {
  it("reuses the Round-shared evidence without a second provider request", async () => {
    const repository = store(existing);
    const fetchImplementation = vi.fn();
    const handler = createArenaOpenReferenceHandler({
      config, store: repository, fetchImplementation: fetchImplementation as never,
    });

    await expect(handler(item, new AbortController().signal)).resolves.toEqual({
      outcome: "SHARED_OPEN_REFERENCE_REUSED",
      referenceSnapshotId: existing.referenceSnapshotId,
      contentSha256: existing.contentSha256,
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(repository.persist).not.toHaveBeenCalled();
  });

  it("fetches the frozen first minute and persists it once", async () => {
    const repository = store(null);
    const body = JSON.stringify({
      bars: { LULU: [{
        t: "2026-08-31T13:30:00Z", o: 120.81, h: 121, l: 120,
        c: 120.9, v: 100, n: 10, vw: 120.8,
      }] },
      next_page_token: null,
    });
    const fetchImplementation = vi.fn(async (_request: string | URL | Request) => new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const handler = createArenaOpenReferenceHandler({
      config,
      store: repository,
      fetchImplementation: fetchImplementation as typeof fetch,
      now: () => new Date("2026-08-31T13:32:05.000Z"),
    });

    await expect(handler(item, new AbortController().signal)).resolves.toEqual({
      outcome: "SHARED_OPEN_REFERENCE_CAPTURED",
      referenceSnapshotId: existing.referenceSnapshotId,
      contentSha256: existing.contentSha256,
    });
    expect(repository.persist).toHaveBeenCalledWith(
      item.roundId,
      "S1_OPEN_REFERENCE",
      expect.objectContaining({
        sessionDate: "2026-08-31",
        expectedOpenAt: "2026-08-31T13:30:00.000Z",
      }),
    );
    expect(new URL(fetchImplementation.mock.calls[0]![0] as URL).searchParams
      .get("symbols")).toBe("LULU");
  });

  it("selects VWAP-volume normalization from the frozen Season rulebook", async () => {
    const repository = store(
      null,
      "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE",
    );
    const body = JSON.stringify({
      bars: { LULU: [{
        t: "2026-08-31T13:30:00Z", o: 120.81, h: 121, l: 120,
        c: 120.9, v: 100, n: 10, vw: 120.8,
      }] },
      next_page_token: null,
    });
    const handler = createArenaOpenReferenceHandler({
      config,
      store: repository,
      fetchImplementation: vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
      now: () => new Date("2026-08-31T13:32:05.000Z"),
    });

    await handler(item, new AbortController().signal);

    expect(repository.persist).toHaveBeenCalledWith(
      item.roundId,
      "S1_OPEN_REFERENCE",
      expect.objectContaining({
        method: "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE",
        references: [expect.objectContaining({
          value: "120.8",
          observedVolume: "100",
        })],
      }),
    );
  });
});
