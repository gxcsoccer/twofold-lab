import { describe, expect, it } from "vitest";

import {
  ARENA_MAX_SUBMISSION_CORRECTIONS,
  ArenaSubmissionToolTracker,
  arenaDecisionFinishOutcome,
  arenaSubmissionCorrection,
  isCorrectableSubmissionRejection,
  type ArenaDecisionFinishObservation,
} from "../src/arena-decision-outcome.js";

const idle: ArenaDecisionFinishObservation = Object.freeze({
  acceptedSubmissionId: null,
  providerBudgetDenied: false,
  descendantBudgetDenied: false,
  deadlineExceeded: false,
  rootTurnEnd: { kind: "completed" },
  submissionToolCalls: 0,
  submissionToolFailures: 0,
  lastSubmissionFailure: null,
  correctionsSpent: 0,
  orchestratedDescendantMissing: false,
});

function observe(
  overrides: Partial<ArenaDecisionFinishObservation>,
): ArenaDecisionFinishObservation {
  return Object.freeze({ ...idle, ...overrides });
}

describe("Arena decision finish taxonomy", () => {
  it("only reports success when a durable accepted submission exists", () => {
    const accepted = arenaDecisionFinishOutcome(observe({
      acceptedSubmissionId: "11111111-1111-4111-8111-111111111111",
    }));
    expect(accepted).toEqual({
      status: "SUCCEEDED",
      failureCode: null,
      failureMessage: null,
      correctable: false,
    });

    // Every hostile combination without an accepted id must stay non-success.
    const flags = [true, false];
    const kinds = [
      undefined,
      { kind: "completed" },
      { kind: "max-tokens" },
      { kind: "blocked" },
      { kind: "interrupted" },
      { kind: "aborted", abortKind: "hook" },
      { kind: "error", errorCode: "PROVIDER_DOWN", errorMessage: "gone" },
      { kind: "some-future-harness-kind" },
    ] as const;
    for (const providerBudgetDenied of flags) {
      for (const descendantBudgetDenied of flags) {
        for (const deadlineExceeded of flags) {
          for (const rootTurnEnd of kinds) {
            for (const submissionToolCalls of [0, 1, 3]) {
              const outcome = arenaDecisionFinishOutcome(observe({
                providerBudgetDenied,
                descendantBudgetDenied,
                deadlineExceeded,
                rootTurnEnd,
                submissionToolCalls,
                submissionToolFailures: submissionToolCalls,
                lastSubmissionFailure: submissionToolCalls === 0
                  ? null
                  : { code: "PORTFOLIO_POLICY_VIOLATION", reason: "weights" },
              }));
              expect(outcome.status).not.toBe("SUCCEEDED");
              expect(outcome.failureCode).not.toBeNull();
              expect(outcome.failureMessage).not.toBeNull();
            }
          }
        }
      }
    }
  });

  it("separates output truncation from a legitimate non-submission", () => {
    expect(arenaDecisionFinishOutcome(observe({
      rootTurnEnd: { kind: "max-tokens" },
    }))).toEqual({
      status: "FAILED",
      failureCode: "ROOT_OUTPUT_TRUNCATED",
      failureMessage:
        "The root Agent reached its frozen output-token ceiling before submitting a target portfolio",
      correctable: true,
    });

    expect(arenaDecisionFinishOutcome(idle)).toEqual({
      status: "NO_ACCEPTED_SUBMISSION",
      failureCode: "NO_ACCEPTED_SUBMISSION",
      failureMessage:
        "The root Agent completed its turn without calling submit_portfolio_targets",
      correctable: true,
    });
  });

  it("names the submit-tool rejection instead of collapsing it to no submission", () => {
    const rejected = arenaDecisionFinishOutcome(observe({
      submissionToolCalls: 1,
      submissionToolFailures: 1,
      lastSubmissionFailure: {
        code: "PORTFOLIO_POLICY_VIOLATION",
        reason: "target weights plus cash_weight_bps must total exactly 10000 (got 9999)",
      },
    }));
    expect(rejected.status).toBe("FAILED");
    expect(rejected.failureCode).toBe("SUBMISSION_TOOL_REJECTED_PORTFOLIO_POLICY_VIOLATION");
    expect(rejected.failureMessage).toContain("1 of 1");
    expect(rejected.failureMessage).toContain("must total exactly 10000");
    expect(rejected.correctable).toBe(true);

    const unattributed = arenaDecisionFinishOutcome(observe({
      submissionToolCalls: 2,
      submissionToolFailures: 2,
      lastSubmissionFailure: null,
    }));
    expect(unattributed.status).toBe("FAILED");
    expect(unattributed.failureCode).toBe("SUBMISSION_TOOL_FAILED_WITHOUT_VERDICT");
    expect(unattributed.failureMessage).toContain("2 of 2");
    expect(unattributed.correctable).toBe(false);
  });

  it("keeps a closed decision and an invalid admission out of the correctable set", () => {
    expect(isCorrectableSubmissionRejection("PORTFOLIO_POLICY_VIOLATION")).toBe(true);
    expect(isCorrectableSubmissionRejection("SUBMISSION_ARGUMENTS_INVALID")).toBe(true);
    expect(isCorrectableSubmissionRejection("SUBMISSION_TOOL_ERRORED")).toBe(true);
    expect(isCorrectableSubmissionRejection("PACKET_FENCE_MISMATCH")).toBe(true);
    expect(isCorrectableSubmissionRejection("ROOT_SESSION_REQUIRED")).toBe(true);
    expect(isCorrectableSubmissionRejection("DESCENDANT_REQUIRED")).toBe(true);
    expect(isCorrectableSubmissionRejection("DECISION_CLOSED")).toBe(false);
    expect(isCorrectableSubmissionRejection("ADMISSION_GUARD_BLOCKED")).toBe(false);
    expect(isCorrectableSubmissionRejection("ADMISSION_EVIDENCE_INVALID")).toBe(false);
    expect(isCorrectableSubmissionRejection("SUBMISSION_NOT_ACCEPTED")).toBe(false);
    expect(isCorrectableSubmissionRejection("GATEWAY_NOT_BOUND")).toBe(false);
    expect(isCorrectableSubmissionRejection("anything-unknown")).toBe(false);
  });

  it("does not double-prefix a code that already names the submission surface", () => {
    expect(arenaDecisionFinishOutcome(observe({
      submissionToolCalls: 1,
      submissionToolFailures: 1,
      lastSubmissionFailure: {
        code: "SUBMISSION_ARGUMENTS_INVALID",
        reason: "targets[0].target_weight_bps must be a string",
      },
    }))).toMatchObject({
      status: "FAILED",
      failureCode: "SUBMISSION_ARGUMENTS_INVALID",
      correctable: true,
    });
    expect(arenaDecisionFinishOutcome(observe({
      submissionToolCalls: 1,
      submissionToolFailures: 1,
      lastSubmissionFailure: {
        code: "SUBMISSION_TOOL_ERRORED",
        reason: "tool arguments failed schema validation",
      },
    })).failureCode).toBe("SUBMISSION_TOOL_ERRORED");
  });

  it("ranks budget, deadline, provider error, and abort above every softer cause", () => {
    const truncatedAndBroke = observe({
      rootTurnEnd: { kind: "max-tokens" },
      submissionToolCalls: 1,
      submissionToolFailures: 1,
      lastSubmissionFailure: { code: "PORTFOLIO_POLICY_VIOLATION", reason: "weights" },
    });

    expect(arenaDecisionFinishOutcome({
      ...truncatedAndBroke,
      providerBudgetDenied: true,
    })).toMatchObject({
      status: "BUDGET_EXHAUSTED",
      failureCode: "ARENA_BUDGET_EXHAUSTED",
      correctable: false,
    });
    expect(arenaDecisionFinishOutcome({
      ...truncatedAndBroke,
      descendantBudgetDenied: true,
    })).toMatchObject({
      status: "BUDGET_EXHAUSTED",
      correctable: false,
    });
    expect(arenaDecisionFinishOutcome({
      ...truncatedAndBroke,
      deadlineExceeded: true,
    })).toMatchObject({
      status: "FAILED",
      failureCode: "SUBMISSION_DEADLINE_EXCEEDED",
      correctable: false,
    });
    expect(arenaDecisionFinishOutcome({
      ...truncatedAndBroke,
      rootTurnEnd: { kind: "error", errorCode: "PROVIDER_5XX", errorMessage: "upstream" },
    })).toMatchObject({
      status: "FAILED",
      failureCode: "PROVIDER_5XX",
      failureMessage: "upstream",
      correctable: false,
    });
    expect(arenaDecisionFinishOutcome({
      ...truncatedAndBroke,
      rootTurnEnd: { kind: "aborted", abortKind: "hook" },
    })).toMatchObject({
      status: "FAILED",
      failureCode: "AGENT_ABORTED",
      correctable: false,
    });
  });

  it("gives a structured code to a blank provider failure and to an unseen turn end", () => {
    expect(arenaDecisionFinishOutcome(observe({
      rootTurnEnd: { kind: "error", errorCode: "   ", errorMessage: "" },
    }))).toMatchObject({
      status: "FAILED",
      failureCode: "AGENT_TURN_FAILED",
      correctable: false,
    });
    expect(arenaDecisionFinishOutcome(observe({
      rootTurnEnd: undefined,
    }))).toMatchObject({
      status: "FAILED",
      failureCode: "ROOT_TURN_END_UNOBSERVED",
      correctable: false,
    });
    expect(arenaDecisionFinishOutcome(observe({
      rootTurnEnd: { kind: "blocked" },
    }))).toMatchObject({
      status: "FAILED",
      failureCode: "ROOT_TURN_BLOCKED",
      correctable: false,
    });
    expect(arenaDecisionFinishOutcome(observe({
      rootTurnEnd: { kind: "interrupted" },
    }))).toMatchObject({
      status: "FAILED",
      failureCode: "ROOT_TURN_INTERRUPTED",
      correctable: false,
    });
    expect(arenaDecisionFinishOutcome(observe({
      rootTurnEnd: { kind: "some-future-harness-kind" },
    }))).toMatchObject({
      status: "FAILED",
      failureCode: "ROOT_TURN_ENDED_UNRECOGNIZED",
      correctable: false,
    });
  });

  it("never leaks an ambient credential into a persisted failure code or message", () => {
    const environment = { DEEPSEEK_API_KEY: "deepseek-private-value" };
    const outcome = arenaDecisionFinishOutcome(
      observe({
        rootTurnEnd: {
          kind: "error",
          errorCode: `E_${environment.DEEPSEEK_API_KEY}`,
          errorMessage: `upstream refused ${environment.DEEPSEEK_API_KEY}`,
        },
      }),
      environment,
    );
    expect(outcome.failureCode).not.toContain(environment.DEEPSEEK_API_KEY);
    expect(outcome.failureMessage).not.toContain(environment.DEEPSEEK_API_KEY);

    const rejected = arenaDecisionFinishOutcome(
      observe({
        submissionToolCalls: 1,
        submissionToolFailures: 1,
        lastSubmissionFailure: {
          code: "PORTFOLIO_POLICY_VIOLATION",
          reason: `refused ${environment.DEEPSEEK_API_KEY}`,
        },
      }),
      environment,
    );
    expect(rejected.failureMessage).not.toContain(environment.DEEPSEEK_API_KEY);
  });
});

