"use client";

import Decimal from "decimal.js";
import Link from "next/link";

import {
  ConnectionNote,
  MetricCard,
  PageHeader,
  SetupRequired,
  StatusBadge,
} from "@/components/ui";
import type {
  ModelUsageSummary,
  RunSummary,
  SeasonOverviewData,
  StatusTone,
} from "@/lib/data/contracts";
import {
  formatCurrency,
  formatDateTime,
  formatInteger,
  formatPercent,
  formatShortDate,
  formatUsdCost,
  formatUsdCostPerDecision,
} from "@/lib/format";

function runTone(run: RunSummary): StatusTone {
  if (run.status === "HEALTHY") return "positive";
  if (run.status === "WARNING") return "warning";
  if (run.status === "UNRESOLVED") return "critical";
  return "neutral";
}

function runStatusLabel(status: RunSummary["status"]): string {
  if (status === "HEALTHY") return "正常";
  if (status === "WARNING") return "警告";
  if (status === "UNRESOLVED") return "未解决";
  return "已完成";
}

function seasonStatusLabel(
  status: NonNullable<SeasonOverviewData["season"]>["status"],
): string {
  if (status === "RUNNING") return "运行中";
  if (status === "PAUSED") return "已暂停";
  if (status === "UNRESOLVED") return "未解决";
  return "已完成";
}

function costStatusLabel(status: ModelUsageSummary["costStatus"]): string {
  if (status === "ESTIMATED") return "完整估算";
  if (status === "PARTIAL") return "部分估算";
  if (status === "UNPRICED") return "待定价";
  return "用量不可用";
}

