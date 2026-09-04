import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ rpc: mocks.rpc })),
}));

import { SupabaseCorporateActionStore } from
  "../src/supabase-corporate-action-store.js";

const asOf = "2026-09-04T02:00:00.000Z";

describe("Supabase corporate-action active universe", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
  });

  it("loads the retirement-aware database contract", async () => {
    mocks.rpc.mockResolvedValue({
      error: null,
      data: {
        schema: "twofold.active_arena_season_symbols/v1",
        asOf,
        symbols: ["AAPL", "RCL"],
      },
    });
    const store = new SupabaseCorporateActionStore(
      "https://example.supabase.co", "service-secret", "worker:test",
    );

    await expect(store.activeSymbols(asOf)).resolves.toEqual(["AAPL", "RCL"]);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "get_active_arena_season_symbols",
      { p_as_of: asOf },
    );
  });

  it("rejects a malformed private symbol contract", async () => {
    mocks.rpc.mockResolvedValue({
      error: null,
      data: {
        schema: "twofold.active_arena_season_symbols/v1",
        asOf,
        symbols: ["AAPL", 7],
      },
    });
    const store = new SupabaseCorporateActionStore(
      "https://example.supabase.co", "service-secret", "worker:test",
    );

    await expect(store.activeSymbols(asOf)).rejects.toThrow(
      "active Arena Season symbols contains a non-string",
    );
  });

  it("surfaces database failures instead of scanning raw tables", async () => {
    mocks.rpc.mockResolvedValue({
      error: { message: "retirement projection unavailable" },
      data: null,
    });
    const store = new SupabaseCorporateActionStore(
      "https://example.supabase.co", "service-secret", "worker:test",
    );

    await expect(store.activeSymbols(asOf)).rejects.toThrow(
      "load active Arena Season symbols failed: retirement projection unavailable",
    );
  });
});
