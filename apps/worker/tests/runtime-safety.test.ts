import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  arenaBudgetEnforcementStatus,
  hasRegisteredArenaDescendant,
  isArenaDescendantRequirementSatisfied,
} from "../src/arena-runtime.js";
import type {
  ArenaDecisionStatus,
  ArenaProjectionState,
} from "../src/arena-types.js";
import {
  createDogfoodAbortScope,
  dogfoodExitCode,
  type DogfoodSignalSource,
} from "../src/dogfood-control.js";
import {
  MAX_PERSISTED_FAILURE_MESSAGE_LENGTH,
  sanitizeFailureMessage,
} from "../src/failure-safety.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("persisted failure safety", () => {
  it("redacts known ambient credentials before enforcing the GUI-safe limit", () => {
    const environment = {
      DEEPSEEK_API_KEY: "deepseek-private-value",
      SUPABASE_SECRET_KEY: "supabase-private-value",
      ALPACA_API_KEY_ID: "alpaca-private-id",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public-value",
    };
    const message = [
      environment.DEEPSEEK_API_KEY,
      encodeURIComponent(environment.SUPABASE_SECRET_KEY),
      environment.ALPACA_API_KEY_ID,
      environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      "x".repeat(MAX_PERSISTED_FAILURE_MESSAGE_LENGTH * 2),
    ].join(":");

    const safe = sanitizeFailureMessage(message, environment);

    expect(safe).not.toContain(environment.DEEPSEEK_API_KEY);
    expect(safe).not.toContain(environment.SUPABASE_SECRET_KEY);
    expect(safe).not.toContain(environment.ALPACA_API_KEY_ID);
    expect(safe).toContain(environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
    expect(safe).toHaveLength(MAX_PERSISTED_FAILURE_MESSAGE_LENGTH);
    expect(safe).toMatch(/\.\.\.\[TRUNCATED\]$/);
  });
});

describe("dogfood process control", () => {
  it("fuses SIGTERM and timeout into one AbortController and removes listeners", async () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const source = emitter as EventEmitter & DogfoodSignalSource;
    const interrupted = createDogfoodAbortScope({ timeoutMs: 100, signalSource: source });

    expect(emitter.listenerCount("SIGINT")).toBe(1);
    expect(emitter.listenerCount("SIGTERM")).toBe(1);
    emitter.emit("SIGTERM");
    expect(interrupted.signal.aborted).toBe(true);
    expect(String(interrupted.signal.reason)).toContain("SIGTERM");
    interrupted.dispose();
    interrupted.dispose();
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(emitter.listenerCount("SIGTERM")).toBe(0);

    const timedOut = createDogfoodAbortScope({ timeoutMs: 100, signalSource: source });
    await vi.advanceTimersByTimeAsync(100);
    expect(timedOut.signal.aborted).toBe(true);
    expect(String(timedOut.signal.reason)).toContain("timeout");
    timedOut.dispose();
  });

  it("returns failure for every non-success terminal projection", () => {
    const statuses: ArenaDecisionStatus[] = [
      "QUEUED",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "BUDGET_EXHAUSTED",
      "NO_ACCEPTED_SUBMISSION",
    ];
    expect(statuses.map((status) => [status, dogfoodExitCode(status)])).toEqual([
      ["QUEUED", 1],
      ["RUNNING", 1],
      ["SUCCEEDED", 0],
      ["FAILED", 1],
      ["BUDGET_EXHAUSTED", 1],
      ["NO_ACCEPTED_SUBMISSION", 1],
    ]);
  });
});

describe("orchestrated submission prerequisite", () => {
  it("requires a registered descendant rather than an in-flight reservation", () => {
    const root = {
      sessionId: "root",
      parentSessionId: null,
      origin: "root",
    };
    const projection = { agents: [root] } as ArenaProjectionState;

    expect(hasRegisteredArenaDescendant(projection)).toBe(false);
    projection.agents.push({
      ...root,
      sessionId: "child",
      parentSessionId: "root",
      origin: "subagent",
    } as ArenaProjectionState["agents"][number]);
    expect(hasRegisteredArenaDescendant(projection)).toBe(true);
  });

  it("does not impose the orchestrated descendant gate on root-only entrants", () => {
    const rootOnly = {
      agents: [{
        sessionId: "root",
        parentSessionId: null,
        origin: "root",
      }],
    } as ArenaProjectionState;

    expect(isArenaDescendantRequirementSatisfied("ROOT_ONLY", rootOnly)).toBe(true);
    expect(isArenaDescendantRequirementSatisfied("ORCHESTRATED", rootOnly)).toBe(false);
    rootOnly.agents.push({
      ...rootOnly.agents[0]!,
      sessionId: "child",
      parentSessionId: "root",
      origin: "subagent",
    });
    expect(isArenaDescendantRequirementSatisfied("ORCHESTRATED", rootOnly)).toBe(true);
  });

  it("does not call a zero descendant allowance a spent provider budget", () => {
    const state = {
      treeUsage: {
        providerRequestCount: "0",
        totalBillableTokens: "0",
        estimatedCostUsd: null,
        costStatus: "ESTIMATED",
      },
      budget: {
        maxProviderRequests: "4",
        maxBillableTokens: "120000",
        maxEstimatedCostUsd: "1.00",
        maxDescendants: "0",
      },
    } as ArenaProjectionState;

    expect(arenaBudgetEnforcementStatus(state, {
      providerBudgetDenied: false,
      descendantBudgetDenied: false,
    })).toBe("WITHIN_LIMITS");
    expect(arenaBudgetEnforcementStatus(state, {
      providerBudgetDenied: false,
      descendantBudgetDenied: true,
    })).toBe("EXHAUSTED");
  });
});
