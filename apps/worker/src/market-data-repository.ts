import { createHash } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  MARKET_SELECTION_POLICY,
  PRIVATE_ARTIFACT_BUCKET,
  type AlpacaMarketDelivery,
} from "./market-data.js";

interface SourceVersionRow {
  readonly source_version_id: string;
}

interface DeliveryRow {
  readonly delivery_id: string;
}

interface SnapshotRow {
  readonly snapshot_id: string;
  readonly manifest_sha256: string;
  readonly sealed_at: string;
}

export interface PersistedMarketDelivery {
  readonly sourceVersionId: string;
  readonly deliveryId: string;
  readonly snapshotId: string;
  readonly snapshotManifestSha256: string;
  readonly snapshotAvailableAt: string;
}

function firstRow<T>(value: unknown, operation: string): T {
  const row = Array.isArray(value) ? value[0] : value;
  if (row === null || typeof row !== "object") {
    throw new Error(`${operation} returned no row`);
  }
  return row as T;
}

function isDuplicateStorageError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { statusCode?: string | number; message?: string };
  return Number(candidate.statusCode) === 409
    || /already exists|duplicate/i.test(candidate.message ?? "");
}

async function verifyExistingArtifact(
  client: SupabaseClient,
  delivery: AlpacaMarketDelivery,
): Promise<void> {
  const { data, error } = await client.storage
    .from(PRIVATE_ARTIFACT_BUCKET)
    .download(delivery.objectPath);
  if (error) throw new Error(`download existing raw artifact failed: ${error.message}`);
  const bytes = new Uint8Array(await data.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== delivery.responseSha256) {
    throw new Error("content-addressed raw artifact exists with a different hash");
  }
}

export class SupabaseMarketDataRepository {
  readonly #client: SupabaseClient;

  constructor(url: string, secretKey: string) {
    this.#client = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async persist(delivery: AlpacaMarketDelivery): Promise<PersistedMarketDelivery> {
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
    if (sourceResult.error) {
      throw new Error(`register_data_source_version failed: ${sourceResult.error.message}`);
    }
    const source = firstRow<SourceVersionRow>(
      sourceResult.data,
      "register_data_source_version",
    );

    const uploadResult = await this.#client.storage
      .from(PRIVATE_ARTIFACT_BUCKET)
      .upload(delivery.objectPath, Buffer.from(delivery.rawBody), {
        contentType: delivery.contentType,
        upsert: false,
      });
    if (uploadResult.error) {
      if (!isDuplicateStorageError(uploadResult.error)) {
        throw new Error(`upload raw artifact failed: ${uploadResult.error.message}`);
      }
      await verifyExistingArtifact(this.#client, delivery);
    }

    const deliveryResult = await this.#client.rpc("register_market_delivery", {
      p_idempotency_key: delivery.idempotencyKey,
      p_source_version_id: source.source_version_id,
      p_request_fingerprint: delivery.requestFingerprint,
      p_provider_request_id: delivery.providerRequestId ?? null,
      p_http_status: delivery.httpStatus,
      p_retrieved_at: delivery.retrievedAt,
      p_first_observed_at: delivery.firstObservedAt,
      p_available_at: delivery.availableAt,
      p_storage_bucket: PRIVATE_ARTIFACT_BUCKET,
      p_object_path: delivery.objectPath,
      p_content_type: delivery.contentType,
      p_byte_size: delivery.byteSize,
      p_response_sha256: delivery.responseSha256,
      p_normalized_manifest_sha256: delivery.normalizedManifestSha256,
      p_etag: delivery.etag ?? null,
      p_last_modified: delivery.lastModified ?? null,
      p_facts: delivery.facts,
    });
    if (deliveryResult.error) {
      throw new Error(`register_market_delivery failed: ${deliveryResult.error.message}`);
    }
    const persistedDelivery = firstRow<DeliveryRow>(
      deliveryResult.data,
      "register_market_delivery",
    );

    const snapshotResult = await this.#client.rpc("seal_market_snapshot", {
      p_idempotency_key:
        `market-snapshot:${source.source_version_id}:${delivery.targetSessionDate}:`
        + `${delivery.cutoffAt}:`
        + delivery.symbols.join(","),
      p_source_version_id: source.source_version_id,
      p_snapshot_kind: "market_close",
      p_cutoff_at: delivery.cutoffAt,
      p_target_session_date: delivery.targetSessionDate,
      p_symbols: delivery.symbols,
      p_selection_policy: MARKET_SELECTION_POLICY,
    });
    if (snapshotResult.error) {
      throw new Error(`seal_market_snapshot failed: ${snapshotResult.error.message}`);
    }
    const snapshot = firstRow<SnapshotRow>(snapshotResult.data, "seal_market_snapshot");

    return Object.freeze({
      sourceVersionId: source.source_version_id,
      deliveryId: persistedDelivery.delivery_id,
      snapshotId: snapshot.snapshot_id,
      snapshotManifestSha256: snapshot.manifest_sha256,
      // PostgreSQL keeps microseconds while JavaScript timestamps keep
      // milliseconds. Advance one millisecond so a Round can never predate
      // the exact immutable seal instant after precision conversion.
      snapshotAvailableAt: new Date(
        Date.parse(snapshot.sealed_at) + 1,
      ).toISOString(),
    });
  }
}
