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
import {
  ALPACA_DATA_ORIGIN,
  type AlpacaMarketDelivery,
} from "./market-data.js";
import { SupabaseMarketDataRepository } from "./market-data-repository.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// Both rows arrive as untyped PostgREST payloads. The close fence is decided
// by their content, and the endpoint is dialled with provider credentials, so
// every field is parsed rather than asserted.
interface DecisionSnapshotRow {
  readonly symbols: unknown;
  readonly source_version_id: unknown;
}

export interface SourceVersionRow {
  readonly source_version_id: unknown;
  readonly provider: unknown;
  readonly dataset: unknown;
  readonly version_key: unknown;
  readonly endpoint_base_url: unknown;
  readonly feed: unknown;
  readonly adjustment: unknown;
  readonly timeframe: unknown;
  readonly normalizer_version: unknown;
  readonly license_scope: unknown;
  readonly config_sha256: unknown;
  readonly effective_from: unknown;
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
    const sourceVersionId = uuid(
      decision.source_version_id,
      `decision snapshot ${round.decision_snapshot_id} source_version_id`,
    );
    const source = await this.#client.from("data_source_version")
      .select(
        "source_version_id,provider,dataset,version_key,endpoint_base_url,feed,adjustment,timeframe,normalizer_version,license_scope,config_sha256,effective_from",
      )
      .eq("source_version_id", sourceVersionId)
      .single();
    if (source.error !== null) {
      throw new Error(`read Round source version failed: ${source.error.message}`);
    }
    return Object.freeze({
      symbols: Object.freeze(symbols),
      source: parseFrozenMarketSource(source.data as SourceVersionRow),
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

/**
 * Parses the Round's registered daily-bars route. A close is dialled and
 * sealed under exactly this row, so an unusable one has to name itself here
 * rather than surface as an invalid date, an unclear PostgREST filter, or an
 * outbound request to somewhere other than the provider.
 */
export function parseFrozenMarketSource(
  row: SourceVersionRow,
): ArenaCloseSnapshotFrozenSource {
  const sourceVersionId = uuid(row.source_version_id, "source_version_id");
  const field = (name: string) => `Round source version ${sourceVersionId} ${name}`;
  // The close fence admits exactly one route, SIP included: an IEX-frozen
  // Round would otherwise parse, fetch and seal before registration refused
  // it, which is the failure this parser exists to prevent.
  if (
    row.provider !== "alpaca"
    || row.dataset !== "us_stock_daily_bars"
    || row.feed !== "sip"
    || row.adjustment !== "raw"
    || row.timeframe !== "1Day"
  ) {
    throw new TypeError(
      `Round source version ${sourceVersionId} is not the Alpaca SIP `
      + "daily-bars route the close fence admits",
    );
  }
  return Object.freeze({
    sourceVersionId,
    provider: "alpaca",
    dataset: "us_stock_daily_bars",
    versionKey: text(row.version_key, field("version_key")),
    endpointBaseUrl: trustedOrigin(
      row.endpoint_base_url,
      field("endpoint_base_url"),
    ),
    feed: "sip",
    adjustment: "raw",
    timeframe: "1Day",
    normalizerVersion: text(row.normalizer_version, field("normalizer_version")),
    licenseScope: text(row.license_scope, field("license_scope")),
    configSha256: sha256(row.config_sha256, field("config_sha256")),
    effectiveFrom: timestamp(row.effective_from, field("effective_from")),
  });
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "" || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!UUID_PATTERN.test(parsed)) throw new TypeError(`${field} must be a UUID`);
  return parsed;
}

function sha256(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!SHA256_PATTERN.test(parsed)) {
    throw new TypeError(`${field} must be SHA-256`);
  }
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = text(value, field);
  const instant = new Date(parsed);
  if (!Number.isFinite(instant.getTime())) {
    throw new TypeError(`${field} must be a timestamp`);
  }
  return instant.toISOString();
}

/**
 * The Worker dials this host with provider credentials attached, so a stored
 * endpoint is admitted only on the same trusted origin the deployment
 * configuration is held to.
 */
function trustedOrigin(value: unknown, field: string): string {
  const parsed = text(value, field).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new TypeError(`${field} must be a URL`);
  }
  if (
    url.origin !== ALPACA_DATA_ORIGIN
    || url.username !== "" || url.password !== ""
    || url.pathname !== "/" || url.search !== "" || url.hash !== ""
  ) {
    throw new TypeError(`${field} must use the trusted origin ${ALPACA_DATA_ORIGIN}`);
  }
  return parsed;
}
