import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

import {
  createDeterministicBaselinePolicy,
  type DeterministicBaselinePolicy,
} from "@twofold/core";

import { buildBaselineDecisionInputs } from "./arena-baseline-decision.js";
import {
  createSupabaseBaselineDecisionPort,
  persistBaselineDecision,
} from "./arena-baseline-repository.js";
import { SupabaseArenaRepository } from "./arena-repository.js";
import type { ArenaWorkItem } from "./arena-work-repository.js";
import { ArenaTerminalWorkError } from "./arena-work-runner.js";
import type { WorkerConfig } from "./config.js";

export interface BaselineCompetitionSeat {
  readonly entrantCode: string;
  /**
   * Present only when the config file still lists this Round. A Season outlives
   * its checked-in config, so from Round 2 onward the authoritative index comes
   * from the database fence instead - the same fallback the Agent seat loader
   * uses. Treating a missing entry as a mismatch would retry forever.
   */
  readonly roundIndex: string | undefined;
  readonly policy: DeterministicBaselinePolicy;
  readonly genesisSymbol: string;
}

export interface BaselineDecisionResult {
  readonly decisionId: string;
  readonly acceptedSubmissionId: string;
  readonly policyId: string;
  readonly maxTargetDeltaBps: string;
}

interface ConfiguredBaselinePolicy {
  readonly policyId?: unknown;
  readonly rule?: unknown;
  readonly symbol?: unknown;
}

/**
 * Resolve the immutable baseline seat for one claimed work item.
 *
 * Returns `null` when the entrant is an Agent, so the caller can fall through
 * to the Harness path without this loader having to know anything about it.
 *
 * @param repositoryRoot - Deployment root holding `config/`.
 * @param configPath - Preferred competition config, still validated by identity.
 * @param item - The claimed Round work item.
 * @returns The baseline seat, or `null` for a non-baseline entrant.
 */
export async function loadBaselineCompetitionSeat(
  repositoryRoot: string,
  configPath: string,
  item: ArenaWorkItem,
): Promise<BaselineCompetitionSeat | null> {
  const registryRoot = resolve(repositoryRoot, "config");
  const entries = await readdir(registryRoot, { withFileTypes: true });
  const paths = [...new Set([
    resolve(repositoryRoot, configPath),
    ...entries
      .filter((entry) => entry.isFile()
        && entry.name.startsWith("private-")
        && entry.name.endsWith(".json"))
      .map((entry) => resolve(registryRoot, entry.name))
      .sort((left, right) => left.localeCompare(right, "en")),
  ])];

  for (const path of paths) {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      schema?: unknown;
      season?: { seasonId?: unknown; openingSymbol?: unknown };
      entrants?: Array<Record<string, unknown>>;
      rounds?: Array<Record<string, unknown>>;
    };
    if (
      raw.schema !== "twofold.private_controlled_lab_config/v1"
      || raw.season?.seasonId !== item.seasonId
    ) continue;
    const entrant = raw.entrants?.find(
      (candidate) => candidate.entrantId === item.entrantId,
    );
    if (entrant === undefined) continue;
    if (entrant.executionClass !== "DETERMINISTIC_BASELINE") return null;

    const round = raw.rounds?.find(
      (candidate) => candidate.roundId === item.roundId,
    );
    const roundIndex = round?.roundIndex;
    const genesisSymbol = raw.season?.openingSymbol;
    const configured = entrant.baselinePolicy as ConfiguredBaselinePolicy | undefined;
    if (
      entrant.runId !== item.runId
      || typeof entrant.entrantCode !== "string"
      || (roundIndex !== undefined
        && (typeof roundIndex !== "string" || !/^[1-9]\d*$/.test(roundIndex)))
      || typeof genesisSymbol !== "string"
      || entrant.provider !== "none"
      || entrant.model !== "none"
      || configured === undefined
      || typeof configured.policyId !== "string"
      || (configured.rule !== "HOLD_GENESIS" && configured.rule !== "ALL_IN_SYMBOL")
      || (configured.symbol !== null && typeof configured.symbol !== "string")
    ) {
      throw new TypeError("competition config does not match claimed baseline work");
    }

    const policy = createDeterministicBaselinePolicy({
      policyId: configured.policyId,
      rule: configured.rule,
      symbol: configured.symbol,
    });
    // The registered entrant identity is the frozen policy's content address.
    // A config edited after registration therefore fails here rather than
    // quietly competing under a different strategy than the one on record.
    if (entrant.bundleSha256 !== policy.policySha256) {
      throw new TypeError(
        "baseline policy bytes do not match the registered entrant identity",
      );
    }

    return Object.freeze({
      entrantCode: entrant.entrantCode,
      roundIndex: roundIndex as string | undefined,
      policy,
      genesisSymbol,
    });
  }
  throw new TypeError("no competition config matches claimed baseline work");
}

/**
 * Execute one deterministic baseline decision against durable Arena state.
 *
 * No provider credential is read and no model is called, so this path cannot
 * bill a token even before the database invariant rejects one. It is not
 * session-free at the database layer: open_decision_invocation still inserts
 * one root agent_session_lineage row to satisfy its FK, recording the policy id
 * as the root identity. That row carries no provider request and no usage.
 *
 * @param input - Worker credentials, resolved seat, and the claimed work item.
 * @returns The persisted decision and accepted submission identity.
 */
export async function executeBaselineDecision(input: {
  readonly worker: WorkerConfig;
  readonly seat: BaselineCompetitionSeat;
  readonly item: ArenaWorkItem;
}): Promise<BaselineDecisionResult> {
  const { worker, seat, item } = input;
  const repository = new SupabaseArenaRepository(
    worker.supabaseUrl!,
    worker.supabaseSecretKey!,
    worker.workerId,
  );
  const fence = await repository.roundEntrantFence(item.roundId, item.entrantId);
  if (
    fence.roundEntryId !== item.roundEntryId
    || (seat.roundIndex !== undefined && fence.roundIndex !== seat.roundIndex)
    || fence.seasonId !== item.seasonId
    || fence.entrantId !== item.entrantId
    || fence.runId !== item.runId
    || fence.decisionAt !== item.scheduledAt
    || fence.submissionDeadlineAt !== item.deadlineAt
  ) {
    throw new TypeError("claimed baseline work diverges from its immutable Round seat");
  }

  const [snapshot, portfolioState] = await Promise.all([
    repository.marketSnapshot(fence.snapshotId),
    repository.portfolioState(item.runId),
  ]);

  let built;
  try {
    built = buildBaselineDecisionInputs({
      policy: seat.policy,
      entrantCode: seat.entrantCode,
      fence,
      snapshot,
      portfolioState,
      genesisSymbol: seat.genesisSymbol,
      observedAt: new Date().toISOString(),
    });
  } catch (error) {
    // A baseline that cannot be priced or weighted on this Round's sealed
    // evidence must not be retried into existence on later, different data.
    throw new ArenaTerminalWorkError(
      "BASELINE_NOT_DERIVABLE",
      error instanceof Error ? error.message : String(error),
    );
  }

  const client = createClient(worker.supabaseUrl!, worker.supabaseSecretKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const persisted = await persistBaselineDecision(
    createSupabaseBaselineDecisionPort(client, worker.workerId),
    built,
  );

  return Object.freeze({
    decisionId: persisted.decisionId,
    acceptedSubmissionId: persisted.submissionId,
    policyId: seat.policy.policyId,
    maxTargetDeltaBps: built.maxTargetDeltaBps,
  });
}
