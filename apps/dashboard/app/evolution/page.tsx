import type { Metadata } from "next";

import { MetricCard, PageHeader, StatusBadge } from "@/components/ui";
import { loadEvolutionOverview } from "@/lib/evolution";
import { formatDateTime, formatInteger } from "@/lib/format";

export const metadata: Metadata = { title: "自进化" };
export const dynamic = "force-dynamic";

function experimentTone(status: string) {
  if (status === "COMPLETED" || status === "PROMOTED") return "positive" as const;
  if (status === "FAILED" || status === "CANCELED") return "critical" as const;
  if (status === "PROPOSED") return "warning" as const;
  return "informative" as const;
}

function metricPair(baseline: string, candidate: string, suffix = "") {
  return `${baseline}${suffix} → ${candidate}${suffix}`;
}

export default async function EvolutionPage() {
  const data = await loadEvolutionOverview();
  if (!data.configured) {
    return (
      <div className="page-stack">
        <PageHeader eyebrow="Self evolution" title="自进化控制面未连接"
          description="需要私有 Supabase 服务端读取权限；页面不会回退到演示记录。"
          actions={<StatusBadge label={data.error ?? "未配置"} tone="warning" />} />
      </div>
    );
  }
  const promotionCandidates = data.experiments.filter(
    (item) => item.recommendation === "PROMOTE_CANDIDATE",
  ).length;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Observe · Learn · Experiment"
        title="自进化实验室"
        description="每六小时回收 agent、平台、数据与账务证据。失败也沉淀；本地回放和线上 shadow 都不能自动进入正式排行榜。"
        actions={<StatusBadge label="人类控制晋级" tone="informative" />}
      />
      <section className="metrics-grid" aria-label="自进化摘要">
        <MetricCard label="分析周期" value={formatInteger(data.cycleCount)} detail="六小时固定 UTC 窗口" />
        <MetricCard label="经验发现" value={formatInteger(data.findingCount)} detail="不可变、保留负结果" tone="warning" />
        <MetricCard label="实验" value={formatInteger(data.experimentCount)} detail="本地或线上 shadow" />
        <MetricCard label="组合回放" value={formatInteger(data.portfolioReplayCount)} detail="同快照、全成本评估" />
        <MetricCard label="待人工晋级" value={String(promotionCandidates)} detail="推荐不等于自动上线" tone={promotionCandidates > 0 ? "positive" : undefined} />
      </section>

      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">Same-snapshot replay</p><h2>组合策略评估证据</h2></div><span>官方 → 候选；建议不触发晋级</span></div>
        {data.decisionEvaluations.length === 0 ? <p className="empty-state">暂无完成的组合策略回放。</p> :
          <div className="table-scroll"><table><thead><tr><th>实验 / 快照</th><th>约束违规</th><th>换手</th><th>模拟成本（滑点 / 费用 / 税）</th><th>终值 NAV</th><th>最大回撤 / 终止失败</th><th>结论 / 证据</th></tr></thead>
            <tbody>{data.decisionEvaluations.map((item) => <tr key={item.evaluationSha256}>
              <td><div className="run-name"><strong>{item.experimentId}</strong><span className="mono">{item.evidenceSnapshotId.slice(0, 12)}… · diff {item.comparisonSha256.slice(0, 10)}…</span></div></td>
              <td className="tabular">{metricPair(item.official.constraintViolationCount, item.candidate.constraintViolationCount)}</td>
              <td><div className="run-name"><strong className="tabular">{metricPair(item.official.turnoverBps, item.candidate.turnoverBps, " bps")}</strong><span>决策差异 {item.decisionDeltaTurnoverBps} bps</span></div></td>
              <td><div className="run-name tabular"><strong>{metricPair(item.official.simulatedSlippageNavCost, item.candidate.simulatedSlippageNavCost)}</strong><span>{metricPair(item.official.simulatedFeeNavCost, item.candidate.simulatedFeeNavCost)} / {metricPair(item.official.simulatedTaxNavCost, item.candidate.simulatedTaxNavCost)} {item.navCurrency}</span></div></td>
              <td className="tabular">{metricPair(item.official.terminalNav, item.candidate.terminalNav)} {item.navCurrency}</td>
              <td><div className="run-name tabular"><strong>{metricPair(item.official.maxDrawdownBps, item.candidate.maxDrawdownBps, " bps")}</strong><span>失败 {metricPair(item.official.terminalFailureCount, item.candidate.terminalFailureCount)}</span></div></td>
              <td><div className="run-name"><StatusBadge label={item.recommendation} tone={item.recommendation === "PROMOTE_CANDIDATE" ? "positive" : "warning"} /><span className="mono">{item.evaluationSha256.slice(0, 14)}…</span></div></td>
            </tr>)}</tbody>
          </table></div>}
      </section>

      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">Hypothesis graph</p><h2>实验与结论</h2></div><span>正式排名始终隔离</span></div>
        <div className="table-scroll"><table><thead><tr><th>实验</th><th>模式</th><th>状态</th><th>试验排名域</th><th>结论</th><th>人批</th><th>更新时间</th></tr></thead>
          <tbody>{data.experiments.map((item) => <tr key={item.experimentId}>
            <td><div className="run-name"><strong>{item.experimentCode}</strong><span className="mono">{item.experimentId}</span></div></td>
            <td>{item.mode === "LOCAL_REPLAY" ? "本地回放" : "线上 Shadow"}</td>
            <td><StatusBadge label={item.status} tone={experimentTone(item.status)} /></td>
            <td><StatusBadge label={item.trialScope ?? item.rankingScope ?? "未排程"} tone={item.trialScope === "SHADOW" ? "warning" : "neutral"} /></td>
            <td>{item.recommendation ?? "等待证据"}</td>
            <td>{item.humanApprovedAt ? formatDateTime(item.humanApprovedAt) : "—"}</td>
            <td><time dateTime={item.updatedAt}>{formatDateTime(item.updatedAt)}</time></td>
          </tr>)}</tbody>
        </table></div>
      </section>

      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">Experience ledger</p><h2>最近经验</h2></div><span>问题不是被覆盖，而是变成下一次实验的来源</span></div>
        <div className="table-scroll"><table><thead><tr><th>严重度</th><th>范围 / 对象</th><th>发现</th><th>观测 / 阈值</th><th>经验</th><th>证据哈希</th></tr></thead>
          <tbody>{data.findings.map((item) => <tr key={item.findingSha256}>
            <td><StatusBadge label={item.severity} tone={item.severity === "CRITICAL" ? "critical" : "warning"} /></td>
            <td><div className="run-name"><strong>{item.scope}</strong><span>{item.subject}</span></div></td>
            <td>{item.title}</td><td className="tabular">{item.observedValue} / {item.threshold}</td>
            <td>{item.lesson}</td><td className="mono">{item.findingSha256.slice(0, 12)}…</td>
          </tr>)}</tbody>
        </table></div>
      </section>

      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">Heartbeat</p><h2>分析周期</h2></div><span>线上定时回收证据</span></div>
        <div className="table-scroll"><table><thead><tr><th>窗口</th><th>状态</th><th>发现</th><th>报告哈希</th></tr></thead>
          <tbody>{data.cycles.map((item) => <tr key={item.cycleId}>
            <td>{formatDateTime(item.windowStartedAt)} → {formatDateTime(item.windowEndedAt)}</td>
            <td><StatusBadge label={item.status} tone={item.status === "SUCCEEDED" ? "positive" : "warning"} /></td>
            <td>{item.findingCount}</td><td className="mono">{item.reportSha256 ? `${item.reportSha256.slice(0, 16)}…` : "—"}</td>
          </tr>)}</tbody>
        </table></div>
      </section>
    </div>
  );
}
