"use client";

import Decimal from "decimal.js";
import Link from "next/link";

import { SealedTimelinePlot } from "@/components/sealed-timeline";
import {
  ConnectionNote,
  PageHeader,
  ReadoutCell,
  SectionHeading,
  SetupRequired,
  StatusBadge,
  Unsealed,
} from "@/components/ui";
import type {
  PrivateArenaEntrantOverview,
  PrivateArenaRoundStage,
  PrivateArenaSeasonStatus,
  PrivateArenaWorkOverview,
  PrivateArenaWorkPhase,
  SeasonOverviewData,
  StatusTone,
} from "@/lib/data/contracts";
import { PRIVATE_ARENA_PHASES } from "@/lib/data/private-arena-overview";
import {
  derivePhaseState,
  isDeadlineBreach,
  nextRoundBoundary,
} from "@/lib/data/round-spine";
import { buildSealedTimeline } from "@/lib/data/sealed-timeline";
import {
  formatClock,
  formatCurrency,
  formatDateTime,
  formatInteger,
  formatPercent,
  formatShortDate,
} from "@/lib/format";

const phaseLabels: Record<PrivateArenaWorkPhase, string> = {
  RUN_AGENT_DECISION: "Agent 决策",
  PREPARE_S1_ORDERS: "冻结 S1 卖单",
  CAPTURE_S1_OPEN_REFERENCE: "采集 S1 开盘参考",
  CAPTURE_S1_CLOSE: "封存 S1 收盘",
  SETTLE_S1_AND_PREPARE_S2: "结算 S1 / 冻结 S2",
  CAPTURE_S2_OPEN_REFERENCE: "采集 S2 开盘参考",
  CAPTURE_S2_CLOSE: "封存 S2 收盘",
  FINALIZE_ACCEPTED_TARGET_CYCLE: "结算净值与排名",
};

function seasonStatus(status: PrivateArenaSeasonStatus): {
  label: string;
  tone: StatusTone;
} {
  if (status === "UPCOMING") return { label: "待开赛", tone: "informative" };
  if (status === "RUNNING") return { label: "比赛中", tone: "positive" };
  return { label: "已结束", tone: "neutral" };
}

function productSeasonName(displayName: string): string {
  return displayName.replace("Controlled Lab", "Arena");
}

function roundStageLabel(stage: PrivateArenaRoundStage): string {
  const labels: Record<PrivateArenaRoundStage, string> = {
    SCHEDULED: "等待决策窗口",
    DECISION_WINDOW: "Agent 决策窗口",
    WAITING_S1_OPEN: "等待 S1 开盘",
    S1_EXECUTION: "S1 卖出执行",
    SETTLING_S1: "S1 结算 / S2 计划",
    S2_EXECUTION: "S2 买入执行",
    FINALIZING: "收盘结算",
    COMPLETE: "本轮已完成",
  };
  return labels[stage];
}

function returnPct(entrant: PrivateArenaEntrantOverview): string | null {
  return entrant.valuation === null
    ? null
    : new Decimal(entrant.valuation.returnMultiple).minus(1).times(100).toString();
}

function executionLabel(entrant: PrivateArenaEntrantOverview): string {
  return entrant.executionClass === "ORCHESTRATED" ? "编排 Agent" : "单 Agent";
}

function workStatusText(item: PrivateArenaWorkOverview): string {
  if (isDeadlineBreach(item)) return `已越界 ${item.errorCode ?? ""}`.trim();
  if (item.status === "SUCCEEDED") return "已封存";
  if (item.status === "CLAIMED") return "执行中";
  if (item.status === "FAILED") return `失败 ${item.errorCode ?? ""}`.trim();
  if (item.status === "CANCELED") return "已取消";
  return `排程于 ${formatDateTime(item.scheduledAt)}`;
}

function entrantProgress(entrant: PrivateArenaEntrantOverview): {
  completed: number;
  label: string;
  tone: StatusTone;
} {
  const completed = entrant.work.filter((item) => item.status === "SUCCEEDED").length;
  if (entrant.noTrade?.status === "SUCCEEDED") {
    return { completed, label: "本轮未交易", tone: "critical" };
  }
  if (entrant.noTrade?.status === "FAILED") {
    return { completed, label: "结转失败", tone: "critical" };
  }
  if (entrant.noTrade !== null) {
    return { completed, label: "等待持仓结转", tone: "warning" };
  }
  if (entrant.work.some((item) => item.status === "FAILED" || item.status === "CANCELED")) {
    return { completed, label: "需要处理", tone: "critical" };
  }
  if (entrant.work.some((item) => item.status === "CLAIMED")) {
    return { completed, label: "正在执行", tone: "warning" };
  }
  if (completed === PRIVATE_ARENA_PHASES.length) {
    return { completed, label: "已完成", tone: "positive" };
  }
  return { completed, label: completed === 0 ? "等待执行" : "按计划等待", tone: "neutral" };
}

