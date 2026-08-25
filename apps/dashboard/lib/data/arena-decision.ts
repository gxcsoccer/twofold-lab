import Decimal from "decimal.js";

import type {
  ArenaAgentNode,
  ArenaAgentUsage,
  ArenaDecisionProjection,
  ArenaDecisionProjectionEvidence,
} from "@/lib/data/contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEQUENCE_PATTERN = /^(?:0|[1-9]\d*)$/;
const NON_NEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const DECISION_STATUSES = new Set([
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "BUDGET_EXHAUSTED",
  "NO_ACCEPTED_SUBMISSION",
]);
const AGENT_STATUSES = new Set(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"]);
const COST_STATUSES = new Set(["ESTIMATED", "PARTIAL", "UNPRICED", "UNAVAILABLE"]);
const ENFORCEMENT_STATUSES = new Set(["WITHIN_LIMITS", "EXHAUSTED", "UNPRICED"]);
const SUBMISSION_STATUSES = new Set(["PENDING", "ACCEPTED", "REJECTED", "NONE"]);

type RecordValue = Record<string, unknown>;

export type ArenaDecisionValidationResult =
  | { ok: true; value: ArenaDecisionProjection }
  | { ok: false; issues: string[] };

export type ArenaDecisionEvidenceValidationResult =
  | { ok: true; value: ArenaDecisionProjectionEvidence }
  | { ok: false; issues: string[] };

export function isDecisionUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function validateArenaDecisionProjectionEvidence(
  value: unknown,
): ArenaDecisionEvidenceValidationResult {
  const issues: string[] = [];
  const record = objectWithExactKeys(value, "projection", [
    "stateHash",
    "lastEventId",
    "projectionUpdatedAt",
  ], issues);
  if (!record) return { ok: false, issues };
  stringField(record, "stateHash", "projection", issues, SHA256_PATTERN);
  nullableStringField(record, "lastEventId", "projection", issues, UUID_PATTERN);
  timestampField(record, "projectionUpdatedAt", "projection", issues);
  return issues.length === 0
    ? { ok: true, value: value as ArenaDecisionProjectionEvidence }
    : { ok: false, issues };
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectWithExactKeys(
  value: unknown,
  path: string,
  keys: readonly string[],
  issues: string[],
): RecordValue | null {
  if (!isRecord(value)) {
    issues.push(`${path} 必须是对象`);
    return null;
  }

  const expected = new Set(keys);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      issues.push(`${path}.${key} 缺失`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) issues.push(`${path}.${key} 不属于 schemaVersion 1`);
  }
  return value;
}

function stringField(
  record: RecordValue,
  key: string,
  path: string,
  issues: string[],
  pattern?: RegExp,
): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${path}.${key} 必须是非空字符串`);
    return null;
  }
  if (pattern && !pattern.test(value)) {
    issues.push(`${path}.${key} 格式无效`);
    return null;
  }
  return value;
}

function nullableStringField(
  record: RecordValue,
  key: string,
  path: string,
  issues: string[],
  pattern?: RegExp,
): string | null | undefined {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${path}.${key} 必须是 null 或非空字符串`);
    return undefined;
  }
  if (pattern && !pattern.test(value)) {
    issues.push(`${path}.${key} 格式无效`);
    return undefined;
  }
  return value;
}

function enumField(
  record: RecordValue,
  key: string,
  path: string,
  allowed: ReadonlySet<string>,
  issues: string[],
): string | null {
  const value = stringField(record, key, path, issues);
  if (value !== null && !allowed.has(value)) {
    issues.push(`${path}.${key} 不在允许枚举内`);
    return null;
  }
  return value;
}

function timestampField(
  record: RecordValue,
  key: string,
  path: string,
  issues: string[],
): string | null {
  const value = stringField(record, key, path, issues, ISO_TIMESTAMP_PATTERN);
  if (value !== null && Number.isNaN(Date.parse(value))) {
    issues.push(`${path}.${key} 不是有效时间`);
    return null;
  }
  return value;
}

