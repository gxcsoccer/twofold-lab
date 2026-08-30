export interface ArenaOperationalHealth {
  readonly schema: "twofold.arena_operational_health/v1";
  readonly checkedAt: string;
  readonly ok: boolean;
  readonly worker: Readonly<{
    workerId: string;
    lastTickAt: string | null;
    lastOutcome: "idle" | "completed" | "failed" | null;
    heartbeatAt: string | null;
    leaseExpiresAt: string | null;
    live: boolean;
  }>;
  readonly activeSeasonCode: string | null;
  readonly latestCorporateActionScanAt: string | null;
  readonly alerts: readonly Readonly<{
    code: string;
    severity: "critical";
    detail: string;
  }>[];
}

export function parseArenaOperationalHealth(value: unknown): ArenaOperationalHealth {
  assertNoJsonNumber(value, "Arena operational health");
  const row = exactRecord(value, [
    "schema",
    "checkedAt",
    "ok",
    "worker",
    "activeSeasonCode",
    "latestCorporateActionScanAt",
    "alerts",
  ], "Arena operational health");
  if (row.schema !== "twofold.arena_operational_health/v1") {
    throw new TypeError("unsupported Arena operational health schema");
  }
  const workerRow = exactRecord(row.worker, [
    "workerId",
    "lastTickAt",
    "lastOutcome",
    "heartbeatAt",
    "leaseExpiresAt",
    "live",
  ], "Arena operational health worker");
  const alertsRaw = array(row.alerts, "alerts");
  const alerts = Object.freeze(alertsRaw.map((candidate, index) => {
    const alert = exactRecord(candidate, [
      "code", "severity", "detail",
    ], `alerts[${index}]`);
    if (alert.severity !== "critical") {
      throw new TypeError(`alerts[${index}].severity is unsupported`);
    }
    return Object.freeze({
      code: identity(alert.code, `alerts[${index}].code`),
      severity: "critical" as const,
      detail: identity(alert.detail, `alerts[${index}].detail`),
    });
  }));
  if (typeof row.ok !== "boolean") throw new TypeError("ok must be boolean");
  if (row.ok !== (alerts.length === 0)) {
    throw new TypeError("ok must match alerts");
  }
  if (typeof workerRow.live !== "boolean") {
    throw new TypeError("worker.live must be boolean");
  }
  const lastOutcome = workerRow.lastOutcome;
  if (
    lastOutcome !== null
    && lastOutcome !== "idle"
    && lastOutcome !== "completed"
    && lastOutcome !== "failed"
  ) {
    throw new TypeError("worker.lastOutcome is unsupported");
  }
  return Object.freeze({
    schema: "twofold.arena_operational_health/v1" as const,
    checkedAt: timestamp(row.checkedAt, "checkedAt"),
    ok: row.ok,
    worker: Object.freeze({
      workerId: identity(workerRow.workerId, "worker.workerId"),
      lastTickAt: nullableTimestamp(workerRow.lastTickAt, "worker.lastTickAt"),
      lastOutcome,
      heartbeatAt: nullableTimestamp(workerRow.heartbeatAt, "worker.heartbeatAt"),
      leaseExpiresAt: nullableTimestamp(
        workerRow.leaseExpiresAt,
        "worker.leaseExpiresAt",
      ),
      live: workerRow.live,
    }),
    activeSeasonCode: nullableIdentity(row.activeSeasonCode, "activeSeasonCode"),
    latestCorporateActionScanAt: nullableTimestamp(
      row.latestCorporateActionScanAt,
      "latestCorporateActionScanAt",
    ),
    alerts,
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(`${field} has an unexpected shape`);
  }
  return row;
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a trimmed non-empty identity`);
  }
  return value;
}

function nullableIdentity(value: unknown, field: string): string | null {
  return value === null ? null : identity(value, field);
}

function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${field} must be a UTC millisecond timestamp`);
  }
  return value;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field);
}

function assertNoJsonNumber(value: unknown, field: string): void {
  if (typeof value === "number") {
    throw new TypeError(`${field} must not contain JSON numbers`);
  }
  if (Array.isArray(value)) {
    value.forEach((candidate) => assertNoJsonNumber(candidate, field));
    return;
  }
  if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>)
      .forEach((candidate) => assertNoJsonNumber(candidate, field));
  }
}
