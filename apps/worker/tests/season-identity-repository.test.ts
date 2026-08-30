import { describe, expect, it, vi } from "vitest";

import {
  registerArenaSeasonExact,
  registerSeasonEntrantExact,
} from "../src/season-identity-repository.js";

const seasonArguments = Object.freeze({
  p_idempotency_key: "private-controlled-lab-s1",
  p_season_id: "a2000000-0000-4000-8000-000000000001",
  p_season_code: "private-controlled-lab-s1",
  p_display_name: "Private Controlled Lab S1",
  p_opens_at: "2026-08-28T21:00:00.000Z",
  p_closes_at: "2026-09-26T00:00:00.000Z",
  p_decision_cadence: "US_EQUITY_DAILY_AFTER_CLOSE" as const,
  p_market_timezone: "America/New_York" as const,
  p_config: { initialHolding: "150 LULU", openingCash: "0" },
  p_recorded_by: "twofold-worker",
});

const entrantArguments = Object.freeze({
  p_idempotency_key: "private-controlled-lab-s1:twofold-orchestrator",
  p_entrant_id: "a3000000-0000-4000-8000-000000000001",
  p_season_id: seasonArguments.p_season_id,
  p_entrant_code: "twofold-orchestrator",
  p_run_id: "a1000000-0000-4000-8000-000000000001",
  p_bundle_id: "twofold-orchestrator@0.1.0",
  p_bundle_sha256: "a".repeat(64),
  p_preset_id: "twofold-orchestrator",
  p_provider: "deepseek-official",
  p_model: "deepseek-v4-pro",
  p_execution_class: "ORCHESTRATED" as const,
  p_metadata: { track: "MAIN_ARENA" },
  p_recorded_by: "twofold-worker",
});

describe("Season identity repository", () => {
  it("retries Season registration with the exact same request", async () => {
    const row = {
      season_id: seasonArguments.p_season_id,
      idempotency_key: seasonArguments.p_idempotency_key,
      season_code: seasonArguments.p_season_code,
      display_name: seasonArguments.p_display_name,
      opens_at: seasonArguments.p_opens_at,
      closes_at: seasonArguments.p_closes_at,
      decision_cadence: seasonArguments.p_decision_cadence,
      market_timezone: seasonArguments.p_market_timezone,
      config: seasonArguments.p_config,
      recorded_by: seasonArguments.p_recorded_by,
      recorded_at: "2026-08-29T00:00:00.000Z",
    };
    const rpc = vi.fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce({ data: row, error: null, status: 200 });

    await expect(registerArenaSeasonExact(
      { rpc } as any,
      seasonArguments,
    )).resolves.toMatchObject({ seasonId: seasonArguments.p_season_id });
    expect(rpc.mock.calls[0]?.[1]).toBe(seasonArguments);
    expect(rpc.mock.calls[1]?.[1]).toBe(seasonArguments);
  });

  it("parses an entrant as one stable Season/Run/Bundle identity", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        entrant_id: entrantArguments.p_entrant_id,
        idempotency_key: entrantArguments.p_idempotency_key,
        season_id: entrantArguments.p_season_id,
        entrant_code: entrantArguments.p_entrant_code,
        run_id: entrantArguments.p_run_id,
        bundle_id: entrantArguments.p_bundle_id,
        bundle_sha256: entrantArguments.p_bundle_sha256,
        preset_id: entrantArguments.p_preset_id,
        provider: entrantArguments.p_provider,
        model: entrantArguments.p_model,
        execution_class: entrantArguments.p_execution_class,
        metadata: entrantArguments.p_metadata,
        recorded_by: entrantArguments.p_recorded_by,
        recorded_at: "2026-08-29T00:00:00.000Z",
      },
      error: null,
      status: 200,
    });

    await expect(registerSeasonEntrantExact(
      { rpc } as any,
      entrantArguments,
    )).resolves.toEqual({
      entrantId: entrantArguments.p_entrant_id,
      seasonId: entrantArguments.p_season_id,
      entrantCode: entrantArguments.p_entrant_code,
      runId: entrantArguments.p_run_id,
      bundleId: entrantArguments.p_bundle_id,
      bundleSha256: entrantArguments.p_bundle_sha256,
      presetId: entrantArguments.p_preset_id,
      provider: entrantArguments.p_provider,
      model: entrantArguments.p_model,
      executionClass: "ORCHESTRATED",
      recordedBy: "twofold-worker",
      recordedAt: "2026-08-29T00:00:00.000Z",
    });
  });

  it("rejects numeric config and returned identity drift before use", async () => {
    const rpc = vi.fn();
    await expect(registerArenaSeasonExact(
      { rpc } as any,
      { ...seasonArguments, p_config: { openingCash: 0 } },
    )).rejects.toThrow("numeric token");
    expect(rpc).not.toHaveBeenCalled();

    const drift = vi.fn().mockResolvedValue({
      data: {
        entrant_id: entrantArguments.p_entrant_id,
        idempotency_key: entrantArguments.p_idempotency_key,
        season_id: entrantArguments.p_season_id,
        entrant_code: entrantArguments.p_entrant_code,
        run_id: "a1000000-0000-4000-8000-000000000009",
        bundle_id: entrantArguments.p_bundle_id,
        bundle_sha256: entrantArguments.p_bundle_sha256,
        preset_id: entrantArguments.p_preset_id,
        provider: entrantArguments.p_provider,
        model: entrantArguments.p_model,
        execution_class: entrantArguments.p_execution_class,
        metadata: entrantArguments.p_metadata,
        recorded_by: entrantArguments.p_recorded_by,
        recorded_at: "2026-08-29T00:00:00.000Z",
      },
      error: null,
      status: 200,
    });
    await expect(registerSeasonEntrantExact(
      { rpc: drift } as any,
      entrantArguments,
    )).rejects.toThrow("inconsistent with the exact request");
  });
});
