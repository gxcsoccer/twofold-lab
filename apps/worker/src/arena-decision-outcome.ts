import { sanitizeFailureMessage } from "./failure-safety.js";
import type { ArenaDecisionStatus } from "./arena-types.js";

/**
 * A decision that ends without an accepted target still has to say WHY, because
 * the operator response differs per cause: a truncated root turn is a prompt or
 * ceiling problem, a rejected submit_portfolio_targets call is an Agent
 * reasoning problem, an exhausted budget is a cost problem, and a missed
 * deadline is a scheduling problem. Collapsing all of them into
 * NO_ACCEPTED_SUBMISSION - as Round 2 of private-us-liquid-100-s4 did for both
 * entrants at once - hides which one happened.
 *
 * The six ArenaDecisionStatus values stay as they are: they are a durable
 * projection contract read by the GUI. The discriminator is failureCode, whose
 * vocabulary is closed here, so a reader can branch on the cause without
 * parsing a human sentence. Both the code and the message pass through
 * sanitizeFailureMessage: a provider failure code is upstream text and may
 * quote a request URL carrying an ambient credential.
 */
export const ARENA_MAX_SUBMISSION_CORRECTIONS = 1;

/**
 * A corrective followup is worth spending only if the Agent can still read the
 * instruction, emit a submission and have it admitted. Below this the frozen
 * deadline would expire mid-turn and the retry would consume budget to produce
 * SUBMISSION_DEADLINE_EXCEEDED anyway.
 */
export const ARENA_MINIMUM_CORRECTION_MILLISECONDS = 15_000;

/**
 * Provider requests the submit-only correction needs: one root generation that
 * calls submit_portfolio_targets. Any run that is not already at its ceiling
 * has this much left, which is why the submit-only path asks for nothing beyond
 * the plain exhausted flag.
 */
export const ARENA_SUBMIT_CORRECTION_PROVIDER_REQUESTS = 1;

/**
 * Provider requests the subagent-then-submit correction needs.
 *
 * The Arena budget charges one shared provider request per model generation
 * anywhere in the tree, and that sequence is three of them: the root reads the
 * followup and calls `subagent`, the child answers, and only then can the root
 * read that tool result and call submit_portfolio_targets - a tool result never
 * turns into a tool call without another generation.
 *
 * Gating on less hands out an instruction the frozen budget cannot finish, and
 * ARENA_MAX_SUBMISSION_CORRECTIONS leaves no second try. Round 3 of
 * private-us-liquid-100-s4 is exactly that shape: its root spent two of four
 * requests before truncating, so a correction issued with two left would have
 * registered the child and then been denied ARENA_BUDGET_EXHAUSTED at the
 * submit generation - the one call the correction existed to obtain.
 *
 * Three is the minimum, not a comfortable margin: a child that needs two
 * generations of its own still runs out. Requiring more would refuse sequences
 * that can in fact complete, so this stays at what the runtime provably needs.
 */
export const ARENA_DESCENDANT_CORRECTION_PROVIDER_REQUESTS = 3;

/** Descendant slots the subagent-then-submit correction needs. */
export const ARENA_DESCENDANT_CORRECTION_DESCENDANTS = 1;

const MAX_FAILURE_CODE_LENGTH = 120;

/**
 * A rejection is correctable only when re-reading the same sealed packet could
 * legitimately produce an accepted submission. DECISION_CLOSED and every
 * admission verdict are excluded on purpose: the fence has already been
 * decided against this submission, and asking again would either be futile or
 * an attempt to talk past the guard.
 */
const CORRECTABLE_SUBMISSION_REJECTIONS: ReadonlySet<string> = new Set([
  "ROOT_SESSION_REQUIRED",
  "PACKET_FENCE_MISMATCH",
  "PORTFOLIO_POLICY_VIOLATION",
  "DESCENDANT_REQUIRED",
  "SUBMISSION_ARGUMENTS_INVALID",
  "SUBMISSION_TOOL_ERRORED",
]);

