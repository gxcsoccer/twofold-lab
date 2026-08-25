import { createHash, randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertJsonValue,
  DEEPSEEK_WEEKDAY_UTC_PRICING_RULE,
  deepseekPricingBandAt,
  type ActorKind,
  type EventPayload,
} from "@twofold/core";
import type {
  PortfolioTargetsSubmission,
} from "@twofold-lab/dsh-twofold";

import {
  canonicalJson,
  type ArenaArtifactMaterial,
  type ArenaMarketSnapshot,
  type BuiltArenaInputs,
} from "./arena-inputs.js";
import type { ArenaCostQuote } from "./arena-budget.js";
import {
  quoteArenaAttempt,
  type ArenaPricingRow,
} from "./arena-pricing.js";
import { ARENA_PROJECTION_NAME, type ArenaProjectionState, type PreparedArenaInvocation } from "./arena-types.js";
import { retryExactRpcOnce } from "./exact-rpc.js";
import { PRIVATE_ARTIFACT_BUCKET } from "./market-data.js";
import type { FrozenHarnessUsage } from "./model-usage-buffer.js";

interface MarketSnapshotRow {
  snapshot_id: string;
  source_version_id: string;
  manifest_sha256: string;
  cutoff_at: string;
  target_session_date: string;
  selection_policy: string;
  sealed_at: string;
  symbols: string[];
}

interface MarketSnapshotMemberRow {
  symbol: string;
  member_index: number;
  fact_id: string;
}

interface MarketBarFactRow {
  fact_id: string;
  symbol: string;
  bar_start: string;
  bar_date: string;
  currency: string;
  open_price: string;
  high_price: string;
  low_price: string;
  close_price: string;
  volume: string;
  trade_count: string;
  vwap: string | null;
  fact_sha256: string;
}

interface EventRow {
  event_id: string;
  stream_seq: string | number;
}

interface ArtifactRow {
  artifact_id: string;
}

interface InvocationRow extends EventRow {
  decision_id: string;
  source_event_id: string;
  source_stream_seq: string | number;
}

interface LineageRow {
  source_event_id: string;
  source_stream_seq: string | number;
  depth: string | number;
}

interface SubmissionRow {
  submission_id: string;
  accepted_at: string;
  source_event_id: string;
  source_stream_seq: string | number;
}

interface ModelUsageRow {
  cost_status: "estimated" | "unpriced" | "unavailable";
  estimated_cost: string | number | null;
}

interface ProjectionRpcArguments {
  readonly p_projection_name: string;
  readonly p_entity_id: string;
  readonly p_stream_id: string;
  readonly p_expected_last_stream_seq: string;
  readonly p_new_last_stream_seq: string;
  readonly p_last_event_id: string;
  readonly p_state: ArenaProjectionState;
  readonly p_state_hash: string;
}

interface PendingProjectionWrite {
  readonly newLastStreamSeq: string;
  readonly arguments: ProjectionRpcArguments;
}

export interface ArenaEventInput {
  eventType: string;
  payload: EventPayload;
  eventTime?: string;
  actorKind?: ActorKind;
  actorId?: string;
  idempotencyKey?: string;
}

export interface PersistedArenaEvent {
  eventId: string;
  eventSeq: string;
}

export interface ArenaDescendantInput {
  sessionId: string;
  parentSessionId: string;
  agentIdentity: string;
  agentPath: string;
  startedAt: string;
}

export interface ArenaAttemptInput {
  sessionId: string;
  turn: number;
  step: number;
  attempt: number;
  provider: string;
  model: string;
  requestStartedAt: string;
  completedAt: string;
  pricingId: string;
  pricingVersion: string;
  frozenUsage: FrozenHarnessUsage;
}

export interface PersistedArenaAttempt extends PersistedArenaEvent {
  costStatus: "estimated" | "unpriced" | "unavailable";
  estimatedCost: string | null;
  pricingVersion: string | null;
}

