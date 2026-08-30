import type {
  PrivateArenaEntrantOverview,
  PrivateArenaNoTradeReason,
  PrivateArenaOverview,
  PrivateArenaRoundStage,
  PrivateArenaSeasonStatus,
  PrivateArenaWorkPhase,
  PrivateArenaWorkStatus,
} from "./contracts";

type ValidationResult =
  | { readonly ok: true; readonly value: PrivateArenaOverview }
  | { readonly ok: false; readonly issues: readonly string[] };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const UTC_MILLISECONDS =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const PRIVATE_ARENA_PHASES = Object.freeze([
  "RUN_AGENT_DECISION",
  "PREPARE_S1_ORDERS",
  "CAPTURE_S1_OPEN_REFERENCE",
  "CAPTURE_S1_CLOSE",
  "SETTLE_S1_AND_PREPARE_S2",
  "CAPTURE_S2_OPEN_REFERENCE",
  "CAPTURE_S2_CLOSE",
  "FINALIZE_ACCEPTED_TARGET_CYCLE",
] as const satisfies readonly PrivateArenaWorkPhase[]);

const WORK_STATUSES = new Set<PrivateArenaWorkStatus>([
  "REQUESTED", "CLAIMED", "SUCCEEDED", "FAILED", "CANCELED",
]);
const SEASON_STATUSES = new Set<PrivateArenaSeasonStatus>([
  "UPCOMING", "RUNNING", "COMPLETE",
]);
const ROUND_STAGES = new Set<PrivateArenaRoundStage>([
  "SCHEDULED", "DECISION_WINDOW", "WAITING_S1_OPEN", "S1_EXECUTION",
  "SETTLING_S1", "S2_EXECUTION", "FINALIZING", "COMPLETE",
]);
const NO_TRADE_STATUSES = new Set(["REQUESTED", "CLAIMED", "SUCCEEDED", "FAILED"]);
const NO_TRADE_PHASES: Readonly<Record<PrivateArenaNoTradeReason, string>> = {
  DECISION_UNAVAILABLE: "RUN_AGENT_DECISION",
  S1_PLAN_UNAVAILABLE: "PREPARE_S1_ORDERS",
  S1_CHECKPOINT_UNAVAILABLE: "SETTLE_S1_AND_PREPARE_S2",
  FINALIZATION_UNAVAILABLE: "FINALIZE_ACCEPTED_TARGET_CYCLE",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  issues: string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    issues.push(`${path} 字段不属于 v1 精确契约`);
  }
}

function string(
  value: unknown,
  path: string,
  issues: string[],
  pattern?: RegExp,
): value is string {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    issues.push(`${path} 格式无效`);
    return false;
  }
  return true;
}

function nullableString(
  value: unknown,
  path: string,
  issues: string[],
  pattern?: RegExp,
): value is string | null {
  return value === null || string(value, path, issues, pattern);
}

function timestamp(value: unknown, path: string, issues: string[]): value is string {
  return string(value, path, issues, UTC_MILLISECONDS)
    && !Number.isNaN(Date.parse(value));
}

function containsJsonNumber(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.some(containsJsonNumber);
  if (isObject(value)) return Object.values(value).some(containsJsonNumber);
  return false;
}

