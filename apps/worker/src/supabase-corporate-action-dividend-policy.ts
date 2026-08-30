import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type {
  CorporateActionDividendPolicyMaterial,
  CorporateActionDividendPolicyProvider,
} from "./corporate-action-account-runner.js";
import {
  getCorporateActionDividendFxReference,
  getCorporateActionDividendPolicyMaterial,
  registerCorporateActionDividendFxExact,
  type CorporateActionDividendFxReference,
  type CorporateActionDividendPolicyRpcClient,
} from "./corporate-action-dividend-policy-repository.js";
import type { CorporateActionAccountWorkItem } from
  "./corporate-action-work-repository.js";
import {
  fetchEcbUsdCnyReferenceCross,
  type EcbFxConfig,
} from "./ecb-fx.js";
import { persistEcbSourceArtifact } from "./supabase-ecb-artifact.js";

/** Resolve one database-frozen policy; every entrant reuses the same FX fact. */
export class SupabaseCorporateActionDividendPolicyProvider
implements CorporateActionDividendPolicyProvider {
  readonly #client: SupabaseClient & CorporateActionDividendPolicyRpcClient;
  readonly #workerId: string;
  readonly #ecb: EcbFxConfig;
  readonly #fetchImplementation: typeof fetch | undefined;
  readonly #now: (() => Date) | undefined;

  constructor(input: {
    readonly url: string;
    readonly secretKey: string;
    readonly workerId: string;
    readonly ecb: EcbFxConfig;
    readonly fetchImplementation?: typeof fetch;
    readonly now?: () => Date;
  }) {
    this.#client = createClient(input.url, input.secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }) as SupabaseClient & CorporateActionDividendPolicyRpcClient;
    this.#workerId = input.workerId;
    this.#ecb = input.ecb;
    this.#fetchImplementation = input.fetchImplementation;
    this.#now = input.now;
  }

  async load(
    item: CorporateActionAccountWorkItem,
    signal: AbortSignal,
  ): Promise<CorporateActionDividendPolicyMaterial> {
    if (item.interpretation !== "CASH_DIVIDEND" || item.payableDate === null) {
      throw new TypeError("dividend policy requested for non-payable work");
    }
    const identity = {
      seasonId: item.seasonId,
      sourceActionId: item.sourceActionId,
      revisionSha256: item.revisionSha256,
    } as const;
    const material = await getCorporateActionDividendPolicyMaterial(this.#client, {
      ...identity,
      instrumentId: item.instrumentId,
    });
    signal.throwIfAborted();
    let fx = await getCorporateActionDividendFxReference(this.#client, identity);
    if (fx === null) {
      const delivery = await fetchEcbUsdCnyReferenceCross(this.#ecb, {
        effectiveDate: item.payableDate,
        allowPreviousDate: true,
        ...(this.#fetchImplementation === undefined
          ? {}
          : { fetchImplementation: this.#fetchImplementation }),
        ...(this.#now === undefined ? {} : { now: this.#now }),
        signal,
      });
      const artifactId = await persistEcbSourceArtifact(
        this.#client,
        item.seasonId,
        this.#workerId,
        delivery,
      );
      try {
        fx = await registerCorporateActionDividendFxExact(this.#client, {
          p_idempotency_key:
            `corporate-action-dividend-fx:${item.seasonId}:${item.sourceActionId}`
              + `:${item.revisionSha256}`,
          p_season_id: item.seasonId,
          p_source_action_id: item.sourceActionId,
          p_revision_sha256: item.revisionSha256,
          p_source_artifact_id: artifactId,
          p_source_artifact_sha256: delivery.envelopeSha256,
          p_raw_body_sha256: delivery.rawBodySha256,
          p_cross_canonical_json: delivery.crossCanonicalJson,
          p_cross_sha256: delivery.crossSha256,
          p_recorded_by: this.#workerId,
        }, delivery);
      } catch (error) {
        fx = await getCorporateActionDividendFxReference(this.#client, identity);
        if (fx === null) throw error;
      }
    }
    return combine(material, fx);
  }
}

function combine(
  material: Awaited<ReturnType<typeof getCorporateActionDividendPolicyMaterial>>,
  fx: CorporateActionDividendFxReference,
): CorporateActionDividendPolicyMaterial {
  if (material.seasonId !== fx.seasonId
    || material.sourceActionId !== fx.sourceActionId
    || material.revisionSha256 !== fx.revisionSha256) {
    throw new TypeError("cash-dividend policy and FX identities differ");
  }
  return Object.freeze({
    currency: material.currency,
    instrumentKind: material.instrumentKind,
    issuerTaxResidenceCountry: material.issuerTaxResidenceCountry,
    distributionClassification: material.distributionClassification,
    foreignWithholdingRate: material.foreignWithholdingRate,
    treatyOrLocalCapRate: material.treatyOrLocalCapRate,
    foreignTaxCreditEvidenceStatus: material.foreignTaxCreditEvidenceStatus,
    fx: Object.freeze({
      fxRateId: fx.fxRateId,
      sourceContentSha256: fx.sourceContentSha256,
      baseCurrency: fx.baseCurrency,
      quoteCurrency: fx.quoteCurrency,
      cnyPerBaseUnit: fx.cnyPerBaseUnit,
      effectiveAt: fx.effectiveAt,
      visibleAt: fx.visibleAt,
      status: fx.status,
    }),
  });
}
