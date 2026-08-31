import type { Metadata } from "next";
import Decimal from "decimal.js";

import {
  PageHeader,
  ReadoutCell,
  SectionHeading,
  StatusBadge,
  Unsealed,
} from "@/components/ui";
import type { StatusTone } from "@/lib/data/contracts";
import { loadEvolutionOverview } from "@/lib/evolution";
import { formatDateTime, formatInteger } from "@/lib/format";

export const metadata: Metadata = { title: "自进化" };
export const dynamic = "force-dynamic";

function experimentTone(status: string): StatusTone {
  if (status === "COMPLETED" || status === "PROMOTED") return "positive";
  if (status === "FAILED" || status === "CANCELED") return "critical";
  if (status === "PROPOSED") return "warning";
  return "informative";
}

function severityTone(severity: string): StatusTone {
  if (severity === "CRITICAL") return "critical";
  if (severity === "WARNING") return "warning";
  return "neutral";
}

function cycleTone(status: string): StatusTone {
  if (status === "SUCCEEDED") return "positive";
  if (status === "FAILED") return "critical";
  return "warning";
}

type Direction = "lower-better" | "higher-better";

/**
 * official → candidate. The candidate side is coloured only when the two
 * values actually differ, so a reviewer sees which axis moved and which way.
 */
function Pair({
  from,
  to,
  suffix = "",
  direction = "lower-better",
}: {
  from: string;
  to: string;
  suffix?: string;
  direction?: Direction;
}) {
  let toClass = "";
  try {
    const left = new Decimal(from);
    const right = new Decimal(to);
    if (!right.equals(left)) {
      const better = direction === "lower-better"
        ? right.lessThan(left)
        : right.greaterThan(left);
      toClass = better ? " pair-better" : " pair-worse";
    }
  } catch {
    toClass = "";
  }
  return (
    <span className="pair">
      <strong className="pair-from">{from}{suffix}</strong>
      <i>→</i>
      <strong className={`pair-to${toClass}`}>{to}{suffix}</strong>
    </span>
  );
}

