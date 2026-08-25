"use client";

import Decimal from "decimal.js";
import Link from "next/link";

import {
  MetricCard,
  PageHeader,
  SetupRequired,
  StatusBadge,
} from "@/components/ui";
import { setupChecklist } from "@/lib/data/setup";
import type { ModelUsageSummary, RunDetailData } from "@/lib/data/contracts";
import {
  formatCurrency,
  formatDateTime,
  formatInteger,
  formatPercent,
  formatUsdCost,
  formatUsdCostPerDecision,
} from "@/lib/format";

function runStatusLabel(status: NonNullable<RunDetailData["run"]>["status"]): string {
  if (status === "HEALTHY") return "正常";
  if (status === "WARNING") return "警告";
  if (status === "UNRESOLVED") return "未解决";
  return "已完成";
}

function triggerLabel(trigger: string): string {
  return trigger === "WEEKLY" ? "每周" : trigger;
}

function costStatusLabel(status: ModelUsageSummary["costStatus"]): string {
  if (status === "ESTIMATED") return "完整估算";
  if (status === "PARTIAL") return "部分估算";
  if (status === "UNPRICED") return "待定价";
  return "用量不可用";
}

export function RunDetail({ initialData }: { initialData: RunDetailData }) {
  const data = initialData;

  if (data.setupRequired || !data.run) {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="运行详情"
          title="策略运行尚不存在"
          description="只有模型、Skill、提示词、数据访问权限和规则集共同冻结后，才会创建运行。"
          actions={<StatusBadge label="只读" tone="neutral" />}
        />
        <SetupRequired
          checklist={setupChecklist}
          connection={data.connection}
          compact
        />
      </div>
    );
  }

  const progressFromBase = Decimal.max(
    0,
    Decimal.min(
      100,
      new Decimal(data.run.liquidationNav)
        .minus(data.roundBase)
        .dividedBy(new Decimal(data.successThreshold).minus(data.roundBase))
        .times(100),
    ),
  );

  return (
    <div className="page-stack">
      <div className="breadcrumb-row">
        <Link href="/">赛季概览</Link>
        <span aria-hidden="true">/</span>
        <span>运行详情</span>
      </div>
      <PageHeader
        eyebrow={data.seasonName ?? "策略运行"}
        title={data.run.model + " × " + data.run.skill}
        description={data.run.pipeline + " · 本页所有控件均为只读。"}
        actions={<StatusBadge label={runStatusLabel(data.run.status)} tone="positive" />}
      />

      <section className="metrics-grid" aria-label="运行指标">
        <MetricCard
          label="清算净值"
          value={formatCurrency(data.run.liquidationNav)}
          detail={"较轮次基准 " + formatPercent(data.run.returnPct)}
          tone="positive"
        />
        <MetricCard
          label="计提税款后净值"
          value={formatCurrency(data.taxReservedNav)}
          detail={"已计提 " + formatCurrency(data.run.taxReserve)}
        />
        <MetricCard
          label="券商净值"
          value={formatCurrency(data.brokerNav)}
          detail="尚未扣除未付影子税"
        />
        <MetricCard
          label="最大回撤"
          value={formatPercent(data.run.maxDrawdownPct)}
          detail="达到 −20% 时进入黄色预警"
        />
      </section>

      <section className="panel boundary-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">第 01 轮</p>
            <h2>边界进度</h2>
          </div>
          <p>已完成达成 2× 目标所需涨幅的 {progressFromBase.toFixed(1)}%</p>
        </div>
        <div className="boundary-track" aria-label={"距离成功目标 " + progressFromBase.toFixed(1) + "%"}>
          <span className="boundary-failure">0.5×</span>
          <span className="boundary-base">1.0× 基准</span>
          <span className="boundary-success">2.0× 成功</span>
          <span
            className="boundary-current"
            style={{
              left:
                new Decimal("33.333")
                  .plus(progressFromBase.times("0.66667"))
                  .toFixed(3) + "%",
            }}
          >
            <span>{new Decimal(data.run.roundMultiple).toFixed(3)}×</span>
          </span>
        </div>
        <div className="boundary-values">
          <span>失败 {formatCurrency(data.failureThreshold)}</span>
          <span>基准 {formatCurrency(data.roundBase)}</span>
          <span>成功 {formatCurrency(data.successThreshold)}</span>
        </div>
      </section>

      {data.run.modelUsage ? (
        <section className="panel usage-panel" aria-label="模型 Token 与成本">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">Harness 用量</p>
              <h2>Token 与成本明细</h2>
            </div>
            <StatusBadge
              label={costStatusLabel(data.run.modelUsage.costStatus)}
              tone={
                data.run.modelUsage.costStatus === "ESTIMATED"
                  ? "positive"
                  : "warning"
              }
            />
          </div>
          <div className="metrics-grid">
            <MetricCard
              label="决策 / Provider 请求"
              value={
                formatInteger(data.run.modelUsage.decisionCount) +
                " / " +
                formatInteger(data.run.modelUsage.requestCount)
              }
              detail="每个物理 attempt 只记一次"
            />
            <MetricCard
              label="总计费 Token"
              value={formatInteger(data.run.modelUsage.totalBillableTokens)}
              detail="未缓存输入 + 缓存读写 + 输出"
            />
            <MetricCard
              label="推理 Token"
              value={formatInteger(data.run.modelUsage.reasoningTokens)}
              detail="已包含在输出 Token 中，不重复计费"
            />
            <MetricCard
              label="估算模型成本"
              value={
                data.run.modelUsage.estimatedCost === null
                  ? "待定价"
                  : formatUsdCost(data.run.modelUsage.estimatedCost)
              }
              detail="供应商账单对账前仅作估算"
            />
            <MetricCard
              label="每次决策成本"
              value={formatUsdCostPerDecision(
                data.run.modelUsage.estimatedCost,
                data.run.modelUsage.decisionCount,
              )}
              detail="资源效率维度，不从组合 NAV 中扣减"
            />
          </div>
          <dl className="definition-list usage-definition-list">
            <div>
              <dt>未缓存输入</dt>
              <dd>{formatInteger(data.run.modelUsage.uncachedInputTokens)} Token</dd>
            </div>
            <div>
              <dt>缓存读取</dt>
              <dd>{formatInteger(data.run.modelUsage.cacheReadTokens)} Token</dd>
            </div>
            <div>
              <dt>缓存写入</dt>
              <dd>{formatInteger(data.run.modelUsage.cacheWriteTokens)} Token</dd>
            </div>
            <div>
              <dt>输出</dt>
              <dd>{formatInteger(data.run.modelUsage.outputTokens)} Token</dd>
            </div>
            <div>
              <dt>定价版本</dt>
              <dd className="mono">
                {data.run.modelUsage.pricingVersions.length > 0
                  ? data.run.modelUsage.pricingVersions.join(" · ")
                  : "未配置"}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      <div className="two-column-grid run-grid">
        <section className="panel">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">当前投影视图</p>
              <h2>持仓</h2>
            </div>
            <span>{new Decimal(data.run.cashPct).toFixed(1)}% 现金</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">标的</th>
                  <th scope="col" className="numeric">数量</th>
                  <th scope="col" className="numeric">标记价格</th>
                  <th scope="col" className="numeric">市值</th>
                  <th scope="col" className="numeric">权重</th>
                  <th scope="col" className="numeric">未实现收益</th>
                </tr>
              </thead>
              <tbody>
                {data.holdings.map((holding) => (
                  <tr key={holding.symbol}>
                    <td>
                      <div className="run-name">
                        <strong>{holding.symbol}</strong>
                        <span>{holding.name}</span>
                      </div>
                    </td>
                    <td className="numeric tabular">{holding.quantity}</td>
                    <td className="numeric tabular">{formatCurrency(holding.markPrice)}</td>
                    <td className="numeric tabular">{formatCurrency(holding.marketValue)}</td>
                    <td className="numeric tabular">{new Decimal(holding.weightPct).toFixed(2)}%</td>
                    <td
                      className={
                        new Decimal(holding.unrealizedPct).isNegative()
                          ? "numeric tabular negative-text"
                          : "numeric tabular positive-text"
                      }
                    >
                      {formatPercent(holding.unrealizedPct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="table-note">
            标记价格是投影输入。事实来源仍是事件账本，而非本表。
          </p>
        </section>

        <section className="panel pipeline-panel">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">执行流水线</p>
              <h2>决策 → S1 → S2</h2>
            </div>
          </div>
          <ol className="timeline">
            {data.pipeline.map((stage) => (
              <li className={"timeline-item timeline-item-" + stage.status} key={stage.id}>
                <span className="timeline-node" aria-hidden="true" />
                <div>
                  <div className="timeline-heading">
                    <strong>{stage.label}</strong>
                    <time dateTime={stage.scheduledAt}>{formatDateTime(stage.scheduledAt)}</time>
                  </div>
                  <p>{stage.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div className="two-column-grid">
        <section className="panel">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">最近一次冻结决策</p>
              <h2>已记录依据</h2>
            </div>
            {data.lastDecision ? (
              <StatusBadge
                label={new Decimal(data.lastDecision.confidence).times(100).toFixed(0) + "% 置信度"}
                tone="informative"
              />
            ) : null}
          </div>
          {data.lastDecision ? (
            <div className="decision-copy">
              <p className="decision-thesis">{data.lastDecision.thesis}</p>
              <dl className="definition-list definition-list-tight">
                <div>
                  <dt>决策时间</dt>
                  <dd>{formatDateTime(data.lastDecision.decidedAt)}</dd>
                </div>
                <div>
                  <dt>数据截止时间</dt>
                  <dd>{formatDateTime(data.lastDecision.dataCutoffAt)}</dd>
                </div>
                <div>
                  <dt>触发条件</dt>
                  <dd>{data.lastDecision.triggers.map(triggerLabel).join("、")}</dd>
                </div>
              </dl>
              <h3>已记录风险</h3>
              <ul className="plain-list">
                {data.lastDecision.risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">运行清单</p>
              <h2>不可变版本</h2>
            </div>
            <Link className="text-link" href="/audit">
              打开审计事件流
            </Link>
          </div>
          <dl className="definition-list">
            {data.manifest.map((entry) => (
              <div key={entry.label}>
                <dt>{entry.label}</dt>
                <dd className={entry.mono ? "mono" : undefined}>{entry.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}