function validateWork(
  value: unknown,
  index: number,
  issues: string[],
): void {
  const path = `entrants[${index}].work`;
  if (!Array.isArray(value)) {
    issues.push(`${path} 必须是数组`);
    return;
  }
  if (value.length !== 0 && value.length !== PRIVATE_ARENA_PHASES.length) {
    issues.push(`${path} 必须为空或包含完整 8 阶段 DAG`);
  }
  value.forEach((item, phaseIndex) => {
    const itemPath = `${path}[${phaseIndex}]`;
    if (!isObject(item)) {
      issues.push(`${itemPath} 必须是对象`);
      return;
    }
    exactKeys(item, [
      "schema", "phase", "status", "scheduledAt", "deadlineAt",
      "attemptCount", "errorCode",
    ], itemPath, issues);
    if (item.schema !== "twofold.private_arena_work_overview/v1") {
      issues.push(`${itemPath}.schema 不受支持`);
    }
    const expectedPhase = PRIVATE_ARENA_PHASES[phaseIndex];
    if (item.phase !== expectedPhase) issues.push(`${itemPath}.phase 顺序无效`);
    if (!WORK_STATUSES.has(item.status as PrivateArenaWorkStatus)) {
      issues.push(`${itemPath}.status 无效`);
    }
    timestamp(item.scheduledAt, `${itemPath}.scheduledAt`, issues);
    if (item.deadlineAt !== null) {
      timestamp(item.deadlineAt, `${itemPath}.deadlineAt`, issues);
    }
    string(item.attemptCount, `${itemPath}.attemptCount`, issues, INTEGER);
    nullableString(item.errorCode, `${itemPath}.errorCode`, issues);
  });
}

function validateScore(value: unknown, index: number, issues: string[]): void {
  const path = `entrants[${index}].valuation`;
  if (!isObject(value)) {
    issues.push(`${path} 必须是对象或 null`);
    return;
  }
  exactKeys(value, [
    "schema", "stage", "roundIndex", "valuationAt", "brokerNav",
    "taxReservedNav", "liquidationNav", "scoreBaseLiquidationNav",
    "returnMultiple", "valuationSha256",
  ], path, issues);
  if (value.schema !== "twofold.private_arena_score/v1") {
    issues.push(`${path}.schema 不受支持`);
  }
  if (!new Set(["OPENING", "S1_CLOSE", "S2_CLOSE"]).has(String(value.stage))) {
    issues.push(`${path}.stage 无效`);
  }
  string(value.roundIndex, `${path}.roundIndex`, issues, POSITIVE_INTEGER);
  timestamp(value.valuationAt, `${path}.valuationAt`, issues);
  for (const field of [
    "brokerNav", "taxReservedNav", "liquidationNav",
    "scoreBaseLiquidationNav", "returnMultiple",
  ] as const) string(value[field], `${path}.${field}`, issues, DECIMAL);
  string(value.valuationSha256, `${path}.valuationSha256`, issues, SHA256);
}

function validateNoTrade(value: unknown, index: number, issues: string[]): void {
  const path = `entrants[${index}].noTrade`;
  if (!isObject(value)) {
    issues.push(`${path} 必须是对象或 null`);
    return;
  }
  exactKeys(value, [
    "schema", "status", "reasonCode", "sourcePhase", "scheduledAt",
    "completedAt", "valuationId", "outcome",
  ], path, issues);
  if (value.schema !== "twofold.private_arena_no_trade_overview/v1") {
    issues.push(`${path}.schema 不受支持`);
  }
  if (!NO_TRADE_STATUSES.has(String(value.status))) {
    issues.push(`${path}.status 无效`);
  }
  const reason = value.reasonCode as PrivateArenaNoTradeReason;
  if (!Object.hasOwn(NO_TRADE_PHASES, String(value.reasonCode))) {
    issues.push(`${path}.reasonCode 无效`);
  } else if (value.sourcePhase !== NO_TRADE_PHASES[reason]) {
    issues.push(`${path}.sourcePhase 与 reasonCode 不一致`);
  }
  timestamp(value.scheduledAt, `${path}.scheduledAt`, issues);
  if (value.completedAt !== null) {
    timestamp(value.completedAt, `${path}.completedAt`, issues);
  }
  nullableString(value.valuationId, `${path}.valuationId`, issues, UUID);
  if (
    value.outcome !== null
    && value.outcome !== "NO_TRADE_CARRY_FORWARD"
    && value.outcome !== "EXISTING_S2_VALUATION"
  ) issues.push(`${path}.outcome 无效`);
  const terminal = value.status === "SUCCEEDED" || value.status === "FAILED";
  if (terminal !== (value.completedAt !== null)) {
    issues.push(`${path}.completedAt 与状态不一致`);
  }
  const succeeded = value.status === "SUCCEEDED";
  if (
    succeeded !== (value.valuationId !== null)
    || succeeded !== (value.outcome !== null)
  ) issues.push(`${path} 成功状态必须绑定估值与结果`);
}

