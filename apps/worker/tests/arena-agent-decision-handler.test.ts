import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  arenaAgentHandlers,
  createArenaAgentDecisionHandler,
  loadCompetitionSeat,
  resolveArenaAgentFilesystem,
  type ArenaAgentDecisionExecution,
} from "../src/arena-agent-decision-handler.js";
import type { ArenaWorkItem } from "../src/arena-work-repository.js";

const item = {
  schema: "twofold.arena_work_item_result/v1",
  workItemId: "a1000000-0000-8000-8000-000000000001",
  roundEntryId: "a2000000-0000-8000-8000-000000000001",
  roundId: "a3000000-0000-4000-8000-000000000001",
  seasonId: "a4000000-0000-4000-8000-000000000001",
  entrantId: "a5000000-0000-4000-8000-000000000001",
  runId: "a6000000-0000-4000-8000-000000000001",
  phase: "RUN_AGENT_DECISION",
  predecessorWorkItemId: null,
  scheduledAt: "2026-08-28T22:23:53.027Z",
  deadlineAt: "2026-08-31T13:15:00.000Z",
  nextAttemptAt: "2026-08-28T22:23:53.027Z",
  status: "CLAIMED",
  attemptCount: "1",
  claimedBy: "worker-1",
  leaseToken: "a7000000-0000-4000-8000-000000000001",
  leaseExpiresAt: "2026-08-28T22:53:53.027Z",
  completedAt: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  retryable: null,
} as const satisfies ArenaWorkItem;

const accepted = {
  decisionId: "a8000000-0000-8000-8000-000000000001",
  status: "SUCCEEDED",
  acceptedSubmissionId: "a9000000-0000-4000-8000-000000000001",
  agentCount: "2",
  providerDispatchAttempts: "4",
  totalBillableTokens: "13641",
  estimatedCostUsd: "0.012078132",
  costStatus: "ESTIMATED",
} as const;

describe("Arena Agent decision phase handler", () => {
  it("completes queue work only after one accepted target exists", async () => {
    const execute: ArenaAgentDecisionExecution = vi.fn(async () => accepted);
    const handler = createArenaAgentDecisionHandler({ execute });

    await expect(handler(item, new AbortController().signal)).resolves.toEqual({
      outcome: "ACCEPTED_TARGET",
      ...accepted,
    });
    expect(execute).toHaveBeenCalledWith(item, expect.any(AbortSignal));
  });

  it("fails closed when the runtime ends without an accepted target", async () => {
    const handler = createArenaAgentDecisionHandler({
      execute: async () => ({
        ...accepted,
        status: "NO_ACCEPTED_SUBMISSION",
        acceptedSubmissionId: null,
      }),
    });
    await expect(handler(item, new AbortController().signal)).rejects.toThrow(
      "without one accepted target",
    );
  });

  it("advertises Agent capability only when the private key is present", () => {
    const handler = createArenaAgentDecisionHandler({ execute: async () => accepted });
    expect(arenaAgentHandlers({}, handler)).toEqual({});
    expect(arenaAgentHandlers({ DEEPSEEK_API_KEY: "   " }, handler)).toEqual({});
    expect(Object.keys(arenaAgentHandlers({
      DEEPSEEK_API_KEY: "private-key-never-returned",
    }, handler))).toEqual(["RUN_AGENT_DECISION"]);
    expect(JSON.stringify(arenaAgentHandlers({
      DEEPSEEK_API_KEY: "private-key-never-returned",
    }, handler))).not.toContain("private-key-never-returned");
  });

  it("uses the deployed project root and frozen Harness revision on Vercel", () => {
    const frozenRevision = "47f943859bef60e4160492346772ded9b24f765a";
    expect(resolveArenaAgentFilesystem({
      environment: {
        VERCEL: "1",
        TWOFOLD_HARNESS_REVISION: frozenRevision,
      },
      processCwd: "/var/task",
    })).toEqual({
      repositoryRoot: "/var/task",
      harnessRoot: "/var/deepseek-harness",
      harnessRevision: frozenRevision,
    });
  });

  it("finds the repository above the Vercel Next.js application directory", () => {
    expect(resolveArenaAgentFilesystem({
      environment: { VERCEL: "1" },
      processCwd: "/var/task/apps/dashboard",
    }).repositoryRoot).toBe("/var/task");
  });

  it("keeps explicit local checkout paths when they are provided", () => {
    expect(resolveArenaAgentFilesystem({
      environment: { VERCEL: "1" },
      repositoryRoot: "/workspace/twofold-lab",
      harnessRoot: "/workspace/deepseek-harness",
      processCwd: "/var/task",
    })).toEqual({
      repositoryRoot: "/workspace/twofold-lab",
      harnessRoot: "/workspace/deepseek-harness",
      harnessRevision: undefined,
    });
  });

  it("resolves the claimed Season from the config registry, not one global file", async () => {
    const root = mkdtempSync(join(tmpdir(), "twofold-season-registry-"));
    const configRoot = join(root, "config");
    mkdirSync(configRoot);
    const config = (seasonId: string, entrantId: string, runId: string) => ({
      schema: "twofold.private_controlled_lab_config/v1",
      season: { seasonId },
      entrants: [{
        entrantId,
        entrantCode: "twofold",
        runId,
        bundleId: "twofold@0.1.0",
        bundleSha256: "b".repeat(64),
        executionClass: "ROOT_ONLY",
        presetId: "twofold",
        provider: "deepseek-official",
        model: "deepseek-v4-pro",
      }],
      rounds: [{ roundId: item.roundId, roundIndex: "1" }],
    });
    try {
      writeFileSync(join(configRoot, "private-old.json"), JSON.stringify(
        config("00000000-0000-4000-8000-000000000001", item.entrantId, item.runId),
      ));
      writeFileSync(join(configRoot, "private-current.json"), JSON.stringify(
        config(item.seasonId, item.entrantId, item.runId),
      ));

      await expect(loadCompetitionSeat(
        root,
        "config/private-old.json",
        item,
      )).resolves.toMatchObject({
        roundIndex: "1",
        identity: {
          seasonId: item.seasonId,
          runId: item.runId,
          entrantCode: "twofold",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
