import { describe, expect, it } from "vitest";

import { arenaDecisionTask } from "../src/arena-decision-task.js";

describe("Arena decision task", () => {
  it("keeps the root-only entrant's task byte-identical and delegation-free", () => {
    // `twofold` is the control arm: it submitted successfully in Round 3 of
    // private-us-liquid-100-s4 with exactly this text. Pinning the bytes keeps
    // a fix aimed at the orchestrated entrant from silently perturbing it.
    expect(arenaDecisionTask("ROOT_ONLY")).toBe(
      "完成这次真实、只读行情快照上的纸面组合决策。先读取绑定的 decision packet，"
      + "并以其中账本头、现金和持仓为唯一账户状态；在截止时间前提交且只提交一次目标权重。"
      + "不要虚构订单、成交、费用、税或 NAV。 这是 root-only 参赛者，不要委派子 Agent。",
    );
    expect(arenaDecisionTask("ROOT_ONLY")).not.toContain("subagent");
    expect(arenaDecisionTask("ROOT_ONLY")).not.toContain("DESCENDANT_REQUIRED");
  });

  it("orders the orchestrated entrant's tool calls ahead of its reasoning", () => {
    const task = arenaDecisionTask("ORCHESTRATED");
    const packet = task.indexOf("read_decision_packet");
    const subagent = task.indexOf("subagent");
    const submit = task.indexOf("submit_portfolio_targets");
    expect(packet).toBeGreaterThanOrEqual(0);
    expect(subagent).toBeGreaterThan(packet);
    expect(submit).toBeGreaterThan(subagent);
    expect(task).toContain("恰好一次");
    expect(task).not.toContain("可以");
  });

  it("names the frozen output ceiling and the admission fence that Round 3 hit", () => {
    // Round 3 spent all 16896 frozen output tokens on reasoning, never called
    // subagent or submit_portfolio_targets, and left the budget unspent. The
    // task has to say that reasoning is billed against the same ceiling and
    // that a childless submission is refused.
    const task = arenaDecisionTask("ORCHESTRATED");
    expect(task).toContain("输出 token");
    expect(task).toContain("reasoning");
    expect(task).toContain("DESCENDANT_REQUIRED");
  });

  it("still binds both entrants to the packet as the only account state", () => {
    for (const executionClass of ["ROOT_ONLY", "ORCHESTRATED"] as const) {
      const task = arenaDecisionTask(executionClass);
      expect(task).toContain("decision packet");
      expect(task).toContain("唯一账户状态");
      expect(task).toContain("不要虚构订单、成交、费用、税或 NAV");
    }
  });

  it("rejects an execution class the Arena Agent plane does not run", () => {
    expect(() => arenaDecisionTask("DETERMINISTIC_BASELINE" as never))
      .toThrow(/execution class/);
  });
});
