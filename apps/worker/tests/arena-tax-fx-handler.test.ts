import { describe, expect, it, vi } from "vitest";

import {
  createArenaTaxFxHandler,
  type ArenaTaxFxStore,
} from "../src/arena-tax-fx-handler.js";
import type { ArenaRoundTaxFxReference } from "../src/arena-tax-fx-repository.js";
import type { EcbFxConfig } from "../src/ecb-fx.js";
import type { ArenaWorkItem } from "../src/arena-work-repository.js";

const item = {
  schema: "twofold.arena_work_item_result/v1",
  workItemId: "a1000000-0000-8000-8000-000000000001",
  roundEntryId: "a2000000-0000-8000-8000-000000000001",
  roundId: "a3000000-0000-4000-8000-000000000001",
  seasonId: "a4000000-0000-4000-8000-000000000001",
  entrantId: "a5000000-0000-4000-8000-000000000001",
  runId: "a6000000-0000-4000-8000-000000000001",
  phase: "CAPTURE_S1_CLOSE",
  predecessorWorkItemId: null,
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
  schema: "twofold.arena_round_tax_fx_reference/v1",
  roundId: item.roundId,
  seasonId: item.seasonId,
  stage: "S1_DISPOSITION",
  fxRateId: "a8000000-0000-8000-8000-000000000001",
  factId: "a9000000-0000-8000-8000-000000000001",
  sourceVersionId: "ecb-eurofxref-hist-90d-v1",
  sourceArtifactId: "aa000000-0000-4000-8000-000000000001",
  sourceContentSha256: "1".repeat(64),
  rawBodySha256: "2".repeat(64),
  baseCurrency: "USD",
  quoteCurrency: "CNY",
  cnyPerBaseUnit: "6.74",
  requestedSessionDate: "2026-08-31",
  effectiveAt: "2026-08-31T00:00:00.000Z",
  visibleAt: "2026-08-31T20:20:05.000Z",
  status: "ESTIMATED",
  authority: "ECB_REFERENCE_CROSS",
  crossSha256: "3".repeat(64),
  boundBy: "worker-1",
  boundAt: "2026-08-31T20:20:06.000Z",
} as const satisfies ArenaRoundTaxFxReference;

function store(found: ArenaRoundTaxFxReference | null): ArenaTaxFxStore {
  return {
    load: vi.fn(async (_roundId, stage) => found === null
      ? null
      : { ...found, stage }),
    schedule: vi.fn(async () => ({
      roundId: item.roundId,
      s1SessionDate: "2026-08-31",
      s1FxAvailableAt: "2026-08-31T20:20:00.000Z",
      s2SessionDate: "2026-09-01",
      s2FxAvailableAt: "2026-09-01T20:20:00.000Z",
    })),
    persist: vi.fn(async (_roundId, stage) => ({ ...existing, stage })),
  };
}

describe("Arena tax-FX close handler", () => {
  const config: EcbFxConfig = {
    sourceUrl: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml",
  };

  it("reuses one shared Round FX fact", async () => {
    const repository = store(existing);
    const fetchImplementation = vi.fn();
    const handler = createArenaTaxFxHandler({
      config, store: repository, fetchImplementation: fetchImplementation as never,
    });
    await expect(handler(item, new AbortController().signal)).resolves.toEqual({
      outcome: "SHARED_TAX_FX_REUSED",
      fxRateId: existing.fxRateId,
      crossSha256: existing.crossSha256,
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("uses the latest ECB publication on or before an S2 session holiday", async () => {
    const repository = store(null);
    const xml = `<Envelope><Cube><Cube time="2026-08-28">
      <Cube currency="USD" rate="1.16"/>
      <Cube currency="CNY" rate="7.82"/>
    </Cube></Cube></Envelope>`;
    const response = new Response(xml, {
      status: 200,
      headers: { "content-type": "application/xml" },
    });
    Object.defineProperty(response, "url", { value: config.sourceUrl });
    const handler = createArenaTaxFxHandler({
      config,
      store: repository,
      fetchImplementation: vi.fn(async () => response) as typeof fetch,
      now: () => new Date("2026-09-01T20:20:05.000Z"),
    });
    await handler({
      ...item,
      phase: "CAPTURE_S2_CLOSE",
      scheduledAt: "2026-09-01T20:20:00.000Z",
      deadlineAt: null,
    }, new AbortController().signal);
    expect(repository.persist).toHaveBeenCalledWith(
      item.roundId,
      "S2_ACQUISITION",
      expect.objectContaining({
        cross: expect.objectContaining({ effectiveDate: "2026-08-28" }),
      }),
    );
  });
});
