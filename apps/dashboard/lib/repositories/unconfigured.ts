import type {
  ArenaDecisionPageData,
  AuditData,
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

/** Fail-closed repository used only when no real Supabase connection exists. */
export class UnconfiguredDashboardRepository implements DashboardRepository {
  async getSeasonOverview(): Promise<SeasonOverviewData> {
    return createSetupSeasonOverview();
  }

  async getRunDetail(_runId: string): Promise<RunDetailData> {
    return createSetupRunDetail();
  }

  async getAuditData(): Promise<AuditData> {
    return createSetupAuditData();
  }

  async getSettingsData(): Promise<SettingsData> {
    return createSetupSettingsData();
  }

  async getMarketData(): Promise<MarketDataPageData> {
    return createSetupMarketData();
  }

  async getArenaDecision(decisionId: string): Promise<ArenaDecisionPageData> {
    return createUnavailableArenaDecision(decisionId);
  }
}
