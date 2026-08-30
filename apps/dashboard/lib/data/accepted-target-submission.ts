import type { AcceptedTargetSubmission } from "./contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INTEGER = /^(?:0|[1-9]\d*)$/;
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,14}$/;

type RecordValue = Record<string, unknown>;

export type AcceptedTargetSubmissionValidation =
  | { ok: true; value: AcceptedTargetSubmission }
  | { ok: false; issues: string[] };

export function validateAcceptedTargetSubmission(
  value: unknown,
  expectedDecisionId: string,
  expectedSubmissionId: string,
): AcceptedTargetSubmissionValidation {
  const issues: string[] = [];
  const row = exactObject(value, "submission", [
    "submission_id",
    "decision_id",
    "targets",
    "cash_weight_bps",
    "decision_summary",
    "submission_sha256",
    "accepted_at",
  ], issues);
  if (row === null) return { ok: false, issues };

  const submissionId = string(row.submission_id, "submission.submission_id", UUID, issues);
  const decisionId = string(row.decision_id, "submission.decision_id", UUID, issues);
  const cashWeightBps = string(
    row.cash_weight_bps,
    "submission.cash_weight_bps",
    INTEGER,
    issues,
  );
  const decisionSummary = nonEmptyString(
    row.decision_summary,
    "submission.decision_summary",
    issues,
  );
  const submissionSha256 = string(
    row.submission_sha256,
    "submission.submission_sha256",
    SHA256,
    issues,
  );
  const acceptedAt = timestamp(row.accepted_at, "submission.accepted_at", issues);

  if (submissionId !== null && submissionId !== expectedSubmissionId) {
    issues.push("submission.submission_id 与 decision 投影不一致");
  }
  if (decisionId !== null && decisionId !== expectedDecisionId) {
    issues.push("submission.decision_id 与页面 decision 不一致");
  }

  const targets: Array<AcceptedTargetSubmission["targets"][number]> = [];
  let targetWeightTotal = 0n;
  const symbols = new Set<string>();
  if (!Array.isArray(row.targets)) {
    issues.push("submission.targets 必须是数组");
  } else {
    row.targets.forEach((candidate, index) => {
      const target = exactObject(candidate, `submission.targets[${index}]`, [
        "symbol", "target_weight_bps",
      ], issues, ["rationale"]);
      if (target === null) return;
      const symbol = string(
        target.symbol,
        `submission.targets[${index}].symbol`,
        SYMBOL,
        issues,
      );
      const targetWeightBps = string(
        target.target_weight_bps,
        `submission.targets[${index}].target_weight_bps`,
        INTEGER,
        issues,
      );
      const rationale = Object.hasOwn(target, "rationale")
        ? nonEmptyString(
          target.rationale,
          `submission.targets[${index}].rationale`,
          issues,
        )
        : undefined;
      if (symbol !== null) {
        if (symbols.has(symbol)) issues.push(`submission.targets 的 symbol ${symbol} 重复`);
        symbols.add(symbol);
      }
      if (targetWeightBps !== null) targetWeightTotal += BigInt(targetWeightBps);
      if (symbol !== null && targetWeightBps !== null && rationale !== null) {
        targets.push({
          symbol,
          targetWeightBps,
          ...(rationale === undefined ? {} : { rationale }),
        });
      }
    });
  }
  if (
    cashWeightBps !== null
    && targetWeightTotal + BigInt(cashWeightBps) !== 10_000n
  ) {
    issues.push("submission 的目标权重与现金权重之和必须为 10000 bps");
  }

  if (
    issues.length > 0
    || submissionId === null
    || decisionId === null
    || cashWeightBps === null
    || decisionSummary === null
    || submissionSha256 === null
    || acceptedAt === null
  ) return { ok: false, issues };

  return {
    ok: true,
    value: {
      submissionId,
      decisionId,
      targets,
      cashWeightBps,
      decisionSummary,
      submissionSha256,
      acceptedAt,
    },
  };
}

function exactObject(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  issues: string[],
  optionalKeys: readonly string[] = [],
): RecordValue | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} 必须是对象`);
    return null;
  }
  const record = value as RecordValue;
  const expected = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of requiredKeys) {
    if (!Object.hasOwn(record, key)) issues.push(`${path}.${key} 缺失`);
  }
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) issues.push(`${path}.${key} 不属于 dashboard contract`);
  }
  return record;
}

function string(
  value: unknown,
  path: string,
  pattern: RegExp,
  issues: string[],
): string | null {
  if (typeof value !== "string" || !pattern.test(value)) {
    issues.push(`${path} 格式无效`);
    return null;
  }
  return value;
}

function nonEmptyString(value: unknown, path: string, issues: string[]): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path} 必须是非空字符串`);
    return null;
  }
  return value;
}

function timestamp(value: unknown, path: string, issues: string[]): string | null {
  if (typeof value !== "string") {
    issues.push(`${path} 必须是时间字符串`);
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    issues.push(`${path} 格式无效`);
    return null;
  }
  return parsed.toISOString();
}
