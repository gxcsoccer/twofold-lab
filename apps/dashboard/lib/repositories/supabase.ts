import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ArenaDecisionPageData,
  AuditData,
  ConnectionSummary,
  DashboardRepository,
  MarketBarSummary,
  MarketDataPageData,
  RunDetailData,
  SeasonOverviewData,
  SettingsData,
} from "@/lib/data/contracts";
import {
  validateArenaDecisionProjection,
  validateArenaDecisionProjectionEvidence,
} from "@/lib/data/arena-decision";
import { validateAcceptedTargetSubmission } from "@/lib/data/accepted-target-submission";
import { validateAcceptedTargetCycleProjection } from "@/lib/data/accepted-target-cycle";
import { validateAcceptedTargetCycleReadiness } from "@/lib/data/accepted-target-cycle-readiness";
import { validatePrivateArenaOverview } from "@/lib/data/private-arena-overview";

interface ProjectionRow<T> {
  state: T;
}

interface ArenaDecisionProjectionRow {
  state: unknown;
  state_hash: unknown;
  last_event_id: unknown;
  updated_at: unknown;
}

interface DataSourceVersionRow {
  source_version_id: string;
  provider: string;
  dataset: string;
  version_key: string;
  feed: string;
  adjustment: string;
  timeframe: string;
  normalizer_version: string;
  license_scope: string;
  effective_from: string;
}

interface SourceDeliveryRow {
  delivery_id: string;
  raw_artifact_id: string;
  provider_request_id: string | null;
  retrieved_at: string;
  first_observed_at: string;
  available_at: string;
  normalized_manifest_sha256: string;
}

interface RawArtifactRow {
  raw_artifact_id: string;
  storage_bucket: string;
  object_path: string;
  content_type: string;
  byte_size: string | number;
  response_sha256: string;
  first_stored_at: string;
}

interface DeliveryFactRow {
  delivery_id: string;
  fact_id: string;
  fact_index: number;
}

interface MarketSnapshotRow {
  snapshot_id: string;
  snapshot_kind: string;
  cutoff_at: string;
  target_session_date: string;
  symbols: string[];
  selection_policy: string;
  manifest_schema: string;
  manifest_sha256: string;
  sealed_at: string;
}

interface MarketSnapshotMemberRow {
  symbol: string;
  delivery_id: string;
  fact_id: string;
  member_index: number;
}

interface MarketBarFactRow {
  fact_id: string;
  symbol: string;
  bar_start: string;
  bar_date: string;
  currency: string;
  open_price: string;
  high_price: string;
  low_price: string;
  close_price: string;
  volume: string;
  trade_count: string;
  vwap: string | null;
  fact_sha256: string;
}

const PROJECTIONS = {
  runDetail: "dashboard.run_detail",
  audit: "dashboard.audit",
  settings: "dashboard.settings",
  arenaDecision: "dashboard.arena_decision",
} as const;

export class ProjectionNotReadyError extends Error {
  readonly kind = "NOT_READY" as const;

  constructor(readonly projection: string) {
    super(`Dashboard projection is not ready: ${projection}`);
    this.name = "ProjectionNotReadyError";
  }
}

export class ProjectionReadError extends Error {
  readonly kind = "ERROR" as const;

  constructor(
    readonly projection: string,
    readonly databaseCode: string,
  ) {
    super(`Dashboard projection read failed: ${projection}:${databaseCode}`);
    this.name = "ProjectionReadError";
  }
}

export class ProjectionContractError extends Error {
  readonly kind = "ERROR" as const;
  readonly databaseCode = "PROJECTION_CONTRACT_INVALID";

  constructor(
    readonly projection: string,
    readonly issues: string[],
  ) {
    super(`Dashboard projection contract is invalid: ${projection}`);
    this.name = "ProjectionContractError";
  }
}

function markProjectionReady<T extends { connection: ConnectionSummary }>(state: T): T {
  return {
    ...state,
    connection: {
      ...state.connection,
      configured: true,
      source: "supabase",
      readStatus: "READY",
    },
  };
}

/**
 * Read model for the console. The immutable event ledger remains the source of
 * truth; a worker writes disposable projections for this UI.
 */
