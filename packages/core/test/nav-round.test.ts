import { describe, expect, it } from "vitest";

import { decimal } from "../src/decimal.js";
import {
  calculateNavSnapshot,
  createRoundState,
  evaluateRoundClose,
  finalizeRoundAtSeasonEnd,
  type NavComponents,
  type RoundState,
} from "../src/nav-round.js";

const D1 = "2026-08-24";
const D2 = "2026-08-25";
const D3 = "2026-08-26";
const SEASON_1 = "season-2026-01";

function components(
  overrides: Partial<NavComponents> = {},
): NavComponents {
  return {
    currency: "USD",
    settledCash: decimal("100"),
    unsettledCash: decimal("0"),
    dividendReceivables: decimal("0"),
    otherRecognizedReceivables: decimal("0"),
    positionMarketValues: [],
    unpaidRealizedCapitalGainsTaxAccrual: decimal("0"),
    pendingDividendChinaTaxTopUp: decimal("0"),
    estimatedForeignWithholdingPayable: decimal("0"),
    otherUnpaidChinaTaxAccrual: decimal("0"),
    estimatedCloseFeesForAllPositions: decimal("0"),
    estimatedUnrealizedLiquidationTax: decimal("0"),
    ...overrides,
  };
}

function initialState(base = "100"): RoundState {
  return createRoundState({
    initialRoundBase: decimal(base),
    startsOn: D1,
  });
}

function close(
  state: RoundState,
  tradingDate: string,
  nextTradingDate: string,
  brokerNav: string,
  liquidationNav = brokerNav,
) {
  return evaluateRoundClose(state, {
    tradingDate,
    nextTradingDate,
    brokerNav: decimal(brokerNav),
    liquidationNav: decimal(liquidationNav),
  });
}

describe("three NAV calculations", () => {
  it("reconciles Broker, Tax-reserved and Liquidation NAV components", () => {
    const nav = calculateNavSnapshot(components({
      settledCash: decimal("50.25"),
      unsettledCash: decimal("-5.25"),
      dividendReceivables: decimal("2"),
      otherRecognizedReceivables: decimal("3"),
      positionMarketValues: [decimal("40"), decimal("60")],
      unpaidRealizedCapitalGainsTaxAccrual: decimal("10"),
      pendingDividendChinaTaxTopUp: decimal("2"),
      estimatedForeignWithholdingPayable: decimal("1"),
      otherUnpaidChinaTaxAccrual: decimal("2"),
      estimatedCloseFeesForAllPositions: decimal("3"),
      estimatedUnrealizedLiquidationTax: decimal("7"),
    }));

    expect(nav).toEqual({
      currency: "USD",
      positionMarketValue: "100",
      brokerNav: "150",
      taxReserveDeductions: "15",
      taxReservedNav: "135",
      liquidationDeductions: "10",
      liquidationNav: "125",
    });
  });

  it("keeps sub-cent and beyond-safe-integer values exact", () => {
    const nav = calculateNavSnapshot(components({
      settledCash: decimal("9007199254740993.00000001"),
      positionMarketValues: [decimal("0.00000002")],
      estimatedCloseFeesForAllPositions: decimal("0.00000001"),
    }));

    expect(nav.brokerNav).toBe("9007199254740993.00000003");
    expect(nav.liquidationNav).toBe("9007199254740993.00000002");
  });

  it("rejects negative deductions instead of increasing NAV", () => {
    expect(() => calculateNavSnapshot(components({
      unpaidRealizedCapitalGainsTaxAccrual: decimal("-20"),
    }))).toThrow("unpaidRealizedCapitalGainsTaxAccrual must be non-negative");
  });
});