function nullableTimestampField(
  record: RecordValue,
  key: string,
  path: string,
  issues: string[],
): string | null | undefined {
  const value = nullableStringField(record, key, path, issues, ISO_TIMESTAMP_PATTERN);
  if (typeof value === "string" && Number.isNaN(Date.parse(value))) {
    issues.push(`${path}.${key} 不是有效时间`);
    return undefined;
  }
  return value;
}

function validateUsage(value: unknown, path: string, issues: string[]): value is ArenaAgentUsage {
  const issueCountBeforeValidation = issues.length;
  const record = objectWithExactKeys(value, path, [
    "providerRequestCount",
    "uncachedInputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "outputTokens",
    "reasoningTokens",
    "totalBillableTokens",
    "estimatedCostUsd",
    "costStatus",
    "pricingVersions",
  ], issues);
  if (!record) return false;

  const countKeys = [
    "providerRequestCount",
    "uncachedInputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "outputTokens",
    "reasoningTokens",
    "totalBillableTokens",
  ] as const;
  const counts = new Map<string, string>();
  for (const key of countKeys) {
    const count = stringField(record, key, path, issues, SEQUENCE_PATTERN);
    if (count !== null) counts.set(key, count);
  }
  nullableStringField(record, "estimatedCostUsd", path, issues, NON_NEGATIVE_DECIMAL_PATTERN);
  enumField(record, "costStatus", path, COST_STATUSES, issues);

  const pricingVersions = record.pricingVersions;
  if (!Array.isArray(pricingVersions)) {
    issues.push(`${path}.pricingVersions 必须是字符串数组`);
  } else {
    const seen = new Set<string>();
    for (const [index, version] of pricingVersions.entries()) {
      if (typeof version !== "string" || version.length === 0) {
        issues.push(`${path}.pricingVersions[${index}] 必须是非空字符串`);
      } else if (seen.has(version)) {
        issues.push(`${path}.pricingVersions 不得包含重复版本`);
      } else {
        seen.add(version);
      }
    }
  }

  if (counts.size === countKeys.length) {
    const output = BigInt(counts.get("outputTokens")!);
    const reasoning = BigInt(counts.get("reasoningTokens")!);
    const expectedBillable = BigInt(counts.get("uncachedInputTokens")!)
      + BigInt(counts.get("cacheReadTokens")!)
      + BigInt(counts.get("cacheWriteTokens")!)
      + output;
    if (reasoning > output) issues.push(`${path}.reasoningTokens 不能大于 outputTokens`);
    if (expectedBillable !== BigInt(counts.get("totalBillableTokens")!)) {
      issues.push(`${path}.totalBillableTokens 与互斥 Token 分桶不守恒`);
    }
  }

  return issues.length === issueCountBeforeValidation;
}

function validateAgent(value: unknown, index: number, issues: string[]): value is ArenaAgentNode {
  const path = `state.agents[${index}]`;
  const record = objectWithExactKeys(value, path, [
    "sessionId",
    "parentSessionId",
    "agentPath",
    "displayName",
    "origin",
    "delegationDepth",
    "status",
    "provider",
    "model",
    "startedAt",
    "completedAt",
    "lastEventSeq",
    "usage",
  ], issues);
  if (!record) return false;

  stringField(record, "sessionId", path, issues);
  nullableStringField(record, "parentSessionId", path, issues);
  stringField(record, "agentPath", path, issues);
  stringField(record, "displayName", path, issues);
  enumField(record, "origin", path, new Set(["root", "subagent"]), issues);
  stringField(record, "delegationDepth", path, issues, SEQUENCE_PATTERN);
  const status = enumField(record, "status", path, AGENT_STATUSES, issues);
  stringField(record, "provider", path, issues);
  stringField(record, "model", path, issues);
  timestampField(record, "startedAt", path, issues);
  const completedAt = nullableTimestampField(record, "completedAt", path, issues);
  stringField(record, "lastEventSeq", path, issues, SEQUENCE_PATTERN);
  validateUsage(record.usage, `${path}.usage`, issues);

  if (status !== null && ["SUCCEEDED", "FAILED", "CANCELED"].includes(status) && completedAt === null) {
    issues.push(`${path}.completedAt 在终态时不能为 null`);
  }
  return true;
}

