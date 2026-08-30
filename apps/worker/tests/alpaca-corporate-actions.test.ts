import { describe, expect, it, vi } from "vitest";

import {
  fetchAlpacaCorporateActions,
  type AlpacaCorporateActionConfig,
} from "../src/alpaca-corporate-actions.js";

const config: AlpacaCorporateActionConfig = {
  apiKeyId: "key-id",
  apiSecretKey: "secret-key",
  dataUrl: "https://data.alpaca.markets",
  symbols: ["LULU", "NVDA"],
  sourceVersionKey: "alpaca-corporate-actions-v1",
  sourceEffectiveFrom: "2024-01-01T00:00:00.000Z",
  licenseScope: "private-research",
};

function response(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Alpaca corporate-action scan", () => {
  it("normalizes complete split and dividend evidence without JSON numbers", async () => {
    const rawBody = `{
      "corporate_actions": {
        "cash_dividends": [{
          "cusip":"67066G104","ex_date":"2024-06-11","foreign":false,
          "id":"034a1fb6-d381-451f-aa76-ae3f1e151fed",
          "payable_date":"2024-06-28","process_date":"2024-06-28",
          "rate":0.010000000000000001,"record_date":"2024-06-11",
          "special":false,"symbol":"NVDA"
        }],
        "forward_splits": [{
          "cusip":"67066G104","due_bill_redemption_date":"2024-06-10",
          "ex_date":"2024-06-10",
          "id":"50199fac-0af8-43ef-9846-eaf64c6d322d",
          "new_rate":10,"old_rate":1,"payable_date":"2024-06-10",
          "process_date":"2024-06-10","record_date":"2024-06-07",
          "symbol":"NVDA"
        }]
      },
      "next_page_token": null
    }`;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(
        "https://data.alpaca.markets/v1/corporate-actions",
      );
      expect(url.searchParams.get("symbols")).toBe("LULU,NVDA");
      expect(url.searchParams.get("region")).toBe("us");
      expect(url.searchParams.get("data_quality")).toBe("all");
      expect(url.searchParams.get("types")).toBeNull();
      expect(new Headers(init?.headers).get("APCA-API-SECRET-KEY"))
        .toBe("secret-key");
      return response(rawBody);
    }) as typeof fetch;

    const scan = await fetchAlpacaCorporateActions(config, {
      processDateStart: "2024-05-01",
      processDateEnd: "2024-07-31",
      fetchImplementation: fetchMock,
      now: () => new Date("2024-07-31T21:00:00.000Z"),
    });

    expect(scan.actions).toEqual([
      expect.objectContaining({
        type: "FORWARD_SPLIT",
        sourceActionId: "50199fac-0af8-43ef-9846-eaf64c6d322d",
        status: "COMPLETE",
        exDate: "2024-06-10",
        oldRate: "1",
        newRate: "10",
      }),
      expect.objectContaining({
        type: "CASH_DIVIDEND",
        sourceActionId: "034a1fb6-d381-451f-aa76-ae3f1e151fed",
        status: "COMPLETE",
        rate: "0.010000000000000001",
        foreign: false,
        special: false,
      }),
    ]);
    expect(scan.pages).toHaveLength(1);
    expect(scan.pages[0]?.rawBody).toBe(rawBody);
    expect(scan.canonicalJson).not.toContain("secret-key");
    const parsed = JSON.parse(scan.canonicalJson) as unknown;
    expect(hasJsonNumber(parsed)).toBe(false);
  });

  it("follows every page and keeps one deterministic request fingerprint", async () => {
    const calls: URL[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      calls.push(url);
      if (calls.length === 1) {
        return response(`{
          "corporate_actions":{"forward_splits":[{
            "id":"50199fac-0af8-43ef-9846-eaf64c6d322d",
            "symbol":"NVDA","ex_date":"2024-06-10",
            "process_date":"2024-06-10","old_rate":1,"new_rate":10
          }]},"next_page_token":"page-2"
        }`);
      }
      return response(`{
        "corporate_actions":{"cash_dividends":[{
          "id":"034a1fb6-d381-451f-aa76-ae3f1e151fed",
          "symbol":"NVDA","ex_date":"2024-06-11",
          "process_date":"2024-06-28","rate":0.01,
          "foreign":false,"special":false
        }]},"next_page_token":null
      }`);
    }) as typeof fetch;

    const scan = await fetchAlpacaCorporateActions(config, {
      processDateStart: "2024-05-01",
      processDateEnd: "2024-07-31",
      fetchImplementation: fetchMock,
      now: () => new Date("2024-07-31T21:00:00.000Z"),
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.searchParams.get("page_token")).toBeNull();
    expect(calls[1]?.searchParams.get("page_token")).toBe("page-2");
    expect(scan.pages).toHaveLength(2);
    expect(scan.actions).toHaveLength(2);
    expect(scan.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("retains incomplete evidence so the competition can fail closed", async () => {
    const scan = await fetchAlpacaCorporateActions(config, {
      processDateStart: "2026-08-01",
      processDateEnd: "2026-09-30",
      fetchImplementation: vi.fn(async () => response(`{
        "corporate_actions":{"reverse_splits":[{
          "id":"50199fac-0af8-43ef-9846-eaf64c6d322d",
          "symbol":"LULU","process_date":"2026-08-29",
          "old_rate":10,"new_rate":1
        }]},"next_page_token":null
      }`)) as typeof fetch,
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    });

    expect(scan.actions[0]).toMatchObject({
      type: "REVERSE_SPLIT",
      status: "INCOMPLETE",
      exDate: null,
    });
  });

  it("uses the acquiree as the affected symbol for merger schemas", async () => {
    const scan = await fetchAlpacaCorporateActions(config, {
      processDateStart: "2026-07-01",
      processDateEnd: "2026-08-31",
      fetchImplementation: vi.fn(async () => response(`{
        "corporate_actions":{"stock_and_cash_mergers":[{
          "id":"602cb008-517f-458d-bf1c-b560f1502136",
          "acquiree_symbol":"SKYT","acquiree_rate":1,
          "acquirer_symbol":"IONQ","acquirer_rate":0.4883,
          "cash_rate":15,"effective_date":"2026-07-31",
          "payable_date":"2026-07-31","process_date":"2026-07-31"
        }]},"next_page_token":null
      }`)) as typeof fetch,
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    });

    expect(scan.actions).toEqual([expect.objectContaining({
      sourceActionId: "602cb008-517f-458d-bf1c-b560f1502136",
      type: "STOCK_AND_CASH_MERGER",
      symbol: "SKYT",
      interpretation: "UNSUPPORTED",
      status: "INCOMPLETE",
    })]);
  });

  it("rejects unknown provider collections and duplicate action identities", async () => {
    const run = (body: string) => fetchAlpacaCorporateActions(config, {
      processDateStart: "2026-08-01",
      processDateEnd: "2026-09-30",
      fetchImplementation: vi.fn(async () => response(body)) as typeof fetch,
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    });
    await expect(run(`{
      "corporate_actions":{"mystery_actions":[]},"next_page_token":null
    }`)).rejects.toThrow(/unknown corporate-action collection/i);
    await expect(run(`{
      "corporate_actions":{"forward_splits":[
        {"id":"50199fac-0af8-43ef-9846-eaf64c6d322d","symbol":"LULU",
         "ex_date":"2026-09-01","process_date":"2026-08-29",
         "old_rate":1,"new_rate":2},
        {"id":"50199fac-0af8-43ef-9846-eaf64c6d322d","symbol":"LULU",
         "ex_date":"2026-09-01","process_date":"2026-08-29",
         "old_rate":1,"new_rate":2}
      ]},"next_page_token":null
    }`)).rejects.toThrow(/duplicate corporate action/i);
  });
});

function hasJsonNumber(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.some(hasJsonNumber);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasJsonNumber);
  }
  return false;
}