export function SeasonOverview({ initialData }: { initialData: SeasonOverviewData }) {
  const data = initialData;

  if (data.setupRequired || !data.season) {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="赛季概览"
          title="查看结果前，请先完成实验设置"
          description="当前如实显示为未启动赛季：不会虚构组合净值、排名或模型活动。"
        />
        <SetupRequired checklist={data.checklist} connection={data.connection} />
      </div>
    );
  }

  const topRun = data.runs[0];
  const modelRuns = data.runs.filter((run) => run.kind === "model");
  const benchmarkRuns = data.runs.filter((run) => run.kind === "baseline");
  const bestBenchmark = benchmarkRuns.sort((a, b) =>
    new Decimal(b.liquidationNav).comparedTo(a.liquidationNav),
  )[0];

  if (!topRun || !bestBenchmark) {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="赛季概览"
          title="真实运行投影不完整"
          description="赛季存在，但运行或基准记录缺失；页面不会补造排名、净值或收益率。"
          actions={<StatusBadge label="等待完整投影" tone="critical" />}
        />
        <section className="panel">
          <p className="eyebrow">Fail closed</p>
          <h2>需要 Worker 重新生成赛季投影</h2>
          <p>至少需要一个真实 Strategy Run 和一个真实基准运行，才能计算可比较指标。</p>
          <ConnectionNote connection={data.connection} />
        </section>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="赛季概览"
        title={data.season.name}
        description={
          formatShortDate(data.season.startAt) +
          " — " +
          formatShortDate(data.season.endAt) +
          " · 第 " +
          data.season.currentWeek +
          " 周，共 " +
          data.season.totalWeeks +
          " 周"
        }
        actions={<StatusBadge label={seasonStatusLabel(data.season.status)} tone="positive" />}
      />

      <section className="metrics-grid" aria-label="赛季指标">
        <MetricCard
          label="领先清算净值"
          value={formatCurrency(topRun.liquidationNav)}
          detail={topRun.model + " × " + topRun.skill}
          tone="positive"
        />
        <MetricCard
          label="最佳模型收益"
          value={formatPercent(topRun.returnPct)}
          detail="已计模拟手续费、滑点和影子税"
        />
        <MetricCard
          label="最佳基准收益"
          value={formatPercent(bestBenchmark.returnPct)}
          detail={bestBenchmark.skill}
        />
        <MetricCard
          label="下次决策截止时间"
          value={formatDateTime(data.season.nextDecisionAt)}
          detail="每个运行将在该收盘时点调用一次模型"
        />
      </section>

      {data.modelUsage ? (
        <section className="panel usage-panel" aria-label="模型资源消耗">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">模型资源消耗</p>
              <h2>Token 与估算成本</h2>
            </div>
            <StatusBadge
              label={costStatusLabel(data.modelUsage.costStatus)}
              tone={data.modelUsage.costStatus === "ESTIMATED" ? "positive" : "warning"}
            />
          </div>
          <div className="metrics-grid">
            <MetricCard
              label="决策 / Provider 请求"
              value={
                formatInteger(data.modelUsage.decisionCount) +
                " / " +
                formatInteger(data.modelUsage.requestCount)
              }
              detail="业务决策与实际模型调用分开计数"
            />
            <MetricCard
              label="总计费 Token"
              value={formatInteger(data.modelUsage.totalBillableTokens)}
              detail="输入分桶 + 输出；推理不重复相加"
            />
            <MetricCard
              label="缓存读取 Token"
              value={formatInteger(data.modelUsage.cacheReadTokens)}
              detail="与未缓存输入分开计价"
            />
            <MetricCard
              label="估算模型成本"
              value={
                data.modelUsage.estimatedCost === null
                  ? "待定价"
                  : formatUsdCost(data.modelUsage.estimatedCost)
              }
              detail="版本化费率估算，不是供应商账单"
            />
            <MetricCard
              label="每次决策成本"
              value={formatUsdCostPerDecision(
                data.modelUsage.estimatedCost,
                data.modelUsage.decisionCount,
              )}
              detail="用于比较模型 × Skill 的资源效率"
            />
          </div>
        </section>
      ) : null}

      <section className="panel leaderboard-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">清算净值排名</p>
            <h2>策略运行与共享基准</h2>
          </div>
          <p>按税后清算价值排序。</p>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">排名</th>
                <th scope="col">运行</th>
                <th scope="col">状态</th>
                <th scope="col" className="numeric">清算净值</th>
                <th scope="col" className="numeric">收益率</th>
                <th scope="col" className="numeric">最大回撤</th>
                <th scope="col" className="numeric">税款准备金</th>
                <th scope="col" className="numeric">模型 Token</th>
                <th scope="col" className="numeric">估算成本</th>
                <th scope="col">轮次进度</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((run, index) => (
                <tr key={run.id}>
                  <td className="rank-cell">{index + 1}</td>
                  <td>
                    <div className="run-name">
                      <strong>{run.model}</strong>
                      <span>{run.skill}</span>
                    </div>
                  </td>
                  <td>
                    <StatusBadge label={runStatusLabel(run.status)} tone={runTone(run)} />
                  </td>
                  <td className="numeric tabular">{formatCurrency(run.liquidationNav)}</td>
                  <td className={new Decimal(run.returnPct).isNegative() ? "numeric tabular negative-text" : "numeric tabular positive-text"}>
                    {formatPercent(run.returnPct)}
                  </td>
                  <td className="numeric tabular">{formatPercent(run.maxDrawdownPct)}</td>
                  <td className="numeric tabular">{formatCurrency(run.taxReserve)}</td>
                  <td className="numeric tabular">
                    {run.modelUsage
                      ? formatInteger(run.modelUsage.totalBillableTokens)
                      : "—"}
                  </td>
                  <td className="numeric tabular">
                    {run.modelUsage?.estimatedCost
                      ? formatUsdCost(run.modelUsage.estimatedCost)
                      : "—"}
                  </td>
                  <td>
                    <div className="progress-cell">
                      <div className="progress-track" aria-hidden="true">
                        <span
                          className="progress-fill"
                          style={{
                            width:
                              Decimal.max(
                                0,
                                Decimal.min(
                                  100,
                                  new Decimal(run.roundMultiple).minus(1).times(100),
                                ),
                              ).toFixed(2) + "%",
                          }}
                        />
                      </div>
                      <span>{new Decimal(run.roundMultiple).toFixed(3)}×</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel-footer">
          <span>{modelRuns.length} 个模型运行 · {benchmarkRuns.length} 个基准</span>
          <Link className="text-link" href={`/runs/${encodeURIComponent(topRun.id)}`}>
            查看领先运行
          </Link>
        </div>
      </section>

      <div className="two-column-grid">
        <section className="panel">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">最近活动</p>
              <h2>来自账本的派生视图</h2>
            </div>
          </div>
          <div className="activity-list">
            {data.activity.map((item) => (
              <div className="activity-row" key={item.id}>
                <span className={"activity-marker activity-marker-" + item.tone} />
                <div>
                  <div className="activity-heading">
                    <strong>{item.label}</strong>
                    <time dateTime={item.occurredAt}>{formatDateTime(item.occurredAt)}</time>
                  </div>
                  <p>{item.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel season-contract">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">已冻结契约</p>
              <h2>赛季边界</h2>
            </div>
          </div>
          <dl className="definition-list">
            <div>
              <dt>实验 ID</dt>
              <dd>{data.season.experimentId}</dd>
            </div>
            <div>
              <dt>规则集</dt>
              <dd>{data.season.ruleVersion}</dd>
            </div>
            <div>
              <dt>成功</dt>
              <dd>清算净值 ≥ 2× 轮次基准</dd>
            </div>
            <div>
              <dt>失败</dt>
              <dd>清算净值 ≤ 0.5× 轮次基准</dd>
            </div>
          </dl>
          <ConnectionNote connection={data.connection} />
        </section>
      </div>
    </div>
  );
}