function validateEntrant(
  value: unknown,
  index: number,
  issues: string[],
): value is PrivateArenaEntrantOverview {
  const path = `entrants[${index}]`;
  if (!isObject(value)) {
    issues.push(`${path} 必须是对象`);
    return false;
  }
  exactKeys(value, [
    "schema", "rank", "entrantId", "entrantCode", "runId", "bundleId",
    "presetId", "provider", "model", "executionClass", "roundEntryId",
    "decisionId", "noTrade", "valuation", "work",
  ], path, issues);
  if (value.schema !== "twofold.private_arena_entrant_overview/v2") {
    issues.push(`${path}.schema 不受支持`);
  }
  nullableString(value.rank, `${path}.rank`, issues, POSITIVE_INTEGER);
  string(value.entrantId, `${path}.entrantId`, issues, UUID);
  string(value.entrantCode, `${path}.entrantCode`, issues);
  string(value.runId, `${path}.runId`, issues, UUID);
  for (const field of ["bundleId", "presetId", "provider", "model"] as const) {
    string(value[field], `${path}.${field}`, issues);
  }
  if (value.executionClass !== "ROOT_ONLY" && value.executionClass !== "ORCHESTRATED") {
    issues.push(`${path}.executionClass 无效`);
  }
  nullableString(value.roundEntryId, `${path}.roundEntryId`, issues, UUID);
  nullableString(value.decisionId, `${path}.decisionId`, issues, UUID);
  if ((value.roundEntryId === null) !== (value.decisionId === null)) {
    issues.push(`${path} 的 roundEntryId 与 decisionId 必须同时存在`);
  }
  if ((value.rank === null) !== (value.valuation === null)) {
    issues.push(`${path} 的 rank 与 valuation 必须同时存在`);
  }
  if (value.noTrade !== null) validateNoTrade(value.noTrade, index, issues);
  if (value.valuation !== null) validateScore(value.valuation, index, issues);
  validateWork(value.work, index, issues);
  if (value.roundEntryId === null && Array.isArray(value.work) && value.work.length > 0) {
    issues.push(`${path} 没有 Round 席位时不能拥有工作 DAG`);
  }
  return true;
}

