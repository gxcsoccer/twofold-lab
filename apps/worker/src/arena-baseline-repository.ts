import type { SupabaseClient } from "@supabase/supabase-js";

import type { DecisionAdmissionEvidence } from "@twofold/core";
import { canonicalFinancialJson } from "@twofold/core";
import { createHash } from "node:crypto";

import type { ArenaArtifactMaterial } from "./arena-inputs.js";
import {
  arenaArtifactRegistrationIdentity,
  uploadArtifact,
} from "./arena-repository.js";
import type { BuiltBaselineDecisionInputs } from "./arena-baseline-decision.js";
import { getEventStreamHead } from "./stream-head-repository.js";
import { PRIVATE_ARTIFACT_BUCKET } from "./market-data.js";

export interface BaselineArtifactRegistration {
  readonly material: ArenaArtifactMaterial;
  readonly artifactKind: string;
  readonly runScoped: boolean;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Narrow persistence port for a deterministic baseline decision.
 *
 * A baseline touches exactly three durable boundaries - artifact registration,
 * the decision invocation, and the evidenced submission - so it does not need
 * the Agent repository's stateful session/usage/projection machinery. Keeping
 * the port this small is what lets the orchestration below be unit-tested
 * without a database.
 */
export interface BaselineDecisionPort {
  uploadArtifact(material: ArenaArtifactMaterial): Promise<void>;
  runStreamSequence(runId: string): Promise<string>;
  registerArtifact(
    input: BaselineArtifactRegistration & {
      readonly runId: string;
      readonly seasonId: string;
    },
  ): Promise<string>;
  openInvocation(input: {
    readonly built: BuiltBaselineDecisionInputs;
    readonly packetArtifactId: string;
    readonly policyArtifactId: string;
    readonly expectedRunStreamSeq: string;
    readonly openedAt: string;
  }): Promise<string>;
  acceptSubmission(input: {
    readonly built: BuiltBaselineDecisionInputs;
    readonly packetArtifactId: string;
    readonly submissionId: string;
    readonly acceptedAt: string;
    readonly expectedRunStreamSeq: string;
  }): Promise<{ readonly submissionId: string; readonly acceptedAt: string }>;
}

export interface PersistedBaselineDecision {
  readonly decisionId: string;
  readonly submissionId: string;
  readonly acceptedAt: string;
  readonly packetArtifactId: string;
  readonly policyArtifactId: string;
}

/**
 * Persist one deterministic baseline decision.
 *
 * Ordering matters and mirrors the Agent path: both artifacts exist before the
 * invocation names them, and the invocation exists before a target can be
 * admitted against it. Every step is keyed by immutable Round identity, so a
 * transport retry re-attaches to the same decision rather than opening a second.
 *
 * @param port - Durable boundary.
 * @param built - Deterministic inputs for one Round seat.
 * @returns The decision and accepted submission identities.
 */
export async function persistBaselineDecision(
  port: BaselineDecisionPort,
  built: BuiltBaselineDecisionInputs,
): Promise<PersistedBaselineDecision> {
  const { identity } = built;
  await Promise.all([
    port.uploadArtifact(built.packetArtifact),
    port.uploadArtifact(built.policyArtifact),
  ]);

  const [packetArtifactId, policyArtifactId] = await Promise.all([
    port.registerArtifact({
      material: built.packetArtifact,
      artifactKind: "baseline_decision_packet",
      runScoped: true,
      runId: identity.runId,
      seasonId: identity.seasonId,
      metadata: {
        schema: "twofold.baseline_decision_packet/v1",
        decisionId: identity.decisionId,
        decisionPacketId: identity.decisionPacketId,
        marketSnapshotId: identity.snapshotId,
        // open_decision_invocation binds the packet to the exact sealed
        // snapshot manifest; omitting this key fails the invocation fence.
        marketManifestSha256: identity.marketManifestSha256,
      },
    }),
    // The frozen policy is content-addressed and Season-scoped: the same
    // baseline reused by a later Season resolves to the identical bytes.
    port.registerArtifact({
      material: built.policyArtifact,
      artifactKind: "deterministic_baseline_policy",
      runScoped: false,
      runId: identity.runId,
      seasonId: identity.seasonId,
      metadata: {
        schema: "twofold.deterministic_baseline_policy/v1",
        policyId: identity.policyId,
        policySha256: identity.policySha256,
      },
    }),
  ]);

  // Every timestamp and identity below comes from the frozen build, never from
  // a fresh clock read or a random UUID. Both RPCs compare each material field
  // against the row their idempotency key already found, so a retry after the
  // invocation is open must present byte-identical content to re-attach rather
  // than fail as a key reused with different content.
  const invocationSeq = await port.openInvocation({
    built,
    packetArtifactId,
    policyArtifactId,
    expectedRunStreamSeq: await port.runStreamSequence(identity.runId),
    openedAt: identity.observedAt,
  });

  const accepted = await port.acceptSubmission({
    built,
    packetArtifactId,
    submissionId: identity.submissionId,
    acceptedAt: identity.observedAt,
    expectedRunStreamSeq: invocationSeq,
  });

  return Object.freeze({
    decisionId: identity.decisionId,
    submissionId: accepted.submissionId,
    acceptedAt: accepted.acceptedAt,
    packetArtifactId,
    policyArtifactId,
  });
}

interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

function firstRow<T>(value: unknown, operation: string): T {
  const row = Array.isArray(value) ? value[0] : value;
  if (row === null || row === undefined) {
    throw new Error(`${operation} returned no row`);
  }
  return row as T;
}

function failure(operation: string, error: { message: string }): Error {
  return new Error(`${operation} failed: ${error.message}`);
}

/**
 * Wire the baseline port to Supabase.
 * @param client - Service-role client.
 * @param workerId - Recording worker identity.
 * @returns A durable port implementation.
 */
export function createSupabaseBaselineDecisionPort(
  client: SupabaseClient,
  workerId: string,
): BaselineDecisionPort {
  const rpc = (name: string, args: Record<string, unknown>): Promise<RpcResult> =>
    client.rpc(name, args) as unknown as Promise<RpcResult>;

  const port: BaselineDecisionPort = {
    async uploadArtifact(material) {
      await uploadArtifact(client, material);
    },

    async runStreamSequence(runId) {
      const head = await getEventStreamHead(
        client as never,
        runId,
        "run",
      );
      return head.sequence;
    },

    async registerArtifact(input) {
      const registration = arenaArtifactRegistrationIdentity({
        runScoped: input.runScoped,
        artifactKind: input.artifactKind,
        sha256: input.material.sha256,
        runId: input.runId,
        seasonId: input.seasonId,
        workerId,
      });
      const result = await rpc("register_artifact", {
        p_idempotency_key: registration.idempotencyKey,
        p_run_id: registration.runId,
        p_season_id: registration.seasonId,
        p_source_event_id: null,
        p_artifact_kind: input.artifactKind,
        p_storage_bucket: PRIVATE_ARTIFACT_BUCKET,
        p_object_path: input.material.objectPath,
        p_content_type: "application/json",
        p_byte_size: input.material.byteSize,
        p_sha256: input.material.sha256,
        p_created_by: registration.createdBy,
        p_metadata: input.metadata,
        p_supersedes_artifact_id: null,
      });
      if (result.error !== null) throw failure("register_artifact", result.error);
      return firstRow<{ artifact_id: string }>(
        result.data,
        "register_artifact",
      ).artifact_id;
    },

    async openInvocation(input) {
      const { identity } = input.built;
      const result = await rpc("open_decision_invocation", {
        p_idempotency_key: `baseline:${identity.decisionId}:open`,
        p_decision_id: identity.decisionId,
        p_run_id: identity.runId,
        p_season_id: identity.seasonId,
        p_expected_run_stream_seq: input.expectedRunStreamSeq,
        p_root_harness_session_id: identity.rootExecutionId,
        p_root_agent_identity: identity.policyId,
        p_packet_artifact_id: input.packetArtifactId,
        p_agent_bundle_artifact_id: input.policyArtifactId,
        p_market_snapshot_id: identity.snapshotId,
        p_decision_at: identity.decisionAt,
        p_data_cutoff_at: identity.dataCutoffAt,
        p_submission_deadline_at: identity.submissionDeadlineAt,
        p_trigger_reasons: ["deterministic_baseline"],
        p_opened_at: input.openedAt,
        p_recorded_by: workerId,
      });
      if (result.error !== null) {
        throw failure("open_decision_invocation", result.error);
      }
      return String(firstRow<{ source_stream_seq: string | number }>(
        result.data,
        "open_decision_invocation",
      ).source_stream_seq);
    },

    async acceptSubmission(input) {
      const { identity, decision, admissionEvidence } = input.built;
      const evidenceCanonicalJson = canonicalFinancialJson(admissionEvidence);
      const result = await rpc("accept_portfolio_targets_with_evidence", {
        p_idempotency_key: `baseline:${identity.decisionId}:submission`,
        p_submission_id: input.submissionId,
        p_root_harness_session_id: identity.rootExecutionId,
        p_packet_artifact_id: input.packetArtifactId,
        p_packet_sha256: identity.packetSha256,
        p_targets: decision.targets.map((entry) => ({
          symbol: entry.symbol,
          target_weight_bps: entry.targetWeightBps,
        })),
        p_cash_weight_bps: decision.cashWeightBps,
        p_decision_summary: decision.decisionSummary,
        p_accepted_at: input.acceptedAt,
        p_admission_evidence: admissionEvidence,
        p_admission_evidence_canonical_json: evidenceCanonicalJson,
        p_admission_evidence_sha256: admissionEvidence.evidenceSha256,
        p_admission_artifact_sha256: createHash("sha256")
          .update(evidenceCanonicalJson, "utf8")
          .digest("hex"),
        p_expected_run_stream_seq: input.expectedRunStreamSeq,
        p_recorded_by: workerId,
      });
      if (result.error !== null) {
        throw failure("accept_portfolio_targets_with_evidence", result.error);
      }
      const row = firstRow<{ submission_id: string; accepted_at: string }>(
        result.data,
        "accept_portfolio_targets_with_evidence",
      );
      return { submissionId: row.submission_id, acceptedAt: row.accepted_at };
    },
  };
  return Object.freeze(port);
}