/** Longest tool-error text kept as a rejection reason. */
const MAX_TOOL_ERROR_REASON_LENGTH = 512;

export interface ArenaRootTurnEnd {
  readonly kind: string;
  readonly errorCode?: string | undefined;
  readonly errorMessage?: string | undefined;
  readonly abortKind?: string | undefined;
}

export interface ArenaSubmissionToolFailure {
  readonly code: string;
  readonly reason: string;
}

export interface ArenaDecisionFinishObservation {
  readonly acceptedSubmissionId: string | null;
  readonly providerBudgetDenied: boolean;
  readonly descendantBudgetDenied: boolean;
  readonly deadlineExceeded: boolean;
  readonly rootTurnEnd: ArenaRootTurnEnd | undefined;
  readonly submissionToolCalls: number;
  readonly submissionToolFailures: number;
  readonly lastSubmissionFailure: ArenaSubmissionToolFailure | null;
  readonly correctionsSpent: number;
  /**
   * An ORCHESTRATED root that never registered a research subagent. It does not
   * change how the finish is classified - a truncated turn is still
   * ROOT_OUTPUT_TRUNCATED - but it does change what the single correction has
   * to ask for, because submitting without a child is refused by admission.
   */
  readonly orchestratedDescendantMissing: boolean;
}

export interface ArenaDecisionOutcome {
  readonly status: ArenaDecisionStatus;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  /** Whether one bounded corrective followup could still change the outcome. */
  readonly correctable: boolean;
}

export function isCorrectableSubmissionRejection(code: string): boolean {
  return CORRECTABLE_SUBMISSION_REJECTIONS.has(code);
}

