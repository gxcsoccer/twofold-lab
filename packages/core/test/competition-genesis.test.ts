import { describe, expect, it } from "vitest";

import { createCompetitionGenesis } from "../src/competition-genesis.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function input() {
  return {
    schema: "twofold.competition_genesis/v1" as const,
    genesisId: "season-one:lulu-150",
    seasonId: "91000000-0000-4000-8000-000000000001",
    asOf: "2026-08-28T21:00:00.000Z",
    brokerLegalEntity: "FUTU_HK",
    accountRegion: "HK",
    baseCurrency: "USD",
    openingStateArtifactId: "92000000-0000-4000-8000-000000000001",
    openingStateArtifactSha256: HASH_A,
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
        sourceSha256: HASH_B,
        observedAt: "2026-08-28T15:59:00.000Z",
        availableAt: "2026-08-28T16:00:00.000Z",
      },
    }],
    entrants: [
      {
        entrantId: "twofold-orchestrator",
        runId: "95000000-0000-4000-8000-000000000002",
        sourceEventId: "96000000-0000-4000-8000-000000000002",
      },
      {
        entrantId: "twofold",
        runId: "95000000-0000-4000-8000-000000000001",
        sourceEventId: "96000000-0000-4000-8000-000000000001",
      },
    ],
  };
}

describe("competition genesis", () => {
  it("clones one evidence-bound economic state into independent run ledgers", () => {
    const result = createCompetitionGenesis(input());

    expect(result.schema).toBe("twofold.competition_genesis_result/v1");
    expect(result.runs.map((run) => run.entrantId)).toEqual([
      "twofold",
      "twofold-orchestrator",
    ]);
    expect(result.economicState.snapshot.cashBalances).toEqual([]);
    expect(result.economicState.snapshot.lots).toMatchObject([{
      symbol: "LULU",
      quantity: "150",
      purchasePricePerShare: "318.5",
      grossPurchasePrice: "47775",
      buyFees: "0",
      taxBasis: "47775",
    }]);
    expect(result.economicState.acquisitionFxBindings).toMatchObject([{
      lotId: "lulu-genesis-lot",
      effectiveDate: "2026-08-28",
      cnyPerUsd: "7.1234",
      acquisitionTaxBasisCny: "340320.435",
    }]);

    for (const run of result.runs) {
      expect(run.ledger.transactionCount).toBe("1");
      expect(run.ledger.positions).toEqual([{
        accountId: "securities.inventory",
        instrumentId: "93000000-0000-4000-8000-000000000001",
        quantity: "150",
      }]);
      expect(run.ledger.balances.find(
        (balance) => balance.accountId === "asset.cash",
      )).toBeUndefined();
      expect(run.economicSha256).toBe(result.economicSha256);
    }

    expect(result.runs[0]?.openingTransactions[0]?.transactionId).not.toBe(
      result.runs[1]?.openingTransactions[0]?.transactionId,
    );
    expect(result.runs[0]?.instanceSha256).not.toBe(result.runs[1]?.instanceSha256);
  });

  it("is deterministic across entrant input order while preserving run isolation", () => {
    const first = createCompetitionGenesis(input());
    const reversedInput = input();
    reversedInput.entrants.reverse();
    const replay = createCompetitionGenesis(reversedInput);

    expect(replay.economicCanonicalJson).toBe(first.economicCanonicalJson);
    expect(replay.economicSha256).toBe(first.economicSha256);
    expect(replay.runs.map((run) => run.instanceCanonicalJson)).toEqual(
      first.runs.map((run) => run.instanceCanonicalJson),
    );
  });

  it("fails closed on unfair identities, unavailable FX, and numeric money", () => {
    const duplicateRun = input();
    duplicateRun.entrants[1]!.runId = duplicateRun.entrants[0]!.runId;
    expect(() => createCompetitionGenesis(duplicateRun)).toThrow("Duplicate runId");

    const duplicateEntrant = input();
    duplicateEntrant.entrants[1]!.entrantId = duplicateEntrant.entrants[0]!.entrantId;
    expect(() => createCompetitionGenesis(duplicateEntrant)).toThrow("Duplicate entrantId");

    const lateFx = input();
    lateFx.lots[0]!.acquisitionFx.availableAt = "2026-08-28T22:00:00.000Z";
    expect(() => createCompetitionGenesis(lateFx)).toThrow(
      "acquisition FX was unavailable at genesis",
    );

    const numericPrice = input() as unknown as {
      lots: Array<{ purchasePricePerShare: unknown }>;
    };
    numericPrice.lots[0]!.purchasePricePerShare = 318.5;
    expect(() => createCompetitionGenesis(numericPrice as never)).toThrow(
      "Decimal values must cross boundaries as strings",
    );
  });
});
