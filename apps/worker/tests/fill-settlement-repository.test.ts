import { describe, expect, it, vi } from "vitest";

import {
  getStrategyLedgerHeadExact,
  initializeStrategyLedgerHeadExact,
  isLedgerHeadConflict,
  settlePaperFillExact,
  type SettlePaperFillRpcArguments,
} from "../src/fill-settlement-repository.js";

const ACCOUNT_ID = "70000000-0000-4000-8000-000000000002";
const PLAN_ID = "74000000-0000-4000-8000-000000000001";
const EVIDENCE_ID = "75000000-0000-4000-8000-000000000001";
const FX_EVIDENCE_ID = "75000000-0000-4000-8000-000000000002";
const SETTLEMENT_ID = "76000000-0000-8000-8000-000000000001";
const TRANSACTION_ID = "77000000-0000-8000-8000-000000000001";
const LOT_ID = "78000000-0000-8000-8000-000000000001";
const HEAD_BEFORE = "a".repeat(64);
const HEAD_AFTER = "b".repeat(64);

const arguments_ = Object.freeze({
  p_idempotency_key: "settle:order-buy-lulu",
  p_strategy_account_id: ACCOUNT_ID,
  p_frozen_order_plan_id: PLAN_ID,
  p_order_id: "order-buy-lulu",
  p_execution_price_evidence_id: EVIDENCE_ID,
  p_tax_fx_rate_evidence_id: FX_EVIDENCE_ID,
  p_executed_at: "2026-08-26T13:30:00.000Z",
  p_settlement_date: "2026-08-27",
  p_expected_head_sequence: "4",
  p_expected_head_sha256: HEAD_BEFORE,
  p_recorded_by: "twofold-worker",
}) satisfies SettlePaperFillRpcArguments;

function filledResult(overrides: Record<string, unknown> = {}) {
  return {
    schema: "twofold.paper_fill_settlement_result/v1",
    settlement_id: SETTLEMENT_ID,
    idempotency_key: arguments_.p_idempotency_key,
    strategy_account_id: ACCOUNT_ID,
    frozen_order_plan_id: PLAN_ID,
    order_id: arguments_.p_order_id,
    stage: "S2",
    side: "BUY",
    outcome: "FILLED",
    execution_price_evidence_id: EVIDENCE_ID,
    tax_fx_rate_evidence_id: FX_EVIDENCE_ID,
    executed_at: arguments_.p_executed_at,
    settlement_date: arguments_.p_settlement_date,
    order_quantity: "8",
    fill_quantity: "8",
    canceled_quantity: "0",
    official_open_price: "120",
    fill_price: "120.06",
    gross_notional: "960.48",
    total_fees: "2.02",
    cash_effect: "962.5",
    tax_reserve_effect: "0",
    buying_power_before: "1000",
    frozen_buying_power_remaining_before: "1000",
    effective_buying_power_limit: "1000",
    buying_power_after: "37.5",
    accounting_transaction_id: TRANSACTION_ID,
    created_lot_origin_id: LOT_ID,
    pre_head_sequence: "4",
    pre_head_sha256: HEAD_BEFORE,
    post_head_sequence: "5",
    post_head_sha256: HEAD_AFTER,
    request_sha256: "c".repeat(64),
    recorded_by: arguments_.p_recorded_by,
    recorded_at: "2026-08-26T13:30:00.123Z",
    ...overrides,
  };
}

