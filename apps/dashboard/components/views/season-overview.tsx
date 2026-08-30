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
  PrivateArenaEntrantOverview,
  PrivateArenaRoundStage,
  PrivateArenaSeasonStatus,
  PrivateArenaWorkPhase,
  SeasonOverviewData,
  StatusTone,
} from "@/lib/data/contracts";
import { PRIVATE_ARENA_PHASES } from "@/lib/data/private-arena-overview";
import {
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

function nextBoundary(round: NonNullable<SeasonOverviewData["overview"]>["currentRound"]): {
  label: string;
  at: string;
} | null {
  if (!round) return null;
  if (round.stage === "SCHEDULED") return { label: "决策窗口开启", at: round.decisionWindowOpensAt };
  if (round.stage === "DECISION_WINDOW") return { label: "决策截止", at: round.decisionWindowClosesAt };
  if (round.stage === "WAITING_S1_OPEN") return { label: "S1 开盘", at: round.s1OpenAt };
  if (round.stage === "S1_EXECUTION") return { label: "S1 收盘", at: round.s1CloseAt };
  if (round.stage === "SETTLING_S1") return { label: "S2 开盘", at: round.s2OpenAt };
  if (round.stage === "S2_EXECUTION") return { label: "S2 收盘", at: round.s2CloseAt };
  if (round.stage === "FINALIZING") return { label: "可结算时点", at: round.cycleReadyAt };
  return null;
}

function returnPct(entrant: PrivateArenaEntrantOverview): string | null {
  return entrant.valuation === null
    ? null
    : new Decimal(entrant.valuation.returnMultiple).minus(1).times(100).toString();
}

function entrantProgress(entrant: PrivateArenaEntrantOverview): {
  completed: number;
  label: string;
  tone: StatusTone;
} {
  const completed = entrant.work.filter((item) => item.status === "SUCCEEDED").length;
  if (entrant.noTrade?.status === "SUCCEEDED") {
    return { completed, label: "本轮未交易", tone: "neutral" };
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
    return { completed, label: "正在执行", tone: "informative" };
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

function phaseState(
  entrants: readonly PrivateArenaEntrantOverview[],
  phase: PrivateArenaWorkPhase,
): { label: string; detail: string; tone: StatusTone; scheduledAt: string | null } {
  const items = entrants.flatMap((entrant) =>
    entrant.work.filter((item) => item.phase === phase)
  );
  const scheduledAt = items[0]?.scheduledAt ?? null;
  const succeeded = items.filter((item) => item.status === "SUCCEEDED").length;
  if (items.length === 0) {
    return { label: "尚未排程", detail: "0 / 0", tone: "neutral", scheduledAt };
  }
  if (items.some((item) =>
    item.errorCode === "DEADLINE_EXPIRED"
    || item.errorCode === "DEADLINE_EXPIRED_DURING_EXECUTION"
  )) {
    return { label: "已错过截止时间", detail: `${succeeded} / ${items.length}`, tone: "critical", scheduledAt };
  }
  if (items.some((item) => item.status === "FAILED" || item.status === "CANCELED")) {
    return { label: "需要处理", detail: `${succeeded} / ${items.length}`, tone: "critical", scheduledAt };
  }
  if (succeeded === items.length) {
    return { label: "已完成", detail: `${succeeded} / ${items.length}`, tone: "positive", scheduledAt };
  }
  if (items.some((item) => item.status === "CLAIMED")) {
    return { label: "执行中", detail: `${succeeded} / ${items.length}`, tone: "informative", scheduledAt };
  }
  return { label: "等待时点", detail: `${succeeded} / ${items.length}`, tone: "neutral", scheduledAt };
}

function valuationStageLabel(stage: NonNullable<PrivateArenaEntrantOverview["valuation"]>["stage"]): string {
  if (stage === "OPENING") return "起始估值";
  if (stage === "S1_CLOSE") return "S1 收盘";
  return "S2 最终";
}

export function SeasonOverview({ initialData }: { initialData: SeasonOverviewData }) {
  const data = initialData;
  if (data.setupRequired || data.overview === null) {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="私有竞技场"
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
  const boundary = nextBoundary(round);
  const ranked = arena.entrants.filter((entrant) => entrant.valuation !== null);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="私有竞技场"
        title={productSeasonName(arena.season.displayName)}
        description={
          formatShortDate(arena.season.opensAt) + " — " +
          formatShortDate(arena.season.closesAt) + " · " +
          arena.season.marketTimezone
        }
        actions={<StatusBadge label={seasonBadge.label} tone={seasonBadge.tone} />}
      />

      <section className="metrics-grid" aria-label="竞技场状态">
        <MetricCard
          label="统一起点"
          value={arena.season.openingHolding}
          detail={`现金 ${formatCurrency(arena.season.openingCash)} · 每位参赛者独立账本`}
          tone="positive"
        />
        <MetricCard
          label="参赛者"
          value={formatInteger(arena.season.entrantCount)}
          detail={`${ranked.length} 个已有可排名净值`}
        />
        <MetricCard
          label={round ? `第 ${round.roundIndex} 轮` : "当前轮次"}
          value={round ? roundStageLabel(round.stage) : "尚未排程"}
          detail={round ? `${round.finalCount} / ${round.entryCount} 个完成最终结算` : "等待冻结 Round"}
        />
        <MetricCard
          label={boundary?.label ?? "下一时点"}
          value={boundary ? formatDateTime(boundary.at) : "—"}
          detail="按真实交易日推进；同一账本不并发重叠周期"
        />
      </section>

      <section className="panel leaderboard-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">实时排名</p>
            <h2>税后清算净值</h2>
          </div>
          <p>同一起点、同一市场证据、同一成交规则。</p>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">排名</th>
                <th scope="col">参赛者</th>
                <th scope="col">运行方式</th>
                <th scope="col" className="numeric">清算净值</th>
                <th scope="col" className="numeric">累计收益</th>
                <th scope="col">估值时点</th>
                <th scope="col">执行进度</th>
                <th scope="col">决策</th>
              </tr>
            </thead>
            <tbody>
              {arena.entrants.map((entrant) => {
                const progress = entrantProgress(entrant);
                const percent = returnPct(entrant);
                return (
                  <tr key={entrant.entrantId}>
                    <td className="rank-cell">{entrant.rank ?? "—"}</td>
                    <td>
                      <div className="run-name">
                        <strong>{entrant.entrantCode}</strong>
                        <span>{entrant.model} · {entrant.presetId}</span>
                      </div>
                    </td>
                    <td>{entrant.executionClass === "ORCHESTRATED" ? "编排 Agent" : "单 Agent"}</td>
                    <td className="numeric tabular">
                      {entrant.valuation ? formatCurrency(entrant.valuation.liquidationNav) : "—"}
                    </td>
                    <td className={
                      percent !== null && new Decimal(percent).isNegative()
                        ? "numeric tabular negative-text"
                        : "numeric tabular positive-text"
                    }>
                      {percent === null ? "—" : formatPercent(percent)}
                    </td>
                    <td>
                      {entrant.valuation
                        ? <StatusBadge label={valuationStageLabel(entrant.valuation.stage)} tone={entrant.valuation.stage === "S2_CLOSE" ? "positive" : "neutral"} />
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
                        ? <Link className="text-link" href={`/arena/decisions/${entrant.decisionId}`}>查看</Link>
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="panel-footer">
          <span>排名依据：Liquidation NAV · 并列使用相同名次</span>
          <span>数据截至 {formatDateTime(arena.asOf)}</span>
        </div>
      </section>

      <div className="two-column-grid">
        <section className="panel">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">真实节奏</p>
              <h2>两交易日执行链</h2>
            </div>
            {round ? <StatusBadge label={roundStageLabel(round.stage)} tone={round.stage === "COMPLETE" ? "positive" : "informative"} /> : null}
          </div>
          <div className="activity-list">
            {PRIVATE_ARENA_PHASES.map((phase) => {
              const state = phaseState(arena.entrants, phase);
              return (
                <div className="activity-row" key={phase}>
                  <span className={`activity-marker activity-marker-${state.tone}`} />
                  <div>
                    <div className="activity-heading">
                      <strong>{phaseLabels[phase]}</strong>
                      <time dateTime={state.scheduledAt ?? undefined}>
                        {state.scheduledAt ? formatDateTime(state.scheduledAt) : "未排程"}
                      </time>
                    </div>
                    <p>{state.label} · {state.detail} 个参赛者</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel season-contract">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">冻结契约</p>
              <h2>公平性边界</h2>
            </div>
          </div>
          <dl className="definition-list">
            <div><dt>赛季代码</dt><dd className="mono">{arena.season.seasonCode}</dd></div>
            <div><dt>统一起点</dt><dd>{arena.season.openingHolding}</dd></div>
            <div><dt>初始现金</dt><dd>{formatCurrency(arena.season.openingCash)}</dd></div>
            <div><dt>决策频率</dt><dd>每轮在美股收盘后</dd></div>
            <div><dt>执行方式</dt><dd>S1 卖出 · S2 买入</dd></div>
            <div><dt>排名口径</dt><dd>费用与影子税后的清算净值</dd></div>
            {round ? <div><dt>Round ID</dt><dd className="mono">{round.roundId}</dd></div> : null}
          </dl>
          <ConnectionNote connection={data.connection} />
        </section>
      </div>
    </div>
  );
}
