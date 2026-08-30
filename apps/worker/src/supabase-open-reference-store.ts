import { createHash } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { AlpacaOpenReferenceDelivery } from "./alpaca-open-reference.js";
import type { AlpacaOpenReferenceMethod } from "./alpaca-open-reference.js";
import type {
  ArenaOpenReferenceRoundSchedule,
  ArenaOpenReferenceStore,
} from "./arena-open-reference-handler.js";
import {
  parseArenaOpenReference,
  registerArenaOpenReferenceExact,
  type ArenaOpenReference,
  type ArenaOpenReferenceStage,
} from "./arena-open-reference-repository.js";

interface SourceVersionRow {
  readonly source_version_id: string;
}

interface RoundRow {
  readonly round_id: string;
  readonly season_id: string;
  readonly decision_snapshot_id: string;
  readonly s1_session_date: string;
  readonly s1_open_at: string;
  readonly s1_reference_available_at: string;
  readonly s2_session_date: string;
  readonly s2_open_at: string;
  readonly s2_reference_available_at: string;
}

function isDuplicateStorageError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { statusCode?: string | number; message?: string };
  return Number(candidate.statusCode) === 409
    || /already exists|duplicate/i.test(candidate.message ?? "");
}

export class SupabaseArenaOpenReferenceStore implements ArenaOpenReferenceStore {
  readonly #client: SupabaseClient;
  readonly #workerId: string;

  constructor(url: string, secretKey: string, workerId: string) {
    this.#client = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    this.#workerId = workerId;
  }