function noTradeReasonLabel(entrant: PrivateArenaEntrantOverview): string | null {
  const reason = entrant.noTrade?.reasonCode;
  if (reason === "DECISION_UNAVAILABLE") return "决策未完成，持仓不变";
  if (reason === "S1_PLAN_UNAVAILABLE") return "S1 计划未完成，持仓不变";
  if (reason === "S1_CHECKPOINT_UNAVAILABLE") return "S1 结算未完成，持仓不变";
  if (reason === "FINALIZATION_UNAVAILABLE") return "最终结算未完成，持仓不变";
  return null;
}

function valuationStageLabel(
  stage: NonNullable<PrivateArenaEntrantOverview["valuation"]>["stage"],
): string {
  if (stage === "OPENING") return "起始估值";
  if (stage === "S1_CLOSE") return "S1 收盘";
  return "S2 最终";
}

/** Every entrant whose round ended at a frozen deadline. */
function breaches(entrants: readonly PrivateArenaEntrantOverview[]): {
  entrant: PrivateArenaEntrantOverview;
  item: PrivateArenaWorkOverview;
}[] {
  return entrants.flatMap((entrant) => {
    const item = entrant.work.find(isDeadlineBreach);
    return item ? [{ entrant, item }] : [];
  });
}

export function SeasonOverview({ initialData }: { initialData: SeasonOverviewData }) {
  const data = initialData;
  if (data.setupRequired || data.overview === null) {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="Private arena"
          title="真实赛场状态暂不可用"
          description="页面不会用演示净值或默认排名替代数据库中的真实比赛状态。"
        />
        <SetupRequired checklist={data.checklist} connection={data.connection} />
      </div>
    );
  }

  const arena = data.overview;
  const seasonBadge = seasonStatus(arena.season.status);
  const round = arena.currentRound;
  const boundary = round ? nextRoundBoundary(round, arena.asOf) : null;
  const ranked = arena.entrants.filter((entrant) => entrant.valuation !== null);
  const timeline = buildSealedTimeline(
    arena,
    phaseLabels,
    workStatusText,
    executionLabel,
    formatClock,
  );
  const breached = breaches(arena.entrants);
  const leadRank = arena.entrants.reduce<string | null>((best, entrant) => {
    if (entrant.rank === null) return best;
    if (best === null) return entrant.rank;
    return Number(entrant.rank) < Number(best) ? entrant.rank : best;
  }, null);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Private arena"
        title={productSeasonName(arena.season.displayName)}
        subtitle={
          `${arena.season.seasonCode} · ${formatShortDate(arena.season.opensAt)} — `
          + `${formatShortDate(arena.season.closesAt)} · ${arena.season.marketTimezone}`
        }
        description="所有参赛者从同一起点出发，走同一条已封存的市场路径，用同一套成交与税费规则结算。名次只看清算净值。"
        actions={
          <>
            <StatusBadge label={seasonBadge.label} tone={seasonBadge.tone} />
            {breached.length > 0 ? (
              <StatusBadge
                label={`${breached.length} 位越界`}
                tone="critical"
              />
            ) : null}
          </>
        }
      />

      {/* ── 签名元素：封存时序尺 ── */}
      <section className="ruler" aria-label="封存时序尺">
        <div className="ruler-readout">
          <ReadoutCell
            label="统一起点"
            value={arena.season.openingHolding}
            detail={`现金 ${formatCurrency(arena.season.openingCash)} · 每位参赛者独立账本`}
          />
          <ReadoutCell
            label="参赛者"
            value={formatInteger(arena.season.entrantCount)}
            detail={`${ranked.length} 个已有可排名净值`}
          />
          <ReadoutCell
            label={round ? `Round ${round.roundIndex} · 阶段` : "当前轮次"}
            value={round ? roundStageLabel(round.stage) : "尚未排程"}
            detail={
              round
                ? `${round.finalCount} / ${round.entryCount} 个完成最终结算`
                : "等待冻结 Round"
            }
            text
          />
          <ReadoutCell
            label={
              boundary === null
                ? "下一时点"
                : boundary.overdue
                  ? `已逾期 · ${boundary.label}`
                  : `下一时点 · ${boundary.label}`
            }
            value={boundary ? formatDateTime(boundary.at) : "—"}
            detail={
              boundary?.overdue
                ? "该冻结时点已过，阶段仍未完成；越过冻结截止线的工作只能记为失败"
                : "按真实交易日推进；越过冻结截止线的工作只能记为失败"
            }
          />
        </div>

        {timeline ? (
          <SealedTimelinePlot timeline={timeline} />
        ) : (
          <div className="ruler-fallback ruler-fallback-shown">
            <span>本轮没有可信的冻结时点，时序尺不绘制。各阶段状态见下方执行链。</span>
            <a className="text-link" href="#phase-list">查看执行链 ↓</a>
          </div>
        )}
      </section>

      {/* 越界告警紧跟仪表，不放在页尾 */}
      {breached.map(({ entrant, item }) => (
        <section className="breach" key={entrant.entrantId} aria-label="已越界的工作">
          <div className="breach-main">
            <div className="breach-head">
              <StatusBadge label="Deadline expired" tone="critical" code />
              <strong>{entrant.entrantCode} · {phaseLabels[item.phase]}</strong>
            </div>
            <p>
              工作在
              {item.deadlineAt ? ` ${formatDateTime(item.deadlineAt)} ` : "冻结截止时间"}
              之后才返回，已记为失败。本轮不再重试，也不会补发成交；
              {entrant.noTrade !== null
                ? "该参赛者的账本逐字节保留，持仓不变，并按同一 S2 收盘估值结转。"
                : "该参赛者的账本逐字节保留，持仓不变。"}
            </p>
            <div className="breach-actions">
              <Link className="text-link" href="/audit">查看审计记录 →</Link>
              {entrant.decisionId ? (
                <Link className="text-link" href={`/arena/decisions/${entrant.decisionId}`}>
                  打开决策详情 →
                </Link>
              ) : null}
            </div>
          </div>
          <div className="breach-side">
            <dl className="definition-list">
              <div>
                <dt>错误码</dt>
                <dd className="mono">{item.errorCode}</dd>
              </div>
              <div>
                <dt>尝试次数</dt>
                <dd className="mono">{item.attemptCount}</dd>
              </div>
              {entrant.noTrade?.outcome ? (
                <div>
                  <dt>后续处理</dt>
                  <dd className="mono">{entrant.noTrade.outcome}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        </section>
      ))}

      <section className="panel panel-flush">
        <SectionHeading
          eyebrow="Liquidation NAV"
          title="税后清算净值排名"
          note={
            <p>
              同一起点 · 同一市场证据 · 同一成交规则
              <br />
              并列使用相同名次
            </p>
          }
        />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">名次</th>
                <th scope="col">参赛者</th>
                <th scope="col">运行方式</th>
                <th scope="col" className="numeric">清算净值</th>
                <th scope="col" className="numeric">累计收益</th>
                <th scope="col" className="numeric">券商净值</th>
                <th scope="col">估值时点</th>
                <th scope="col">执行进度</th>
                <th scope="col">决策</th>
              </tr>
            </thead>
            <tbody>
              {arena.entrants.map((entrant) => {
                const progress = entrantProgress(entrant);
                const percent = returnPct(entrant);
                const isLead = entrant.rank !== null && entrant.rank === leadRank;
                return (
                  <tr key={entrant.entrantId}>
                    <td className={isLead ? "rank-cell rank-cell-lead" : "rank-cell"}>
                      {entrant.rank ?? "—"}
                    </td>
                    <td>
                      <div className="run-name">
                        <strong>{entrant.entrantCode}</strong>
                        <span>{entrant.model} · {entrant.presetId}</span>
                      </div>
                    </td>
                    <td>{executionLabel(entrant)}</td>
                    <td className="numeric tabular">
                      {entrant.valuation
                        ? formatCurrency(entrant.valuation.liquidationNav)
                        : <Unsealed label="未估值" pending />}
                    </td>
                    <td className={
                      percent !== null && new Decimal(percent).isNegative()
                        ? "numeric tabular negative-text"
                        : "numeric tabular positive-text"
                    }>
                      {percent === null ? "—" : formatPercent(percent)}
                    </td>
                    {/* brokerNav beside liquidationNav makes the fee-and-tax
                        gap visible without deriving a figure the projection
                        does not publish. */}
                    <td className="numeric tabular">
                      {entrant.valuation
                        ? formatCurrency(entrant.valuation.brokerNav)
                        : "—"}
                    </td>
                    <td>
                      {entrant.valuation
                        ? (
                            <StatusBadge
                              label={valuationStageLabel(entrant.valuation.stage)}
                              tone={entrant.valuation.stage === "S2_CLOSE" ? "positive" : "neutral"}
                            />
                          )
                        : <StatusBadge label="等待估值" tone="warning" />}
                    </td>
                    <td>
                      <div className="run-name">
                        <StatusBadge label={progress.label} tone={progress.tone} />
                        <span>{noTradeReasonLabel(entrant)
                          ?? `${progress.completed} / ${PRIVATE_ARENA_PHASES.length} 阶段`}</span>
                      </div>
                    </td>
                    <td>
                      {entrant.decisionId
                        ? (
                            <Link
                              className="text-link"
                              href={`/arena/decisions/${entrant.decisionId}`}
                            >
                              查看 →
                            </Link>
                          )
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="panel-footer">
          <span>排名依据：Liquidation NAV · 收益为费用与影子税之后</span>
          <span>数据截至 <strong>{formatDateTime(arena.asOf)}</strong></span>
        </div>
      </section>

      <div className="two-column-grid">
        <div className="column-stack">
          <section className="panel panel-flush" id="phase-list">
            <SectionHeading
              eyebrow={round ? `Round ${round.roundIndex} · work DAG` : "Work DAG"}
              title="八阶段执行链"
              note={
                <p>
                  阶段按冻结的交易日历排程
                  <br />
                  越界的工作只能记为失败
                </p>
              }
            />
            <div className="phase-list">
              {PRIVATE_ARENA_PHASES.map((phase) => {
                const state = derivePhaseState(arena.entrants, phase);
                return (
                  <div className="phase-row" key={phase}>
                    <i className={`phase-mark phase-mark-${state.tone}`} aria-hidden="true" />
                    <div className="phase-name">
                      <strong>{phaseLabels[phase]}</strong>
                      <span>{phase}</span>
                    </div>
                    <p className="phase-when">
                      {state.scheduledAt ? formatDateTime(state.scheduledAt) : "未排程"}
                      {state.deadlineAt
                        ? <strong>截止 {formatDateTime(state.deadlineAt)}</strong>
                        : null}
                    </p>
                    <StatusBadge label={state.label} tone={state.tone} />
                    <p className="phase-count">
                      {state.succeeded} / {state.expected}
                      {state.canceled > 0
                        ? <strong>{state.canceled} 已取消</strong>
                        : null}
                    </p>
                  </div>
                );
              })}
            </div>
            <div className="panel-footer">
              <span>分母为本轮仍需完成该阶段的参赛者；已取消的工作单独列出</span>
              <Link className="text-link" href="/audit">查看审计记录 →</Link>
            </div>
          </section>
        </div>

        <div className="column-stack">
          <section className="panel">
            <SectionHeading eyebrow="Frozen contract" title="公平性边界" compact />
            <dl className="definition-list">
              <div><dt>赛季代码</dt><dd className="mono">{arena.season.seasonCode}</dd></div>
              <div><dt>统一起点</dt><dd>{arena.season.openingHolding}</dd></div>
              <div><dt>初始现金</dt><dd>{formatCurrency(arena.season.openingCash)}</dd></div>
              <div><dt>决策频率</dt><dd>每轮在美股收盘后</dd></div>
              <div><dt>执行方式</dt><dd>S1 卖出 · S2 买入</dd></div>
              <div><dt>排名口径</dt><dd>费用与影子税后的清算净值</dd></div>
              <div><dt>已冻结轮次</dt><dd className="tabular">{arena.season.roundCount}</dd></div>
              {round
                ? <div><dt>Round ID</dt><dd className="mono hash-value">{round.roundId}</dd></div>
                : null}
            </dl>
            <ConnectionNote connection={data.connection} />
          </section>
        </div>
      </div>
    </div>
  );
}
