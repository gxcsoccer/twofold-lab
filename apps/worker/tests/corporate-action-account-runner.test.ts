import { describe, expect, it, vi } from "vitest";

import {
  reconcileCorporateActionWork,
  type CorporateActionReconciliationClient,
} from "../src/corporate-action-account-runner.js";
import type {
  CorporateActionAccountWork,
  CorporateActionAccountWorkItem,
} from "../src/corporate-action-work-repository.js";

const ids = {
  account: "11111111-1111-4111-8111-111111111111",
  run: "22222222-2222-4222-8222-222222222222",
  season: "33333333-3333-4333-8333-333333333333",
  action: "44444444-4444-4444-8444-444444444444",
  instrument: "55555555-5555-4555-8555-555555555555",
  lot: "66666666-6666-4666-8666-666666666666",
  artifact: "77777777-7777-4777-8777-777777777777",
  fx: "88888888-8888-4888-8888-888888888888",
} as const;

function item(): CorporateActionAccountWorkItem {
  const acquisitionFx = {
    lotId: ids.lot,
    instrumentId: ids.instrument,
    effectiveDate: "2026-08-28",
    cnyPerUsd: "7.1234",
    acquisitionTaxBasisCny: "213702",
    authority: "ECB_REFERENCE_CROSS",
    sourceArtifactId: ids.artifact,
    sourceSha256: "f".repeat(64),
    observedAt: "2026-08-28T20:05:00.000Z",
    availableAt: "2026-08-28T20:06:00.000Z",
  };
  return {
    seasonId: ids.season,
    strategyAccountId: ids.account,
    runId: ids.run,
    sourceActionId: ids.action,
    revisionSha256: "a".repeat(64),
    actionType: "FORWARD_SPLIT",
    symbol: "LULU",
    instrumentId: ids.instrument,
    interpretation: "SPLIT",
    evidenceStatus: "COMPLETE",
    exDate: "2026-09-01",
    payableDate: null,
    exDateOpenAt: "2026-09-01T13:30:00.000Z",
    dueAt: "2026-09-01T13:30:00.000Z",
    observedAt: "2026-08-29T12:00:00.000Z",
    phase: "PREPARE",
    normalizedAction: {
      sourceActionId: ids.action,
      revisionSha256: "a".repeat(64),
      type: "FORWARD_SPLIT",
      symbol: "LULU",
      status: "COMPLETE",
      processDate: "2026-08-29",
      exDate: "2026-09-01",
      oldRate: "1",
      newRate: "2",
    },
    preparationId: null,
    preparationSha256: null,
    preparation: null,
    replayMaterial: {
      schema: "twofold.corporate_action_account_replay_material/v1",
      strategyAccountId: ids.account,
      runId: ids.run,
      portfolio: {
        schema: "twofold.strategy_portfolio_state/v1",
        strategyAccountId: ids.account,
        runId: ids.run,
        asOf: "2026-09-01T13:00:00.000Z",
        account: {
          accountCode: "arena:test", broker: "FUTU_HK", brokerRegion: "HK",
          baseCurrency: "USD", liveTrading: false,
        },
        ledgerHead: {
          sequence: "0", sha256: "b".repeat(64),
          accountingTransactionCount: "1", lotOriginCount: "1",
          acquisitionFxBindingCount: "1", settlementCount: "0",
          corporateActionMutationCount: "0",
        },
        cash: { settled: "0", taxReserve: "0", buyingPower: "0" },
        positions: [{
          instrumentId: ids.instrument, symbol: "LULU", quantity: "150",
          grossCost: "30000", taxBasis: "30000", currency: "USD", lotCount: "1",
        }],
      },
      genesis: {
        schema: "twofold.competition_economic_state/v1",
        genesisId: "runner:lulu-150",
        seasonId: ids.season,
        openingStateArtifactId: ids.artifact,
        snapshot: {
          snapshotId: "runner:lulu-150",
          schema: "twofold.initial_portfolio/v1",
          asOf: "2026-08-28T20:00:00.000Z",
          brokerLegalEntity: "FUTU_HK",
          accountRegion: "HK",
          baseCurrency: "USD",
          sourceArtifactSha256: "e".repeat(64),
          cashBalances: [],
          lots: [{
            lotId: ids.lot, instrumentId: ids.instrument, symbol: "LULU",
            acquiredOn: "2026-08-28", acquisitionSequence: "1",
            quantity: "150", purchasePricePerShare: "200",
            grossPurchasePrice: "30000", buyFees: "0", taxBasis: "30000",
            currency: "USD",
          }],
        },
        acquisitionFxBindings: [acquisitionFx],
      },
      priorCycles: [],
      priorCorporateActions: [],
      runStreamHead: {
        schema: "twofold.event_stream_head/v1",
        streamId: ids.run,
        streamType: "run",
        sequence: "5",
        lastEventId: null,
      },
    },
  };
}