function sumAgentCount(agents: ArenaAgentNode[], key: keyof Pick<
ArenaAgentUsage,
| "providerRequestCount"
| "uncachedInputTokens"
| "cacheReadTokens"
| "cacheWriteTokens"
| "outputTokens"
| "reasoningTokens"
| "totalBillableTokens"
>): bigint {
  return agents.reduce(
    (sum, agent) => sum + BigInt(agent.usage[key]),
    BigInt(0),
  );
}

function validateTree(agents: ArenaAgentNode[], rootSessionId: string, issues: string[]): void {
  const byId = new Map<string, ArenaAgentNode>();
  const paths = new Set<string>();
  for (const agent of agents) {
    if (byId.has(agent.sessionId)) issues.push("state.agents 的 sessionId 必须唯一");
    byId.set(agent.sessionId, agent);
    if (paths.has(agent.agentPath)) issues.push("state.agents 的 agentPath 必须唯一");
    paths.add(agent.agentPath);
  }

  const root = byId.get(rootSessionId);
  if (!root) {
    issues.push("state.rootSessionId 必须对应 agents 中的节点");
    return;
  }
  if (root.parentSessionId !== null || root.origin !== "root" || root.delegationDepth !== "0") {
    issues.push("state.rootSessionId 对应节点必须是 depth=0 且无父节点的 root");
  }

  const roots = agents.filter((agent) => agent.parentSessionId === null);
  if (roots.length !== 1) issues.push("state.agents 必须恰好包含一个无父节点的 root");

  for (const agent of agents) {
    if (agent.sessionId === rootSessionId) continue;
    if (agent.origin !== "subagent" || agent.parentSessionId === null) {
      issues.push(`Agent ${agent.agentPath} 必须是带父节点的 subagent`);
      continue;
    }
    const parent = byId.get(agent.parentSessionId);
    if (!parent) {
      issues.push(`Agent ${agent.agentPath} 的 parentSessionId 不存在`);
      continue;
    }
    if (
      BigInt(agent.delegationDepth)
      !== BigInt(parent.delegationDepth) + BigInt(1)
    ) {
      issues.push(`Agent ${agent.agentPath} 的 delegationDepth 与父节点不连续`);
    }

    const visited = new Set<string>();
    let cursor: ArenaAgentNode | undefined = agent;
    while (cursor && cursor.sessionId !== rootSessionId) {
      if (visited.has(cursor.sessionId)) {
        issues.push(`Agent ${agent.agentPath} 的父链存在环`);
        break;
      }
      visited.add(cursor.sessionId);
      cursor = cursor.parentSessionId ? byId.get(cursor.parentSessionId) : undefined;
    }
    if (!cursor) issues.push(`Agent ${agent.agentPath} 未连接到 root`);
  }
}

