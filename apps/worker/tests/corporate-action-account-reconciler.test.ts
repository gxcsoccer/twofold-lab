import { describe, expect, it, vi } from "vitest";

import {
  CorporateActionAccountReconciler,
  type CorporateActionAccountWorkSource,
} from "../src/corporate-action-account-reconciler.js";
import type { CorporateActionAccountWork } from
  "../src/corporate-action-work-repository.js";

const emptyWork: CorporateActionAccountWork = {
  schema: "twofold.corporate_action_account_work/v1",
  asOf: "2026-09-01T13:00:00.000Z",
  items: [],
};

describe("corporate-action account reconciler", () => {
  it("loads database-authoritative due work at the exact tick instant", async () => {
    const load = vi.fn(async () => emptyWork);
    const reconcile = vi.fn();
    const source: CorporateActionAccountWorkSource = { load };
    const runner = new CorporateActionAccountReconciler({
      recordedBy: "worker:test",
      source,
      reconcile,
      now: () => new Date("2026-09-01T13:00:00.000Z"),
    });

    await expect(runner.tick(new AbortController().signal)).resolves.toBe("idle");
    expect(load).toHaveBeenCalledWith("2026-09-01T13:00:00.000Z");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("completes mutations and leaves policy-blocked work to health alerts", async () => {
    const dueWork = {
      ...emptyWork,
      items: [{}],
    } as unknown as CorporateActionAccountWork;
    const reconcile = vi.fn()
      .mockResolvedValueOnce({ prepared: "1", applied: "0", blocked: [] })
      .mockResolvedValueOnce({
        prepared: "0",
        applied: "0",
        blocked: [{
          strategyAccountId: "11111111-1111-4111-8111-111111111111",
          sourceActionId: "22222222-2222-4222-8222-222222222222",
          reason: "UNSUPPORTED",
        }],
      });
    const runner = new CorporateActionAccountReconciler({
      recordedBy: "worker:test",
      source: { load: vi.fn(async () => dueWork) },
      reconcile,
      now: () => new Date("2026-09-01T13:00:00.000Z"),
    });

    await expect(runner.tick(new AbortController().signal)).resolves
      .toBe("completed");
    await expect(runner.tick(new AbortController().signal)).resolves.toBe("idle");
    expect(reconcile).toHaveBeenCalledWith(
      dueWork,
      "worker:test",
      expect.any(AbortSignal),
    );
  });

  it("turns transient reconciliation errors into a failed tick", async () => {
    const runner = new CorporateActionAccountReconciler({
      recordedBy: "worker:test",
      source: { load: vi.fn(async () => { throw new Error("database unavailable"); }) },
      reconcile: vi.fn(),
      now: () => new Date("2026-09-01T13:00:00.000Z"),
    });

    await expect(runner.tick(new AbortController().signal)).resolves.toBe("failed");
  });
});