describe("Round close state machine", () => {
  it("does not succeed at 1.9999x and only evaluates that close once", () => {
    const before = close(initialState(), D1, D2, "199.99");
    expect(before.event).toBeNull();
    expect(before.state.lastEvaluatedDate).toBe(D1);

    const retroactiveRetry = close(before.state, D1, D2, "199.99");
    expect(retroactiveRetry.event).toBeNull();
    expect(retroactiveRetry.state).toBe(before.state);
    expect(() => close(before.state, D1, D2, "200")).toThrow(
      "replayed with a different immutable payload",
    );

    const success = close(before.state, D2, D3, "200");
    expect(success.event).toMatchObject({
      type: "SUCCESS",
      roundBase: "100",
      liquidationNav: "200",
      nextRoundBase: "200",
      nextRoundStartsOn: D3,
    });
    expect(success.state.successCount).toBe("1");

    const replay = close(success.state, D2, D3, "200");
    expect(replay.event).toBeNull();
    expect(replay.state).toBe(success.state);
    expect(replay.state.failureCount).toBe("0");
    expect(() => close(success.state, D2, D3, "50")).toThrow(
      "replayed with a different immutable payload",
    );
  });

  it("fails exactly at 0.5x and retains the actual gap value as the new base", () => {
    const exactFailure = close(initialState(), D1, D2, "50");
    expect(exactFailure.event?.type).toBe("FAILURE");
    expect(exactFailure.state.roundBase).toBe("50");

    const gapSuccess = close(initialState(), D1, D2, "220");
    expect(gapSuccess.event?.type).toBe("SUCCESS");
    expect(gapSuccess.state.roundBase).toBe("220");
    expect(gapSuccess.event?.nextRoundBase).toBe("220");
  });

  it("records 100 -> 200 -> 100 as one success and one failure", () => {
    const first = close(initialState(), D1, D2, "200");
    const second = close(first.state, D2, D3, "100");

    expect([first.event?.type, second.event?.type]).toEqual([
      "SUCCESS",
      "FAILURE",
    ]);
    expect(second.state).toMatchObject({
      initialRoundBase: "100",
      roundBase: "100",
      successCount: "1",
      failureCount: "1",
    });
  });

  it("uses Liquidation NAV, not Broker NAV, for the success boundary", () => {
    const result = close(initialState(), D1, D2, "205", "198");

    expect(result.event).toBeNull();
    expect(result.state.successCount).toBe("0");
  });

  it.each(["0", "-1"])(
    "emits one RUIN terminal event at liquidation NAV %s",
    (liquidationNav) => {
      const ruin = close(initialState(), D1, D2, "10", liquidationNav);
      expect(ruin.event?.type).toBe("RUIN");
      expect(ruin.state).toMatchObject({
        status: "TERMINATED",
        failureCount: "1",
        successCount: "0",
      });

      const replay = close(ruin.state, D2, D3, "0", liquidationNav);
      expect(replay.event).toBeNull();
      expect(replay.state.failureCount).toBe("1");
    },
  );

  it("records only one success for a 100 -> 420 close", () => {
    const first = close(initialState(), D1, D2, "420");
    const sameClose = close(first.state, D1, D2, "420");

    expect(first.event?.type).toBe("SUCCESS");
    expect(first.state.roundBase).toBe("420");
    expect(sameClose.event).toBeNull();
    expect(sameClose.state.successCount).toBe("1");
  });

  it("rejects out-of-order close evaluation", () => {
    const evaluated = close(initialState(), D2, D3, "100");

    expect(() => close(evaluated.state, D1, D2, "100")).toThrow(
      "tradingDate must not precede lastEvaluatedDate",
    );
  });

  it("rejects impossible calendar dates and accepts a real leap day", () => {
    expect(() => createRoundState({
      initialRoundBase: decimal("100"),
      startsOn: "2026-02-29",
    })).toThrow("startsOn must be a real ISO calendar date");

    expect(createRoundState({
      initialRoundBase: decimal("100"),
      startsOn: "2028-02-29",
    }).roundStartsOn).toBe("2028-02-29");

    expect(() => evaluateRoundClose(initialState(), {
      tradingDate: "2026-04-31",
      nextTradingDate: "2026-05-01",
      brokerNav: decimal("100"),
      liquidationNav: decimal("100"),
    })).toThrow("tradingDate must be a real ISO calendar date");
  });

  it("fails closed when Liquidation NAV exceeds Broker NAV", () => {
    expect(() => close(initialState(), D1, D2, "100", "100.01")).toThrow(
      "liquidationNav must not exceed brokerNav",
    );
  });

  it("runtime-validates base, status and counters on supplied state", () => {
    expect(() => close({
      ...initialState(),
      roundBase: decimal("0"),
    }, D1, D2, "100")).toThrow(
      "RoundState.roundBase must be greater than zero",
    );

    expect(() => close({
      ...initialState(),
      status: "PAUSED",
    } as unknown as RoundState, D1, D2, "100")).toThrow(
      "RoundState.status must be ACTIVE or TERMINATED",
    );

    expect(() => close({
      ...initialState(),
      successCount: "01",
    } as unknown as RoundState, D1, D2, "100")).toThrow(
      "Invalid sequence string",
    );
  });
});