export function arenaDecisionFinishOutcome(
  observation: ArenaDecisionFinishObservation,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ArenaDecisionOutcome {
  const raw = classify(observation, environment);
  // Success is structural: it requires the durable accepted submission id, so
  // no classification path can report SUCCEEDED without one.
  if (raw.status === "SUCCEEDED" && observation.acceptedSubmissionId === null) {
    throw new TypeError("SUCCEEDED requires a durably accepted submission");
  }
  const budget = observation.correctionsSpent < ARENA_MAX_SUBMISSION_CORRECTIONS;
  return Object.freeze({
    status: raw.status,
    failureCode: raw.failureCode,
    failureMessage: raw.failureMessage,
    correctable: raw.correctable && budget,
  });
}

function classify(
  observation: ArenaDecisionFinishObservation,
  environment: Readonly<Record<string, string | undefined>>,
): ArenaDecisionOutcome {
  if (observation.acceptedSubmissionId !== null) {
    return outcome("SUCCEEDED", null, null, false);
  }

  // Frozen-fence causes outrank every softer one: a budget or deadline that has
  // already been spent cannot be re-entered, so the softer cause is a symptom.
  if (observation.providerBudgetDenied || observation.descendantBudgetDenied) {
    return outcome(
      "BUDGET_EXHAUSTED",
      "ARENA_BUDGET_EXHAUSTED",
      "The shared provider, token, cost, or descendant budget was exhausted",
      false,
    );
  }
  if (observation.deadlineExceeded) {
    return outcome(
      "FAILED",
      "SUBMISSION_DEADLINE_EXCEEDED",
      "The decision did not produce an accepted submission before its deadline",
      false,
    );
  }

  const turnEnd = observation.rootTurnEnd;
  if (turnEnd?.kind === "error") {
    return outcome(
      "FAILED",
      safeCode(turnEnd.errorCode, "AGENT_TURN_FAILED", environment),
      safeMessage(
        turnEnd.errorMessage,
        "The root Agent turn failed without a provider-supplied reason",
        environment,
      ),
      false,
    );
  }
  if (turnEnd?.kind === "aborted") {
    return outcome(
      "FAILED",
      "AGENT_ABORTED",
      `The root Agent was aborted (${turnEnd.abortKind ?? "unknown"})`,
      false,
    );
  }

  // A submit-tool failure is the most specific thing that can be said about a
  // missing submission, so it is reported ahead of how the turn happened to
  // end: Round 2's `twofold` entrant both failed the tool AND ended completed.
  if (observation.submissionToolFailures > 0) {
    const attempts =
      `${observation.submissionToolFailures} of ${observation.submissionToolCalls}`;
    const failure = observation.lastSubmissionFailure;
    if (failure === null) {
      return outcome(
        "FAILED",
        "SUBMISSION_TOOL_FAILED_WITHOUT_VERDICT",
        `submit_portfolio_targets failed on ${attempts} call(s) without a`
        + " structured verdict",
        false,
      );
    }
    const code = safeCode(failure.code, "SUBMISSION_TOOL_REJECTED", environment);
    return outcome(
      "FAILED",
      // Codes minted on the submission surface already say so; a gateway
      // verdict like PORTFOLIO_POLICY_VIOLATION needs the qualifier to state
      // where it was refused.
      code.startsWith("SUBMISSION_") ? code : `SUBMISSION_TOOL_REJECTED_${code}`,
      `submit_portfolio_targets failed on ${attempts} call(s); the last`
      + ` rejection was ${code}: ${safeMessage(
        failure.reason,
        "no reason was supplied",
        environment,
      )}`,
      isCorrectableSubmissionRejection(failure.code),
    );
  }

  if (turnEnd === undefined) {
    return outcome(
      "FAILED",
      "ROOT_TURN_END_UNOBSERVED",
      "The root Agent reached idle without an observed root turn end",
      false,
    );
  }
  switch (turnEnd.kind) {
    case "max-tokens":
      return outcome(
        "FAILED",
        "ROOT_OUTPUT_TRUNCATED",
        "The root Agent reached its frozen output-token ceiling before"
        + " submitting a target portfolio",
        true,
      );
    case "blocked":
      return outcome(
        "FAILED",
        "ROOT_TURN_BLOCKED",
        "The root Agent turn was blocked before it could submit a target"
        + " portfolio",
        false,
      );
    case "interrupted":
      return outcome(
        "FAILED",
        "ROOT_TURN_INTERRUPTED",
        "The root Agent turn was interrupted before it could submit a target"
        + " portfolio",
        false,
      );
    case "completed":
      // The only genuinely uninformative case left: the Agent had its turn,
      // spent no budget it was denied, hit no ceiling, and simply never called
      // the tool. That is what NO_ACCEPTED_SUBMISSION should have always meant.
      return outcome(
        "NO_ACCEPTED_SUBMISSION",
        "NO_ACCEPTED_SUBMISSION",
        "The root Agent completed its turn without calling"
        + " submit_portfolio_targets",
        true,
      );
    default:
      // TurnEndReasonMap is merge-extensible, so an unknown kind is a real
      // possibility after a Harness upgrade. Name it rather than silently
      // filing it under a cause it was never observed to be.
      return outcome(
        "FAILED",
        "ROOT_TURN_ENDED_UNRECOGNIZED",
        `The root Agent turn ended for an unrecognized reason (${
          safeCode(turnEnd.kind, "unknown", environment)
        })`,
        false,
      );
  }
}

function outcome(
  status: ArenaDecisionStatus,
  failureCode: string | null,
  failureMessage: string | null,
  correctable: boolean,
): ArenaDecisionOutcome {
  return Object.freeze({ status, failureCode, failureMessage, correctable });
}

function safeCode(
  code: string | undefined,
  fallback: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const safe = sanitizeFailureMessage(code ?? "", environment).trim();
  if (safe === "") return fallback;
  return safe.length <= MAX_FAILURE_CODE_LENGTH
    ? safe
    : safe.slice(0, MAX_FAILURE_CODE_LENGTH);
}

function safeMessage(
  message: string | undefined,
  fallback: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const safe = sanitizeFailureMessage(message ?? "", environment).trim();
  return safe === "" ? fallback : safe;
}

/**
 * Attribute every submit_portfolio_targets call to an outcome using only what
 * the Harness Session stream reports plus the gateway's own verdicts.
 *
 * Both halves are needed. defineTool validates arguments against the tool
 * schema and throws before the plugin body runs, so a JSON-number weight never
 * reaches the gateway and the gateway can never report it - only the isError
 * tool result proves it happened. Conversely a gateway rejection returns a
 * normal, non-error result, so the event stream alone cannot tell it from a
 * successful call. Round 2 of private-us-liquid-100-s4 hit the first case and
 * the decision was filed as "never submitted".
 */
export class ArenaSubmissionToolTracker {
  #calls = 0;
  #failures = 0;
  #lastFailure: ArenaSubmissionToolFailure | null = null;
  #verdicts = 0;
  /** Open submit calls mapped to the verdict count observed when they began. */
  readonly #open = new Map<string, number>();

  get calls(): number {
    return this.#calls;
  }

  get failures(): number {
    return this.#failures;
  }

  get lastFailure(): ArenaSubmissionToolFailure | null {
    return this.#lastFailure;
  }

  openCall(callId: string): void {
    if (this.#open.has(callId)) return;
    this.#calls += 1;
    this.#open.set(callId, this.#verdicts);
  }

  /** Record a verdict the gateway itself produced and durably persisted. */
  recordGatewayRejection(code: string, reason: string): void {
    this.#verdicts += 1;
    this.#lastFailure = Object.freeze({ code, reason });
  }

  /**
   * Close one observed submit call.
   * @returns The failure attributed to this call, or `null` when the call
   * succeeded or was never an open submit call.
   */
  closeCall(callId: string, input: {
    readonly accepted: boolean;
    readonly isError: boolean;
    readonly errorText?: string | undefined;
  }): ArenaSubmissionToolFailure | null {
    const verdictsAtOpen = this.#open.get(callId);
    if (verdictsAtOpen === undefined) return null;
    this.#open.delete(callId);
    if (input.accepted) return null;
    this.#failures += 1;
    // A verdict minted after this call opened belongs to it and is the most
    // specific description available. An older verdict belongs to a previous
    // call and must not be reused.
    if (this.#verdicts > verdictsAtOpen && this.#lastFailure !== null) {
      return this.#lastFailure;
    }
    const failure = Object.freeze(input.isError
      ? {
          code: "SUBMISSION_TOOL_ERRORED",
          reason: boundedReason(input.errorText),
        }
      : {
          code: "SUBMISSION_NOT_ACCEPTED",
          reason:
            "submit_portfolio_targets returned without a durably accepted target",
        });
    this.#lastFailure = failure;
    return failure;
  }
}

function boundedReason(text: string | undefined): string {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") {
    return "submit_portfolio_targets failed before the decision gateway was reached";
  }
  return trimmed.length <= MAX_TOOL_ERROR_REASON_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_TOOL_ERROR_REASON_LENGTH - 1)}…`;
}

export type ArenaSubmissionCorrection =
  | { readonly allowed: false; readonly reason: string }
  | { readonly allowed: true; readonly instruction: string };

/**
 * One followup, inside the fences that were already frozen. The correction
 * neither extends the deadline nor raises the budget - it only asks whether
 * what is left is enough to be worth using.
 */
export function arenaSubmissionCorrection(input: {
  readonly outcome: ArenaDecisionOutcome;
  readonly remainingMilliseconds: number;
  readonly budgetExhausted: boolean;
  /**
   * Taken from the finish observation. Omitted or false means the descendant
   * requirement is already satisfied or does not apply, so the correction asks
   * for the submission alone.
   */
  readonly orchestratedDescendantMissing?: boolean;
  /**
   * Provider requests the frozen shared budget can still reserve, counting the
   * whole Agent tree. Only the descendant-first path reads it, and an omitted
   * or unusable value is read as "not enough" rather than "plenty": spending
   * the single correction on a sequence the budget cannot finish is strictly
   * worse than not spending it.
   */
  readonly remainingProviderRequests?: number;
  /** Descendant slots the frozen budget can still reserve, same convention. */
  readonly remainingDescendants?: number;
}): ArenaSubmissionCorrection {
  if (!input.outcome.correctable || input.outcome.failureCode === null) {
    return Object.freeze({
      allowed: false,
      reason: "the failure cannot be corrected inside the frozen decision fence",
    });
  }
  if (input.budgetExhausted) {
    return Object.freeze({
      allowed: false,
      reason: "the frozen decision budget has no remaining headroom",
    });
  }
  if (
    !Number.isFinite(input.remainingMilliseconds)
    || input.remainingMilliseconds < ARENA_MINIMUM_CORRECTION_MILLISECONDS
  ) {
    return Object.freeze({
      allowed: false,
      reason: "the frozen submission deadline has no remaining headroom",
    });
  }
  if (input.orchestratedDescendantMissing === true) {
    // The descendant-first instruction is a three-generation sequence, so
    // "budget not already empty" is the wrong test for it. Refusing outright is
    // the only safe alternative: submit-only is not a fallback here, because a
    // root with no child is precisely what admission refuses with
    // DESCENDANT_REQUIRED.
    if (
      headroom(input.remainingProviderRequests)
        < ARENA_DESCENDANT_CORRECTION_PROVIDER_REQUESTS
    ) {
      return Object.freeze({
        allowed: false,
        reason: "the frozen decision budget cannot cover the"
          + " subagent-then-submit correction",
      });
    }
    if (
      headroom(input.remainingDescendants)
        < ARENA_DESCENDANT_CORRECTION_DESCENDANTS
    ) {
      return Object.freeze({
        allowed: false,
        reason: "the frozen descendant budget cannot cover the"
          + " subagent-then-submit correction",
      });
    }
  }
  return Object.freeze({
    allowed: true,
    instruction: correctionInstruction(
      input.outcome,
      input.orchestratedDescendantMissing === true,
    ),
  });
}

/** Unknown, fractional, or negative remaining headroom counts as none. */
function headroom(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

/**
 * Ask for exactly what admission is still missing.
 *
 * Round 3 of private-us-liquid-100-s4 is why the orchestrated branch exists: a
 * submit-only correction sent to a root that never spawned a child spends the
 * single retry producing DESCENDANT_REQUIRED, and ARENA_MAX_SUBMISSION_CORRECTIONS
 * leaves no second one. Neither branch relaxes the frozen budget or deadline.
 */
function correctionInstruction(
  outcome: ArenaDecisionOutcome,
  descendantMissing: boolean,
): string {
  return [
    `上一轮没有产生被接受的目标组合，原因代码 ${outcome.failureCode}：`,
    `${outcome.failureMessage ?? "无附加说明"}。`,
    "这是本次决策唯一一次纠正机会，截止时间与预算都不会因此放宽。",
    ...(descendantMissing
      ? [
          "本参赛者是编排型(ORCHESTRATED)且尚未注册研究子 Agent，"
          + "此时直接提交会被 DESCENDANT_REQUIRED 拒绝。",
          "请先调用 subagent 恰好一次做一轮简短的独立风险复核，调用前不要展开长篇推理，",
          "拿到子 Agent 结果后立即调用 submit_portfolio_targets 提交一次合规目标权重：",
        ]
      : ["请直接调用 submit_portfolio_targets 提交一次合规目标权重："]),
    "沿用同一个 decision packet 的 decision_packet_id 与 packet_sha256，",
    "所有 target_weight_bps 与 cash_weight_bps 之和必须正好是 10000，",
    "并给出非空的 decision_summary。不要虚构订单、成交、费用、税或 NAV。",
  ].join("\n");
}