describe("submit-tool observation from the Harness event stream", () => {
  it("attributes a tool-layer error that never reached the gateway", () => {
    // Round 2's `twofold` entrant: submit_portfolio_targets came back isError
    // with no gateway verdict, because argument validation runs before the
    // gateway is consulted. The count and the reason must survive anyway.
    const tracker = new ArenaSubmissionToolTracker();
    tracker.openCall("call-1");
    const recorded = tracker.closeCall("call-1", {
      accepted: false,
      isError: true,
      errorText: "targets[0].target_weight_bps must be a string",
    });
    expect(recorded).toEqual({
      code: "SUBMISSION_TOOL_ERRORED",
      reason: "targets[0].target_weight_bps must be a string",
    });
    expect(tracker.calls).toBe(1);
    expect(tracker.failures).toBe(1);
    expect(tracker.lastFailure).toEqual(recorded);
  });

  it("prefers the gateway verdict recorded during the same call", () => {
    const tracker = new ArenaSubmissionToolTracker();
    tracker.openCall("call-1");
    tracker.recordGatewayRejection("PORTFOLIO_POLICY_VIOLATION", "weights must total 10000");
    const recorded = tracker.closeCall("call-1", { accepted: false, isError: false });
    expect(recorded).toEqual({
      code: "PORTFOLIO_POLICY_VIOLATION",
      reason: "weights must total 10000",
    });
    expect(tracker.failures).toBe(1);
  });

  it("does not reuse a stale verdict from an earlier call", () => {
    const tracker = new ArenaSubmissionToolTracker();
    tracker.openCall("call-1");
    tracker.recordGatewayRejection("PORTFOLIO_POLICY_VIOLATION", "weights must total 10000");
    tracker.closeCall("call-1", { accepted: false, isError: false });
    tracker.openCall("call-2");
    const recorded = tracker.closeCall("call-2", { accepted: false, isError: true });
    expect(recorded?.code).toBe("SUBMISSION_TOOL_ERRORED");
    expect(tracker.calls).toBe(2);
    expect(tracker.failures).toBe(2);
  });

  it("counts nothing when the call ended in a durable acceptance", () => {
    const tracker = new ArenaSubmissionToolTracker();
    tracker.openCall("call-1");
    expect(tracker.closeCall("call-1", { accepted: true, isError: false })).toBeNull();
    expect(tracker.calls).toBe(1);
    expect(tracker.failures).toBe(0);
    expect(tracker.lastFailure).toBeNull();
  });

  it("ignores a result for a call it never opened and never counts one twice", () => {
    const tracker = new ArenaSubmissionToolTracker();
    expect(tracker.closeCall("read-call", { accepted: false, isError: true })).toBeNull();
    tracker.openCall("call-1");
    tracker.closeCall("call-1", { accepted: false, isError: true });
    expect(tracker.closeCall("call-1", { accepted: false, isError: true })).toBeNull();
    expect(tracker.calls).toBe(1);
    expect(tracker.failures).toBe(1);
  });

  it("bounds an unbounded tool error text before it is stored", () => {
    const tracker = new ArenaSubmissionToolTracker();
    tracker.openCall("call-1");
    const recorded = tracker.closeCall("call-1", {
      accepted: false,
      isError: true,
      errorText: "x".repeat(5_000),
    });
    expect(recorded?.reason.length).toBeLessThanOrEqual(512);
    expect(recorded?.reason.endsWith("…")).toBe(true);
  });

  it("names a non-error result that still produced no accepted target", () => {
    const tracker = new ArenaSubmissionToolTracker();
    tracker.openCall("call-1");
    expect(tracker.closeCall("call-1", { accepted: false, isError: false })).toEqual({
      code: "SUBMISSION_NOT_ACCEPTED",
      reason: "submit_portfolio_targets returned without a durably accepted target",
    });
  });

  it("reproduces Round 2 and reports the argument path instead of no submission", () => {
    // `twofold` read the packet, called submit_portfolio_targets once, got
    // isError back, and its turn ended `completed`. Reporting the refusal from
    // the tool boundary turns that into a named, correctable cause.
    const tracker = new ArenaSubmissionToolTracker();
    tracker.openCall("call-2");
    tracker.recordGatewayRejection(
      "SUBMISSION_ARGUMENTS_INVALID",
      "targets[0].target_weight_bps: targets[0].target_weight_bps must be a"
      + " canonical non-negative decimal integer string",
    );
    const failure = tracker.closeCall("call-2", {
      accepted: false,
      isError: true,
      errorText: "tool execution failed",
    });
    expect(failure?.code).toBe("SUBMISSION_ARGUMENTS_INVALID");

    const outcome = arenaDecisionFinishOutcome(observe({
      rootTurnEnd: { kind: "completed" },
      submissionToolCalls: tracker.calls,
      submissionToolFailures: tracker.failures,
      lastSubmissionFailure: tracker.lastFailure,
    }));
    expect(outcome.status).toBe("FAILED");
    expect(outcome.failureCode).toBe("SUBMISSION_ARGUMENTS_INVALID");
    expect(outcome.failureMessage).toContain("targets[0].target_weight_bps");
    expect(outcome.correctable).toBe(true);
    expect(arenaSubmissionCorrection({
      outcome,
      remainingMilliseconds: 600_000,
      budgetExhausted: false,
    }).allowed).toBe(true);
  });

  it("keeps a gateway verdict that arrives with no observed tool call", () => {
    const tracker = new ArenaSubmissionToolTracker();
    tracker.recordGatewayRejection("DECISION_CLOSED", "past its deadline");
    expect(tracker.lastFailure).toEqual({
      code: "DECISION_CLOSED",
      reason: "past its deadline",
    });
    expect(tracker.calls).toBe(0);
    expect(tracker.failures).toBe(0);
  });
});