describe("corporate-action account runner", () => {
  it("derives and commits exact post-split units in the pre-open window", async () => {
    const rpc = vi.fn(async (functionName: string, arguments_: any) => {
      if (functionName !== "register_corporate_action_account_preparation") {
        return { data: null, error: { message: "unexpected RPC" }, status: 500 };
      }
      const artifact = JSON.parse(arguments_.p_preparation_canonical_json);
      return {
        data: {
          schema: "twofold.corporate_action_account_preparation_result/v1",
          preparationId: arguments_.p_preparation_id,
          strategyAccountId: ids.account,
          runId: ids.run,
          sourceActionId: ids.action,
          revisionSha256: "a".repeat(64),
          actionType: "FORWARD_SPLIT",
          status: artifact.status,
          ledgerHeadSequence: "0",
          ledgerHeadSha256: "b".repeat(64),
          contentSha256: arguments_.p_content_sha256,
          capturedAt: arguments_.p_captured_at,
          sourceStreamSeq: "6",
        },
        error: null,
        status: 200,
      };
    });
    const client = { rpc } as CorporateActionReconciliationClient;
    const work: CorporateActionAccountWork = {
      schema: "twofold.corporate_action_account_work/v1",
      asOf: "2026-09-01T13:00:00.000Z",
      items: [item()],
    };
    const result = await reconcileCorporateActionWork(client, work, "worker:test");

    expect(result).toEqual({ prepared: "1", applied: "0", blocked: [] });
    const call = rpc.mock.calls[0]!;
    const artifact = JSON.parse(call[1].p_preparation_canonical_json);
    expect(artifact).toMatchObject({
      status: "PREPARED",
      material: {
        application: { position: { symbol: "LULU", quantity: "300", grossCost: "30000" } },
      },
    });
  });

  it("applies the frozen split exactly once and advances the account head", async () => {
    let preparationArguments: any = null;
    let applicationArguments: any = null;
    const rpc = vi.fn(async (functionName: string, arguments_: any) => {
      if (functionName === "register_corporate_action_account_preparation") {
        preparationArguments = arguments_;
        const artifact = JSON.parse(arguments_.p_preparation_canonical_json);
        return {
          data: {
            schema: "twofold.corporate_action_account_preparation_result/v1",
            preparationId: arguments_.p_preparation_id,
            strategyAccountId: ids.account,
            runId: ids.run,
            sourceActionId: ids.action,
            revisionSha256: "a".repeat(64),
            actionType: "FORWARD_SPLIT",
            status: artifact.status,
            ledgerHeadSequence: "0",
            ledgerHeadSha256: "b".repeat(64),
            contentSha256: arguments_.p_content_sha256,
            capturedAt: arguments_.p_captured_at,
            sourceStreamSeq: "6",
          },
          error: null,
          status: 200,
        };
      }
      if (functionName === "commit_corporate_action_account_application") {
        applicationArguments = arguments_;
        const artifact = JSON.parse(arguments_.p_application_canonical_json);
        return {
          data: {
            schema: "twofold.corporate_action_account_application_result/v1",
            applicationId: arguments_.p_application_id,
            preparationId: preparationArguments.p_preparation_id,
            strategyAccountId: ids.account,
            runId: ids.run,
            sourceActionId: ids.action,
            revisionSha256: "a".repeat(64),
            actionType: "FORWARD_SPLIT",
            status: artifact.status,
            openingHeadSequence: artifact.openingLedgerHead.sequence,
            openingHeadSha256: artifact.openingLedgerHead.sha256,
            finalHeadSequence: artifact.finalLedgerHead.sequence,
            finalHeadSha256: artifact.finalLedgerHead.sha256,
            mutationSha256: artifact.mutationSha256,
            contentSha256: arguments_.p_content_sha256,
            appliedAt: arguments_.p_applied_at,
            sourceStreamSeq: "7",
          },
          error: null,
          status: 200,
        };
      }
      return { data: null, error: { message: "unexpected RPC" }, status: 500 };
    });
    const client = { rpc } as CorporateActionReconciliationClient;
    const preparing = item();
    await reconcileCorporateActionWork(client, {
      schema: "twofold.corporate_action_account_work/v1",
      asOf: "2026-09-01T13:00:00.000Z",
      items: [preparing],
    }, "worker:test");
    const preparation = JSON.parse(preparationArguments.p_preparation_canonical_json);
    const applying: CorporateActionAccountWorkItem = {
      ...preparing,
      phase: "APPLY",
      preparationId: preparationArguments.p_preparation_id,
      preparationSha256: preparationArguments.p_content_sha256,
      preparation,
      replayMaterial: {
        ...preparing.replayMaterial,
        runStreamHead: {
          ...preparing.replayMaterial.runStreamHead,
          sequence: "6",
        },
      },
    };
    const result = await reconcileCorporateActionWork(client, {
      schema: "twofold.corporate_action_account_work/v1",
      asOf: "2026-09-01T13:01:00.000Z",
      items: [applying],
    }, "worker:test");

    expect(result).toEqual({ prepared: "0", applied: "1", blocked: [] });
    const artifact = JSON.parse(applicationArguments.p_application_canonical_json);
    expect(artifact).toMatchObject({
      status: "APPLIED",
      openingLedgerHead: { sequence: "0", sha256: "b".repeat(64) },
      finalLedgerHead: { sequence: "1" },
      positions: [{ instrumentId: ids.instrument, symbol: "LULU", quantity: "300" }],
      cash: { settled: "0", taxReserve: "0", buyingPower: "0" },
    });
    expect(artifact.mutationSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not guess across missed or unsupported evidence", async () => {
    const blockedItems = [
      { ...item(), phase: "MISSED_PREPARATION" as const },
      { ...item(), phase: "UNSUPPORTED" as const },
    ];
    const client = { rpc: vi.fn() } as unknown as CorporateActionReconciliationClient;
    const result = await reconcileCorporateActionWork(client, {
      schema: "twofold.corporate_action_account_work/v1",
      asOf: "2026-09-01T13:30:00.000Z",
      items: blockedItems,
    }, "worker:test");
    expect(result.blocked).toHaveLength(2);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("credits a payable dividend from frozen entitlement and shared policy evidence", async () => {
    let preparationArguments: any = null;
    let applicationArguments: any = null;
    const rpc = vi.fn(async (functionName: string, arguments_: any) => {
      if (functionName === "register_corporate_action_account_preparation") {
        preparationArguments = arguments_;
        const artifact = JSON.parse(arguments_.p_preparation_canonical_json);
        return {
          data: {
            schema: "twofold.corporate_action_account_preparation_result/v1",
            preparationId: arguments_.p_preparation_id,
            strategyAccountId: ids.account,
            runId: ids.run,
            sourceActionId: ids.action,
            revisionSha256: "a".repeat(64),
            actionType: "CASH_DIVIDEND",
            status: artifact.status,
            ledgerHeadSequence: "0",
            ledgerHeadSha256: "b".repeat(64),
            contentSha256: arguments_.p_content_sha256,
            capturedAt: arguments_.p_captured_at,
            sourceStreamSeq: "6",
          },
          error: null,
          status: 200,
        };
      }
      if (functionName === "commit_corporate_action_account_application") {
        applicationArguments = arguments_;
        const artifact = JSON.parse(arguments_.p_application_canonical_json);
        return {
          data: {
            schema: "twofold.corporate_action_account_application_result/v1",
            applicationId: arguments_.p_application_id,
            preparationId: preparationArguments.p_preparation_id,
            strategyAccountId: ids.account,
            runId: ids.run,
            sourceActionId: ids.action,
            revisionSha256: "a".repeat(64),
            actionType: "CASH_DIVIDEND",
            status: artifact.status,
            openingHeadSequence: artifact.openingLedgerHead.sequence,
            openingHeadSha256: artifact.openingLedgerHead.sha256,
            finalHeadSequence: artifact.finalLedgerHead.sequence,
            finalHeadSha256: artifact.finalLedgerHead.sha256,
            mutationSha256: artifact.mutationSha256,
            contentSha256: arguments_.p_content_sha256,
            appliedAt: arguments_.p_applied_at,
            sourceStreamSeq: "7",
          },
          error: null,
          status: 200,
        };
      }
      return { data: null, error: { message: "unexpected RPC" }, status: 500 };
    });
    const client = { rpc } as CorporateActionReconciliationClient;
    const preparing: CorporateActionAccountWorkItem = {
      ...item(),
      actionType: "CASH_DIVIDEND",
      interpretation: "CASH_DIVIDEND",
      payableDate: "2026-09-05",
      dueAt: "2026-09-05T13:30:00.000Z",
      normalizedAction: {
        sourceActionId: ids.action,
        revisionSha256: "a".repeat(64),
        type: "CASH_DIVIDEND",
        symbol: "LULU",
        status: "COMPLETE",
        processDate: "2026-08-29",
        exDate: "2026-09-01",
        recordDate: "2026-09-02",
        payableDate: "2026-09-05",
        rate: "1",
        foreign: false,
        special: false,
      },
    };
    await reconcileCorporateActionWork(client, {
      schema: "twofold.corporate_action_account_work/v1",
      asOf: "2026-09-01T13:00:00.000Z",
      items: [preparing],
    }, "worker:test");
    const preparation = JSON.parse(preparationArguments.p_preparation_canonical_json);
    const applying: CorporateActionAccountWorkItem = {
      ...preparing,
      phase: "APPLY",
      preparationId: preparationArguments.p_preparation_id,
      preparationSha256: preparationArguments.p_content_sha256,
      preparation,
      replayMaterial: {
        ...preparing.replayMaterial,
        runStreamHead: { ...preparing.replayMaterial.runStreamHead, sequence: "6" },
      },
    };
    const load = vi.fn(async () => ({
      currency: "USD" as const,
      instrumentKind: "common_stock" as const,
      issuerTaxResidenceCountry: "US",
      distributionClassification: "ordinary_dividend" as const,
      foreignWithholdingRate: "0.1",
      treatyOrLocalCapRate: "0.1",
      foreignTaxCreditEvidenceStatus: "EVIDENCE_PENDING" as const,
      fx: {
        fxRateId: ids.fx,
        sourceContentSha256: "c".repeat(64),
        baseCurrency: "USD",
        quoteCurrency: "CNY" as const,
        cnyPerBaseUnit: "7.142857142857",
        effectiveAt: "2026-09-04T00:00:00.000Z",
        visibleAt: "2026-09-05T13:31:00.000Z",
        status: "FINAL" as const,
      },
    }));
    const result = await reconcileCorporateActionWork(client, {
      schema: "twofold.corporate_action_account_work/v1",
      asOf: "2026-09-05T13:31:00.000Z",
      items: [applying],
    }, "worker:test", { dividendPolicy: { load } });

    expect(result).toEqual({ prepared: "0", applied: "1", blocked: [] });
    expect(load).toHaveBeenCalledWith(applying, expect.any(AbortSignal));
    const artifact = JSON.parse(applicationArguments.p_application_canonical_json);
    expect(artifact).toMatchObject({
      status: "APPLIED",
      positions: [{ instrumentId: ids.instrument, symbol: "LULU", quantity: "150" }],
      application: {
        grossDividend: "150",
        foreignWithholding: "15",
        netCash: "135",
        taxPolicy: {
          rulesetId: "cn_resident_direct_foreign_securities_strict_v1",
          fx: { fxRateId: ids.fx },
        },
      },
      cash: { settled: "135" },
    });
    expect(applicationArguments.p_applied_at).toBe("2026-09-05T13:31:00.000Z");
  });
});