export interface PersistedArenaSubmission extends PersistedArenaEvent {
  submissionId: string;
  acceptedAt: string;
}

function firstRow<T>(value: unknown, operation: string): T {
  const row = Array.isArray(value) ? value[0] : value;
  if (row === null || typeof row !== "object") {
    throw new Error(`${operation} returned no row`);
  }
  return row as T;
}

function databaseFailure(operation: string, error: { message: string }): Error {
  return new Error(`${operation} failed: ${error.message}`);
}

function isDuplicateStorageError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { statusCode?: string | number; message?: string };
  return Number(candidate.statusCode) === 409
    || /already exists|duplicate/i.test(candidate.message ?? "");
}

async function verifyExistingArtifact(
  client: SupabaseClient,
  material: ArenaArtifactMaterial,
): Promise<void> {
  const { data, error } = await client.storage
    .from(PRIVATE_ARTIFACT_BUCKET)
    .download(material.objectPath);
  if (error) throw databaseFailure("download existing Arena artifact", error);
  const bytes = new Uint8Array(await data.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== material.sha256) {
    throw new Error("content-addressed Arena artifact exists with a different hash");
  }
}

async function uploadArtifact(
  client: SupabaseClient,
  material: ArenaArtifactMaterial,
): Promise<void> {
  const { error } = await client.storage
    .from(PRIVATE_ARTIFACT_BUCKET)
    .upload(material.objectPath, Buffer.from(material.content), {
      contentType: "application/json",
      upsert: false,
    });
  if (error === null) return;
  if (!isDuplicateStorageError(error)) {
    throw databaseFailure("upload Arena artifact", error);
  }
  await verifyExistingArtifact(client, material);
}

function sequence(value: string | number): string {
  return String(value);
}