describe("bounded submission correction", () => {
  const truncated = arenaDecisionFinishOutcome(observe({
    rootTurnEnd: { kind: "max-tokens" },
  }));

  it("spends at most one correction and never raises the frozen fence", () => {
    expect(ARENA_MAX_SUBMISSION_CORRECTIONS).toBe(1);
    const first = arenaSubmissionCorrection({
      outcome: truncated,
      remainingMilliseconds: 120_000,
      budgetExhausted: false,
    });
    expect(first.allowed).toBe(true);
    if (first.allowed) {
      expect(first.instruction).toContain("ROOT_OUTPUT_TRUNCATED");
      expect(first.instruction).toContain("submit_portfolio_targets");
    }

    const second = arenaDecisionFinishOutcome(observe({
      rootTurnEnd: { kind: "max-tokens" },
      correctionsSpent: ARENA_MAX_SUBMISSION_CORRECTIONS,
    }));
    expect(second.correctable).toBe(false);
    expect(arenaSubmissionCorrection({
      outcome: second,
      remainingMilliseconds: 120_000,
      budgetExhausted: false,
    })).toEqual({
      allowed: false,
      reason: "the failure cannot be corrected inside the frozen decision fence",
    });
  });

  it("separates the correction sentences with newlines", () => {
    const correction = arenaSubmissionCorrection({
      outcome: truncated,
      remainingMilliseconds: 120_000,
      budgetExhausted: false,
    });
    expect(correction.allowed).toBe(true);
    if (!correction.allowed) return;
    const lines = correction.instruction.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.trim().length > 0)).toBe(true);
    expect(lines[0]).toContain("ROOT_OUTPUT_TRUNCATED");
    expect(lines.some((line) => line.includes("submit_portfolio_targets"))).toBe(true);
    expect(lines.at(-1)).toContain("decision_summary");
  });

  it("refuses to correct without frozen budget or deadline headroom", () => {
    expect(arenaSubmissionCorrection({
      outcome: truncated,
      remainingMilliseconds: 120_000,
      budgetExhausted: true,
    })).toEqual({
      allowed: false,
      reason: "the frozen decision budget has no remaining headroom",
    });
    expect(arenaSubmissionCorrection({
      outcome: truncated,
      remainingMilliseconds: 0,
      budgetExhausted: false,
    })).toEqual({
      allowed: false,
      reason: "the frozen submission deadline has no remaining headroom",
    });
    expect(arenaSubmissionCorrection({
      outcome: truncated,
      remainingMilliseconds: 1_000,
      budgetExhausted: false,
    })).toEqual({
      allowed: false,
      reason: "the frozen submission deadline has no remaining headroom",
    });
  });

  it("asks an orchestrated root with no child for the subagent call first", () => {
    // Round 3 of private-us-liquid-100-s4: the orchestrated root hit its frozen
    // output ceiling before it ever called subagent, so a submit-only
    // correction would spend the single retry on a submission that admission
    // refuses with DESCENDANT_REQUIRED.
    const correction = arenaSubmissionCorrection({
      outcome: arenaDecisionFinishOutcome(observe({
        rootTurnEnd: { kind: "max-tokens" },
        orchestratedDescendantMissing: true,
      })),
      remainingMilliseconds: 120_000,
      budgetExhausted: false,
      orchestratedDescendantMissing: true,
    });
    expect(correction.allowed).toBe(true);
    if (!correction.allowed) return;
    expect(correction.instruction).toContain("ROOT_OUTPUT_TRUNCATED");
    expect(correction.instruction).toContain("DESCENDANT_REQUIRED");
    expect(correction.instruction).toContain("subagent");
    expect(correction.instruction.indexOf("subagent"))
      .toBeLessThan(correction.instruction.indexOf("submit_portfolio_targets"));
    expect(correction.instruction).toContain("恰好一次");
    const lines = correction.instruction.split("\n");
    expect(lines.every((line) => line.trim().length > 0)).toBe(true);
    expect(lines.at(-1)).toContain("decision_summary");
  });

  it("keeps the correction submit-only once a descendant is registered", () => {
    for (const orchestratedDescendantMissing of [false, undefined]) {
      const correction = arenaSubmissionCorrection({
        outcome: truncated,
        remainingMilliseconds: 120_000,
        budgetExhausted: false,
        ...(orchestratedDescendantMissing === undefined
          ? {}
          : { orchestratedDescendantMissing }),
      });
      expect(correction.allowed).toBe(true);
      if (!correction.allowed) continue;
      expect(correction.instruction).toContain("直接调用 submit_portfolio_targets");
      expect(correction.instruction).not.toContain("subagent");
      expect(correction.instruction).not.toContain("DESCENDANT_REQUIRED");
    }
  });

  it("refuses to correct an already-successful or hard-failed decision", () => {
    for (const observation of [
      observe({ acceptedSubmissionId: "22222222-2222-4222-8222-222222222222" }),
      observe({ deadlineExceeded: true }),
      observe({ providerBudgetDenied: true }),
      observe({ rootTurnEnd: { kind: "aborted", abortKind: "user" } }),
      observe({
        submissionToolCalls: 1,
        submissionToolFailures: 1,
        lastSubmissionFailure: { code: "DECISION_CLOSED", reason: "closed" },
      }),
    ]) {
      expect(arenaSubmissionCorrection({
        outcome: arenaDecisionFinishOutcome(observation),
        remainingMilliseconds: 600_000,
        budgetExhausted: false,
      }).allowed).toBe(false);
    }
  });
});
