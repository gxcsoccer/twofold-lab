import { describe, expect, it } from "vitest";

import { describeDeadlineBreach } from "./breach-alert";

const fence = "2026-08-31 18:00 EDT";

describe("deadline breach alert copy", () => {
  it("says work returned after the fence only for DEADLINE_EXPIRED_DURING_EXECUTION", () => {
    const copy = describeDeadlineBreach(
      { errorCode: "DEADLINE_EXPIRED_DURING_EXECUTION", deadlineAt: "2026-08-31T22:00:00.000Z" },
      null,
      () => fence,
    );
    expect(copy).toContain(`工作在 ${fence} 之后才返回，已记为失败`);
    expect(copy).toContain("本轮不再重试，也不会补发成交");
    expect(copy).toContain("该参赛者的账本逐字节保留，持仓不变。");
    expect(copy).not.toContain("按同一 S2 收盘估值结转");
    expect(copy).not.toContain("被扫过并取消");
  });

  it("describes a sweep-and-cancel, not a late return, for DEADLINE_EXPIRED", () => {
    const copy = describeDeadlineBreach(
      { errorCode: "DEADLINE_EXPIRED", deadlineAt: "2026-08-31T22:00:00.000Z" },
      null,
      () => fence,
    );
    expect(copy).toContain(`未领取的工作已在 ${fence} 被扫过并取消`);
    expect(copy).not.toContain("之后才返回");
    expect(copy).not.toContain("已记为失败");
  });

  it("claims S2 carry-forward only when no-trade work succeeded", () => {
    const item = {
      errorCode: "DEADLINE_EXPIRED_DURING_EXECUTION",
      deadlineAt: "2026-08-31T22:00:00.000Z",
    };
    const succeeded = describeDeadlineBreach(item, { status: "SUCCEEDED" }, () => fence);
    expect(succeeded).toContain("并按同一 S2 收盘估值结转");

    for (const status of ["REQUESTED", "CLAIMED", "FAILED"] as const) {
      const copy = describeDeadlineBreach(item, { status }, () => fence);
      expect(copy).not.toContain("并按同一 S2 收盘估值结转");
      expect(copy).toContain("该参赛者的账本逐字节保留，持仓不变");
    }
    expect(describeDeadlineBreach(item, { status: "REQUESTED" }, () => fence))
      .toContain("持仓结转仍在等待");
    expect(describeDeadlineBreach(item, { status: "CLAIMED" }, () => fence))
      .toContain("持仓结转仍在等待");
    expect(describeDeadlineBreach(item, { status: "FAILED" }, () => fence))
      .toContain("持仓结转失败");
  });

  it("does not invent a return-after when the error code is unknown", () => {
    const copy = describeDeadlineBreach(
      { errorCode: "WORKER_ABORTED", deadlineAt: null },
      null,
      () => fence,
    );
    expect(copy).toContain("该阶段越过冻结截止线");
    expect(copy).not.toContain("之后才返回");
    expect(copy).not.toContain(fence);
  });
});
