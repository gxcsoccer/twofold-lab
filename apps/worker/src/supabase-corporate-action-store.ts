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
    const response = await this.#client.rpc(
      "get_active_arena_season_symbols",
      { p_as_of: asOf },
    );
    if (response.error !== null) {
      throw new Error(
        `load active Arena Season symbols failed: ${response.error.message}`,
      );
    }
    if (response.data === null || typeof response.data !== "object"
      || Array.isArray(response.data)) {
      throw new TypeError("active Arena Season symbols returned a non-object");
    }
    const value = response.data as Record<string, unknown>;
    if (value.schema !== "twofold.active_arena_season_symbols/v1"
      || value.asOf !== asOf || !Array.isArray(value.symbols)) {
      throw new TypeError("active Arena Season symbols contract is invalid");
    }
    const symbols = value.symbols.map((symbol) => {
      if (typeof symbol !== "string") {
        throw new TypeError("active Arena Season symbols contains a non-string");
      }
      return symbol;
    });
    return Object.freeze(symbols);
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