function headResult(overrides: Record<string, unknown> = {}) {
  return {
    schema: "twofold.strategy_ledger_head_result/v1",
    strategyAccountId: ACCOUNT_ID,
    headSequence: "0",
    headSha256: HEAD_BEFORE,
    lastSettlementId: null,
    accountingTransactionCount: "1",
    lotOriginCount: "0",
    acquisitionFxBindingCount: "0",
    settlementCount: "0",
    initializedBy: "twofold-worker",
    initializedAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("paper fill settlement repository", () => {
  it("retries an ambiguous settlement once with the exact same CAS request", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: "timeout" }, status: 504 })
      .mockResolvedValueOnce({ data: filledResult(), error: null, status: 200 });

    await expect(settlePaperFillExact({ rpc } as any, arguments_)).resolves.toMatchObject({
      outcome: "FILLED",
      fill_quantity: "8",
      pre_head_sequence: "4",
      post_head_sequence: "5",
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[1]).toBe(arguments_);
    expect(rpc.mock.calls[1]?.[1]).toBe(arguments_);
  });

  it("recovers a committed settlement after the first client promise rejects", async () => {
    const rpc = vi.fn()
      .mockRejectedValueOnce(new Error("connection closed after commit"))
      .mockResolvedValueOnce({ data: filledResult(), error: null, status: 200 });

    await expect(settlePaperFillExact(
      { rpc } as any,
      arguments_,
    )).resolves.toMatchObject({
      settlement_id: SETTLEMENT_ID,
      outcome: "FILLED",
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[1]).toBe(arguments_);
    expect(rpc.mock.calls[1]?.[1]).toBe(arguments_);
  });

  it("accepts a zero-fill cancellation without fabricating a journal or lot", async () => {
    const canceled = filledResult({
      outcome: "CANCELED_CASH_LIMIT",
      fill_quantity: "0",
      canceled_quantity: "8",
      gross_notional: "0",
      total_fees: "0",
      cash_effect: "0",
      buying_power_before: "0",
      frozen_buying_power_remaining_before: "1000",
      effective_buying_power_limit: "0",
      buying_power_after: "0",
      accounting_transaction_id: null,
      created_lot_origin_id: null,
      tax_fx_rate_evidence_id: null,
    });
    const rpc = vi.fn().mockResolvedValue({ data: canceled, error: null, status: 200 });

    await expect(settlePaperFillExact({ rpc } as any, arguments_)).resolves.toMatchObject({
      outcome: "CANCELED_CASH_LIMIT",
      fill_quantity: "0",
      accounting_transaction_id: null,
      tax_fx_rate_evidence_id: null,
    });

    const noFxArguments = Object.freeze({
      ...arguments_,
      p_tax_fx_rate_evidence_id: null,
    });
    const noFxRpc = vi.fn().mockResolvedValue({
      data: { ...canceled, tax_fx_rate_evidence_id: null },
      error: null,
      status: 200,
    });
    await expect(settlePaperFillExact(
      { rpc: noFxRpc } as any,
      noFxArguments,
    )).resolves.toMatchObject({
      outcome: "CANCELED_CASH_LIMIT",
      tax_fx_rate_evidence_id: null,
    });
  });

  it("rejects numeric JSON tokens and response identity drift", async () => {
    const numericRpc = vi.fn().mockResolvedValue({
      data: filledResult({ gross_notional: 960.48 }),
      error: null,
      status: 200,
    });
    await expect(settlePaperFillExact(
      { rpc: numericRpc } as any,
      arguments_,
    )).rejects.toThrow("numeric token");

    const driftRpc = vi.fn().mockResolvedValue({
      data: filledResult({ order_id: "other-order" }),
      error: null,
      status: 200,
    });
    await expect(settlePaperFillExact(
      { rpc: driftRpc } as any,
      arguments_,
    )).rejects.toThrow("inconsistent with the exact request");
  });

  it("rejects non-canonical uppercase UUIDs before a mutating RPC", async () => {
    const rpc = vi.fn();
    await expect(settlePaperFillExact(
      { rpc } as any,
      {
        ...arguments_,
        p_strategy_account_id: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
      },
    )).rejects.toThrow("canonical lowercase form");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not retry a deterministic ledger-head conflict and exposes it for refetch", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "40001", message: "ledger head changed" },
      status: 500,
    });

    const error = await settlePaperFillExact(
      { rpc } as any,
      arguments_,
    ).catch((candidate: unknown) => candidate);
    expect(isLedgerHeadConflict(error)).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects non-conserving quantities and malformed cancellation outcomes", async () => {
    const quantityRpc = vi.fn().mockResolvedValue({
      data: filledResult({ fill_quantity: "7" }),
      error: null,
      status: 200,
    });
    await expect(settlePaperFillExact(
      { rpc: quantityRpc } as any,
      arguments_,
    )).rejects.toThrow("quantities do not conserve");

    const fakeCancelRpc = vi.fn().mockResolvedValue({
      data: filledResult({
        outcome: "CANCELED_CASH_LIMIT",
        fill_quantity: "0",
        canceled_quantity: "8",
        tax_fx_rate_evidence_id: null,
      }),
      error: null,
      status: 200,
    });
    await expect(settlePaperFillExact(
      { rpc: fakeCancelRpc } as any,
      arguments_,
    )).rejects.toThrow("must not fabricate");

    const grossRpc = vi.fn().mockResolvedValue({
      data: filledResult({
        gross_notional: "960.47",
        cash_effect: "962.49",
        buying_power_after: "37.51",
      }),
      error: null,
      status: 200,
    });
    await expect(settlePaperFillExact(
      { rpc: grossRpc } as any,
      arguments_,
    )).rejects.toThrow("price times quantity");

    const taxRpc = vi.fn().mockResolvedValue({
      data: filledResult({ tax_reserve_effect: "1" }),
      error: null,
      status: 200,
    });
    await expect(settlePaperFillExact(
      { rpc: taxRpc } as any,
      arguments_,
    )).rejects.toThrow("tax-reserve effect");
  });

  it("initializes a string-only genesis head with one exact retry", async () => {
    const args = Object.freeze({
      p_strategy_account_id: ACCOUNT_ID,
      p_recorded_by: "twofold-worker",
    });
    const head = headResult();
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: "gateway" }, status: 503 })
      .mockResolvedValueOnce({ data: head, error: null, status: 200 });

    await expect(initializeStrategyLedgerHeadExact(
      { rpc } as any,
      args,
    )).resolves.toEqual(head);
    expect(rpc.mock.calls[0]?.[1]).toBe(args);
    expect(rpc.mock.calls[1]?.[1]).toBe(args);
  });

  it("rejects initialization response from a different audit principal", async () => {
    const args = Object.freeze({
      p_strategy_account_id: ACCOUNT_ID,
      p_recorded_by: "twofold-worker",
    });
    const rpc = vi.fn().mockResolvedValue({
      data: headResult({ initializedBy: "other-worker" }),
      error: null,
      status: 200,
    });

    await expect(initializeStrategyLedgerHeadExact(
      { rpc } as any,
      args,
    )).rejects.toThrow("different initializer");
  });

  it("reloads the authoritative head with string-only integrity counters", async () => {
    const args = Object.freeze({ p_strategy_account_id: ACCOUNT_ID });
    const head = headResult({
      headSequence: "1",
      lastSettlementId: SETTLEMENT_ID,
      accountingTransactionCount: "2",
      lotOriginCount: "1",
      acquisitionFxBindingCount: "1",
      settlementCount: "1",
      updatedAt: "2026-08-26T13:30:00.123Z",
    });
    const rpc = vi.fn().mockResolvedValue({ data: head, error: null, status: 200 });

    await expect(getStrategyLedgerHeadExact(
      { rpc } as any,
      args,
    )).resolves.toEqual(head);
    expect(rpc).toHaveBeenCalledWith("get_strategy_ledger_head", args);
  });

  it("rejects a ledger head whose counters cannot describe the CAS state", async () => {
    const args = Object.freeze({ p_strategy_account_id: ACCOUNT_ID });
    const rpc = vi.fn().mockResolvedValue({
      data: headResult({ lotOriginCount: "1" }),
      error: null,
      status: 200,
    });

    await expect(getStrategyLedgerHeadExact(
      { rpc } as any,
      args,
    )).rejects.toThrow("unbound acquisition FX lot");
  });
});
