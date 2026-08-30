import { describe, expect, it, vi } from "vitest";

import {
  CorporateActionScanner,
  type CorporateActionScanStore,
} from "../src/corporate-action-scanner.js";
import type { AlpacaCorporateActionConfig } from
  "../src/alpaca-corporate-actions.js";

const config: AlpacaCorporateActionConfig = {
  apiKeyId: "key-id",
  apiSecretKey: "secret-key",
  dataUrl: "https://data.alpaca.markets",
  symbols: ["LULU"],
  sourceVersionKey: "alpaca-corporate-actions-v1",
  sourceEffectiveFrom: "2026-08-01T00:00:00.000Z",
  licenseScope: "private-research",
};

const emptyBody = JSON.stringify({
  corporate_actions: {},
  next_page_token: null,
});

describe("corporate-action scanner cadence", () => {
  it("scans immediately, then no more often than the frozen cadence", async () => {
    let now = new Date("2026-08-29T12:00:00.000Z");
    const persist = vi.fn(async (_scan: unknown) => ({ scanId: "scan-1" }));
    const store: CorporateActionScanStore = {
      latestObservedAt: async () => null,
      activeSymbols: async () => ["AAPL", "LULU"],
      persist,
    };
    const fetchImplementation = vi.fn(async (_request: string | URL | Request) => new Response(emptyBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const scanner = new CorporateActionScanner({
      config,
      store,
      scanIntervalMs: 15 * 60 * 1_000,
      lookbackDays: 45,
      horizonDays: 45,
      fetchImplementation: fetchImplementation as typeof fetch,
      now: () => now,
    });

    await expect(scanner.tick(new AbortController().signal)).resolves
      .toBe("completed");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      processDateStart: "2026-07-15",
      processDateEnd: "2026-10-13",
      observedAt: "2026-08-29T12:00:00.000Z",
      actions: [],
    });
    expect(new URL(fetchImplementation.mock.calls[0]![0] as URL).searchParams
      .get("symbols")).toBe("AAPL,LULU");

    now = new Date("2026-08-29T12:14:59.999Z");
    await expect(scanner.tick(new AbortController().signal)).resolves.toBe("idle");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    now = new Date("2026-08-29T12:15:00.000Z");
    await expect(scanner.tick(new AbortController().signal)).resolves
      .toBe("completed");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("reports a failed scan and retries after one minute without advancing cadence", async () => {
    let now = new Date("2026-08-29T12:00:00.000Z");
    const persist = vi.fn();
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(emptyBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const scanner = new CorporateActionScanner({
      config,
      store: {
        latestObservedAt: async () => null,
        activeSymbols: async () => ["LULU"],
        persist,
      },
      scanIntervalMs: 15 * 60 * 1_000,
      lookbackDays: 45,
      horizonDays: 45,
      retryIntervalMs: 60_000,
      fetchImplementation,
      now: () => now,
    });

    await expect(scanner.tick(new AbortController().signal)).resolves.toBe("failed");
    now = new Date("2026-08-29T12:00:59.999Z");
    await expect(scanner.tick(new AbortController().signal)).resolves.toBe("idle");
    now = new Date("2026-08-29T12:01:00.000Z");
    await expect(scanner.tick(new AbortController().signal)).resolves
      .toBe("completed");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("keeps the frozen cadence across serverless cold starts", async () => {
    let now = new Date("2026-08-29T12:00:00.000Z");
    let latestObservedAt: string | null = null;
    const store: CorporateActionScanStore = {
      latestObservedAt: vi.fn(async () => latestObservedAt),
      activeSymbols: async () => ["LULU"],
      persist: vi.fn(async (scan) => {
        latestObservedAt = scan.observedAt;
      }),
    };
    const fetchImplementation = vi.fn(async () => new Response(emptyBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const createScanner = () => new CorporateActionScanner({
      config,
      store,
      scanIntervalMs: 15 * 60 * 1_000,
      lookbackDays: 45,
      horizonDays: 45,
      fetchImplementation,
      now: () => now,
    });

    await expect(createScanner().tick(new AbortController().signal)).resolves
      .toBe("completed");
    now = new Date("2026-08-29T12:14:59.999Z");
    await expect(createScanner().tick(new AbortController().signal)).resolves
      .toBe("idle");
    now = new Date("2026-08-29T12:15:00.000Z");
    await expect(createScanner().tick(new AbortController().signal)).resolves
      .toBe("completed");

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(store.latestObservedAt).toHaveBeenCalledTimes(3);
  });
});