function nextSequence(value: string): string {
  return (BigInt(value) + 1n).toString();
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function frozenClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/**
 * Stateful, single-invocation persistence boundary. Calls must be serialized by
 * the runtime so the optimistic run/projection sequence remains exact.
 */
export class SupabaseArenaRepository {
  readonly #client: SupabaseClient;
  readonly #workerId: string;
  #identity: PreparedArenaInvocation["identity"] | undefined;
  #runStreamSeq = "0";
  #projectionStreamSeq = "0";
  #eventCounter = 0n;
  #pendingProjection: PendingProjectionWrite | undefined;
  #submissionAttempt:
    | {
        canonical: string;
        submissionId: string;
        acceptedAt: string;
      }
    | undefined;

  constructor(url: string, secretKey: string, workerId: string) {
    this.#client = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    this.#workerId = workerId;
  }

  async latestMarketSnapshot(): Promise<ArenaMarketSnapshot> {
    const snapshotResult = await this.#client
      .from("market_snapshot")
      .select(
        "snapshot_id,source_version_id,manifest_sha256,cutoff_at,target_session_date,selection_policy,sealed_at,symbols",
      )
      .order("sealed_at", { ascending: false })
      .order("snapshot_id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (snapshotResult.error) {
      throw databaseFailure("read latest market snapshot", snapshotResult.error);
    }
    if (snapshotResult.data === null) {
      throw new Error("no sealed real market snapshot is available");
    }
    const snapshot = snapshotResult.data as MarketSnapshotRow;

    const membersResult = await this.#client
      .from("market_snapshot_member")
      .select("symbol,member_index,fact_id")
      .eq("snapshot_id", snapshot.snapshot_id)
      .order("member_index", { ascending: true });
    if (membersResult.error) {
      throw databaseFailure("read market snapshot members", membersResult.error);
    }
    const members = (membersResult.data ?? []) as MarketSnapshotMemberRow[];
    if (members.length === 0 || members.length !== snapshot.symbols.length) {
      throw new Error("latest market snapshot is incomplete");
    }

    const factsResult = await this.#client
      .from("market_bar_fact")
      .select(
        "fact_id,symbol,bar_start,bar_date,currency,open_price,high_price,low_price,close_price,volume,trade_count,vwap,fact_sha256",
      )
      .in("fact_id", members.map((member) => member.fact_id));
    if (factsResult.error) {
      throw databaseFailure("read market snapshot facts", factsResult.error);
    }
    const factsById = new Map(
      ((factsResult.data ?? []) as MarketBarFactRow[]).map((fact) => [fact.fact_id, fact]),
    );
    const bars = members.map((member) => {
      const fact = factsById.get(member.fact_id);
      if (fact === undefined || fact.symbol !== member.symbol) {
        throw new Error(`market snapshot fact is missing or mismatched for ${member.symbol}`);
      }
      return Object.freeze({
        factId: fact.fact_id,
        symbol: fact.symbol,
        barStart: fact.bar_start,
        barDate: fact.bar_date,
        currency: fact.currency,
        openPrice: fact.open_price,
        highPrice: fact.high_price,
        lowPrice: fact.low_price,
        closePrice: fact.close_price,
        volume: fact.volume,
        tradeCount: fact.trade_count,
        vwap: fact.vwap,
        factSha256: fact.fact_sha256,
      });
    });
    if (bars.some((bar, index) => bar.symbol !== snapshot.symbols[index])) {
      throw new Error("market snapshot member order does not match its sealed symbol order");
    }

    return Object.freeze({
      snapshotId: snapshot.snapshot_id,
      sourceVersionId: snapshot.source_version_id,
      manifestSha256: snapshot.manifest_sha256,
      cutoffAt: snapshot.cutoff_at,
      targetSessionDate: snapshot.target_session_date,
      selectionPolicy: snapshot.selection_policy,
      sealedAt: snapshot.sealed_at,
      symbols: Object.freeze([...snapshot.symbols]),
      bars: Object.freeze(bars),
    });
  }

  async prepareInvocation(inputs: BuiltArenaInputs): Promise<PreparedArenaInvocation> {
    if (this.#identity !== undefined) {
      throw new Error("Arena repository already owns an invocation");
    }
    await Promise.all([
      uploadArtifact(this.#client, inputs.packetArtifact),
      uploadArtifact(this.#client, inputs.bundleArtifact),
    ]);

    const staged = await this.#appendRawEvent({
      streamId: inputs.identity.runId,
      decisionId: inputs.identity.decisionId,
      expectedSeq: "0",
      eventType: "decision.inputs_staged",
      eventTime: inputs.identity.decisionAt,
      payload: {
        decisionId: inputs.identity.decisionId,
        packetSha256: inputs.packetArtifact.sha256,
        bundleSha256: inputs.bundleArtifact.sha256,
        marketSnapshotId: inputs.identity.snapshotId,
      },
    });
    this.#runStreamSeq = staged.eventSeq;

    const packetArtifact = await this.#registerArtifact({
      inputs,
      sourceEventId: staged.eventId,
      runScoped: true,
      material: inputs.packetArtifact,
      artifactKind: "decision_packet",
      metadata: {
        schema: "twofold.decision_packet/v1",
        decisionId: inputs.identity.decisionId,
        decisionPacketId: inputs.identity.decisionPacketId,
        marketSnapshotId: inputs.identity.snapshotId,
        marketManifestSha256: inputs.packet.payload.market_snapshot === undefined
          ? ""
          : (inputs.packet.payload.market_snapshot as { manifest_sha256?: string }).manifest_sha256 ?? "",
      },
    });
    const bundleArtifact = await this.#registerArtifact({
      inputs,
      sourceEventId: null,
      runScoped: false,
      material: inputs.bundleArtifact,
      artifactKind: "dsh_agent_bundle_manifest",
      metadata: {
        schema: "twofold.dsh_agent_bundle_manifest/v1",
        bundleId: inputs.identity.bundleId,
        presetId: inputs.identity.presetId,
        provider: inputs.identity.provider,
        model: inputs.identity.model,
      },
    });

    const openedAt = new Date().toISOString();
    const invocationResult = await this.#client.rpc("open_decision_invocation", {
      p_idempotency_key: `arena:${inputs.identity.decisionId}:open`,
      p_decision_id: inputs.identity.decisionId,
      p_run_id: inputs.identity.runId,
      p_season_id: inputs.identity.seasonId,
      p_expected_run_stream_seq: this.#runStreamSeq,
      p_root_harness_session_id: inputs.identity.rootSessionId,
      p_root_agent_identity: inputs.identity.presetId,
      p_packet_artifact_id: packetArtifact.artifact_id,
      p_agent_bundle_artifact_id: bundleArtifact.artifact_id,
      p_market_snapshot_id: inputs.identity.snapshotId,
      p_decision_at: inputs.identity.decisionAt,
      p_data_cutoff_at: inputs.identity.dataCutoffAt,
      p_submission_deadline_at: inputs.identity.submissionDeadlineAt,
      p_trigger_reasons: ["manual_dogfood"],
      p_opened_at: openedAt,
      p_recorded_by: this.#workerId,
    });
    if (invocationResult.error) {
      throw databaseFailure("open_decision_invocation", invocationResult.error);
    }
    const invocation = firstRow<InvocationRow>(
      invocationResult.data,
      "open_decision_invocation",
    );
    this.#runStreamSeq = sequence(invocation.source_stream_seq);

    const identity = Object.freeze({
      ...inputs.identity,
      packetArtifactId: packetArtifact.artifact_id,
      bundleArtifactId: bundleArtifact.artifact_id,
    });
    this.#identity = identity;
    inputs.projection.updatedAt = openedAt;
    inputs.projection.decision.startedAt = openedAt;
    inputs.projection.agents[0]!.startedAt = openedAt;
    await this.project(inputs.projection);

    return Object.freeze({
      identity,
      packet: inputs.packet,
      projection: inputs.projection,
      runStreamSeq: this.#runStreamSeq,
      projectionStreamSeq: this.#projectionStreamSeq,
    });
  }

  async appendEvent(input: ArenaEventInput): Promise<PersistedArenaEvent> {
    const identity = this.#requireIdentity();
    const event = await this.#appendRawEvent({
      streamId: identity.runId,
      decisionId: identity.decisionId,
      expectedSeq: this.#runStreamSeq,
      eventType: input.eventType,
      eventTime: input.eventTime ?? new Date().toISOString(),
      payload: input.payload,
      ...(input.actorKind === undefined ? {} : { actorKind: input.actorKind }),
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
    });
    this.#runStreamSeq = event.eventSeq;
    return event;
  }

  async project(state: ArenaProjectionState): Promise<void> {
    const identity = this.#requireIdentity();
    await this.#flushPendingProjection();
    if (BigInt(this.#runStreamSeq) <= BigInt(this.#projectionStreamSeq)) return;
    state.updatedAt = new Date().toISOString();
    const stateSnapshot = frozenClone(state);
    assertJsonValue(stateSnapshot);
    const serialized = canonicalJson(stateSnapshot);
    const newLastStreamSeq = this.#runStreamSeq;
    const headResult = await this.#client
      .from("event_stream")
      .select("event_id,stream_seq")
      .eq("stream_id", identity.runId)
      .eq("stream_seq", newLastStreamSeq)
      .single();
    if (headResult.error) throw databaseFailure("read Arena run head", headResult.error);
    const head = headResult.data as EventRow;
    const args = Object.freeze({
      p_projection_name: ARENA_PROJECTION_NAME,
      p_entity_id: identity.decisionId,
      p_stream_id: identity.runId,
      p_expected_last_stream_seq: this.#projectionStreamSeq,
      p_new_last_stream_seq: newLastStreamSeq,
      p_last_event_id: head.event_id,
      p_state: stateSnapshot,
      p_state_hash: createHash("sha256").update(serialized).digest("hex"),
    });
    this.#pendingProjection = Object.freeze({
      newLastStreamSeq,
      arguments: args,
    });
    await this.#flushPendingProjection();
  }

  async registerDescendant(input: ArenaDescendantInput): Promise<{
    eventId: string;
    eventSeq: string;
    depth: string;
  }> {
    const identity = this.#requireIdentity();
    const result = await this.#client.rpc("register_descendant_session", {
      p_idempotency_key: `arena:${identity.decisionId}:session:${input.sessionId}`,
      p_root_harness_session_id: identity.rootSessionId,
      p_parent_harness_session_id: input.parentSessionId,
      p_harness_session_id: input.sessionId,
      p_agent_identity: input.agentIdentity,
      p_agent_path: input.agentPath,
      p_started_at: input.startedAt,
      p_expected_run_stream_seq: this.#runStreamSeq,
      p_recorded_by: this.#workerId,
    });
    if (result.error) throw databaseFailure("register_descendant_session", result.error);
    const row = firstRow<LineageRow>(result.data, "register_descendant_session");
    this.#runStreamSeq = sequence(row.source_stream_seq);
    return {
      eventId: row.source_event_id,
      eventSeq: this.#runStreamSeq,
      depth: sequence(row.depth),
    };
  }

  async quoteAttempt(input: {
    provider: string;
    model: string;
    requestStartedAt: string;
    maxInputTokens: string;
    maxOutputTokens: string;
  }): Promise<ArenaCostQuote | null> {
    const pricing = await this.#pricingFor(
      input.provider,
      input.model,
      input.requestStartedAt,
    );
    if (pricing === null) return null;
    return quoteArenaAttempt({ row: pricing, ...input });
  }

  async recordAttempt(input: ArenaAttemptInput): Promise<PersistedArenaAttempt> {
    const identity = this.#requireIdentity();
    const completedAt = input.completedAt;
    const requestStartedAt = input.requestStartedAt;
    const attemptKey = [
      encodeURIComponent(input.sessionId),
      String(input.turn),
      String(input.step),
      String(input.attempt),
    ].join(":");
    const event = await this.appendEvent({
      eventType: "decision.model_attempt_recorded",
      eventTime: completedAt,
      actorKind: "model",
      actorId: input.sessionId,
      idempotencyKey: `arena:${identity.decisionId}:model-attempt:${attemptKey}`,
      payload: {
        decisionId: identity.decisionId,
        harnessSessionId: input.sessionId,
        turn: String(input.turn),
        step: String(input.step),
        attempt: String(input.attempt),
        provider: input.provider,
        model: input.model,
        usageStatus: input.frozenUsage.usageStatus,
        usageSource: input.frozenUsage.usageSource,
        harnessEventSeq: input.frozenUsage.harnessEventSeq,
      },
    });
    const usage = input.frozenUsage.usageStatus === "captured"
      ? input.frozenUsage.usage
      : undefined;
    const usageArguments = Object.freeze({
      p_idempotency_key:
        `arena:${identity.decisionId}:usage:${input.sessionId}:${input.turn}:${input.step}:${input.attempt}`,
      p_run_id: identity.runId,
      p_season_id: identity.seasonId,
      p_decision_id: identity.decisionId,
      p_harness_session_id: input.sessionId,
      p_turn_index: String(input.turn),
      p_step_index: String(input.step),
      p_attempt_index: String(input.attempt),
      p_provider: input.provider,
      p_model: input.model,
      p_request_started_at: requestStartedAt,
      p_completed_at: completedAt,
      p_usage_status: input.frozenUsage.usageStatus,
      p_usage_source: input.frozenUsage.usageSource,
      p_uncached_input_tokens: usage?.uncachedInputTokens ?? null,
      p_cache_read_tokens: usage?.cacheReadTokens ?? null,
      p_cache_write_tokens: usage?.cacheWriteTokens ?? null,
      p_output_tokens: usage?.outputTokens ?? null,
      p_reasoning_tokens: usage?.reasoningTokens ?? null,
      p_recorded_by: this.#workerId,
      p_provider_request_id: null,
      p_pricing_id: usage === undefined ? null : input.pricingId,
      p_source_event_id: event.eventId,
      p_harness_artifact_id: null,
      p_harness_event_seq: input.frozenUsage.harnessEventSeq,
    });
    const usageResult = await retryExactRpcOnce(
      () => this.#client.rpc("register_model_usage", usageArguments),
    );
    if (usageResult.error) throw databaseFailure("register_model_usage", usageResult.error);
    const row = firstRow<ModelUsageRow>(usageResult.data, "register_model_usage");
    return {
      ...event,
      costStatus: row.cost_status,
      estimatedCost: row.estimated_cost === null ? null : String(row.estimated_cost),
      pricingVersion: usage === undefined ? null : input.pricingVersion,
    };
  }

  async acceptSubmission(
    submission: PortfolioTargetsSubmission,
  ): Promise<PersistedArenaSubmission> {
    const identity = this.#requireIdentity();
    if (submission.session_id !== identity.rootSessionId) {
      throw new Error("only the bound root Harness Session may submit portfolio targets");
    }
    if (
      submission.decision_packet_id !== identity.decisionPacketId
      || submission.packet_sha256 !== identity.packetSha256
    ) {
      throw new Error("submission decision packet fence does not match this invocation");
    }
    const canonical = canonicalJson(submission);
    if (
      this.#submissionAttempt !== undefined
      && this.#submissionAttempt.canonical !== canonical
    ) {
      throw new Error("Arena repository already attempted a different target submission");
    }
    this.#submissionAttempt ??= {
      canonical,
      submissionId: randomUUID(),
      acceptedAt: new Date().toISOString(),
    };
    const { submissionId, acceptedAt } = this.#submissionAttempt;
    const result = await this.#client.rpc("accept_portfolio_targets", {
      // Stable across a transport-level retry. The RPC also compares every
      // material field, so reusing this key with different content fails closed.
      p_idempotency_key: `arena:${identity.decisionId}:submission`,
      p_submission_id: submissionId,
      p_root_harness_session_id: identity.rootSessionId,
      p_packet_artifact_id: identity.packetArtifactId,
      p_packet_sha256: identity.packetSha256,
      p_targets: submission.targets,
      p_cash_weight_bps: submission.cash_weight_bps,
      p_decision_summary: submission.decision_summary,
      p_accepted_at: acceptedAt,
      p_expected_run_stream_seq: this.#runStreamSeq,
      p_recorded_by: this.#workerId,
    });
    if (result.error) throw databaseFailure("accept_portfolio_targets", result.error);
    const row = firstRow<SubmissionRow>(result.data, "accept_portfolio_targets");
    this.#runStreamSeq = sequence(row.source_stream_seq);
    return {
      submissionId: row.submission_id,
      acceptedAt: row.accepted_at,
      eventId: row.source_event_id,
      eventSeq: this.#runStreamSeq,
    };
  }

  async #registerArtifact(input: {
    inputs: BuiltArenaInputs;
    sourceEventId: string | null;
    runScoped: boolean;
    material: ArenaArtifactMaterial;
    artifactKind: string;
    metadata: EventPayload;
  }): Promise<ArtifactRow> {
    assertJsonValue(input.metadata);
    const result = await this.#client.rpc("register_artifact", {
      p_idempotency_key: `arena:${input.artifactKind}:${input.material.sha256}`,
      p_run_id: input.runScoped ? input.inputs.identity.runId : null,
      p_season_id: input.inputs.identity.seasonId,
      p_source_event_id: input.sourceEventId,
      p_artifact_kind: input.artifactKind,
      p_storage_bucket: PRIVATE_ARTIFACT_BUCKET,
      p_object_path: input.material.objectPath,
      p_content_type: "application/json",
      p_byte_size: input.material.byteSize,
      p_sha256: input.material.sha256,
      // A reusable content-addressed Bundle must resolve identically when a
      // different worker later runs the same bytes. Run-scoped packet authors
      // remain attributable to the concrete worker.
      p_created_by: input.runScoped ? this.#workerId : "twofold-bundle-registry",
      p_metadata: input.metadata,
      p_supersedes_artifact_id: null,
    });
    if (result.error) throw databaseFailure("register_artifact", result.error);
    return firstRow<ArtifactRow>(result.data, "register_artifact");
  }

  async #appendRawEvent(input: {
    streamId: string;
    decisionId: string;
    expectedSeq: string;
    eventType: string;
    eventTime: string;
    payload: EventPayload;
    actorKind?: ActorKind;
    actorId?: string;
    idempotencyKey?: string;
  }): Promise<PersistedArenaEvent> {
    const payload = frozenClone(input.payload);
    assertJsonValue(payload);
    const next = nextSequence(input.expectedSeq);
    let idempotencyKey = input.idempotencyKey;
    if (idempotencyKey === undefined) {
      this.#eventCounter += 1n;
      idempotencyKey =
        `arena:${input.decisionId}:event:${next}:${this.#eventCounter.toString()}`;
    }
    const args = Object.freeze({
      p_stream_id: input.streamId,
      p_stream_type: "run",
      p_expected_stream_seq: input.expectedSeq,
      p_event_type: input.eventType,
      p_schema_version: "1",
      p_idempotency_key: idempotencyKey,
      p_actor_kind: input.actorKind ?? "worker",
      p_actor_id: input.actorId ?? this.#workerId,
      p_event_time: input.eventTime,
      p_payload: payload,
      p_metadata: Object.freeze({}),
      p_correlation_id: input.decisionId,
    });
    const result = await retryExactRpcOnce(
      () => this.#client.rpc("append_event", args),
    );
    if (result.error) throw databaseFailure("append_event", result.error);
    const row = firstRow<EventRow>(result.data, "append_event");
    return { eventId: row.event_id, eventSeq: sequence(row.stream_seq) };
  }

  async #flushPendingProjection(): Promise<void> {
    const pending = this.#pendingProjection;
    if (pending === undefined) return;
    const result = await retryExactRpcOnce(
      () => this.#client.rpc("put_projection", pending.arguments),
    );
    if (result.error) throw databaseFailure("put_projection", result.error);
    this.#projectionStreamSeq = pending.newLastStreamSeq;
    if (this.#pendingProjection === pending) {
      this.#pendingProjection = undefined;
    }
  }

  async #pricingFor(
    provider: string,
    model: string,
    requestStartedAt: string,
  ): Promise<ArenaPricingRow | null> {
    const band = provider === "deepseek-official" && model === "deepseek-v4-pro"
      ? deepseekPricingBandAt(requestStartedAt)
      : null;
    if (band === null) return null;
    const result = await this.#client
      .from("model_pricing_version")
      .select(
        "pricing_id,pricing_version,pricing_band,selection_rule,provider,model,currency,unit_tokens,uncached_input_rate,cache_read_rate,cache_write_rate,output_rate,effective_from,effective_to",
      )
      .eq("provider", provider)
      .eq("model", model)
      .eq("pricing_band", band)
      .eq("selection_rule", DEEPSEEK_WEEKDAY_UTC_PRICING_RULE)
      .eq("currency", "USD")
      .lte("effective_from", requestStartedAt)
      .or(`effective_to.is.null,effective_to.gt.${requestStartedAt}`)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (result.error) throw databaseFailure("lookup model pricing", result.error);
    return result.data as ArenaPricingRow | null;
  }

  #requireIdentity(): PreparedArenaInvocation["identity"] {
    if (this.#identity === undefined) {
      throw new Error("Arena invocation has not been prepared");
    }
    return this.#identity;
  }
}