  async load(
    roundId: string,
    stage: ArenaOpenReferenceStage,
  ): Promise<ArenaOpenReference | null> {
    const result = await this.#client.rpc("get_arena_round_open_reference", {
      p_round_id: roundId,
      p_stage: stage,
    });
    if (result.error !== null) {
      throw new Error(`get_arena_round_open_reference failed: ${result.error.message}`);
    }
    return result.data === null ? null : parseArenaOpenReference(result.data);
  }

  async schedule(roundId: string): Promise<ArenaOpenReferenceRoundSchedule> {
    const round = await this.#round(roundId);
    const [snapshot, policy] = await Promise.all([
      this.#client.from("market_snapshot")
        .select("symbols")
        .eq("snapshot_id", round.decision_snapshot_id)
        .single(),
      this.#client.from("arena_execution_rulebook")
        .select("rulebook")
        .eq("season_id", round.season_id)
        .single(),
    ]);
    if (snapshot.error !== null) {
      throw new Error(`read Round universe failed: ${snapshot.error.message}`);
    }
    if (!Array.isArray(snapshot.data.symbols)) {
      throw new TypeError("Round market snapshot has no symbol universe");
    }
    if (policy.error !== null) {
      throw new Error(`read Arena execution rulebook failed: ${policy.error.message}`);
    }
    const openReferenceMethod = rulebookMethod(policy.data.rulebook);
    return Object.freeze({
      roundId: round.round_id,
      symbols: Object.freeze(snapshot.data.symbols.map((symbol: unknown) => {
        if (typeof symbol !== "string") {
          throw new TypeError("Round universe contains a non-string symbol");
        }
        return symbol;
      })),
      openReferenceMethod,
      s1SessionDate: round.s1_session_date,
      s1OpenAt: new Date(round.s1_open_at).toISOString(),
      s1ReferenceAvailableAt:
        new Date(round.s1_reference_available_at).toISOString(),
      s2SessionDate: round.s2_session_date,
      s2OpenAt: new Date(round.s2_open_at).toISOString(),
      s2ReferenceAvailableAt:
        new Date(round.s2_reference_available_at).toISOString(),
    });
  }

  async persist(
    roundId: string,
    stage: ArenaOpenReferenceStage,
    delivery: AlpacaOpenReferenceDelivery,
  ): Promise<ArenaOpenReference> {
    const round = await this.#round(roundId);
    const sourceResult = await this.#client.rpc("register_data_source_version", {
      p_provider: delivery.source.provider,
      p_dataset: delivery.source.dataset,
      p_version_key: delivery.source.versionKey,
      p_endpoint_base_url: delivery.source.endpointBaseUrl,
      p_feed: delivery.source.feed,
      p_adjustment: delivery.source.adjustment,
      p_timeframe: delivery.source.timeframe,
      p_normalizer_version: delivery.source.normalizerVersion,
      p_license_scope: delivery.source.licenseScope,
      p_config_sha256: delivery.source.configSha256,
      p_effective_from: delivery.source.effectiveFrom,
    });
    if (sourceResult.error !== null) {
      throw new Error(`register_data_source_version failed: ${sourceResult.error.message}`);
    }
    const source = firstRow<SourceVersionRow>(
      sourceResult.data,
      "register_data_source_version",
    );

    const upload = await this.#client.storage
      .from(delivery.storageBucket)
      .upload(delivery.objectPath, Buffer.from(delivery.rawBody), {
        contentType: "application/json",
        upsert: false,
      });
    if (upload.error !== null) {
      if (!isDuplicateStorageError(upload.error)) {
        throw new Error(`upload open-reference artifact failed: ${upload.error.message}`);
      }
      await this.#verifyExistingArtifact(delivery);
    }
    const arguments_ = {
      p_idempotency_key: `arena-open-reference:${roundId}:${stage}`,
      p_round_id: roundId,
      p_stage: stage,
      p_source_version_id: source.source_version_id,
      p_storage_bucket: delivery.storageBucket,
      p_object_path: delivery.objectPath,
      p_byte_size: delivery.byteSize,
      p_response_sha256: delivery.responseSha256,
      p_canonical_json: delivery.canonicalJson,
      p_recorded_by: this.#workerId,
    } as const;
    try {
      return await registerArenaOpenReferenceExact(
        this.#client as never,
        arguments_,
        { seasonId: round.season_id, delivery },
      );
    } catch (error) {
      // Two entrant-scoped queue items may race to capture the same shared
      // Round stage. The winner is authoritative; the loser re-reads it.
      const winner = await this.load(roundId, stage);
      if (winner !== null) return winner;
      throw error;
    }
  }

  async #round(roundId: string): Promise<RoundRow> {
    const result = await this.#client.from("arena_round")
      .select(
        "round_id,season_id,decision_snapshot_id,s1_session_date,s1_open_at,s1_reference_available_at,s2_session_date,s2_open_at,s2_reference_available_at",
      )
      .eq("round_id", roundId)
      .single();
    if (result.error !== null) {
      throw new Error(`read Arena Round schedule failed: ${result.error.message}`);
    }
    return result.data as RoundRow;
  }

  async #verifyExistingArtifact(delivery: AlpacaOpenReferenceDelivery): Promise<void> {
    const result = await this.#client.storage
      .from(delivery.storageBucket)
      .download(delivery.objectPath);
    if (result.error !== null) {
      throw new Error(`download existing open-reference artifact failed: ${result.error.message}`);
    }
    const bytes = new Uint8Array(await result.data.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== delivery.responseSha256) {
      throw new Error("content-addressed open-reference artifact hash changed");
    }
  }
}

function rulebookMethod(value: unknown): AlpacaOpenReferenceMethod {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Arena execution rulebook must be an object");
  }
  const method = (value as Record<string, unknown>).openReferenceMethod;
  if (
    method !== "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE"
    && method !== "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE"
  ) {
    throw new TypeError("Arena execution rulebook has unsupported open-reference method");
  }
  return method;
}

function firstRow<T>(value: unknown, operation: string): T {
  const row = Array.isArray(value) ? value[0] : value;
  if (row === null || typeof row !== "object") {
    throw new Error(`${operation} returned no row`);
  }
  return row as T;
}
