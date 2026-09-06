import { describe, expect, it, vi } from "vitest";
import { SupabaseArenaRepository } from "../src/arena-repository.js";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from }) }));

describe("market snapshot database boundary", () => {
  it("canonicalizes PostgREST offsets and microseconds before constructing immutable packets", async () => {
    const snapshot = { snapshot_id: "snapshot", source_version_id: "source",
      manifest_sha256: "a".repeat(64), cutoff_at: "2026-09-01T20:39:10.387+00:00",
      sealed_at: "2026-09-01T20:39:15.419546+00:00", target_session_date: "2026-09-01",
      selection_policy: "complete", symbols: ["LULU"] };
    from.mockImplementation((table: string) => {
      const data = table === "market_snapshot" ? snapshot
        : table === "market_snapshot_member" ? [{ symbol: "LULU", member_index: 0, fact_id: "fact" }]
        : [{ fact_id: "fact", symbol: "LULU", bar_start: "2026-09-01T04:00:00+00:00" }];
      const query: Record<string, unknown> = { then: (resolve: (r: unknown) => void) => resolve({ data, error: null }) };
      for (const method of ["select", "eq", "order", "in", "maybeSingle"]) query[method] = () => query;
      return query;
    });
    const result = await new SupabaseArenaRepository("https://test.invalid", "key", "worker").marketSnapshot("snapshot");
    expect(result.cutoffAt).toBe("2026-09-01T20:39:10.387Z");
    expect(result.sealedAt).toBe("2026-09-01T20:39:15.419Z");
    expect(result.bars[0]!.barStart).toBe("2026-09-01T04:00:00.000Z");
  });
});
