import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type {
  ArenaCloseSnapshotRoundSchedule,
  ArenaCloseSnapshotStore,
} from "./arena-close-snapshot-handler.js";
import {
  getArenaRoundCloseSnapshot,
  registerArenaRoundCloseSnapshotExact,
  type ArenaCloseSnapshotStage,
  type ArenaRoundCloseSnapshot,
} from "./arena-close-snapshot-repository.js";
import type { AlpacaMarketDelivery } from "./market-data.js";
import { SupabaseMarketDataRepository } from "./market-data-repository.js";

interface RoundRow {
  readonly round_id: string;
  readonly season_id: string;
  readonly decision_snapshot_id: string;
  readonly s1_session_date: string;
  readonly s1_close_available_at: string;
  readonly s2_session_date: string;
  readonly cycle_ready_at: string;
}

export class SupabaseArenaCloseSnapshotStore implements ArenaCloseSnapshotStore {
  readonly #client: SupabaseClient;
  readonly #marketRepository: SupabaseMarketDataRepository;
  readonly #workerId: string;

  constructor(url: string, secretKey: string, workerId: string) {
    this.#client = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    this.#marketRepository = new SupabaseMarketDataRepository(url, secretKey);
    this.#workerId = workerId;
  }

  load(
    roundId: string,
    stage: ArenaCloseSnapshotStage,
  ): Promise<ArenaRoundCloseSnapshot | null> {
    return getArenaRoundCloseSnapshot(this.#client as never, roundId, stage);
  }

  async schedule(roundId: string): Promise<ArenaCloseSnapshotRoundSchedule> {
    const round = await this.#round(roundId);
    const snapshot = await this.#client.from("market_snapshot")
      .select("symbols")
      .eq("snapshot_id", round.decision_snapshot_id)
      .single();
    if (snapshot.error !== null) {
      throw new Error(`read close-snapshot universe failed: ${snapshot.error.message}`);
    }
    if (!Array.isArray(snapshot.data.symbols)) {
      throw new TypeError("Round decision snapshot has no symbol universe");
    }
    const symbols = snapshot.data.symbols.map((symbol: unknown) => {
      if (typeof symbol !== "string") {
        throw new TypeError("Round universe contains a non-string symbol");
      }
      return symbol;
    });
    return Object.freeze({
      roundId: round.round_id,
      symbols: Object.freeze(symbols),
      s1SessionDate: round.s1_session_date,
      s1CloseAvailableAt: new Date(round.s1_close_available_at).toISOString(),
      s2SessionDate: round.s2_session_date,
      s2CloseAvailableAt: new Date(round.cycle_ready_at).toISOString(),
    });
  }

  async persist(
    roundId: string,
    stage: ArenaCloseSnapshotStage,
    delivery: AlpacaMarketDelivery,
  ): Promise<ArenaRoundCloseSnapshot> {
    const round = await this.#round(roundId);
    const expectedSession = stage === "S1_CLOSE"
      ? round.s1_session_date
      : round.s2_session_date;
    if (delivery.targetSessionDate !== expectedSession) {
      throw new TypeError("daily close delivery belongs to another Round session");
    }
    const persisted = await this.#marketRepository.persist(delivery);
    try {
      return await registerArenaRoundCloseSnapshotExact(
        this.#client as never,
        {
          p_idempotency_key: `arena-close:${roundId}:${stage}`,
          p_round_id: roundId,
          p_stage: stage,
          p_snapshot_id: persisted.snapshotId,
          p_recorded_by: this.#workerId,
        },
        {
          seasonId: round.season_id,
          manifestSha256: persisted.snapshotManifestSha256,
          sessionDate: expectedSession,
        },
      );
    } catch (error) {
      // Entrant-scoped work items can race. The first immutable Round binding
      // wins and every loser consumes those same bytes.
      const winner = await this.load(roundId, stage);
      if (winner !== null) return winner;
      throw error;
    }
  }

  async #round(roundId: string): Promise<RoundRow> {
    const result = await this.#client.from("arena_round")
      .select(
        "round_id,season_id,decision_snapshot_id,s1_session_date,s1_close_available_at,s2_session_date,cycle_ready_at",
      )
      .eq("round_id", roundId)
      .single();
    if (result.error !== null) {
      throw new Error(`read Arena Round close schedule failed: ${result.error.message}`);
    }
    return result.data as RoundRow;
  }
}
