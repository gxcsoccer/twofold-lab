import { describe, expect, it } from "vitest";

import { createDeterministicBaselinePolicy } from "@twofold/core";

import {
  buildBaselineDecisionInputs,
  computeMaxTargetDeltaBps,
} from "../src/arena-baseline-decision.js";
import type {
  ArenaMarketSnapshot,
  ArenaPortfolioState,
} from "../src/arena-inputs.js";
import type { ArenaRoundEntrantFence } from "../src/arena-repository.js";

const SNAPSHOT_ID = "e502936c-1c97-49d5-9351-deb16721cb5b";
const LULU_INSTRUMENT = "122dd8f9-709a-5652-a27c-a3b5c32755de";

const holdGenesis = createDeterministicBaselinePolicy({
  policyId: "hold-genesis",
  rule: "HOLD_GENESIS",
  symbol: null,
});

function bar(symbol: string, closePrice: string) {
  return {
    factId: `fact-${symbol}`,
    symbol,
    barStart: "2026-08-28T20:00:00.000Z",
    barDate: "2026-08-28",
    currency: "USD",
    openPrice: closePrice,
    highPrice: closePrice,
    lowPrice: closePrice,
    closePrice,
    volume: "1000000",
    tradeCount: "5000",
    vwap: closePrice,
    factSha256: "a".repeat(64),
  };
}

const snapshot: ArenaMarketSnapshot = {
  snapshotId: SNAPSHOT_ID,
  sourceVersionId: "11111111-1111-4111-8111-111111111111",
  manifestSha256: "b".repeat(64),
  cutoffAt: "2026-08-28T20:20:00.000Z",
  targetSessionDate: "2026-08-28",
  selectionPolicy: "latest_completed_session",
  sealedAt: "2026-08-28T20:30:00.000Z",
  symbols: ["AAPL", "LULU", "NVDA"],
  bars: [
    bar("AAPL", "230.00"),
    bar("LULU", "120.7911"),
    bar("NVDA", "180.50"),
  ],
};

function portfolio(input: {
  settled: string;
  positions: ArenaPortfolioState["positions"];
}): ArenaPortfolioState {
  return {
    schema: "twofold.strategy_portfolio_state/v1",
    strategyAccountId: "22222222-2222-4222-8222-222222222222",
    runId: "ce2caf2a-a4f5-58fc-8794-16abb3d369aa",
    asOf: "2026-08-29T21:20:32.000Z",
    account: {
      accountCode: "baseline-hold",
      broker: "futu",
      brokerRegion: "HK",
      baseCurrency: "USD",
      liveTrading: false,
    },
    ledgerHead: {
      sequence: "1",
      sha256: "c".repeat(64),
      accountingTransactionCount: "2",
      lotOriginCount: "1",
      acquisitionFxBindingCount: "1",
      settlementCount: "0",
      corporateActionMutationCount: "0",
    },
    cash: { settled: input.settled, taxReserve: "0", buyingPower: input.settled },
    positions: input.positions,
  };
}

const genesisPortfolio = portfolio({
  settled: "0",
  positions: [{
    instrumentId: LULU_INSTRUMENT,
    symbol: "LULU",
    quantity: "150",
    grossCost: "18000.00",
    taxBasis: "18000.00",
    currency: "USD",
    lotCount: "1",
  }],
});

const fence: ArenaRoundEntrantFence = {
  roundId: "d83eff85-da7b-5e07-81d6-d4feaf4d9839",
  roundIndex: "1",
  decisionId: "33333333-3333-4333-8333-333333333333",
  decisionAt: "2026-08-29T21:28:55.699Z",
  submissionDeadlineAt: "2026-08-31T13:15:00.000Z",
  roundEntryId: "44444444-4444-4444-8444-444444444444",
  seasonId: "1486ba8e-47ae-5774-ba44-5c26f9359eeb",
  entrantId: "55555555-5555-4555-8555-555555555555",
  runId: "ce2caf2a-a4f5-58fc-8794-16abb3d369aa",
  snapshotId: SNAPSHOT_ID,
};

function build(policy = holdGenesis, state = genesisPortfolio) {
  return buildBaselineDecisionInputs({
    policy,
    entrantCode: "baseline-hold-lulu",
    fence,
    snapshot,
    portfolioState: state,
    genesisSymbol: "LULU",
  });
}

