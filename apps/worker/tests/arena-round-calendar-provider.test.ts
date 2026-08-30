import { describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256 } from "../src/arena-inputs.js";
import {
  ExchangeCalendarProvider,
  type ExchangeCalendarArtifactRepository,
} from "../src/arena-round-calendar-provider.js";

const rawBody = JSON.stringify([
  { date: "2026-09-02", open: "09:30", close: "16:00", settlement_date: "2026-09-03" },
  { date: "2026-09-03", open: "09:30", close: "16:00", settlement_date: "2026-09-04" },
  { date: "2026-09-04", open: "09:30", close: "16:00", settlement_date: "2026-09-08" },
]);

const delivery = Object.freeze({
  schema: "twofold.alpaca_calendar_delivery/v1" as const,
  requestUrl: "https://api.alpaca.markets/v2/calendar?start=2026-09-01&end=2026-09-17",
  retrievedAt: "2026-09-03T12:00:00.000Z",
  responseSha256: sha256(rawBody),
  rawBody,
  sessions: Object.freeze([
    { date: "2026-09-02", open: "09:30", close: "16:00", settlementDate: "2026-09-03" },
    { date: "2026-09-03", open: "09:30", close: "16:00", settlementDate: "2026-09-04" },
    { date: "2026-09-04", open: "09:30", close: "16:00", settlementDate: "2026-09-08" },
  ]),
});

function repository(): ExchangeCalendarArtifactRepository {
  return {
    find: vi.fn(async () => null),
    download: vi.fn(async () => ""),
    upload: vi.fn(async () => undefined),
    register: vi.fn(async (input) => ({
      artifactId: "a1000000-0000-4000-8000-000000000001",
      sha256: input.sha256,
      storageBucket: input.storageBucket,
      objectPath: input.objectPath,
    })),
  };
}

const request = {
  seasonId: "a2000000-0000-4000-8000-000000000001",
  seasonCode: "private-controlled-lab-s1",
  roundIndex: "2",
  decisionSessionDate: "2026-09-01",
  decisionAvailableAt: "2026-09-02T13:20:00.000Z",
  calendarStartDate: "2026-09-01",
  calendarEndDate: "2026-09-17",
  recordedBy: "twofold-worker",
  signal: new AbortController().signal,
} as const;

describe("exchange-calendar Round provider", () => {
  it("freezes authoritative bytes and keys retries by the executable S1 date", async () => {
    const artifacts = repository();
    const provider = new ExchangeCalendarProvider({
      artifacts,
      fetchCalendar: vi.fn(async () => delivery),
    });

    const material = await provider.prepare(request);

    expect(material.schedule.s1SessionDate).toBe("2026-09-03");
    expect(artifacts.find).toHaveBeenCalledWith({
      seasonId: request.seasonId,
      idempotencyKey:
        "private-controlled-lab-s1:round:2:exchange-calendar:2026-09-03",
    });
    expect(artifacts.upload).toHaveBeenCalledWith(expect.objectContaining({
      objectPath: `arena/exchange-calendars/${material.calendarArtifactSha256}.json`,
      contentType: "application/json",
    }));
    expect(artifacts.register).toHaveBeenCalledWith(expect.objectContaining({
      seasonId: request.seasonId,
      sha256: material.calendarArtifactSha256,
      metadata: expect.objectContaining({
        decisionSessionDate: "2026-09-01",
        s1SessionDate: "2026-09-03",
      }),
    }));
  });

  it("reuses only exact canonical stored bytes", async () => {
    const artifacts = repository();
    const provider = new ExchangeCalendarProvider({
      artifacts,
      fetchCalendar: vi.fn(async () => delivery),
    });
    const first = await provider.prepare(request);
    const registered = vi.mocked(artifacts.register).mock.results[0]!.value;
    const row = await registered;
    const uploaded = vi.mocked(artifacts.upload).mock.calls[0]![0];
    vi.mocked(artifacts.find).mockResolvedValue(row);
    vi.mocked(artifacts.download).mockResolvedValue(uploaded.content);

    await expect(provider.prepare(request)).resolves.toEqual(first);
    expect(artifacts.register).toHaveBeenCalledTimes(1);

    vi.mocked(artifacts.download).mockResolvedValue(canonicalJson({ corrupt: "bytes" }));
    await expect(provider.prepare(request)).rejects.toThrow(
      "artifact bytes do not match metadata",
    );
  });
});