export function validatePrivateArenaOverview(value: unknown): ValidationResult {
  const issues: string[] = [];
  if (containsJsonNumber(value)) issues.push("overview 不允许 JSON number token");
  if (!isObject(value)) return { ok: false, issues: ["overview 必须是对象"] };
  exactKeys(value, ["schema", "asOf", "season", "currentRound", "entrants"], "overview", issues);
  if (value.schema !== "twofold.private_arena_overview/v2") {
    issues.push("overview.schema 不受支持");
  }
  timestamp(value.asOf, "overview.asOf", issues);

  if (!isObject(value.season)) {
    issues.push("overview.season 必须是对象");
  } else {
    const season = value.season;
    exactKeys(season, [
      "schema", "seasonId", "seasonCode", "displayName", "opensAt",
      "closesAt", "status", "decisionCadence", "marketTimezone",
      "openingHolding", "openingCash", "entrantCount", "roundCount",
    ], "overview.season", issues);
    if (season.schema !== "twofold.private_arena_season_overview/v1") {
      issues.push("overview.season.schema 不受支持");
    }
    string(season.seasonId, "overview.season.seasonId", issues, UUID);
    for (const field of ["seasonCode", "displayName", "openingHolding"] as const) {
      string(season[field], `overview.season.${field}`, issues);
    }
    timestamp(season.opensAt, "overview.season.opensAt", issues);
    timestamp(season.closesAt, "overview.season.closesAt", issues);
    if (!SEASON_STATUSES.has(season.status as PrivateArenaSeasonStatus)) {
      issues.push("overview.season.status 无效");
    }
    if (season.decisionCadence !== "US_EQUITY_DAILY_AFTER_CLOSE") {
      issues.push("overview.season.decisionCadence 无效");
    }
    if (season.marketTimezone !== "America/New_York") {
      issues.push("overview.season.marketTimezone 无效");
    }
    string(season.openingCash, "overview.season.openingCash", issues, DECIMAL);
    string(season.entrantCount, "overview.season.entrantCount", issues, INTEGER);
    string(season.roundCount, "overview.season.roundCount", issues, INTEGER);
  }

  if (value.currentRound !== null) {
    if (!isObject(value.currentRound)) {
      issues.push("overview.currentRound 必须是对象或 null");
    } else {
      const round = value.currentRound;
      exactKeys(round, [
        "schema", "roundId", "roundIndex", "stage", "entryCount",
        "finalCount", "decisionSessionDate", "decisionWindowOpensAt",
        "decisionWindowClosesAt", "s1SessionDate", "s1OpenAt", "s1CloseAt",
        "s2SessionDate", "s2OpenAt", "s2CloseAt", "cycleReadyAt",
      ], "overview.currentRound", issues);
      if (round.schema !== "twofold.private_arena_round_overview/v1") {
        issues.push("overview.currentRound.schema 不受支持");
      }
      string(round.roundId, "overview.currentRound.roundId", issues, UUID);
      for (const field of ["roundIndex", "entryCount", "finalCount"] as const) {
        string(round[field], `overview.currentRound.${field}`, issues, INTEGER);
      }
      if (!ROUND_STAGES.has(round.stage as PrivateArenaRoundStage)) {
        issues.push("overview.currentRound.stage 无效");
      }
      for (const field of [
        "decisionSessionDate", "s1SessionDate", "s2SessionDate",
      ] as const) string(round[field], `overview.currentRound.${field}`, issues, DATE);
      for (const field of [
        "decisionWindowOpensAt", "decisionWindowClosesAt", "s1OpenAt",
        "s1CloseAt", "s2OpenAt", "s2CloseAt", "cycleReadyAt",
      ] as const) timestamp(round[field], `overview.currentRound.${field}`, issues);
      if (
        typeof round.entryCount === "string" && INTEGER.test(round.entryCount)
        && typeof round.finalCount === "string" && INTEGER.test(round.finalCount)
        && BigInt(round.finalCount) > BigInt(round.entryCount)
      ) issues.push("overview.currentRound.finalCount 不能超过 entryCount");
    }
  }

  if (!Array.isArray(value.entrants)) {
    issues.push("overview.entrants 必须是数组");
  } else {
    value.entrants.forEach((entrant, index) => validateEntrant(entrant, index, issues));
    const ids = new Set<string>();
    const codes = new Set<string>();
    for (const entrant of value.entrants) {
      if (!isObject(entrant)) continue;
      if (typeof entrant.entrantId === "string" && ids.has(entrant.entrantId)) {
        issues.push("overview.entrants 包含重复 entrantId");
      }
      if (typeof entrant.entrantCode === "string" && codes.has(entrant.entrantCode)) {
        issues.push("overview.entrants 包含重复 entrantCode");
      }
      if (typeof entrant.entrantId === "string") ids.add(entrant.entrantId);
      if (typeof entrant.entrantCode === "string") codes.add(entrant.entrantCode);
    }
    const count = isObject(value.season) ? value.season.entrantCount : null;
    if (typeof count === "string" && INTEGER.test(count)
      && BigInt(count) !== BigInt(value.entrants.length)) {
      issues.push("overview.season.entrantCount 与 entrants 数量不一致");
    }
  }

  return issues.length === 0
    ? { ok: true, value: value as unknown as PrivateArenaOverview }
    : { ok: false, issues };
}
