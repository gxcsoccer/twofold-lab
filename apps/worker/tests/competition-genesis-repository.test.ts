import { createHash } from "node:crypto";

import { createCompetitionGenesis } from "@twofold/core";
import { describe, expect, it, vi } from "vitest";

import {
  initializeCompetitionStrategyAccountExact,
  type InitializeCompetitionStrategyAccountRpcArguments,
} from "../src/competition-genesis-repository.js";

const RUN_ID = "95000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "97000000-0000-4000-8000-000000000001";
const GENESIS_ROW_ID = "98000000-0000-8000-8000-000000000001";

function economicState() {
  return createCompetitionGenesis({
    schema: "twofold.competition_genesis/v1",
    genesisId: "season-one:lulu-150",
    seasonId: "91000000-0000-4000-8000-000000000001",
    asOf: "2026-08-28T21:00:00.000Z",
    brokerLegalEntity: "FUTU_HK",
    accountRegion: "HK",
    baseCurrency: "USD",
    openingStateArtifactId: "92000000-0000-4000-8000-000000000001",
    openingStateArtifactSha256: "a".repeat(64),
    cashBalances: [],
    lots: [{
      lotId: "lulu-genesis-lot",
      instrumentId: "93000000-0000-4000-8000-000000000001",
      symbol: "LULU",
      acquiredOn: "2026-08-28",
      quantity: "150",
      purchasePricePerShare: "318.5",
      buyFees: "0",
      currency: "USD",
      acquisitionFx: {
        effectiveDate: "2026-08-28",
        cnyPerUsd: "7.1234",
        authority: "ECB_REFERENCE_CROSS",
        sourceArtifactId: "94000000-0000-4000-8000-000000000001",
        sourceSha256: "b".repeat(64),
        observedAt: "2026-08-28T15:59:00.000Z",
        availableAt: "2026-08-28T16:00:00.000Z",
      },
    }],
    entrants: [{
      entrantId: "twofold",
      runId: RUN_ID,
      sourceEventId: "96000000-0000-4000-8000-000000000001",
    }],
  });
}

const genesis = economicState();
const arguments_ = Object.freeze({
  p_account_idempotency_key: "season-one:account:twofold",
  p_run_id: RUN_ID,
  p_account_code: "twofold",
  p_broker: "FUTU_HK",
  p_broker_region: "HK",
  p_economic_state_canonical_json: genesis.economicCanonicalJson,
  p_economic_state_sha256: genesis.economicSha256,
  p_recorded_by: "twofold-worker",
}) satisfies InitializeCompetitionStrategyAccountRpcArguments;

function result(overrides: Record<string, unknown> = {}) {
  return {
    schema: "twofold.competition_strategy_account_result/v1",
    strategyAccountId: ACCOUNT_ID,
    runId: RUN_ID,
    competitionGenesisId: GENESIS_ROW_ID,
    economicStateSha256: genesis.economicSha256,
    head: {
      schema: "twofold.strategy_ledger_head_result/v1",
      strategyAccountId: ACCOUNT_ID,
      headSequence: "0",
      headSha256: "c".repeat(64),
      lastSettlementId: null,
      accountingTransactionCount: "1",
      lotOriginCount: "1",
      acquisitionFxBindingCount: "1",
      settlementCount: "0",
      corporateActionMutationCount: "0",
      initializedBy: "twofold-worker",
      initializedAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("competition genesis repository", () => {
  it("retries an ambiguous atomic genesis with byte-identical arguments", async () => {
    const rpc = vi.fn()
      .mockRejectedValueOnce(new Error("connection closed after commit"))
      .mockResolvedValueOnce({ data: result(), error: null, status: 200 });

    await expect(initializeCompetitionStrategyAccountExact(
      { rpc } as any,
      arguments_,
    )).resolves.toMatchObject({
      strategyAccountId: ACCOUNT_ID,
      runId: RUN_ID,
      economicStateSha256: genesis.economicSha256,
      head: {
        accountingTransactionCount: "1",
        lotOriginCount: "1",
        acquisitionFxBindingCount: "1",
      },
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[1]).toBe(arguments_);
    expect(rpc.mock.calls[1]?.[1]).toBe(arguments_);
  });

  it("rejects a digest mismatch before a mutating RPC", async () => {
    const rpc = vi.fn();
    await expect(initializeCompetitionStrategyAccountExact(
      { rpc } as any,
      { ...arguments_, p_economic_state_sha256: "0".repeat(64) },
    )).rejects.toThrow("does not match exact economic-state bytes");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects numeric responses, identity drift, and unreconciled heads", async () => {
    const numericRpc = vi.fn().mockResolvedValue({
      data: result({ head: { ...result().head, lotOriginCount: 1 } }),
      error: null,
      status: 200,
    });
    await expect(initializeCompetitionStrategyAccountExact(
      { rpc: numericRpc } as any,
      arguments_,
    )).rejects.toThrow("numeric token");

    const driftRpc = vi.fn().mockResolvedValue({
      data: result({ runId: "95000000-0000-4000-8000-000000000002" }),
      error: null,
      status: 200,
    });
    await expect(initializeCompetitionStrategyAccountExact(
      { rpc: driftRpc } as any,
      arguments_,
    )).rejects.toThrow("inconsistent with the exact request");

    const headRpc = vi.fn().mockResolvedValue({
      data: result({
        head: { ...result().head, acquisitionFxBindingCount: "0" },
      }),
      error: null,
      status: 200,
    });
    await expect(initializeCompetitionStrategyAccountExact(
      { rpc: headRpc } as any,
      arguments_,
    )).rejects.toThrow("unbound acquisition FX lot");
  });

  it("uses the Core canonical bytes as the RPC digest boundary", () => {
    expect(createHash("sha256").update(
      arguments_.p_economic_state_canonical_json,
      "utf8",
    ).digest("hex")).toBe(arguments_.p_economic_state_sha256);
    expect(genesis.economicState.snapshot.lots[0]?.quantity).toBe("150");
  });
});