export function validateArenaDecisionProjection(
  value: unknown,
  expectedDecisionId: string,
): ArenaDecisionValidationResult {
  const issues: string[] = [];
  if (!isDecisionUuid(expectedDecisionId)) {
    return { ok: false, issues: ["路由 decisionId 不是有效 UUID"] };
  }

  const state = objectWithExactKeys(value, "state", [
    "schemaVersion",
    "decision",
    "rootSessionId",
    "agents",
    "treeUsage",
    "budget",
    "submission",
    "updatedAt",
  ], issues);
  if (!state) return { ok: false, issues };

  if (state.schemaVersion !== "1") issues.push("state.schemaVersion 必须严格等于 1");
  const rootSessionId = stringField(state, "rootSessionId", "state", issues);
  timestampField(state, "updatedAt", "state", issues);

  const decision = objectWithExactKeys(state.decision, "state.decision", [
    "decisionId",
    "runId",
    "seasonId",
    "bundleId",
    "bundleSha256",
    "presetId",
    "status",
    "decisionPacketId",
    "snapshotId",
    "packetSha256",
    "dataCutoffAt",
    "startedAt",
    "completedAt",
    "failureCode",
    "failureMessage",
  ], issues);
  if (decision) {
    const decisionId = stringField(decision, "decisionId", "state.decision", issues, UUID_PATTERN);
    if (decisionId !== null && decisionId.toLowerCase() !== expectedDecisionId.toLowerCase()) {
      issues.push("state.decision.decisionId 与路由 entity_id 不一致");
    }
    stringField(decision, "runId", "state.decision", issues, UUID_PATTERN);
    stringField(decision, "seasonId", "state.decision", issues, UUID_PATTERN);
    stringField(decision, "bundleId", "state.decision", issues);
    stringField(decision, "bundleSha256", "state.decision", issues, SHA256_PATTERN);
    stringField(decision, "presetId", "state.decision", issues);
    const status = enumField(decision, "status", "state.decision", DECISION_STATUSES, issues);
    stringField(decision, "decisionPacketId", "state.decision", issues, UUID_PATTERN);
    stringField(decision, "snapshotId", "state.decision", issues, UUID_PATTERN);
    stringField(decision, "packetSha256", "state.decision", issues, SHA256_PATTERN);
    timestampField(decision, "dataCutoffAt", "state.decision", issues);
    timestampField(decision, "startedAt", "state.decision", issues);
    const completedAt = nullableTimestampField(decision, "completedAt", "state.decision", issues);
    nullableStringField(decision, "failureCode", "state.decision", issues);
    nullableStringField(decision, "failureMessage", "state.decision", issues);
    if (status !== null && !["QUEUED", "RUNNING"].includes(status) && completedAt === null) {
      issues.push("state.decision.completedAt 在决策终态时不能为 null");
    }
  }

  let agents: ArenaAgentNode[] | null = null;
  if (!Array.isArray(state.agents) || state.agents.length === 0) {
    issues.push("state.agents 必须是至少包含 root 的数组");
  } else {
    const beforeAgents = issues.length;
    state.agents.forEach((agent, index) => validateAgent(agent, index, issues));
    if (issues.length === beforeAgents) agents = state.agents as ArenaAgentNode[];
  }

  const treeUsageValid = validateUsage(state.treeUsage, "state.treeUsage", issues);
  const budgetIssueCount = issues.length;
  const budget = objectWithExactKeys(state.budget, "state.budget", [
    "maxProviderRequests",
    "usedProviderRequests",
    "maxBillableTokens",
    "usedBillableTokens",
    "maxEstimatedCostUsd",
    "usedEstimatedCostUsd",
    "maxDescendants",
    "activeDescendants",
    "enforcementStatus",
  ], issues);
  if (budget) {
    for (const key of [
      "maxProviderRequests",
      "usedProviderRequests",
      "maxBillableTokens",
      "usedBillableTokens",
      "maxDescendants",
      "activeDescendants",
    ]) {
      stringField(budget, key, "state.budget", issues, SEQUENCE_PATTERN);
    }
    stringField(budget, "maxEstimatedCostUsd", "state.budget", issues, NON_NEGATIVE_DECIMAL_PATTERN);
    nullableStringField(budget, "usedEstimatedCostUsd", "state.budget", issues, NON_NEGATIVE_DECIMAL_PATTERN);
    enumField(budget, "enforcementStatus", "state.budget", ENFORCEMENT_STATUSES, issues);
  }
  const budgetValid = budget !== null && issues.length === budgetIssueCount;

  const submission = objectWithExactKeys(state.submission, "state.submission", [
    "status",
    "acceptedSubmissionId",
    "acceptedAt",
    "rejectionCode",
  ], issues);
  if (submission) {
    const status = enumField(submission, "status", "state.submission", SUBMISSION_STATUSES, issues);
    const acceptedSubmissionId = nullableStringField(
      submission,
      "acceptedSubmissionId",
      "state.submission",
      issues,
      UUID_PATTERN,
    );
    const acceptedAt = nullableTimestampField(submission, "acceptedAt", "state.submission", issues);
    const rejectionCode = nullableStringField(submission, "rejectionCode", "state.submission", issues);
    if (status === "ACCEPTED" && (typeof acceptedSubmissionId !== "string" || typeof acceptedAt !== "string" || rejectionCode !== null)) {
      issues.push("ACCEPTED submission 必须有 acceptedSubmissionId/acceptedAt 且无 rejectionCode");
    }
    if (status === "REJECTED" && (acceptedSubmissionId !== null || acceptedAt !== null || typeof rejectionCode !== "string")) {
      issues.push("REJECTED submission 只能包含 rejectionCode");
    }
    if ((status === "PENDING" || status === "NONE") && (acceptedSubmissionId !== null || acceptedAt !== null || rejectionCode !== null)) {
      issues.push(`${status} submission 的结果字段必须全部为 null`);
    }
  }

  if (agents && rootSessionId && treeUsageValid && budget && budgetValid) {
    validateTree(agents, rootSessionId, issues);
    const treeUsage = state.treeUsage as ArenaAgentUsage;
    const usageKeys = [
      "providerRequestCount",
      "uncachedInputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "outputTokens",
      "reasoningTokens",
      "totalBillableTokens",
    ] as const;
    for (const key of usageKeys) {
      if (sumAgentCount(agents, key) !== BigInt(treeUsage[key])) {
        issues.push(`state.treeUsage.${key} 不等于逐 Agent 汇总`);
      }
    }
    const versionUnion = [...new Set(agents.flatMap((agent) => agent.usage.pricingVersions))].sort();
    const treeVersions = [...treeUsage.pricingVersions].sort();
    if (versionUnion.join("\u0000") !== treeVersions.join("\u0000")) {
      issues.push("state.treeUsage.pricingVersions 不等于逐 Agent 版本并集");
    }
    if (budget.usedProviderRequests !== treeUsage.providerRequestCount) {
      issues.push("state.budget.usedProviderRequests 与 treeUsage 不一致");
    }
    if (budget.usedBillableTokens !== treeUsage.totalBillableTokens) {
      issues.push("state.budget.usedBillableTokens 与 treeUsage 不一致");
    }
    const usedCost = budget.usedEstimatedCostUsd;
    if (
      (usedCost === null) !== (treeUsage.estimatedCostUsd === null)
      || (typeof usedCost === "string"
        && typeof treeUsage.estimatedCostUsd === "string"
        && !new Decimal(usedCost).equals(treeUsage.estimatedCostUsd))
    ) {
      issues.push("state.budget.usedEstimatedCostUsd 与 treeUsage 不一致");
    }
    if (BigInt(budget.maxProviderRequests as string) < BigInt(budget.usedProviderRequests as string)) {
      issues.push("state.budget.usedProviderRequests 超过 maxProviderRequests");
    }
    const budgetExhausted = budget.enforcementStatus === "EXHAUSTED";
    if (
      !budgetExhausted
      && BigInt(budget.maxBillableTokens as string) < BigInt(budget.usedBillableTokens as string)
    ) {
      issues.push("state.budget.usedBillableTokens 超过 maxBillableTokens");
    }
    if (
      !budgetExhausted
      && typeof usedCost === "string"
      && new Decimal(usedCost).greaterThan(budget.maxEstimatedCostUsd as string)
    ) {
      issues.push("state.budget.usedEstimatedCostUsd 超过 maxEstimatedCostUsd");
    }
    const descendants = agents.filter((agent) => agent.origin === "subagent");
    if (BigInt(budget.maxDescendants as string) < BigInt(descendants.length)) {
      issues.push("state.agents 的 descendant 数超过预算上限");
    }
    const activeDescendants = descendants.filter((agent) => agent.status === "QUEUED" || agent.status === "RUNNING").length;
    if (BigInt(budget.activeDescendants as string) !== BigInt(activeDescendants)) {
      issues.push("state.budget.activeDescendants 与 Agent 树状态不一致");
    }
  }

  return issues.length === 0
    ? { ok: true, value: value as ArenaDecisionProjection }
    : { ok: false, issues };
}
