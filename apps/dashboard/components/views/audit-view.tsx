"use client";

import { useMemo, useState } from "react";

import {
  MetricCard,
  PageHeader,
  SetupRequired,
  StatusBadge,
} from "@/components/ui";
import type { AuditData, AuditEvent, StatusTone } from "@/lib/data/contracts";
import { setupChecklist } from "@/lib/data/setup";
import { formatDateTime, formatInteger } from "@/lib/format";

function auditTone(status: AuditEvent["status"]): StatusTone {
  if (status === "VERIFIED") return "positive";
  if (status === "WARNING") return "warning";
  if (status === "REJECTED") return "critical";
  return "neutral";
}

function auditStatusLabel(status: AuditEvent["status"]): string {
  if (status === "VERIFIED") return "已验证";
  if (status === "RECORDED") return "已记录";
  if (status === "WARNING") return "警告";
  return "已拒绝";
}

function chainStatusLabel(status: AuditData["chainStatus"]): string {
  if (status === "VERIFIED") return "已验证";
  if (status === "BROKEN") return "链路断裂";
  return "空";
}

function auditTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    VALUATION_COMMITTED: "估值已提交",
    DATA_CUTOFF_SEALED: "数据截止点已封存",
    ORDER_FILLED: "订单已成交",
    BUYING_POWER_CHECKED: "购买力已检查",
    BUY_ORDERS_FROZEN: "买入订单已冻结",
    MODEL_OUTPUT_VALIDATED: "模型输出已验证",
  };
  return labels[type] ?? type;
}

export function AuditView({ initialData }: { initialData: AuditData }) {
  const data = initialData;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");

  const filteredEvents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return data.events.filter((event) => {
      const matchesStatus = status === "ALL" || event.status === status;
      const matchesQuery =
        !normalized ||
        [event.id, event.type, event.entity, event.summary, event.idempotencyKey]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      return matchesStatus && matchesQuery;
    });
  }, [data.events, query, status]);

  if (data.setupRequired) {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="审计"
          title="事件流为空"
          description="事件将在此以只追加、只读方式展示。控制台不会把“重新运行模型”作为审计操作。"
          actions={<StatusBadge label="无事件" tone="neutral" />}
        />
        <SetupRequired
          checklist={setupChecklist}
          connection={data.connection}
          compact
        />
        <section className="panel audit-principles">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">审计契约</p>
              <h2>可验证内容</h2>
            </div>
          </div>
          <div className="principle-grid">
            <div>
              <h3>不可变事件</h3>
              <p>订单、成交、费用、汇率、税款、数据截止点和决策均保留稳定 ID。</p>
            </div>
            <div>
              <h3>确定性重放</h3>
              <p>重放使用已记录的模型输出和冻结输入，不会再次调用模型。</p>
            </div>
            <div>
              <h3>缺失即中止</h3>
              <p>价格、分类或清单一旦缺失，结果会标记为未解决，而不会猜测补全。</p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="审计"
        title="不可变事件流"
        description="查看已记录事实和投影检查点，不修改历史，也不调用模型。"
        actions={<StatusBadge label="只读" tone="neutral" />}
      />

      <section className="metrics-grid metrics-grid-three" aria-label="审计指标">
        <MetricCard
          label="链完整性"
          value={chainStatusLabel(data.chainStatus)}
          detail="所有样例链路均按序解析"
          tone="positive"
        />
        <MetricCard
          label="已记录事件"
          value={formatInteger(data.eventCount)}
          detail="覆盖决策、成交、估值、费用与税款"
        />
        <MetricCard
          label="最近检查点"
          value={data.lastCheckpointHash ?? "无"}
          detail="仅截断展示，完整哈希保留在账本中"
        />
      </section>

      <section className="panel audit-table-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">最近事件</p>
            <h2>搜索只读模型</h2>
          </div>
          <span>显示 {filteredEvents.length} 条</span>
        </div>
        <div className="filter-bar">
          <label className="field field-grow">
            <span>搜索事件</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="事件 ID、类型、实体或幂等键"
            />
          </label>
          <label className="field">
            <span>状态</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="ALL">全部状态</option>
              <option value="VERIFIED">已验证</option>
              <option value="RECORDED">已记录</option>
              <option value="WARNING">警告</option>
              <option value="REJECTED">已拒绝</option>
            </select>
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">发生时间</th>
                <th scope="col">事件</th>
                <th scope="col">实体</th>
                <th scope="col">摘要</th>
                <th scope="col">状态</th>
                <th scope="col">链哈希</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.map((event) => (
                <tr key={event.id}>
                  <td className="audit-time">
                    <time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time>
                  </td>
                  <td>
                    <div className="run-name">
                      <strong>{auditTypeLabel(event.type)}</strong>
                      <span className="mono">{event.type} · {event.id}</span>
                    </div>
                  </td>
                  <td className="mono">{event.entity}</td>
                  <td>
                    <p className="event-summary">{event.summary}</p>
                    <span className="event-key mono">{event.idempotencyKey}</span>
                  </td>
                  <td>
                    <StatusBadge label={auditStatusLabel(event.status)} tone={auditTone(event.status)} />
                  </td>
                  <td className="mono">{event.chainHash}</td>
                </tr>
              ))}
              {filteredEvents.length === 0 ? (
                <tr>
                  <td className="no-results" colSpan={6}>
                    没有符合当前筛选条件的事件。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
