import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { EcbUsdCnyDelivery } from "./ecb-fx.js";
import { PRIVATE_ARTIFACT_BUCKET } from "./market-data.js";

interface ArtifactRow { readonly artifact_id: string }

/** Persist one content-addressed ECB envelope for any season-scoped tax fact. */
export async function persistEcbSourceArtifact(
  client: SupabaseClient,
  seasonId: string,
  workerId: string,
  delivery: EcbUsdCnyDelivery,
): Promise<string> {
  const upload = await client.storage.from(PRIVATE_ARTIFACT_BUCKET)
    .upload(delivery.objectPath, Buffer.from(delivery.envelopeCanonicalJson), {
      contentType: "application/json",
      upsert: false,
    });
  if (upload.error !== null) {
    if (!isDuplicate(upload.error)) {
      throw new Error(`upload ECB artifact failed: ${upload.error.message}`);
    }
    const existing = await client.storage.from(PRIVATE_ARTIFACT_BUCKET)
      .download(delivery.objectPath);
    if (existing.error !== null) {
      throw new Error(`download ECB artifact failed: ${existing.error.message}`);
    }
    const digest = createHash("sha256")
      .update(new Uint8Array(await existing.data.arrayBuffer()))
      .digest("hex");
    if (digest !== delivery.envelopeSha256) {
      throw new Error("content-addressed ECB artifact hash changed");
    }
  }
  const artifact = await client.rpc("register_artifact", {
    p_idempotency_key: `ecb-reference-rates:${delivery.envelopeSha256}`,
    p_run_id: null,
    p_season_id: seasonId,
    p_source_event_id: null,
    p_artifact_kind: "official_tax_fx_rate",
    p_storage_bucket: PRIVATE_ARTIFACT_BUCKET,
    p_object_path: delivery.objectPath,
    p_content_type: "application/json",
    p_byte_size: Buffer.byteLength(delivery.envelopeCanonicalJson, "utf8"),
    p_sha256: delivery.envelopeSha256,
    p_created_by: workerId,
    p_metadata: {
      schema: "twofold.ecb_reference_source/v1",
      sourceUrl: delivery.sourceUrl,
      effectiveDate: delivery.cross.effectiveDate,
      observedAt: delivery.observedAt,
      rawBodySha256: delivery.rawBodySha256,
    },
    p_supersedes_artifact_id: null,
  });
  if (artifact.error !== null) {
    throw new Error(`register ECB artifact failed: ${artifact.error.message}`);
  }
  return firstRow<ArtifactRow>(artifact.data, "register ECB artifact").artifact_id;
}

function firstRow<T>(value: unknown, operation: string): T {
  const row = Array.isArray(value) ? value[0] : value;
  if (row === null || typeof row !== "object") {
    throw new Error(`${operation} returned no row`);
  }
  return row as T;
}

function isDuplicate(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { statusCode?: string | number; message?: string };
  return Number(candidate.statusCode) === 409
    || /already exists|duplicate/i.test(candidate.message ?? "");
}
