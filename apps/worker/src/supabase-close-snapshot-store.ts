import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type {
  ArenaCloseSnapshotFrozenSource,
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

interface DecisionSnapshotRow {
  readonly symbols: unknown;
  readonly source_version_id: string;
}

interface SourceVersionRow {
  readonly source_version_id: string;
  readonly provider: string;
  readonly dataset: string;
  readonly version_key: string;
  readonly endpoint_base_url: string;
  readonly feed: string;
  readonly adjustment: string;
  readonly timeframe: string;
  readonly normalizer_version: string;
  readonly license_scope: string;
  readonly config_sha256: string;
  readonly effective_from: string;
}

interface RoundDecision {
  readonly symbols: readonly string[];
  readonly source: ArenaCloseSnapshotFrozenSource;
}

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
    const decision = await this.#decision(round);
    return Object.freeze({
      roundId: round.round_id,
      symbols: decision.symbols,
      source: decision.source,
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
    const decision = await this.#decision(round);
    const persisted = await this.#marketRepository.persist(delivery);
    if (persisted.sourceVersionId !== decision.source.sourceVersionId) {
      throw new TypeError(
        `daily close sealed source version ${persisted.sourceVersionId}, but `
        + `Round ${roundId} froze ${decision.source.sourceVersionId} `
        + `(${decision.source.versionKey})`,
      );
    }
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

  /**
   * Reads the universe and the daily-bars source version frozen with the
   * Round's decision snapshot. The close fence compares a capture against
   * both, so neither may come from deployment configuration.
   */
  async #decision(round: RoundRow): Promise<RoundDecision> {
    const snapshot = await this.#client.from("market_snapshot")
      .select("symbols,source_version_id")
      .eq("snapshot_id", round.decision_snapshot_id)
      .single();
    if (snapshot.error !== null) {
      throw new Error(`read close-snapshot universe failed: ${snapshot.error.message}`);
    }
    const decision = snapshot.data as DecisionSnapshotRow;
    if (!Array.isArray(decision.symbols)) {
      throw new TypeError("Round decision snapshot has no symbol universe");
    }
    const symbols = decision.symbols.map((symbol: unknown) => {
      if (typeof symbol !== "string") {
        throw new TypeError("Round universe contains a non-string symbol");
      }
      return symbol;
    });
    const source = await this.#client.from("data_source_version")
      .select(
        "source_version_id,provider,dataset,version_key,endpoint_base_url,feed,adjustment,timeframe,normalizer_version,license_scope,config_sha256,effective_from",
      )
      .eq("source_version_id", decision.source_version_id)
      .single();
    if (source.error !== null) {
      throw new Error(`read Round source version failed: ${source.error.message}`);
    }
    return Object.freeze({
      symbols: Object.freeze(symbols),
      source: frozenSource(source.data as SourceVersionRow),
    });
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

function frozenSource(row: SourceVersionRow): ArenaCloseSnapshotFrozenSource {
  if (
    row.provider !== "alpaca"
    || row.dataset !== "us_stock_daily_bars"
    || row.adjustment !== "raw"
    || row.timeframe !== "1Day"
    || (row.feed !== "sip" && row.feed !== "iex")
  ) {
    throw new TypeError(
      `Round source version ${row.source_version_id} is not an Alpaca daily-bars route`,
    );
  }
  return Object.freeze({
    sourceVersionId: row.source_version_id,
    provider: "alpaca",
    dataset: "us_stock_daily_bars",
    versionKey: row.version_key,
    endpointBaseUrl: row.endpoint_base_url,
    feed: row.feed,
    adjustment: "raw",
    timeframe: "1Day",
    normalizerVersion: row.normalizer_version,
    licenseScope: row.license_scope,
    configSha256: row.config_sha256,
    effectiveFrom: new Date(row.effective_from).toISOString(),
  });
}
