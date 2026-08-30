"use client";

import { useMemo, useState } from "react";

import {
  Note,
  PageHeader,
  ReadoutCell,
  SectionHeading,
  SetupRequired,
  StatusBadge,
  Unsealed,
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

function chainTone(status: AuditData["chainStatus"]): StatusTone {
  if (status === "VERIFIED") return "positive";
  if (status === "BROKEN") return "critical";
  return "neutral";
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
          eyebrow="Append-only ledger"
          title="事件流为空"
          description="事件在 Worker 写入后出现，控制台不会补写历史，也不会把“重新运行模型”当作审计操作。"
          actions={<StatusBadge label="无事件" tone="neutral" />}
        />
        <SetupRequired
          checklist={setupChecklist}
          connection={data.connection}
          compact
        />
        <section className="panel">
          <SectionHeading
            eyebrow="Audit contract"
            title="可验证的内容"
            note={<span>这三条决定了哪些结论可以被复核</span>}
            compact
          />
          <div className="principle-grid">
            <Note title="不可变事件" tone="warning">
              订单、成交、费用、汇率、税款、数据截止点与决策各自保留稳定 ID，修订以追加表达。
            </Note>
            <Note title="确定性重放" tone="informative">
              重放使用已记录的模型输出和冻结输入，不会再次调用模型，因此同一输入永远得到同一账本。
            </Note>
            <Note title="缺失即中止" tone="critical">
              价格、分类或清单一旦缺失，结果标记为未解决，不猜测补全，也不产出可排名净值。
            </Note>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Append-only ledger"
        title="不可变事件流"
        subtitle="only append · never rewrite · never re-call the model"
        description="每条事件带稳定 ID、幂等键和链哈希。这里可以查、可以筛、可以核对链路，但不能改历史，也不会触发模型重跑。"
        actions={<StatusBadge label="只读" tone="neutral" />}
      />

      <section className="panel panel-flush" aria-label="审计指标">
        <div className="ruler-readout ruler-readout-three ruler-readout-last">
          <ReadoutCell
            label="链完整性"
            value={chainStatusLabel(data.chainStatus)}
            detail={
              data.chainStatus === "VERIFIED"
                ? `${formatInteger(data.eventCount)} 条按序解析，无断点`
                : "链路未通过顺序校验"
            }
            text
          />
          <ReadoutCell
            label="已记录事件"
            value={formatInteger(data.eventCount)}
            detail="覆盖决策、成交、估值、费用与税款"
          />
          <ReadoutCell
            label="最近检查点"
            value={data.lastCheckpointHash ?? <Unsealed label="尚无检查点" pending />}
            detail="仅截断展示 · 完整哈希保留在账本中"
            text={data.lastCheckpointHash === null}
          />
        </div>
      </section>

      <section className="panel panel-flush audit-table-panel">
        <SectionHeading
          eyebrow="Recent events"
          title="最近事件"
          note={
            <p>
              显示 {filteredEvents.length} / {formatInteger(data.eventCount)} 条
              <br />
              按发生时间倒序
            </p>
          }
        />
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
              {filteredEvents.map((event, index) => {
                // The chain is checkable by eye: this row's `prev` is the next
                // row's hash, because the table runs newest-first.
                const previous = filteredEvents[index + 1];
                return (
                  <tr key={event.id}>
                    <td className="audit-time">
                      <time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time>
                    </td>
                    <td>
                      <div className="run-name">
                        <strong>{auditTypeLabel(event.type)}</strong>
                        <span>{event.type} · {event.id}</span>
                      </div>
                    </td>
                    <td className="mono">{event.entity}</td>
                    <td>
                      <p className="event-summary">{event.summary}</p>
                      <span className="event-key mono">{event.idempotencyKey}</span>
                    </td>
                    <td>
                      <StatusBadge
                        label={auditStatusLabel(event.status)}
                        tone={auditTone(event.status)}
                      />
                    </td>
                    <td>
                      <div className="chain">
                        <strong>{event.chainHash}</strong>
                        {previous ? <span>{previous.chainHash}</span> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredEvents.length === 0 ? (
                <tr>
                  <td className="no-results" colSpan={6}>
                    没有符合当前筛选条件的事件。清空搜索框或改回“全部状态”。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="panel-footer">
          <span>每行第二个哈希是上一条事件的链哈希；相邻两行应当首尾相接</span>
          <StatusBadge
            label={chainStatusLabel(data.chainStatus)}
            tone={chainTone(data.chainStatus)}
          />
        </div>
      </section>

      <section className="panel">
        <SectionHeading
          eyebrow="Audit contract"
          title="可验证的内容"
          note={<span>这三条决定了哪些结论可以被复核</span>}
          compact
        />
        <div className="principle-grid">
          <Note title="不可变事件" tone="warning">
            订单、成交、费用、汇率、税款、数据截止点与决策各自保留稳定 ID，修订以追加表达。
          </Note>
          <Note title="确定性重放" tone="informative">
            重放使用已记录的模型输出和冻结输入，不会再次调用模型，因此同一输入永远得到同一账本。
          </Note>
          <Note title="缺失即中止" tone="critical">
            价格、分类或清单一旦缺失，结果标记为未解决，不猜测补全，也不产出可排名净值。
          </Note>
        </div>
      </section>
    </div>
  );
}
