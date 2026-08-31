import Link from "next/link";

import type {
  ConnectionSummary,
  SetupItem,
  StatusTone,
} from "@/lib/data/contracts";

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>
          {title}
          {subtitle ? <small className="page-subtitle">{subtitle}</small> : null}
        </h1>
        <p className="page-description">{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function StatusBadge({
  label,
  tone = "neutral",
  code = false,
}: {
  label: string;
  tone?: StatusTone;
  /** Enum values keep their machine spelling, because operators grep for them. */
  code?: boolean;
}) {
  return (
    <span className={`badge badge-${tone}${code ? " badge-code" : ""}`}>
      {label}
    </span>
  );
}

/**
 * The fail-closed primitive.
 *
 * A missing value must never look like `0`, and never like a normal value. It
 * gets a hatched fill, a dashed border, and a machine-readable reason code.
 * `pending` is for "not due yet", which is normal and speaks more quietly than
 * a breach.
 */
export function Unsealed({
  label,
  reason,
  pending = false,
}: {
  label: string;
  reason?: string;
  pending?: boolean;
}) {
  return (
    <span className={pending ? "unsealed unsealed-pending" : "unsealed"}>
      {label}
      {reason ? <code>{reason}</code> : null}
    </span>
  );
}

export function Note({
  title,
  children,
  tone = "neutral",
}: {
  title?: string;
  children: React.ReactNode;
  tone?: StatusTone;
}) {
  return (
    <div className={tone === "neutral" ? "note" : `note note-${tone}`}>
      {title ? <strong>{title}</strong> : null}
      {children}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  note,
  compact = false,
}: {
  eyebrow: string;
  title: string;
  note?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "section-heading compact-heading" : "section-heading"}>
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {note ?? null}
    </div>
  );
}

export function ReadoutCell({
  label,
  value,
  detail,
  text = false,
}: {
  label: string;
  value: React.ReactNode;
  detail: React.ReactNode;
  /** Set for prose values so they use the body face, not the data face. */
  text?: boolean;
}) {
  return (
    <div>
      <p className="readout-label">{label}</p>
      <p className={text ? "readout-value readout-value-text" : "readout-value"}>
        {value}
      </p>
      <p className="readout-detail">{detail}</p>
    </div>
  );
}

export function ConnectionNote({ connection }: { connection: ConnectionSummary }) {
  const status = connection.readStatus ?? (
    connection.configured ? "READY" : "UNCONFIGURED"
  );
  const badge = status === "READY"
    ? { label: "已连接", tone: "positive" as const }
    : status === "NOT_READY"
      ? { label: "等待投影", tone: "warning" as const }
      : status === "ERROR"
        ? { label: "读取异常", tone: "critical" as const }
        : { label: "离线安全", tone: "neutral" as const };

  return (
    <div className="connection-note">
      <div>
        <p className="connection-label">{connection.label}</p>
        <p>{connection.detail}</p>
      </div>
      <StatusBadge label={badge.label} tone={badge.tone} />
    </div>
  );
}

export function SetupRequired({
  checklist,
  connection,
  compact = false,
}: {
  checklist: SetupItem[];
  connection: ConnectionSummary;
  compact?: boolean;
}) {
  const readStatus = connection.readStatus ?? (
    connection.configured ? "NOT_READY" : "UNCONFIGURED"
  );
  const heading = readStatus === "ERROR"
    ? {
        badge: "投影读取异常",
        title: "真实状态当前不可判定",
        description: "数据库读取失败不是“尚未设置”。页面已停止展示投影值，请先查看连接错误并恢复真实读取。",
        tone: "critical" as const,
      }
    : readStatus === "NOT_READY"
      ? {
          badge: "等待真实投影",
          title: "工作进程尚未生成投影",
          description: "Supabase 已连接，但所需投影还不存在。页面不会用默认值冒充真实赛季状态。",
          tone: "warning" as const,
        }
      : {
          badge: "需要完成设置",
          title: "正式输入尚未冻结",
          description: "在初始持仓、规则、数据源和不可变版本全部就绪前，控制台不会显示赛季已启动。",
          tone: "warning" as const,
        };

  return (
    <section
      className={
        readStatus === "ERROR"
          ? "setup-panel decision-failure-panel"
          : compact
            ? "setup-panel setup-panel-compact"
            : "setup-panel"
      }
    >
      <div className="setup-intro">
        <StatusBadge label={heading.badge} tone={heading.tone} />
        <h2>{heading.title}</h2>
        <p>{heading.description}</p>
        <div className="setup-actions">
          <Link className="button button-primary" href="/settings">
            检查设置
          </Link>
          <Link className="text-link" href="/data">
            查看真实数据接入状态 →
          </Link>
        </div>
      </div>

      {!compact ? (
        <div className="setup-checklist" aria-label="设置检查清单">
          {checklist.map((item) => (
            <div className="setup-row" key={item.id}>
              <span
                className={"setup-marker setup-marker-" + item.status}
                aria-hidden="true"
              />
              <div>
                <div className="setup-row-heading">
                  <h3>{item.label}</h3>
                  <span>{item.owner}</span>
                </div>
                <p>{item.description}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <ConnectionNote connection={connection} />
    </section>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "positive" | "warning" | "critical";
}) {
  return (
    <div className={tone ? "metric-card metric-card-" + tone : "metric-card"}>
      <p className="metric-label">{label}</p>
      <p className="metric-value">{value}</p>
      <p className="metric-detail">{detail}</p>
    </div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}