export default async function EvolutionPage() {
  const data = await loadEvolutionOverview();
  if (!data.configured) {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="Observe · learn · experiment"
          title="自进化控制面未连接"
          description="需要私有 Supabase 服务端读取权限。页面不会回退到演示记录。"
          actions={<StatusBadge label={data.error ?? "未配置"} tone="warning" />}
        />
      </div>
    );
  }

  const promotionCandidates = data.experiments.filter(
    (item) => item.recommendation === "PROMOTE_CANDIDATE",
  ).length;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Observe · learn · experiment"
        title="自进化实验室"
        subtitle="六小时固定 UTC 窗口 · 建议永不自动上线"
        description="每六小时回收 Agent、平台、数据与账务证据，把失败也写进经验账本。本地回放和线上 shadow 都跑在正式排名之外，晋级由人签字。"
        actions={<StatusBadge label="人类控制晋级" tone="informative" />}
      />

      <section className="panel panel-flush" aria-label="自进化摘要">
        <div className="ruler-readout ruler-readout-five ruler-readout-last">
          <ReadoutCell
            label="分析周期"
            value={formatInteger(data.cycleCount)}
            detail="六小时固定 UTC 窗口"
          />
          <ReadoutCell
            label="经验发现"
            value={formatInteger(data.findingCount)}
            detail="不可变 · 保留负结果"
          />
          <ReadoutCell
            label="实验"
            value={formatInteger(data.experimentCount)}
            detail="本地回放或线上 shadow"
          />
          <ReadoutCell
            label="组合回放"
            value={formatInteger(data.portfolioReplayCount)}
            detail="同快照 · 全成本评估"
          />
          <ReadoutCell
            label="待人工晋级"
            value={String(promotionCandidates)}
            detail="推荐不等于自动上线"
          />
        </div>
      </section>

      <section className="panel panel-flush">
        <SectionHeading
          eyebrow="Same-snapshot replay"
          title="组合策略评估证据"
          note={
            <p>
              官方 → 候选，同一份封存快照
              <br />
              更优的一侧标绿，更差标红
            </p>
          }
        />
        {data.decisionEvaluations.length === 0 ? (
          <div className="panel-footer">
            <span>暂无完成的组合策略回放。回放由分析周期触发，控制台不发起。</span>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">实验 / 快照</th>
                    <th scope="col">约束违规</th>
                    <th scope="col">换手</th>
                    <th scope="col">滑点成本</th>
                    <th scope="col">费用</th>
                    <th scope="col">影子税</th>
                    <th scope="col">终值 NAV</th>
                    <th scope="col">最大回撤</th>
                    <th scope="col">终止失败</th>
                    <th scope="col">结论</th>
                  </tr>
                </thead>
                <tbody>
                  {data.decisionEvaluations.map((item) => (
                    <tr key={item.evaluationSha256}>
                      <td>
                        <div className="run-name">
                          <strong>{item.experimentId}</strong>
                          <span>
                            {item.evidenceSnapshotId.slice(0, 12)}… · diff{" "}
                            {item.comparisonSha256.slice(0, 10)}…
                          </span>
                        </div>
                      </td>
                      <td>
                        <Pair
                          from={item.official.constraintViolationCount}
                          to={item.candidate.constraintViolationCount}
                        />
                      </td>
                      <td>
                        <div className="run-name">
                          <Pair
                            from={item.official.turnoverBps}
                            to={item.candidate.turnoverBps}
                            suffix=" bps"
                          />
                          <span>决策差异 {item.decisionDeltaTurnoverBps} bps</span>
                        </div>
                      </td>
                      <td>
                        <Pair
                          from={item.official.simulatedSlippageNavCost}
                          to={item.candidate.simulatedSlippageNavCost}
                        />
                      </td>
                      <td>
                        <Pair
                          from={item.official.simulatedFeeNavCost}
                          to={item.candidate.simulatedFeeNavCost}
                        />
                      </td>
                      <td>
                        <Pair
                          from={item.official.simulatedTaxNavCost}
                          to={item.candidate.simulatedTaxNavCost}
                        />
                      </td>
                      <td>
                        <Pair
                          from={item.official.terminalNav}
                          to={item.candidate.terminalNav}
                          direction="higher-better"
                        />
                      </td>
                      <td>
                        <Pair
                          from={item.official.maxDrawdownBps}
                          to={item.candidate.maxDrawdownBps}
                          suffix=" bps"
                        />
                      </td>
                      <td>
                        <Pair
                          from={item.official.terminalFailureCount}
                          to={item.candidate.terminalFailureCount}
                        />
                      </td>
                      <td>
                        <div className="run-name">
                          <StatusBadge
                            label={item.recommendation}
                            tone={item.recommendation === "PROMOTE_CANDIDATE"
                              ? "positive"
                              : "warning"}
                            code
                          />
                          <span>eval {item.evaluationSha256.slice(0, 14)}…</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel-footer">
              <span>
                单位：换手与回撤为 bps，成本与 NAV 为{" "}
                {data.decisionEvaluations[0]?.navCurrency ?? "USD"} · 建议不触发晋级
              </span>
              <StatusBadge label="正式排名始终隔离" tone="informative" />
            </div>
          </>
        )}
      </section>

      <div className="two-column-grid">
        <div className="column-stack">
          <section className="panel panel-flush">
            <SectionHeading
              eyebrow="Experience ledger"
              title="最近经验"
              note={
                <p>
                  问题不被覆盖
                  <br />
                  而是变成下一次实验的来源
                </p>
              }
            />
            {data.findings.length === 0 ? (
              <div className="panel-footer">
                <span>暂无经验发现。分析周期写入后出现在这里。</span>
              </div>
            ) : (
              <>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">严重度</th>
                        <th scope="col">范围 / 对象</th>
                        <th scope="col">发现</th>
                        <th scope="col" className="numeric">观测 / 阈值</th>
                        <th scope="col">经验</th>
                        <th scope="col">证据哈希</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.findings.map((item) => (
                        <tr key={item.findingSha256}>
                          <td>
                            <StatusBadge
                              label={item.severity}
                              tone={severityTone(item.severity)}
                              code
                            />
                          </td>
                          <td>
                            <div className="run-name">
                              <strong>{item.scope}</strong>
                              <span>{item.subject}</span>
                            </div>
                          </td>
                          <td>{item.title}</td>
                          <td className="numeric tabular">
                            {item.observedValue} / {item.threshold}
                          </td>
                          <td>{item.lesson}</td>
                          <td className="mono">{item.findingSha256.slice(0, 12)}…</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="panel-footer">
                  <span>
                    显示 {data.findings.length} / {formatInteger(data.findingCount)} 条 ·
                    负结果与正结果同等保留
                  </span>
                </div>
              </>
            )}
          </section>
        </div>

        <div className="column-stack">
          <section className="panel panel-flush">
            <SectionHeading
              eyebrow="Hypothesis graph"
              title="实验与结论"
              note={<span>试验排名域与正式赛季物理隔离</span>}
            />
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">实验</th>
                    <th scope="col">模式</th>
                    <th scope="col">状态</th>
                    <th scope="col">试验排名域</th>
                    <th scope="col">结论</th>
                    <th scope="col">人批</th>
                  </tr>
                </thead>
                <tbody>
                  {data.experiments.map((item) => (
                    <tr key={item.experimentId}>
                      <td>
                        <div className="run-name">
                          <strong>{item.experimentCode}</strong>
                          <span>{item.experimentId}</span>
                        </div>
                      </td>
                      <td>{item.mode === "LOCAL_REPLAY" ? "本地回放" : "线上 Shadow"}</td>
                      <td>
                        <StatusBadge
                          label={item.status}
                          tone={experimentTone(item.status)}
                          code
                        />
                      </td>
                      <td>
                        <StatusBadge
                          label={item.trialScope ?? item.rankingScope ?? "未排程"}
                          tone={item.trialScope === "SHADOW" ? "warning" : "neutral"}
                          code
                        />
                      </td>
                      <td>{item.recommendation ?? "等待证据"}</td>
                      <td className="mono">
                        {item.humanApprovedAt ? formatDateTime(item.humanApprovedAt) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel-footer">
              <span>建议不等于上线；晋级需要人签字</span>
            </div>
          </section>

          <section className="panel panel-flush">
            <SectionHeading
              eyebrow="Heartbeat"
              title="分析周期"
              note={<span>窗口边界固定，不随部署时间漂移</span>}
            />
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">窗口</th>
                    <th scope="col">状态</th>
                    <th scope="col" className="numeric">发现</th>
                    <th scope="col">报告哈希</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cycles.map((item) => (
                    <tr key={item.cycleId}>
                      <td className="mono">
                        {formatDateTime(item.windowStartedAt)} →{" "}
                        {formatDateTime(item.windowEndedAt)}
                      </td>
                      <td>
                        <StatusBadge
                          label={item.status}
                          tone={cycleTone(item.status)}
                          code
                        />
                      </td>
                      <td className="numeric tabular">{item.findingCount}</td>
                      <td className="mono">
                        {item.reportSha256
                          ? `${item.reportSha256.slice(0, 16)}…`
                          : <Unsealed label="待生成" pending />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