describe("baseline decision inputs", () => {
  it("targets the genesis holding at full weight with no cash", () => {
    const built = build();
    expect(built.decision.targets).toEqual([
      { symbol: "LULU", targetWeightBps: "10000" },
    ]);
    expect(built.decision.cashWeightBps).toBe("0");
  });

  it("reports a zero reallocation for an already-converged hold", () => {
    expect(build().maxTargetDeltaBps).toBe("0");
  });

  it("binds the root execution id to the database baseline shape", () => {
    expect(build().identity.rootExecutionId).toBe(
      `baseline:hold-genesis:${fence.roundEntryId}`,
    );
    expect(build().identity.rootExecutionId).toMatch(
      /^baseline:[a-z0-9][a-z0-9-]{1,63}:/,
    );
  });

  it("rebuilds byte-identical artifacts for the same Round", () => {
    const first = build();
    const second = build();
    expect(second.packetArtifact.sha256).toBe(first.packetArtifact.sha256);
    expect(second.policyArtifact.sha256).toBe(first.policyArtifact.sha256);
    expect(second.identity.decisionPacketId).toBe(first.identity.decisionPacketId);
  });

  it("carries the frozen policy bytes as its own artifact", () => {
    const built = build();
    expect(built.policyArtifact.content).toBe(holdGenesis.policyCanonicalJson);
    expect(built.policyArtifact.sha256).toBe(holdGenesis.policySha256);
  });

  it("admits the decision on the same sealed snapshot", () => {
    const evidence = build().admissionEvidence;
    expect(evidence.guardAction).toBe("ALLOW");
    expect(evidence.evidenceSnapshotId).toBe(SNAPSHOT_ID);
    expect(evidence.decision.policyRef).toBe(
      `baseline-policy:${holdGenesis.policySha256}`,
    );
  });

  it("reports a full reallocation when a baseline switches instrument", () => {
    const built = build(createDeterministicBaselinePolicy({
      policyId: "all-in-nvda",
      rule: "ALL_IN_SYMBOL",
      symbol: "NVDA",
    }));
    expect(built.maxTargetDeltaBps).toBe("10000");
    expect(built.admissionEvidence.guardAction).toBe("ALLOW");
  });

  it("rejects a snapshot outside the Round fence", () => {
    expect(() => buildBaselineDecisionInputs({
      policy: holdGenesis,
      entrantCode: "baseline-hold-lulu",
      fence,
      snapshot: { ...snapshot, snapshotId: "99999999-9999-4999-8999-999999999999" },
      portfolioState: genesisPortfolio,
      genesisSymbol: "LULU",
    })).toThrow(/outside the Round fence/);
  });
});

describe("baseline target delta", () => {
  it("measures an all-in switch away from idle cash as a full reallocation", () => {
    const delta = computeMaxTargetDeltaBps({
      snapshot,
      portfolioState: portfolio({
        settled: "18118.66",
        positions: [{
          instrumentId: LULU_INSTRUMENT,
          symbol: "LULU",
          quantity: "150",
          grossCost: "18000.00",
          taxBasis: "18000.00",
          currency: "USD",
          lotCount: "1",
        }],
      }),
      targetSymbol: "LULU",
    });
    // Defaults to an all-in target, which would have to absorb the cash half.
    expect(delta).toBe("5000");
  });

  it("fails closed when the snapshot cannot mark a held position", () => {
    expect(() => computeMaxTargetDeltaBps({
      snapshot,
      portfolioState: portfolio({
        settled: "0",
        positions: [{
          instrumentId: LULU_INSTRUMENT,
          symbol: "TSLA",
          quantity: "10",
          grossCost: "1000.00",
          taxBasis: "1000.00",
          currency: "USD",
          lotCount: "1",
        }],
      }),
      targetSymbol: "LULU",
    })).toThrow(/cannot mark held position/);
  });

  it("refuses to weight an empty portfolio", () => {
    expect(() => computeMaxTargetDeltaBps({
      snapshot,
      portfolioState: portfolio({ settled: "0", positions: [] }),
      targetSymbol: "LULU",
    })).toThrow(/empty portfolio/);
  });
});

