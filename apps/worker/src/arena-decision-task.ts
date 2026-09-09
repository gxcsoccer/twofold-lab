/**
 * The operator task message handed to one Arena entrant's root Session.
 *
 * The task is selected by execution class rather than by preset name because
 * execution class is what the admission fence enforces: an ORCHESTRATED
 * submission with no registered research subagent is refused with
 * DESCENDANT_REQUIRED, while a ROOT_ONLY entrant has no descendant budget at
 * all. The two trusted presets pair one-to-one with the two classes
 * (`twofold`/ROOT_ONLY, `twofold-orchestrator`/ORCHESTRATED), so keying on the
 * class keeps the instruction and the fence from ever disagreeing.
 *
 * Round 3 of private-us-liquid-100-s4 is why the orchestrated task prescribes
 * an order and names the ceiling. Its root spent all 16896 frozen output
 * tokens - every one of them reasoning - without calling `subagent` or
 * `submit_portfolio_targets` even once, so the round ended with no target while
 * the shared budget still had two provider requests and ~220k tokens left. A
 * task that only says which tools exist leaves the model free to reason itself
 * out of the turn; this one puts both tool calls before the long reasoning and
 * says why.
 */
export type ArenaDecisionExecutionClass = "ROOT_ONLY" | "ORCHESTRATED";

const COMMON =
  "完成这次真实、只读行情快照上的纸面组合决策。先读取绑定的 decision packet，"
  + "并以其中账本头、现金和持仓为唯一账户状态；在截止时间前提交且只提交一次目标权重。"
  + "不要虚构订单、成交、费用、税或 NAV。";

/** Unchanged control-arm wording: this entrant submits successfully today. */
const ROOT_ONLY_TASK = `${COMMON} 这是 root-only 参赛者，不要委派子 Agent。`;

const ORCHESTRATED_TASK = [
  COMMON,
  "工具调用顺序是硬约束：先调用 read_decision_packet；紧接着调用 subagent 恰好一次，"
  + "委派一个前台研究子 Agent 做一轮独立风险复核；它返回后只做简短综合，"
  + "随后立即调用 submit_portfolio_targets 提交唯一一份目标权重。",
  "本次 root 回合的输出 token 上限是冻结的，思考(reasoning)与正文共用这一个上限。"
  + "不要在上述两次工具调用之前展开长篇推理：先把 subagent 派出去、把目标权重提交上来，"
  + "要说明的内容写进 decision_summary。未注册研究子 Agent 的提交会被 DESCENDANT_REQUIRED 拒绝，"
  + "而本次决策最多只有一次纠正机会。",
].join("\n\n");

/**
 * @param executionClass - Registered execution class of the entrant seat.
 * @returns The task text for that class.
 */
export function arenaDecisionTask(
  executionClass: ArenaDecisionExecutionClass,
): string {
  switch (executionClass) {
    case "ORCHESTRATED":
      return ORCHESTRATED_TASK;
    case "ROOT_ONLY":
      return ROOT_ONLY_TASK;
    default:
      // Fail closed: a DETERMINISTIC_BASELINE seat has no Agent plane, and a
      // class added later must get its own task instead of silently inheriting
      // one written for a different fence.
      throw new TypeError("Arena execution class is unsupported");
  }
}
