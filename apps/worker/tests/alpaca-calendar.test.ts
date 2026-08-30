import { describe, expect, it } from "vitest";

import {
  parseAlpacaCalendar,
  planTwoStageCycleCalendar,
} from "../src/alpaca-calendar.js";

const response = JSON.stringify([
  {
    close: "16:00",
    date: "2026-08-28",
    open: "09:30",
    session_close: "2000",
    session_open: "0400",
    settlement_date: "2026-08-31",
  },
  {
    close: "16:00",
    date: "2026-08-31",
    open: "09:30",
    session_close: "2000",
    session_open: "0400",
    settlement_date: "2026-09-01",
  },
  {
    close: "16:00",
    date: "2026-09-01",
    open: "09:30",
    session_close: "2000",
    session_open: "0400",
    settlement_date: "2026-09-02",
  },
]);

describe("Alpaca exchange calendar", () => {
  it("uses the next two real sessions and skips the weekend", () => {
    const sessions = parseAlpacaCalendar(response);
    const schedule = planTwoStageCycleCalendar("2026-08-28", sessions);

    expect(schedule).toEqual({
      schema: "twofold.two_stage_cycle_calendar/v1",
      decisionSessionDate: "2026-08-28",
      s1SessionDate: "2026-08-31",
      s1OpenAt: "2026-08-31T13:30:00.000Z",
      s1ReferenceAvailableAt: "2026-08-31T13:32:00.000Z",
      s1CloseAt: "2026-08-31T20:00:00.000Z",
      s1CloseAvailableAt: "2026-08-31T20:20:00.000Z",
      s2SessionDate: "2026-09-01",
      s2OpenAt: "2026-09-01T13:30:00.000Z",
      s2ReferenceAvailableAt: "2026-09-01T13:32:00.000Z",
      s2CloseAt: "2026-09-01T20:00:00.000Z",
      cycleReadyAt: "2026-09-01T20:20:00.000Z",
    });
  });

  it("handles the standard-time UTC offset without hard-coding DST", () => {
    const sessions = parseAlpacaCalendar(JSON.stringify([
      { date: "2026-11-27", open: "09:30", close: "13:00", settlement_date: "2026-11-30" },
      { date: "2026-11-30", open: "09:30", close: "16:00", settlement_date: "2026-12-01" },
      { date: "2026-12-01", open: "09:30", close: "16:00", settlement_date: "2026-12-02" },
    ]));
    const schedule = planTwoStageCycleCalendar("2026-11-27", sessions);
    expect(schedule.s1OpenAt).toBe("2026-11-30T14:30:00.000Z");
    expect(schedule.s1CloseAt).toBe("2026-11-30T21:00:00.000Z");
  });

  it("skips a session whose decision cutoff has already passed", () => {
    const sessions = parseAlpacaCalendar(JSON.stringify([
      { date: "2026-09-02", open: "09:30", close: "16:00", settlement_date: "2026-09-03" },
      { date: "2026-09-03", open: "09:30", close: "16:00", settlement_date: "2026-09-04" },
      { date: "2026-09-04", open: "09:30", close: "16:00", settlement_date: "2026-09-08" },
    ]));
    const schedule = planTwoStageCycleCalendar(
      "2026-09-01",
      sessions,
      { decisionAvailableAt: "2026-09-02T13:20:00.000Z" },
    );

    expect(schedule.s1SessionDate).toBe("2026-09-03");
    expect(schedule.s2SessionDate).toBe("2026-09-04");
  });

  it("fails closed on missing future sessions, duplicates, and malformed clocks", () => {
    const sessions = parseAlpacaCalendar(response);
    expect(() => planTwoStageCycleCalendar("2026-09-01", sessions))
      .toThrow("two future market sessions");
    expect(() => parseAlpacaCalendar(JSON.stringify([
      { date: "2026-08-31", open: "09:30", close: "16:00", settlement_date: "2026-09-01" },
      { date: "2026-08-31", open: "09:30", close: "16:00", settlement_date: "2026-09-01" },
    ]))).toThrow("strictly ordered");
    expect(() => parseAlpacaCalendar(JSON.stringify([
      { date: "2026-08-31", open: "9:30", close: "16:00", settlement_date: "2026-09-01" },
    ]))).toThrow("open");
  });
});