// Regression cover for the RPC contract fences the mocked-port tests missed.
describe("baseline decision RPC fences", () => {
  it("names the raw invocation decision id, which the accept RPC compares", () => {
    expect(build().admissionEvidence.decision.decisionRef).toBe(fence.decisionId);
  });

  it("takes observedAt from the Round fence, not from a clock", () => {
    const built = build();
    expect(built.identity.observedAt).toBe(fence.decisionAt);
    expect(built.admissionEvidence.observedAt).toBe(built.identity.observedAt);
  });

  it("rebuilds an identical decision on a later retry attempt", () => {
    // A Worker retry re-derives every value; nothing may drift with wall time,
    // or the RPCs reject the reopen as an idempotency key reused with
    // different content.
    expect(build().identity).toEqual(build().identity);
    expect(build().admissionEvidence.evidenceSha256)
      .toBe(build().admissionEvidence.evidenceSha256);
  });

  it("derives the submission id so a retry re-presents the same identity", () => {
    expect(build().identity.submissionId).toBe(build().identity.submissionId);
    expect(build().identity.submissionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("carries the snapshot manifest the invocation fence requires", () => {
    expect(build().identity.marketManifestSha256).toBe(snapshot.manifestSha256);
  });

  it("sizes the input-age ceiling to the Round window, not a fixed span", () => {
    const evidence = build().admissionEvidence;
    const windowMs = Date.parse(fence.submissionDeadlineAt)
      - Date.parse(snapshot.cutoffAt);
    expect(evidence.policy.maxInputAgeMs).toBe(String(windowMs));
    // ~65h here: a hard-coded 48h ceiling would have BLOCKed this decision.
    expect(windowMs).toBeGreaterThan(48 * 3600_000);
    expect(evidence.guardAction).toBe("ALLOW");
  });

  it("weights a fractional holding instead of failing the Round", () => {
    const delta = computeMaxTargetDeltaBps({
      snapshot,
      portfolioState: portfolio({
        settled: "0",
        positions: [{
          instrumentId: LULU_INSTRUMENT,
          symbol: "LULU",
          quantity: "150.500000000000",
          grossCost: "18000.00",
          taxBasis: "18000.00",
          currency: "USD",
          lotCount: "1",
        }],
      }),
      targetSymbol: "LULU",
    });
    expect(delta).toBe("0");
  });
});

describe("HOLD_GENESIS ledger fence", () => {
  it("refuses a config genesis symbol the account does not actually hold", () => {
    // season.openingSymbol is not covered by the policy SHA-256, so the durable
    // ledger is authoritative: editing it mid-Season must fail closed rather
    // than silently retargeting the baseline.
    expect(() => buildBaselineDecisionInputs({
      policy: holdGenesis,
      entrantCode: "baseline-hold-lulu",
      fence,
      snapshot,
      portfolioState: genesisPortfolio,
      genesisSymbol: "NVDA",
    })).toThrow(/do not match the declared genesis symbol/);
  });

  it("refuses a hold account that has drifted off a single holding", () => {
    expect(() => buildBaselineDecisionInputs({
      policy: holdGenesis,
      entrantCode: "baseline-hold-lulu",
      fence,
      snapshot,
      portfolioState: portfolio({
        settled: "0",
        positions: [
          ...genesisPortfolio.positions,
          {
            instrumentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            symbol: "AAPL",
            quantity: "10",
            grossCost: "2300.00",
            taxBasis: "2300.00",
            currency: "USD",
            lotCount: "1",
          },
        ],
      }),
      genesisSymbol: "LULU",
    })).toThrow(/do not match the declared genesis symbol/);
  });
});

describe("HOLD_GENESIS and cash dividends", () => {
  // A cash dividend credits settled cash. Targeting the position at the full
  // weight would spend it on more shares - dividend reinvestment, not holding.
  const afterDividend = portfolio({
    settled: "181.18",
    positions: [{
      instrumentId: LULU_INSTRUMENT,
      symbol: "LULU",
      quantity: "150",
      grossCost: "18000.00",
      taxBasis: "18000.00",
      currency: "USD",
      lotCount: "1",
    }],
  });

  it("keeps dividend cash instead of buying more shares with it", () => {
    const built = build(holdGenesis, afterDividend);
    const positionBps = BigInt(built.decision.targets[0]!.targetWeightBps);
    const cashBps = BigInt(built.decision.cashWeightBps);
    expect(cashBps).toBeGreaterThan(0n);
    expect(positionBps + cashBps).toBe(10000n);
  });

  it("reports the hold as a near-zero reallocation, not a rebalance", () => {
    // Only the bps flooring residue, so no whole-share order can result.
    expect(Number(build(holdGenesis, afterDividend).maxTargetDeltaBps))
      .toBeLessThanOrEqual(1);
  });

  it("still targets the full weight when the account holds no cash", () => {
    const built = build();
    expect(built.decision.targets[0]!.targetWeightBps).toBe("10000");
    expect(built.decision.cashWeightBps).toBe("0");
  });
});
