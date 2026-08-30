import { describe, expect, it, vi } from "vitest";

import {
  loadCorporateActionAccountWork,
  type CorporateActionWorkRpcClient,
} from "../src/corporate-action-work-repository.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";

function response() {
  return {
    schema: "twofold.corporate_action_account_work/v1",
    asOf: "2026-08-29T12:00:01.000Z",
    items: [{
      seasonId: "33333333-3333-4333-8333-333333333333",
      strategyAccountId: accountId,
      runId,
      sourceActionId: "44444444-4444-4444-8444-444444444444",
      revisionSha256: "a".repeat(64),
      actionType: "FORWARD_SPLIT",
      symbol: "LULU",
      instrumentId: "55555555-5555-4555-8555-555555555555",
      interpretation: "SPLIT",
      evidenceStatus: "COMPLETE",
      exDate: "2026-09-01",
      payableDate: null,
      exDateOpenAt: "2026-09-01T13:30:00.000Z",
      dueAt: "2026-09-01T13:30:00.000Z",
      observedAt: "2026-08-29T12:00:00.000Z",
      phase: "PREPARE",
      normalizedAction: {
        sourceActionId: "44444444-4444-4444-8444-444444444444",
        revisionSha256: "a".repeat(64),
        type: "FORWARD_SPLIT",
        symbol: "LULU",
        oldRate: "1",
        newRate: "2",
        exDate: "2026-09-01",
        processDate: "2026-08-29",
        status: "COMPLETE",
      },
      preparationId: null,
      preparationSha256: null,
      preparation: null,
      replayMaterial: {
        schema: "twofold.corporate_action_account_replay_material/v1",
        strategyAccountId: accountId,
        runId,
        portfolio: {
          schema: "twofold.strategy_portfolio_state/v1",
          strategyAccountId: accountId,
          runId,
          asOf: "2026-08-29T11:59:00.000Z",
          account: {
            accountCode: "arena:test", broker: "TWOFOLD_PAPER",
            brokerRegion: "US", baseCurrency: "USD", liveTrading: false,
          },
          ledgerHead: {
            sequence: "0", sha256: "b".repeat(64),
            accountingTransactionCount: "1", lotOriginCount: "1",
            acquisitionFxBindingCount: "1", settlementCount: "0",
            corporateActionMutationCount: "0",
          },
          cash: { settled: "0", taxReserve: "0", buyingPower: "0" },
          positions: [{
            instrumentId: "55555555-5555-4555-8555-555555555555",
            symbol: "LULU", quantity: "150", grossCost: "30000",
            taxBasis: "30000", currency: "USD", lotCount: "1",
          }],
        },
        genesis: {},
        priorCycles: [],
        priorCorporateActions: [],
        runStreamHead: {
          schema: "twofold.event_stream_head/v1", streamId: runId,
          streamType: "run", sequence: "5", lastEventId: null,
        },
      },
    }],
  };
}

describe("corporate-action work repository", () => {
  it("loads exact account-scoped pre-open work without numeric tokens", async () => {
    const client: CorporateActionWorkRpcClient = {
      rpc: vi.fn(async () => ({ data: response(), error: null, status: 200 })),
    };
    const work = await loadCorporateActionAccountWork(
      client,
      "2026-08-29T12:00:01.000Z",
    );
    expect(work.items[0]).toMatchObject({
      phase: "PREPARE",
      symbol: "LULU",
      replayMaterial: { runStreamHead: { sequence: "5" } },
    });
    expect(client.rpc).toHaveBeenCalledWith("get_corporate_action_account_work", {
      p_as_of: "2026-08-29T12:00:01.000Z",
    });
  });

  it("rejects numeric tokens and database failures", async () => {
    const numeric = response();
    (numeric.items[0]!.replayMaterial.runStreamHead as Record<string, unknown>)
      .sequence = 5;
    await expect(loadCorporateActionAccountWork({
      rpc: vi.fn(async () => ({ data: numeric, error: null, status: 200 })),
    }, "2026-08-29T12:00:01.000Z")).rejects.toThrow(/numeric token/i);
    await expect(loadCorporateActionAccountWork({
      rpc: vi.fn(async () => ({
        data: null, error: { message: "work unavailable", code: "55000" }, status: 500,
      })),
    }, "2026-08-29T12:00:01.000Z")).rejects.toThrow("work unavailable");
  });
});
