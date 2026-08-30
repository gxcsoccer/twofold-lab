import { describe, expect, it } from "vitest";

import { calculateVolumeParticipationLimit } from
  "../src/execution-liquidity.js";

describe("volume participation execution limit", () => {
  it("floors one entrant to the frozen share of observed minute volume", () => {
    expect(calculateVolumeParticipationLimit({
      requestedQuantity: "300",
      observedVolume: "25099",
      maxParticipationBps: "100",
    })).toEqual({
      requestedQuantity: "300",
      observedVolume: "25099",
      maxParticipationBps: "100",
      maximumFillQuantity: "250",
      canceledQuantity: "50",
      constrained: true,
    });
  });

  it("never inflates a small order merely because market capacity is larger", () => {
    expect(calculateVolumeParticipationLimit({
      requestedQuantity: "150",
      observedVolume: "500000",
      maxParticipationBps: "100",
    }).maximumFillQuantity).toBe("150");
  });

  it("does not invent a minimum fill when the participation share floors to zero", () => {
    expect(calculateVolumeParticipationLimit({
      requestedQuantity: "1",
      observedVolume: "99",
      maxParticipationBps: "100",
    })).toMatchObject({
      maximumFillQuantity: "0",
      canceledQuantity: "1",
      constrained: true,
    });
  });

  it("rejects non-canonical shares and participation above one hundred percent", () => {
    expect(() => calculateVolumeParticipationLimit({
      requestedQuantity: "01",
      observedVolume: "100",
      maxParticipationBps: "100",
    })).toThrow("requestedQuantity");
    expect(() => calculateVolumeParticipationLimit({
      requestedQuantity: "1",
      observedVolume: "1.5",
      maxParticipationBps: "100",
    })).toThrow("observedVolume");
    expect(() => calculateVolumeParticipationLimit({
      requestedQuantity: "1",
      observedVolume: "100",
      maxParticipationBps: "10001",
    })).toThrow("maxParticipationBps");
  });
});
