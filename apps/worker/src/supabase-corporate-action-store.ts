import { createHash } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { AlpacaCorporateActionScan } from
  "./alpaca-corporate-actions.js";
import type { CorporateActionScanStore } from
  "./corporate-action-scanner.js";
import {
  registerCorporateActionScanExact,
  type CorporateActionScanCommitResult,
} from "./corporate-action-repository.js";

interface SourceVersionRow {
  readonly source_version_id: string;
}

interface SeasonRow {
  readonly season_id: string;
}

interface RoundRow {
  readonly decision_snapshot_id: string;
}

interface SnapshotRow {
  readonly symbols: unknown;
}

export class SupabaseCorporateActionStore implements CorporateActionScanStore {
  readonly #client: SupabaseClient;
  readonly #workerId: string;

  constructor(url: string, secretKey: string, workerId: string) {
    this.#client = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    this.#workerId = workerId;
  }

  async latestObservedAt(): Promise<string | null> {
    const response = await this.#client.rpc(
      "get_latest_corporate_action_scan_observed_at",
    );
    if (response.error !== null) {
      throw new Error(
        `load corporate-action scan cadence failed: ${response.error.message}`,
      );
    }
    if (response.data === null) return null;
    if (typeof response.data !== "string") {
      throw new TypeError("corporate-action scan cadence returned a non-instant");
    }
    return response.data;
  }

  async activeSymbols(asOf: string): Promise<readonly string[]> {
    const instant = new Date(asOf);
    if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== asOf) {
      throw new TypeError("active-season symbol as-of must be an ISO instant");
    }
    const seasons = await this.#client.from("arena_season")
      .select("season_id")
      .lte("opens_at", asOf)
      .gt("closes_at", asOf);
    if (seasons.error !== null) {
      throw new Error(`load active Arena seasons failed: ${seasons.error.message}`);
    }
    const seasonIds = (seasons.data as SeasonRow[]).map((row) => row.season_id);
    if (seasonIds.length === 0) return Object.freeze([]);
    const rounds = await this.#client.from("arena_round")
      .select("decision_snapshot_id")
      .in("season_id", seasonIds);
    if (rounds.error !== null) {
      throw new Error(`load active Arena Round universes failed: ${rounds.error.message}`);
    }
    const snapshotIds = [...new Set((rounds.data as RoundRow[])
      .map((row) => row.decision_snapshot_id))];
    if (snapshotIds.length === 0) return Object.freeze([]);
    const snapshots = await this.#client.from("market_snapshot")
      .select("symbols")
      .in("snapshot_id", snapshotIds);
    if (snapshots.error !== null) {
      throw new Error(`load active market snapshots failed: ${snapshots.error.message}`);
    }
    const symbols = new Set<string>();
    for (const row of snapshots.data as SnapshotRow[]) {
      if (!Array.isArray(row.symbols)) {
        throw new TypeError("active market snapshot has no symbol universe");
      }
      for (const symbol of row.symbols) {
        if (typeof symbol !== "string") {
          throw new TypeError("active market snapshot contains a non-string symbol");
        }
        symbols.add(symbol);
      }
    }
    return Object.freeze([...symbols].sort((left, right) =>
      left.localeCompare(right, "en")));
  }

  async persist(
    scan: AlpacaCorporateActionScan,
  ): Promise<CorporateActionScanCommitResult> {
    const sourceResponse = await this.#client.rpc(
      "register_data_source_version",
      {
        p_provider: scan.source.provider,
        p_dataset: scan.source.dataset,
        p_version_key: scan.source.versionKey,
        p_endpoint_base_url: scan.source.endpointBaseUrl,
        p_feed: scan.source.feed,
        p_adjustment: scan.source.adjustment,
        p_timeframe: scan.source.timeframe,
        p_normalizer_version: scan.source.normalizerVersion,
        p_license_scope: scan.source.licenseScope,
        p_config_sha256: scan.source.configSha256,
        p_effective_from: scan.source.effectiveFrom,
      },
    );
    if (sourceResponse.error !== null) {
      throw new Error(
        `register corporate-action source failed: ${sourceResponse.error.message}`,
      );
    }
    const source = firstRow<SourceVersionRow>(
      sourceResponse.data,
      "register_data_source_version",
    );

    for (const page of scan.pages) {
      const upload = await this.#client.storage
        .from(page.storageBucket)
        .upload(page.objectPath, Buffer.from(page.rawBody), {
          contentType: "application/json",
          upsert: false,
        });
      if (upload.error !== null) {
        if (!isDuplicateStorageError(upload.error)) {
          throw new Error(
            `upload corporate-action artifact failed: ${upload.error.message}`,
          );
        }
        await this.#verifyExistingArtifact(page);
      }
    }

    return registerCorporateActionScanExact(
      this.#client as never,
      {
        p_idempotency_key: `corporate-action-scan:${scan.contentSha256}`,
        p_source_version_id: source.source_version_id,
        p_request_fingerprint: scan.requestFingerprint,
        p_process_date_start: scan.processDateStart,
        p_process_date_end: scan.processDateEnd,
        p_observed_at: scan.observedAt,
        p_canonical_json: scan.canonicalJson,
        p_content_sha256: scan.contentSha256,
        p_pages: scan.pages.map((page) => Object.freeze({
          pageIndex: page.pageIndex,
          providerRequestId: page.providerRequestId ?? null,
          storageBucket: page.storageBucket,
          objectPath: page.objectPath,
          byteSize: page.byteSize,
          responseSha256: page.responseSha256,
        })),
        p_actions: scan.actions,
        p_recorded_by: this.#workerId,
      },
      scan,
    );
  }

  async #verifyExistingArtifact(
    page: AlpacaCorporateActionScan["pages"][number],
  ): Promise<void> {
    const response = await this.#client.storage
      .from(page.storageBucket)
      .download(page.objectPath);
    if (response.error !== null) {
      throw new Error(
        `download existing corporate-action artifact failed: ${response.error.message}`,
      );
    }
    const bytes = new Uint8Array(await response.data.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== page.responseSha256
      || bytes.byteLength.toString() !== page.byteSize) {
      throw new Error("content-addressed corporate-action artifact changed");
    }
  }
}

function isDuplicateStorageError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { statusCode?: string | number; message?: string };
  return Number(candidate.statusCode) === 409
    || /already exists|duplicate/i.test(candidate.message ?? "");
}

function firstRow<T>(value: unknown, operation: string): T {
  const row = Array.isArray(value) ? value[0] : value;
  if (row === null || typeof row !== "object") {
    throw new Error(`${operation} returned no row`);
  }
  return row as T;
}