export class SupabaseDashboardRepository implements DashboardRepository {
  constructor(private readonly client: SupabaseClient) {}

  private async readLatestProjection<T>(projectionName: string): Promise<T> {
    const { data, error } = await this.client
      .from("projection")
      .select("state")
      .eq("projection_name", projectionName)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new ProjectionReadError(projectionName, error.code);
    }

    if (!data) {
      throw new ProjectionNotReadyError(projectionName);
    }

    return (data as ProjectionRow<T>).state;
  }

  private async readEntityProjection<T>(projectionName: string, entityId: string): Promise<T> {
    const { data, error } = await this.client
      .from("projection")
      .select("state")
      .eq("projection_name", projectionName)
      .eq("entity_id", entityId)
      .maybeSingle();

    if (error) {
      throw new ProjectionReadError(`${projectionName}/${entityId}`, error.code);
    }

    if (!data) {
      throw new ProjectionNotReadyError(`${projectionName}/${entityId}`);
    }

    return (data as ProjectionRow<T>).state;
  }

  async getSeasonOverview(): Promise<SeasonOverviewData> {
    const result = await this.client.rpc("get_private_arena_overview");
    if (result.error) {
      throw new ProjectionReadError("private_arena_overview", result.error.code);
    }
    const overview = validatePrivateArenaOverview(result.data);
    if (!overview.ok) {
      throw new ProjectionContractError(
        "private_arena_overview",
        [...overview.issues],
      );
    }
    return {
      setupRequired: false,
      connection: {
        configured: true,
        source: "supabase",
        readStatus: "READY",
        label: "私有竞技场已连接",
        detail: "赛季、赛程、工作队列和排名来自同一个数据库快照。",
      },
      checklist: [],
      overview: overview.value,
    };
  }

  async getRunDetail(runId: string): Promise<RunDetailData> {
    return markProjectionReady(
      await this.readEntityProjection<RunDetailData>(PROJECTIONS.runDetail, runId),
    );
  }

  async getAuditData(): Promise<AuditData> {
    return markProjectionReady(
      await this.readLatestProjection<AuditData>(PROJECTIONS.audit),
    );
  }

  async getSettingsData(): Promise<SettingsData> {
    return markProjectionReady(
      await this.readLatestProjection<SettingsData>(PROJECTIONS.settings),
    );
  }

  async getArenaDecision(decisionId: string): Promise<ArenaDecisionPageData> {
    const projectionKey = `${PROJECTIONS.arenaDecision}/${decisionId}`;
    const { data, error } = await this.client
      .from("projection")
      .select("state,state_hash,last_event_id,updated_at")
      .eq("projection_name", PROJECTIONS.arenaDecision)
      .eq("entity_id", decisionId)
      .maybeSingle();

    if (error) throw new ProjectionReadError(projectionKey, error.code);
    if (!data) throw new ProjectionNotReadyError(projectionKey);

    const row = data as ArenaDecisionProjectionRow;
    const stateResult = validateArenaDecisionProjection(row.state, decisionId);
    const evidenceResult = validateArenaDecisionProjectionEvidence({
      stateHash: row.state_hash,
      lastEventId: row.last_event_id,
      projectionUpdatedAt: row.updated_at,
    });
    const issues = [
      ...(stateResult.ok ? [] : stateResult.issues),
      ...(evidenceResult.ok ? [] : evidenceResult.issues),
    ];
    if (!stateResult.ok || !evidenceResult.ok) {
      throw new ProjectionContractError(projectionKey, issues);
    }

    const acceptedSubmissionId = stateResult.value.submission.acceptedSubmissionId;
    const submissionKey = `accepted_target_submission/${decisionId}`;
    const submissionResult = await this.client
      .from("accepted_target_submission")
      .select(
        "submission_id,decision_id,targets,cash_weight_bps,decision_summary,submission_sha256,accepted_at",
      )
      .eq("decision_id", decisionId)
      .maybeSingle();
    if (submissionResult.error) {
      throw new ProjectionReadError(submissionKey, submissionResult.error.code);
    }
    if (acceptedSubmissionId === null && submissionResult.data !== null) {
      throw new ProjectionContractError(submissionKey, [
        "decision 投影尚未接受提交，但 accepted_target_submission 已存在",
      ]);
    }
    if (acceptedSubmissionId !== null && submissionResult.data === null) {
      throw new ProjectionContractError(submissionKey, [
        "decision 投影引用的 accepted_target_submission 不存在",
      ]);
    }
    const acceptedSubmission = acceptedSubmissionId === null
      ? null
      : validateAcceptedTargetSubmission(
          submissionResult.data,
          decisionId,
          acceptedSubmissionId,
        );
    if (acceptedSubmission !== null && !acceptedSubmission.ok) {
      throw new ProjectionContractError(submissionKey, acceptedSubmission.issues);
    }

    const cycleProjectionKey = `dashboard.accepted_target_cycle/${decisionId}`;
    const cycleResult = await this.client
      .from("projection")
      .select("state")
      .eq("projection_name", "dashboard.accepted_target_cycle")
      .eq("entity_id", decisionId)
      .maybeSingle();
    if (cycleResult.error) {
      throw new ProjectionReadError(cycleProjectionKey, cycleResult.error.code);
    }
    const executionCycle = cycleResult.data === null
      ? null
      : validateAcceptedTargetCycleProjection(
          (cycleResult.data as ProjectionRow<unknown>).state,
          decisionId,
          stateResult.value.submission.acceptedSubmissionId,
        );
    if (executionCycle !== null && !executionCycle.ok) {
      throw new ProjectionContractError(cycleProjectionKey, executionCycle.issues);
    }

    const readinessKey = `accepted_target_cycle_readiness/${decisionId}`;
    const readinessResult = await this.client.rpc(
      "get_accepted_target_cycle_readiness",
      { p_decision_id: decisionId },
    );
    if (readinessResult.error) {
      throw new ProjectionReadError(readinessKey, readinessResult.error.code);
    }
    const executionReadiness = validateAcceptedTargetCycleReadiness(
      readinessResult.data,
      decisionId,
    );
    if (!executionReadiness.ok) {
      throw new ProjectionContractError(readinessKey, executionReadiness.issues);
    }
    const readinessIssues: string[] = [];
    if (
      acceptedSubmissionId !== null
      && executionReadiness.value.acceptedSubmissionId !== null
      && executionReadiness.value.acceptedSubmissionId !== acceptedSubmissionId
    ) readinessIssues.push("readiness acceptedSubmissionId 与 decision 投影不一致");
    if (
      executionCycle?.ok
      && (
        executionReadiness.value.status !== "COMPLETED"
        || executionReadiness.value.cycleId !== executionCycle.value.cycleId
      )
    ) readinessIssues.push("readiness 与已提交 cycle 投影不一致");
    if (readinessIssues.length > 0) {
      throw new ProjectionContractError(readinessKey, readinessIssues);
    }

    return {
      decisionId,
      connection: {
        configured: true,
        source: "supabase",
        readStatus: "READY",
        label: "真实 Agent 投影已连接",
        detail: "按 decision UUID 精确读取；Realtime 只触发重新读取该投影。",
      },
      status: "READY",
      projection: stateResult.value,
      evidence: evidenceResult.value,
      acceptedSubmission: acceptedSubmission?.value ?? null,
      executionCycle: executionCycle?.value ?? null,
      executionReadiness: executionReadiness.value,
      issues: [],
    };
  }

  async getMarketData(): Promise<MarketDataPageData> {
    const connection = {
      configured: true,
      source: "supabase" as const,
      readStatus: "READY" as const,
      label: "真实数据仓库已连接",
      detail: "仅展示已归档、规范化并封存的 Provider 数据。",
    };
    const sourceResult = await this.client
      .from("data_source_version")
      .select(
        "source_version_id,provider,dataset,version_key,feed,adjustment,timeframe,normalizer_version,license_scope,effective_from",
      )
      .eq("provider", "alpaca")
      .eq("dataset", "us_stock_daily_bars")
      .order("registered_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (sourceResult.error) {
      throw new Error(`DATA_SOURCE_READ_FAILED:${sourceResult.error.code}`);
    }
    if (!sourceResult.data) {
      return {
        connection,
        status: "WAITING",
        source: null,
        deliveries: [],
        snapshot: null,
        bars: [],
        issues: ["尚未注册真实 Alpaca 数据源版本。"],
      };
    }
    const source = sourceResult.data as DataSourceVersionRow;

    const snapshotResult = await this.client
      .from("market_snapshot")
      .select(
        "snapshot_id,snapshot_kind,cutoff_at,target_session_date,symbols,selection_policy,manifest_schema,manifest_sha256,sealed_at",
      )
      .eq("source_version_id", source.source_version_id)
      .order("sealed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (snapshotResult.error) {
      throw new Error(`MARKET_SNAPSHOT_READ_FAILED:${snapshotResult.error.code}`);
    }
    const snapshot = snapshotResult.data as MarketSnapshotRow | null;
    const sourceSummary = {
      sourceVersionId: source.source_version_id,
      provider: source.provider,
      dataset: source.dataset,
      versionKey: source.version_key,
      feed: source.feed,
      adjustment: source.adjustment,
      timeframe: source.timeframe,
      normalizerVersion: source.normalizer_version,
      licenseScope: source.license_scope,
      effectiveFrom: source.effective_from,
    };
    if (snapshot === null) {
      return {
        connection,
        status: "WAITING",
        source: sourceSummary,
        deliveries: [],
        snapshot: null,
        bars: [],
        issues: ["数据源已注册，但尚未封存完整快照；未封存的 delivery 不作为快照证据展示。"],
      };
    }

    const memberResult = await this.client
      .from("market_snapshot_member")
      .select("symbol,delivery_id,fact_id,member_index")
      .eq("snapshot_id", snapshot.snapshot_id)
      .order("member_index", { ascending: true });
    if (memberResult.error) {
      throw new Error(`SNAPSHOT_MEMBER_READ_FAILED:${memberResult.error.code}`);
    }
    const members = (memberResult.data ?? []) as MarketSnapshotMemberRow[];
    if (members.length !== snapshot.symbols.length) {
      throw new Error("INVALID_SNAPSHOT_MEMBER_COUNT");
    }
    for (const [index, member] of members.entries()) {
      if (member.member_index !== index || member.symbol !== snapshot.symbols[index]) {
        throw new Error(`INVALID_SNAPSHOT_MEMBER_ORDER:${member.symbol}`);
      }
    }
    const factResult = await this.client
      .from("market_bar_fact")
      .select(
        "fact_id,symbol,bar_start,bar_date,currency,open_price,high_price,low_price,close_price,volume,trade_count,vwap,fact_sha256",
      )
      .in("fact_id", members.map((member) => member.fact_id));
    if (factResult.error) {
      throw new Error(`MARKET_FACT_READ_FAILED:${factResult.error.code}`);
    }
    const factById = new Map(
      ((factResult.data ?? []) as MarketBarFactRow[])
        .map((fact) => [fact.fact_id, fact] as const),
    );
    for (const member of members) {
      const fact = factById.get(member.fact_id);
      if (
        !fact
        || fact.symbol !== member.symbol
        || fact.bar_date !== snapshot.target_session_date
      ) {
        throw new Error(`SNAPSHOT_FACT_MISMATCH:${member.symbol}`);
      }
    }

    const memberFactIds = members.map((member) => member.fact_id);
    const memberDeliveryIds = [...new Set(members.map((member) => member.delivery_id))];
    const linkResult = await this.client
      .from("delivery_fact")
      .select("delivery_id,fact_id,fact_index")
      .in("fact_id", memberFactIds)
      .in("delivery_id", memberDeliveryIds);
    if (linkResult.error) {
      throw new Error(`DELIVERY_FACT_READ_FAILED:${linkResult.error.code}`);
    }
    const links = (linkResult.data ?? []) as DeliveryFactRow[];
    for (const member of members) {
      if (!links.some((link) =>
        link.delivery_id === member.delivery_id && link.fact_id === member.fact_id
      )) {
        throw new Error(`SNAPSHOT_DELIVERY_LINK_MISSING:${member.symbol}`);
      }
    }

    const deliveryResult = await this.client
      .from("source_delivery")
      .select(
        "delivery_id,raw_artifact_id,provider_request_id,retrieved_at,first_observed_at,available_at,normalized_manifest_sha256",
      )
      .eq("source_version_id", source.source_version_id)
      .in("delivery_id", memberDeliveryIds)
      .lte("available_at", snapshot.cutoff_at)
      .order("available_at", { ascending: true })
      .order("delivery_id", { ascending: true });
    if (deliveryResult.error) {
      throw new Error(`SOURCE_DELIVERY_READ_FAILED:${deliveryResult.error.code}`);
    }
    const deliveryRows = (deliveryResult.data ?? []) as SourceDeliveryRow[];
    if (deliveryRows.length === 0) {
      throw new Error("SNAPSHOT_ELIGIBLE_DELIVERIES_MISSING");
    }
    const eligibleDeliveryIds = new Set(deliveryRows.map((delivery) => delivery.delivery_id));
    for (const member of members) {
      if (!eligibleDeliveryIds.has(member.delivery_id)) {
        throw new Error(`SNAPSHOT_DELIVERY_MISSING:${member.symbol}`);
      }
    }

    const rawArtifactIds = [
      ...new Set(deliveryRows.map((delivery) => delivery.raw_artifact_id)),
    ];
    const artifactResult = await this.client
      .from("raw_artifact")
      .select(
        "raw_artifact_id,storage_bucket,object_path,content_type,byte_size,response_sha256,first_stored_at",
      )
      .in("raw_artifact_id", rawArtifactIds);
    if (artifactResult.error) {
      throw new Error(`RAW_ARTIFACT_READ_FAILED:${artifactResult.error.code}`);
    }
    const artifactById = new Map(
      ((artifactResult.data ?? []) as RawArtifactRow[])
        .map((artifact) => [artifact.raw_artifact_id, artifact] as const),
    );
    const deliveries = deliveryRows.map((delivery) => {
      const artifact = artifactById.get(delivery.raw_artifact_id);
      if (!artifact) {
        throw new Error(`DELIVERY_RAW_ARTIFACT_MISSING:${delivery.delivery_id}`);
      }
      return {
        deliveryId: delivery.delivery_id,
        rawArtifactId: artifact.raw_artifact_id,
        providerRequestId: delivery.provider_request_id,
        retrievedAt: delivery.retrieved_at,
        firstObservedAt: delivery.first_observed_at,
        availableAt: delivery.available_at,
        storageBucket: artifact.storage_bucket,
        responseSha256: artifact.response_sha256,
        normalizedManifestSha256: delivery.normalized_manifest_sha256,
        objectPath: artifact.object_path,
        contentType: artifact.content_type,
        byteSize: String(artifact.byte_size),
        firstStoredAt: artifact.first_stored_at,
      };
    });
    const bars: MarketBarSummary[] = members.map((member) => {
      const fact = factById.get(member.fact_id);
      if (!fact) throw new Error(`SNAPSHOT_FACT_MISSING:${member.symbol}`);
      return {
        factId: fact.fact_id,
        deliveryIds: [member.delivery_id],
        symbol: fact.symbol,
        barStart: fact.bar_start,
        barDate: fact.bar_date,
        currency: fact.currency,
        openPrice: fact.open_price,
        highPrice: fact.high_price,
        lowPrice: fact.low_price,
        closePrice: fact.close_price,
        volume: fact.volume,
        tradeCount: fact.trade_count,
        vwap: fact.vwap,
        factSha256: fact.fact_sha256,
      };
    });

    return {
      connection,
      status: "READY",
      source: sourceSummary,
      deliveries,
      snapshot: {
        snapshotId: snapshot.snapshot_id,
        snapshotKind: snapshot.snapshot_kind,
        cutoffAt: snapshot.cutoff_at,
        targetSessionDate: snapshot.target_session_date,
        symbols: snapshot.symbols,
        selectionPolicy: snapshot.selection_policy,
        manifestSchema: snapshot.manifest_schema,
        manifestSha256: snapshot.manifest_sha256,
        sealedAt: snapshot.sealed_at,
      },
      bars,
      issues: [],
    };
  }
}
