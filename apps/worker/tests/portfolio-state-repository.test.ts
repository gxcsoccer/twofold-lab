import { describe, expect, it, vi } from "vitest";

import {
  loadArenaPortfolioState,
  type StrategyPortfolioStateRpcClient,
} from "../src/portfolio-state-repository.js";

const runId = "72000000-0000-4000-8000-000000000001";
const accountId = "73000000-0000-4000-8000-000000000001";

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "twofold.strategy_portfolio_state/v1",
    strategyAccountId: accountId,
    runId,
    asOf: "2026-08-28T21:57:32.343Z",
    account: {
      accountCode: "private-controlled-lab-s1:twofold-orchestrator",
      broker: "TWOFOLD_PAPER",
      brokerRegion: "US",
      baseCurrency: "USD",
      liveTrading: false,
    },
    ledgerHead: {
      sequence: "0",
      sha256: "a".repeat(64),
      accountingTransactionCount: "1",
      lotOriginCount: "1",
      acquisitionFxBindingCount: "1",
      settlementCount: "0",
      corporateActionMutationCount: "0",
    },
    cash: {
      settled: "0",
      taxReserve: "0",
      buyingPower: "0",
    },
    positions: [{
      instrumentId: "74000000-0000-4000-8000-000000000001",
      symbol: "LULU",
      quantity: "150",
      grossCost: "18121.5",
      taxBasis: "18121.5",
      currency: "USD",
      lotCount: "1",
    }],
    ...overrides,
  };
}

function client(data: unknown): StrategyPortfolioStateRpcClient {
  return {
    rpc: vi.fn(async () => ({ data, error: null, status: 200 })),
  };
}

describe("strategy portfolio state repository", () => {
  it("loads an exact string-decimal account snapshot for a stable Run", async () => {
    const rpc = client(result());
    const state = await loadArenaPortfolioState(rpc, runId);

    expect(rpc.rpc).toHaveBeenCalledWith("get_strategy_portfolio_state", {
      p_run_id: runId,
    });
    expect(state).toMatchObject({
      runId,
      strategyAccountId: accountId,
      cash: { settled: "0", taxReserve: "0", buyingPower: "0" },
      positions: [{ symbol: "LULU", quantity: "150" }],
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.positions)).toBe(true);
    expect(Object.isFrozen(state.positions[0])).toBe(true);
  });

  it("rejects a response for a different Run", async () => {
    await expect(loadArenaPortfolioState(client(result({
      runId: "72000000-0000-4000-8000-000000000002",
    })), runId)).rejects.toThrow("different Run");
  });

  it("rejects JavaScript numeric tokens at the financial boundary", async () => {
    await expect(loadArenaPortfolioState(client(result({
      cash: { settled: 0, taxReserve: "0", buyingPower: "0" },
    })), runId)).rejects.toThrow("numeric token");
  });

  it("rejects inconsistent accounting counters and unsafe account state", async () => {
    await expect(loadArenaPortfolioState(client(result({
      ledgerHead: {
        sequence: "0",
        sha256: "a".repeat(64),
        accountingTransactionCount: "1",
        lotOriginCount: "2",
        acquisitionFxBindingCount: "1",
        settlementCount: "0",
        corporateActionMutationCount: "0",
      },
    })), runId)).rejects.toThrow("unbound acquisition FX lot");

    await expect(loadArenaPortfolioState(client(result({
      account: {
        accountCode: "private-controlled-lab-s1:twofold-orchestrator",
        broker: "TWOFOLD_PAPER",
        brokerRegion: "US",
        baseCurrency: "USD",
        liveTrading: true,
      },
    })), runId)).rejects.toThrow("live trading");
  });

  it("surfaces database failures without leaking request credentials", async () => {
    const failing: StrategyPortfolioStateRpcClient = {
      rpc: vi.fn(async () => ({
        data: null,
        error: { message: "strategy account is missing", code: "P0002" },
        status: 404,
      })),
    };
    await expect(loadArenaPortfolioState(failing, runId)).rejects.toThrow(
      "get_strategy_portfolio_state failed: strategy account is missing",
    );
  });
});