describe("Season end Round classification", () => {
  it("records a resolved open Round as INCOMPLETE without resetting it", () => {
    const state = close(initialState(), D2, D3, "100").state;
    const result = finalizeRoundAtSeasonEnd(state, {
      seasonId: SEASON_1,
      tradingDate: D2,
      resolution: "RESOLVED",
    });

    expect(result.outcome).toBe("INCOMPLETE");
    expect(result.event).toMatchObject({
      type: "INCOMPLETE",
      seasonId: SEASON_1,
      roundBase: "100",
    });
    expect(result.state).not.toBe(state);
    expect(result.state).toMatchObject({
      roundBase: "100",
      lastFinalizedSeasonId: SEASON_1,
      finalizedSeasonIds: [SEASON_1],
    });
  });

  it.each(["NAV_UNRESOLVED", "TAX_UNRESOLVED"] as const)(
    "classifies %s as UNRESOLVED instead of INCOMPLETE",
    (resolution) => {
      const result = finalizeRoundAtSeasonEnd(initialState(), {
        seasonId: SEASON_1,
        tradingDate: D2,
        resolution,
      });

      expect(result.outcome).toBe("UNRESOLVED");
      expect(result.event).toMatchObject({ type: "UNRESOLVED", resolution });
    },
  );

  it("does not create an incomplete zero-day Round after a final-close boundary", () => {
    const success = close(initialState(), D1, D2, "200");
    const result = finalizeRoundAtSeasonEnd(success.state, {
      seasonId: SEASON_1,
      tradingDate: D1,
      resolution: "RESOLVED",
    });

    expect(result).toMatchObject({
      outcome: "NO_OPEN_ROUND",
      event: null,
    });
  });

  it("does not emit a second event when the same Season is finalized again", () => {
    const evaluated = close(initialState(), D2, D3, "100").state;
    const first = finalizeRoundAtSeasonEnd(evaluated, {
      seasonId: SEASON_1,
      tradingDate: D2,
      resolution: "RESOLVED",
    });
    const replay = finalizeRoundAtSeasonEnd(first.state, {
      seasonId: SEASON_1,
      tradingDate: D2,
      resolution: "RESOLVED",
    });

    expect(replay).toEqual({
      state: first.state,
      outcome: "NO_OPEN_ROUND",
      event: null,
    });
    expect(() => finalizeRoundAtSeasonEnd(first.state, {
      seasonId: SEASON_1,
      tradingDate: D2,
      resolution: "TAX_UNRESOLVED",
    })).toThrow("replayed with a different immutable payload");
  });

  it("deduplicates an older Season even after a newer Season was finalized", () => {
    const evaluated = close(initialState(), D2, D3, "100").state;
    const first = finalizeRoundAtSeasonEnd(evaluated, {
      seasonId: SEASON_1,
      tradingDate: D2,
      resolution: "RESOLVED",
    });
    const second = finalizeRoundAtSeasonEnd(first.state, {
      seasonId: "season-2026-02",
      tradingDate: D3,
      resolution: "NAV_UNRESOLVED",
    });
    const oldReplay = finalizeRoundAtSeasonEnd(second.state, {
      seasonId: SEASON_1,
      tradingDate: D2,
      resolution: "RESOLVED",
    });

    expect(oldReplay).toEqual({
      state: second.state,
      outcome: "NO_OPEN_ROUND",
      event: null,
    });
    expect(second.state).toMatchObject({
      lastFinalizedSeasonId: "season-2026-02",
      finalizedSeasonIds: [SEASON_1, "season-2026-02"],
    });
  });

  it("requires the final resolved close to be evaluated before classification", () => {
    expect(() => finalizeRoundAtSeasonEnd(initialState(), {
      seasonId: SEASON_1,
      tradingDate: D2,
      resolution: "RESOLVED",
    })).toThrow(
      "A resolved Season end requires a Round close evaluation on tradingDate",
    );

    const laterClose = close(initialState(), D2, D3, "100").state;
    expect(() => finalizeRoundAtSeasonEnd(laterClose, {
      seasonId: SEASON_1,
      tradingDate: D1,
      resolution: "NAV_UNRESOLVED",
    })).toThrow("Season end tradingDate must not precede lastEvaluatedDate");
  });

  it("rejects an unsupported runtime resolution", () => {
    expect(() => finalizeRoundAtSeasonEnd(initialState(), {
      seasonId: SEASON_1,
      tradingDate: D2,
      resolution: "PARTIAL",
    } as never)).toThrow("resolution must be a supported Season end resolution");
  });
});
