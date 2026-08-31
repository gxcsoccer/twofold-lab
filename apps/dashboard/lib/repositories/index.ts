import { cache } from "react";

import type {
  ArenaDecisionPageData,
  AuditData,
  ConnectionSummary,
  DashboardRepository,
  MarketDataPageData,
  RunDetailData,
  SeasonOverviewData,
  SettingsData,
} from "@/lib/data/contracts";
import {
  createUnavailableArenaDecision,
  createSetupAuditData,
  createSetupMarketData,
  createSetupRunDetail,
  createSetupSeasonOverview,
  createSetupSettingsData,
} from "@/lib/data/setup";
import { isDecisionUuid } from "@/lib/data/arena-decision";
import {
  ProjectionContractError,
  ProjectionNotReadyError,
  ProjectionReadError,
  SupabaseDashboardRepository,
} from "@/lib/repositories/supabase";
import { UnconfiguredDashboardRepository } from "@/lib/repositories/unconfigured";
import { createServerSupabaseClient } from "@/lib/supabase/server";

function getRepository(): {
  repository: DashboardRepository;
  fallbackConnection?: ConnectionSummary;
} {
  const client = createServerSupabaseClient();
  if (!client) {
    return { repository: new UnconfiguredDashboardRepository() };
  }

  return {
    repository: new SupabaseDashboardRepository(client),
    fallbackConnection: {
      configured: true,
      source: "supabase",
      readStatus: "READY",
      label: "Supabase 已配置",
      detail: "服务端已配置真实 Supabase 读取路径。",
    },
  };
}

function projectionFallbackConnection(error: unknown): ConnectionSummary {
  if (error instanceof ProjectionNotReadyError) {
    return {
      configured: true,
      source: "supabase",
      readStatus: "NOT_READY",
      label: "Supabase 已连接，投影尚未就绪",
      detail: `等待 Worker 生成 ${error.projection}；这不是数据库故障，也不会回退到默认结果。`,
    };
  }

  const databaseCode = error instanceof ProjectionReadError
    ? error.databaseCode
    : "UNKNOWN_PROJECTION_ERROR";
  console.error(`[dashboard] projection read failed (${databaseCode})`);
  return {
    configured: true,
    source: "supabase",
    readStatus: "ERROR",
    label: "Supabase 投影读取失败",
    detail: `数据库读取返回 ${databaseCode}；真实状态未知，页面已停止展示投影值。`,
  };
}

function marketDataErrorConnection(detail: string): ConnectionSummary {
  return {
    configured: true,
    source: "supabase",
    readStatus: "ERROR",
    label: "真实市场数据读取失败",
    detail: `${detail}；页面已停止展示市场数据证据。`,
  };
}

/** Cached per request: the round spine in the app chrome reads this too, and
 *  one page render must not cost two projection reads. */
export const loadSeasonOverview = cache(
  async function loadSeasonOverview(): Promise<SeasonOverviewData> {
    const { repository, fallbackConnection } = getRepository();
    try {
      return await repository.getSeasonOverview();
    } catch (error) {
      return createSetupSeasonOverview(
        fallbackConnection ? projectionFallbackConnection(error) : undefined,
      );
    }
  },
);

export async function loadRunDetail(runId: string): Promise<RunDetailData> {
  const { repository, fallbackConnection } = getRepository();
  try {
    return await repository.getRunDetail(runId);
  } catch (error) {
    return createSetupRunDetail(
      fallbackConnection ? projectionFallbackConnection(error) : undefined,
    );
  }
}

export async function loadAuditData(): Promise<AuditData> {
  const { repository, fallbackConnection } = getRepository();
  try {
    return await repository.getAuditData();
  } catch (error) {
    return createSetupAuditData(
      fallbackConnection ? projectionFallbackConnection(error) : undefined,
    );
  }
}

/** Cached per request: the masthead readiness counter reads this too. */
export const loadSettingsData = cache(
  async function loadSettingsData(): Promise<SettingsData> {
    const { repository, fallbackConnection } = getRepository();
    try {
      return await repository.getSettingsData();
    } catch (error) {
      return createSetupSettingsData(
        fallbackConnection ? projectionFallbackConnection(error) : undefined,
      );
    }
  },
);

export async function loadMarketData(): Promise<MarketDataPageData> {
  const { repository, fallbackConnection } = getRepository();
  try {
    return await repository.getMarketData();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "UNKNOWN_DATA_ERROR";
    if (fallbackConnection) {
      console.error(`[dashboard] market data read failed (${detail})`);
    }
    return createSetupMarketData(
      fallbackConnection ? marketDataErrorConnection(detail) : undefined,
      fallbackConnection ? "ERROR" : "UNCONFIGURED",
      fallbackConnection
        ? [`真实数据读取失败：${detail}`]
        : undefined,
    );
  }
}

export async function loadArenaDecision(decisionId: string): Promise<ArenaDecisionPageData> {
  const { repository, fallbackConnection } = getRepository();
  if (!isDecisionUuid(decisionId)) {
    return createUnavailableArenaDecision(
      decisionId,
      {
        configured: fallbackConnection?.configured ?? false,
        source: fallbackConnection?.source ?? "unconfigured",
        readStatus: "ERROR",
        label: "Decision 地址无效",
        detail: "路由参数不是 UUID；为避免读到错误实体，数据库查询未执行。",
      },
      "ERROR",
      ["decisionId 必须是有效 UUID。"],
    );
  }

  try {
    return await repository.getArenaDecision(decisionId);
  } catch (error) {
    if (error instanceof ProjectionNotReadyError) {
      return createUnavailableArenaDecision(
        decisionId,
        projectionFallbackConnection(error),
        "NOT_READY",
        ["这个 decision UUID 尚无 dashboard.arena_decision 投影。"],
      );
    }

    const contractIssues = error instanceof ProjectionContractError
      ? error.issues
      : [];
    const databaseCode = error instanceof ProjectionReadError
      ? error.databaseCode
      : error instanceof ProjectionContractError
        ? error.databaseCode
        : "UNKNOWN_PROJECTION_ERROR";
    console.error(`[dashboard] arena decision projection read failed (${databaseCode})`);
    return createUnavailableArenaDecision(
      decisionId,
      {
        configured: fallbackConnection?.configured ?? false,
        source: fallbackConnection?.source ?? "unconfigured",
        readStatus: "ERROR",
        label: "Agent 投影读取失败",
        detail: `读取返回 ${databaseCode}；页面已停止展示该决策状态。`,
      },
      "ERROR",
      contractIssues.length > 0
        ? contractIssues
        : [`真实投影读取失败：${databaseCode}`],
    );
  }
}
