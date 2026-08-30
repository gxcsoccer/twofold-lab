import type {
  ArenaDecisionPageData,
  AuditData,
  ConnectionSummary,
  MarketDataPageData,
  RunDetailData,
  SeasonOverviewData,
  SettingsData,
  SetupItem,
} from "@/lib/data/contracts";

export const disconnectedConnection: ConnectionSummary = {
  configured: false,
  source: "unconfigured",
  readStatus: "UNCONFIGURED",
  label: "真实数据未配置",
  detail: "Supabase 与市场数据凭证尚未连接；系统不会回退到演示数据。",
};

export const setupChecklist: SetupItem[] = [
  {
    id: "initial-lots",
    label: "导入初始 LULU 税务批次",
    description: "数量、购入日期、成本、费用、快照时间与来源哈希。",
    status: "missing",
    owner: "实验负责人",
  },
  {
    id: "season-window",
    label: "冻结赛季窗口",
    description: "在任何决策运行前，设定首个与最后一个有效交易日。",
    status: "missing",
    owner: "实验负责人",
  },
  {
    id: "skill-commits",
    label: "固定 Skill 提交",
    description: "将 No Skill、UZI 和 ai-berkshire 输入锁定到不可变版本。",
    status: "pending",
    owner: "Harness 负责人",
  },
  {
    id: "market-data",
    label: "批准市场与汇率数据源",
    description: "记录来源、可用时间戳、修订策略和快照哈希。",
    status: "missing",
    owner: "数据负责人",
  },
  {
    id: "rulesets",
    label: "冻结费用与税务规则集",
    description: "对 Futu 费用、滑点、税务、汇率和交割假设统一版本化。",
    status: "pending",
    owner: "实验负责人",
  },
  {
    id: "runtime-secret",
    label: "连接私有模型运行时",
    description: "DeepSeek 凭证保存在工作进程的密钥存储中，绝不会在此处暴露。",
    status: "missing",
    owner: "Harness 负责人",
  },
  {
    id: "model-pricing",
    label: "冻结模型定价版本",
    description: "保存官方费率来源、生效区间与计价单位；估算成本不冒充账单实付。",
    status: "pending",
    owner: "Harness 负责人",
  },
];

export function createSetupSeasonOverview(
  connection: ConnectionSummary = disconnectedConnection,
): SeasonOverviewData {
  return {
    setupRequired: true,
    connection,
    checklist: setupChecklist,
    overview: null,
  };
}

export function createSetupMarketData(
  connection: ConnectionSummary = disconnectedConnection,
  status: MarketDataPageData["status"] = "UNCONFIGURED",
  issues: string[] = [
    "需要配置独立的 Twofold Supabase 项目。",
    "需要在 Worker 密钥层配置 Alpaca Market Data 凭证。",
  ],
): MarketDataPageData {
  return {
    connection,
    status,
    source: null,
    deliveries: [],
    snapshot: null,
    bars: [],
    issues,
  };
}

export function createSetupRunDetail(
  connection: ConnectionSummary = disconnectedConnection,
): RunDetailData {
  return {
    setupRequired: true,
    connection,
    run: null,
    seasonName: null,
    roundBase: "0",
    successThreshold: "0",
    failureThreshold: "0",
    brokerNav: "0",
    taxReservedNav: "0",
    holdings: [],
    pipeline: [],
    lastDecision: null,
    manifest: [],
  };
}

export function createSetupAuditData(
  connection: ConnectionSummary = disconnectedConnection,
): AuditData {
  return {
    setupRequired: true,
    connection,
    asOf: null,
    chainStatus: "EMPTY",
    eventCount: "0",
    lastCheckpointHash: null,
    events: [],
  };
}

export function createSetupSettingsData(
  connection: ConnectionSummary = disconnectedConnection,
): SettingsData {
  return {
    setupRequired: true,
    connection,
    checklist: setupChecklist,
    draft: {
      seasonName: "赛季 01",
      startAt: "",
      endAt: "",
      timezone: "America/New_York",
      decisionCadence: "Weekly · final trading day at 16:15",
      slippageBps: "5",
      feeProfile: "Futu HK · US stocks fixed platform fee",
      taxProfile: "Mainland China individual · shadow reserve",
      marketDataProvider: "Not selected",
      maxProviderRequestsPerDecision: "2",
      maxBillableTokensPerDecision: "100000",
      maxEstimatedCostUsdPerDecision: "1.00",
    },
    model: {
      id: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      credentialStatus: "not_configured",
      pricingStatus: "not_configured",
      pricingVersion: null,
    },
  };
}

export function createUnavailableArenaDecision(
  decisionId: string,
  connection: ConnectionSummary = disconnectedConnection,
  status: ArenaDecisionPageData["status"] = "UNCONFIGURED",
  issues: string[] = [],
): ArenaDecisionPageData {
  return {
    decisionId,
    connection,
    status,
    projection: null,
    evidence: null,
    acceptedSubmission: null,
    executionCycle: null,
    executionReadiness: null,
    issues,
  };
}
