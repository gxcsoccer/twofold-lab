import Decimal from "decimal.js";

import type { AcceptedTargetCycleProjection } from "./contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INTEGER = /^(?:0|[1-9]\d*)$/;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type RecordValue = Record<string, unknown>;

export type AcceptedTargetCycleValidation =
  | { ok: true; value: AcceptedTargetCycleProjection }
  | { ok: false; issues: string[] };

export function validateAcceptedTargetCycleProjection(
  value: unknown,
  expectedDecisionId: string,
  expectedSubmissionId: string | null,
): AcceptedTargetCycleValidation {
  const issues: string[] = [];
  const state = exactObject(value, "cycle", [
    "schema", "status", "cycleId", "decisionId", "acceptedSubmissionId",
    "s1", "s2", "ledger", "nav", "artifactSha256", "completedAt",
  ], issues);
  if (!state) return { ok: false, issues };
  literal(state.schema, "twofold.dashboard.accepted_target_cycle/v1", "cycle.schema", issues);
  literal(state.status, "COMPLETED", "cycle.status", issues);
  string(state, "cycleId", "cycle", UUID, issues);
  const decisionId = string(state, "decisionId", "cycle", UUID, issues);
  const submissionId = string(state, "acceptedSubmissionId", "cycle", UUID, issues);
  string(state, "artifactSha256", "cycle", SHA256, issues);
  const completedAt = string(state, "completedAt", "cycle", TIMESTAMP, issues);
  if (completedAt && new Date(completedAt).toISOString() !== completedAt) {
    issues.push("cycle.completedAt 不是规范 UTC 时间");
  }
  if (decisionId !== null && decisionId !== expectedDecisionId) {
    issues.push("cycle.decisionId 与页面 decision 不一致");
  }
  if (
    expectedSubmissionId !== null
    && submissionId !== null
    && submissionId !== expectedSubmissionId
  ) {
    issues.push("cycle.acceptedSubmissionId 与已接受提交不一致");
  }

  validateStage(state.s1, "cycle.s1", issues);
  validateStage(state.s2, "cycle.s2", issues);
  const ledger = exactObject(state.ledger, "cycle.ledger", [
    "transactionCount", "headSequence", "headSha256",
  ], issues);
  if (ledger) {
    string(ledger, "transactionCount", "cycle.ledger", INTEGER, issues);
    string(ledger, "headSequence", "cycle.ledger", INTEGER, issues);
    string(ledger, "headSha256", "cycle.ledger", SHA256, issues);
  }
  const nav = exactObject(state.nav, "cycle.nav", [
    "currency", "positionMarketValue", "brokerNav", "taxReserveDeductions",
    "taxReservedNav", "liquidationDeductions", "liquidationNav",
  ], issues);
  if (nav) validateNav(nav, issues);

  return issues.length === 0
    ? { ok: true, value: value as AcceptedTargetCycleProjection }
    : { ok: false, issues };
}

function validateStage(value: unknown, path: string, issues: string[]): void {
  const stage = exactObject(value, path, [
    "status", "orderCount", "settlementCount",
  ], issues);
  if (!stage) return;
  literal(stage.status, "COMPLETED", `${path}.status`, issues);
  const orders = string(stage, "orderCount", path, INTEGER, issues);
  const settlements = string(stage, "settlementCount", path, INTEGER, issues);
  if (orders !== null && settlements !== null && orders !== settlements) {
    issues.push(`${path} 的 orderCount 与 settlementCount 不守恒`);
  }
}

function validateNav(nav: RecordValue, issues: string[]): void {
  const issueCountBeforeNav = issues.length;
  string(nav, "currency", "cycle.nav", /^[A-Z]{3}$/, issues);
  for (const key of [
    "positionMarketValue", "brokerNav", "taxReserveDeductions",
    "taxReservedNav", "liquidationDeductions", "liquidationNav",
  ]) string(nav, key, "cycle.nav", DECIMAL, issues);
  if (issues.length > issueCountBeforeNav) return;
  const broker = new Decimal(nav.brokerNav as string);
  const tax = new Decimal(nav.taxReserveDeductions as string);
  const reserved = new Decimal(nav.taxReservedNav as string);
  const liquidation = new Decimal(nav.liquidationDeductions as string);
  const liquidationNav = new Decimal(nav.liquidationNav as string);
  if (!broker.minus(tax).equals(reserved)) {
    issues.push("cycle.nav 的 Broker NAV 与 Tax-reserved NAV 不守恒");
  }
  if (!reserved.minus(liquidation).equals(liquidationNav)) {
    issues.push("cycle.nav 的 Tax-reserved NAV 与 Liquidation NAV 不守恒");
  }
}

function exactObject(
  value: unknown,
  path: string,
  keys: readonly string[],
  issues: string[],
): RecordValue | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} 必须是对象`);
    return null;
  }
  const record = value as RecordValue;
  const expected = new Set(keys);
  for (const key of keys) if (!Object.hasOwn(record, key)) issues.push(`${path}.${key} 缺失`);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) issues.push(`${path}.${key} 不属于 v1 schema`);
  }
  return record;
}

function string(
  record: RecordValue,
  key: string,
  path: string,
  pattern: RegExp,
  issues: string[],
): string | null {
  const value = record[key];
  if (typeof value !== "string" || !pattern.test(value)) {
    issues.push(`${path}.${key} 格式无效`);
    return null;
  }
  return value;
}

function literal(
  value: unknown,
  expected: string,
  path: string,
  issues: string[],
): void {
  if (value !== expected) issues.push(`${path} 必须等于 ${expected}`);
}
