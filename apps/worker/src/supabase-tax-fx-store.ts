import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { ArenaTaxFxSchedule, ArenaTaxFxStore } from "./arena-tax-fx-handler.js";
import {
  getArenaRoundTaxFx,
  registerArenaRoundTaxFxExact,
  type ArenaRoundTaxFxReference,
  type ArenaTaxFxStage,
} from "./arena-tax-fx-repository.js";
import type { EcbUsdCnyDelivery } from "./ecb-fx.js";
import { persistEcbSourceArtifact } from "./supabase-ecb-artifact.js";

interface RoundRow {
  readonly round_id: string;
  readonly season_id: string;
  readonly s1_session_date: string;
  readonly s1_close_available_at: string;
  readonly s2_session_date: string;
  readonly cycle_ready_at: string;
}
export class SupabaseArenaTaxFxStore implements ArenaTaxFxStore {
  readonly #client: SupabaseClient;
  readonly #workerId: string;

  constructor(url: string, secretKey: string, workerId: string) {
    this.#client = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    this.#workerId = workerId;
  }

  load(
    roundId: string,
    stage: ArenaTaxFxStage,
  ): Promise<ArenaRoundTaxFxReference | null> {
    return getArenaRoundTaxFx(this.#client as never, roundId, stage);
  }

  async schedule(roundId: string): Promise<ArenaTaxFxSchedule> {
    const round = await this.#round(roundId);
    return Object.freeze({
      roundId: round.round_id,
      s1SessionDate: round.s1_session_date,
      s1FxAvailableAt: new Date(round.s1_close_available_at).toISOString(),
      s2SessionDate: round.s2_session_date,
      s2FxAvailableAt: new Date(round.cycle_ready_at).toISOString(),
    });
  }

  async persist(
    roundId: string,
    stage: ArenaTaxFxStage,
    delivery: EcbUsdCnyDelivery,
  ): Promise<ArenaRoundTaxFxReference> {
    const round = await this.#round(roundId);
    const expectedDate = stage === "S1_DISPOSITION"
      ? round.s1_session_date
      : round.s2_session_date;
    if (delivery.cross.effectiveDate > expectedDate) {
      throw new TypeError("ECB cross follows the requested Round session");
    }
    const artifactId = await persistEcbSourceArtifact(
      this.#client,
      round.season_id,
      this.#workerId,
      delivery,
    );
    try {
      const registered = await registerArenaRoundTaxFxExact(this.#client as never, {
        p_idempotency_key: `arena-tax-fx:${roundId}:${stage}`,
        p_round_id: roundId,
        p_stage: stage,
        p_source_artifact_id: artifactId,
        p_source_artifact_sha256: delivery.envelopeSha256,
        p_raw_body_sha256: delivery.rawBodySha256,
        p_cross_canonical_json: delivery.crossCanonicalJson,
        p_cross_sha256: delivery.crossSha256,
        p_recorded_by: this.#workerId,
      }, { seasonId: round.season_id, delivery });
      if (registered.requestedSessionDate !== expectedDate) {
        throw new TypeError("registered ECB cross belongs to another Round session");
      }
      return registered;
    } catch (error) {
      const winner = await this.load(roundId, stage);
      if (winner !== null) {
        if (winner.requestedSessionDate !== expectedDate) {
          throw new TypeError("stored ECB cross belongs to another Round session");
        }
        return winner;
      }
      throw error;
    }
  }

  async #round(roundId: string): Promise<RoundRow> {
    const result = await this.#client.from("arena_round")
      .select(
        "round_id,season_id,s1_session_date,s1_close_available_at,s2_session_date,cycle_ready_at",
      )
      .eq("round_id", roundId)
      .single();
    if (result.error !== null) {
      throw new Error(`read Arena Round FX schedule failed: ${result.error.message}`);
    }
    return result.data as RoundRow;
  }

}
