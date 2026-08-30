import Decimal from "decimal.js";
import Link from "next/link";

import {
  ConnectionNote,
  EmptyState,
  MetricCard,
  PageHeader,
  StatusBadge,
} from "@/components/ui";
import type {
  ArenaAgentNode,
  ArenaAgentUsage,
  AcceptedTargetCycleReadiness,
  AcceptedTargetCycleProjection,
  ArenaDecisionPageData,
  ArenaDecisionProjection,
  StatusTone,
} from "@/lib/data/contracts";
import {
  formatCurrency,
  formatDateTime,
  formatInteger,
  formatUsdCost,
} from "@/lib/format";

function decisionStatus(status: ArenaDecisionProjection["decision"]["status"]): {
  label: string;
  tone: StatusTone;
} {
  if (status === "QUEUED") return { label: "排队中", tone: "neutral" };
  if (status === "RUNNING") return { label: "运行中", tone: "informative" };
  if (status === "SUCCEEDED") return { label: "已完成", tone: "positive" };
  if (status === "BUDGET_EXHAUSTED") return { label: "预算耗尽", tone: "critical" };
  if (status === "NO_ACCEPTED_SUBMISSION") return { label: "无有效提交", tone: "warning" };
  return { label: "失败", tone: "critical" };
}

function agentStatus(status: ArenaAgentNode["status"]): { label: string; tone: StatusTone } {
  if (status === "QUEUED") return { label: "排队中", tone: "neutral" };
  if (status === "RUNNING") return { label: "运行中", tone: "informative" };
  if (status === "SUCCEEDED") return { label: "已完成", tone: "positive" };
  if (status === "CANCELED") return { label: "已取消", tone: "warning" };
  return { label: "失败", tone: "critical" };
}

function costStatusLabel(status: ArenaAgentUsage["costStatus"]): string {
  if (status === "ESTIMATED") return "完整估算";
  if (status === "PARTIAL") return "部分估算";
  if (status === "UNPRICED") return "未定价";
  return "用量不可用";
}

function submissionStatus(
  status: ArenaDecisionProjection["submission"]["status"],
): { label: string; tone: StatusTone } {
  if (status === "ACCEPTED") return { label: "已接受", tone: "positive" };
  if (status === "REJECTED") return { label: "已拒绝", tone: "critical" };
  if (status === "PENDING") return { label: "等待提交", tone: "informative" };
  return { label: "无提交", tone: "neutral" };
}

function enforcementStatus(
  status: ArenaDecisionProjection["budget"]["enforcementStatus"],
): { label: string; tone: StatusTone } {
  if (status === "WITHIN_LIMITS") return { label: "预算内", tone: "positive" };
  if (status === "EXHAUSTED") return { label: "已耗尽", tone: "critical" };
  return { label: "成本未定价", tone: "warning" };
}

function formatOptionalCost(value: string | null): string {
  return value === null ? "未定价" : formatUsdCost(value);
}

function formatWeightBps(value: string): string {
  return `${new Decimal(value).dividedBy(100).toFixed(2)}%`;
}

function ratio(used: string, maximum: string): { width: string; label: string } | null {
  const max = new Decimal(maximum);
  if (!max.isPositive()) return null;
  const percent = Decimal.min(100, new Decimal(used).dividedBy(max).times(100));
  return {
    width: `${percent.toFixed(2)}%`,
    label: `${percent.toFixed(1)}%`,
  };
}

function BudgetTrack({
  label,
  used,
  maximum,
  formatter = formatInteger,
}: {
  label: string;
  used: string;
  maximum: string;
  formatter?: (value: string) => string;
}) {
  const progress = ratio(used, maximum);
  return (
    <div className="agent-budget-track">
      <div>
        <span>{label}</span>
        <strong className="tabular">
          {formatter(used)} / {formatter(maximum)}
        </strong>
      </div>
      {progress ? (
        <div className="progress-track" aria-label={`${label}已使用 ${progress.label}`}>
          <span className="progress-fill" style={{ width: progress.width }} />
        </div>
      ) : (
        <p>上限为 {formatter(maximum)}，不计算比例。</p>
      )}
    </div>
  );
}

function AgentBranch({
  node,
  childrenByParent,
}: {
  node: ArenaAgentNode;
  childrenByParent: ReadonlyMap<string, ArenaAgentNode[]>;
}) {
  const status = agentStatus(node.status);
  const childNodes = childrenByParent.get(node.sessionId) ?? [];
  return (
    <li className="agent-tree-item">
      <article className="agent-node">
        <div className="agent-node-header">
          <div>
            <div className="agent-node-title">
              <span className={`agent-origin agent-origin-${node.origin}`} aria-hidden="true" />
              <h3>{node.displayName}</h3>
              <span className="agent-path mono">{node.agentPath}</span>
            </div>
            <p>{node.provider} / {node.model} · 深度 {node.delegationDepth}</p>
          </div>
          <StatusBadge label={status.label} tone={status.tone} />
        </div>

        <div className="agent-node-metrics">
          <div>
            <span>Provider 请求</span>
            <strong className="tabular">{formatInteger(node.usage.providerRequestCount)}</strong>
          </div>
          <div>
            <span>计费 Token</span>
            <strong className="tabular">{formatInteger(node.usage.totalBillableTokens)}</strong>
          </div>
          <div>
            <span>推理 Token</span>
            <strong className="tabular">{formatInteger(node.usage.reasoningTokens)}</strong>
          </div>
          <div>
            <span>估算成本</span>
            <strong className="tabular">{formatOptionalCost(node.usage.estimatedCostUsd)}</strong>
          </div>
        </div>

        <dl className="agent-node-evidence">
          <div>
            <dt>Session</dt>
            <dd className="mono">{node.sessionId}</dd>
          </div>
          <div>
            <dt>最后事件序号</dt>
            <dd className="mono">{node.lastEventSeq}</dd>
          </div>
          <div>
            <dt>开始</dt>
            <dd>{formatDateTime(node.startedAt)}</dd>
          </div>
          <div>
            <dt>结束</dt>
            <dd>{node.completedAt ? formatDateTime(node.completedAt) : "仍在运行"}</dd>
          </div>
          <div>
            <dt>用量状态</dt>
            <dd>{costStatusLabel(node.usage.costStatus)}</dd>
          </div>
          <div>
            <dt>定价版本</dt>
            <dd className="mono">
              {node.usage.pricingVersions.length > 0
                ? node.usage.pricingVersions.join(" · ")
                : "未记录"}
            </dd>
          </div>
        </dl>
      </article>

      {childNodes.length > 0 ? (
        <ol className="agent-tree-children">
          {childNodes.map((child) => (
            <AgentBranch
              key={child.sessionId}
              node={child}
              childrenByParent={childrenByParent}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function UnavailableDecision({ data }: { data: ArenaDecisionPageData }) {
  const isNotReady = data.status === "NOT_READY";
  const isError = data.status === "ERROR";
  return (
    <div className="page-stack">
      <div className="breadcrumb-row">
        <Link href="/">赛季概览</Link>
        <span aria-hidden="true">/</span>
        <span>Agent 运行</span>
      </div>
      <PageHeader
        eyebrow="Agent Tree"
        title={
          isNotReady
            ? "这次决策还没有真实 Agent 投影"
            : isError
              ? "无法验证这次决策的真实投影"
              : "真实 Agent 投影尚未连接"
        }
        description={
          isNotReady
            ? "数据库中不存在这个 decision UUID 的 dashboard.arena_decision 行。页面不会改读最新决策，也不会生成演示树。"
            : isError
              ? "路由、数据库读取或 schema 校验失败。为避免把不完整状态当成事实，Agent Tree 已停止渲染。"
              : "配置真实 Supabase 服务端读取路径后，才能按 decision UUID 查看 Agent Tree。"
        }
        actions={(
          <StatusBadge
            label={isNotReady ? "NOT_READY" : isError ? "读取异常" : "未配置"}
            tone={isError ? "critical" : "warning"}
          />
        )}
      />

      <section className="panel decision-lookup-panel">
        <p className="eyebrow">精确查询</p>
        <h2>Decision UUID</h2>
        <p className="mono decision-id-value">{data.decisionId}</p>
        <ConnectionNote connection={data.connection} />
      </section>

      <EmptyState
        title={isNotReady ? "NOT_READY" : "没有可安全展示的 Agent Tree"}
        description={
          isNotReady
            ? "等待 Worker 为这个 UUID 写入 schemaVersion 1 投影后，手动刷新页面或由已认证 Realtime 触发刷新。"
            : "当前页面只接受完整、可验证的 dashboard.arena_decision schemaVersion 1。"
        }
      />

      {data.issues.length > 0 ? (
        <section className="panel projection-issues" aria-label="投影校验问题">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">Fail closed</p>
              <h2>{isError ? "校验问题" : "等待条件"}</h2>
            </div>
          </div>
          <ul>
            {data.issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function AcceptedTargetCyclePanel({
  cycle,
  readiness = null,
}: {
  cycle: AcceptedTargetCycleProjection | null;
  readiness?: AcceptedTargetCycleReadiness | null;
}) {
  if (cycle === null) {
    const blockerText: Record<AcceptedTargetCycleReadiness["blockers"][number], string> = {
      DECISION_NOT_FOUND: "找不到该 decision 的不可变调用记录。",
      ACCEPTED_SUBMISSION_MISSING: "等待唯一、已校验的 accepted target submission。",
      STRATEGY_ACCOUNT_MISSING: "需要为这个 Strategy Run 注册 paper strategy account。",
      LEDGER_HEAD_MISSING: "需要导入 opening state，并初始化可验证的 ledger head。",
    };
    const ready = readiness?.status === "READY_FOR_INPUT_BUILD";
    const committed = readiness?.status === "COMPLETED";
    const blocked = readiness?.status === "BLOCKED";
    return (
      <section
        className="panel"
        data-testid={blocked
          ? "accepted-target-cycle-blocked"
          : ready
            ? "accepted-target-cycle-input-ready"
            : "accepted-target-cycle-pending"}
      >
        <div className="section-heading compact-heading">
          <div>
            <p className="eyebrow">Accepted target → NAV</p>
            <h2>{blocked
              ? "执行闭环被前置条件阻塞"
              : ready
                ? "基础输入已就绪"
                : committed
                  ? "Cycle 已提交，等待投影读取"
                  : "等待确定性执行闭环"}</h2>
          </div>
          <StatusBadge
            label={readiness?.status ?? "NOT_READY"}
            tone={ready || committed ? "informative" : "warning"}
          />
        </div>
        <p className="table-note">
          {ready
            ? "Worker 现在可以构建确定性 S1 输入；官方开盘价、交易日和 FX 证据仍须在执行前逐项通过。"
            : committed
              ? "数据库已确认不可变 cycle；页面尚未取得对应 dashboard projection，不会先行展示 NAV。"
              : "Accepted submission 只证明目标组合已被接受；在 S1、S2、ledger replay 和 NAV artifact 原子提交前，页面不会把它显示为已成交。"}
        </p>
        {readiness?.blockers.map((blocker) => (
          <div className="readiness-blocker" key={blocker}>
            <span className="mono">{blocker}</span>
            <span>{blockerText[blocker]}</span>
          </div>
        ))}
      </section>
    );
  }

  const money = (value: string) => cycle.nav.currency === "USD"
    ? formatCurrency(value)
    : `${cycle.nav.currency} ${value}`;
  return (
    <section className="panel" data-testid="accepted-target-cycle-completed">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">Accepted target → S1 → S2 → ledger → NAV</p>
          <h2>确定性执行闭环</h2>
        </div>
        <StatusBadge label="已回放验证" tone="positive" />
      </div>
      <div className="metrics-grid metrics-grid-three">
        <MetricCard
          label="S1 卖出"
          value={`${formatInteger(cycle.s1.settlementCount)} / ${formatInteger(cycle.s1.orderCount)}`}
          detail="settlements / orders"
        />
        <MetricCard
          label="S2 买入"
          value={`${formatInteger(cycle.s2.settlementCount)} / ${formatInteger(cycle.s2.orderCount)}`}
          detail="settlements / orders"
        />
        <MetricCard
          label="Ledger transactions"
          value={formatInteger(cycle.ledger.transactionCount)}
          detail={`head #${formatInteger(cycle.ledger.headSequence)}`}
        />
        <MetricCard
          label="Broker NAV"
          value={money(cycle.nav.brokerNav)}
          detail={`持仓市值 ${money(cycle.nav.positionMarketValue)}`}
        />
        <MetricCard
          label="Tax-reserved NAV"
          value={money(cycle.nav.taxReservedNav)}
          detail={`税款预留 ${money(cycle.nav.taxReserveDeductions)}`}
        />
        <MetricCard
          label="Liquidation NAV"
          value={money(cycle.nav.liquidationNav)}
          detail={`平仓扣减 ${money(cycle.nav.liquidationDeductions)}`}
        />
      </div>
      <dl className="definition-list arena-definition-list">
        <div><dt>Cycle</dt><dd className="mono">{cycle.cycleId}</dd></div>
        <div><dt>完成时间</dt><dd>{formatDateTime(cycle.completedAt)}</dd></div>
        <div><dt>Ledger head</dt><dd className="mono hash-value">{cycle.ledger.headSha256}</dd></div>
        <div><dt>Artifact SHA-256</dt><dd className="mono hash-value">{cycle.artifactSha256}</dd></div>
      </dl>
    </section>
  );
}

export function ArenaDecisionView({ initialData }: { initialData: ArenaDecisionPageData }) {
  const data = initialData;
  if (data.status !== "READY" || !data.projection || !data.evidence) {
    return <UnavailableDecision data={data} />;
  }

  const projection = data.projection;
  const decision = projection.decision;
  const decisionState = decisionStatus(decision.status);
  const submissionState = submissionStatus(projection.submission.status);
  const budgetState = enforcementStatus(projection.budget.enforcementStatus);
  const root = projection.agents.find((agent) => agent.sessionId === projection.rootSessionId)!;
  const childrenByParent = new Map<string, ArenaAgentNode[]>();
  for (const agent of projection.agents) {
    if (agent.parentSessionId === null) continue;
    const children = childrenByParent.get(agent.parentSessionId) ?? [];
    children.push(agent);
    childrenByParent.set(agent.parentSessionId, children);
  }

  return (
    <div className="page-stack">
      <div className="breadcrumb-row">
        <Link href="/">赛季概览</Link>
        <span aria-hidden="true">/</span>
        <span>Agent 运行</span>
      </div>
      <PageHeader
        eyebrow="Agent Tree · 真实投影"
        title={decision.bundleId}
        description={`${decision.presetId} · 开始于 ${formatDateTime(decision.startedAt)} · 只读`}
        actions={<StatusBadge label={decisionState.label} tone={decisionState.tone} />}
      />

      <section className="metrics-grid agent-summary-grid" aria-label="决策 Agent 与预算摘要">
        <MetricCard
          label="Agent 节点"
          value={formatInteger(String(projection.agents.length))}
          detail={`${formatInteger(String(projection.agents.length - 1))} 个 descendant`}
        />
        <MetricCard
          label="Provider 请求预算"
          value={`${formatInteger(projection.budget.usedProviderRequests)} / ${formatInteger(projection.budget.maxProviderRequests)}`}
          detail={budgetState.label}
          tone={projection.budget.enforcementStatus === "EXHAUSTED" ? "critical" : undefined}
        />
        <MetricCard
          label="Token 预算"
          value={`${formatInteger(projection.budget.usedBillableTokens)} / ${formatInteger(projection.budget.maxBillableTokens)}`}
          detail="全树计费 Token；推理 Token 不重复相加"
        />
        <MetricCard
          label="成本预算"
          value={`${formatOptionalCost(projection.budget.usedEstimatedCostUsd)} / ${formatUsdCost(projection.budget.maxEstimatedCostUsd)}`}
          detail={`${costStatusLabel(projection.treeUsage.costStatus)} · 估算值`}
          tone={projection.budget.enforcementStatus === "UNPRICED" ? "warning" : undefined}
        />
        <MetricCard
          label="Accepted submission"
          value={submissionState.label}
          detail={projection.submission.acceptedAt ? formatDateTime(projection.submission.acceptedAt) : "尚无接受时间"}
          tone={projection.submission.status === "ACCEPTED" ? "positive" : projection.submission.status === "REJECTED" ? "critical" : undefined}
        />
      </section>

      <AcceptedTargetCyclePanel
        cycle={data.executionCycle}
        readiness={data.executionReadiness}
      />

      {decision.failureCode || decision.failureMessage ? (
        <section className="panel decision-failure-panel">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">运行结果</p>
              <h2>决策未正常完成</h2>
            </div>
            <StatusBadge label={decision.failureCode ?? decision.status} tone="critical" />
          </div>
          {decision.failureMessage ? <p>{decision.failureMessage}</p> : null}
        </section>
      ) : null}

      <div className="two-column-grid arena-evidence-grid">
        <section className="panel">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">Decision fence</p>
              <h2>不可绕过的数据围栏</h2>
            </div>
            <StatusBadge label="已冻结" tone="positive" />
          </div>
          <dl className="definition-list arena-definition-list">
            <div><dt>Decision</dt><dd className="mono">{decision.decisionId}</dd></div>
            <div><dt>Run</dt><dd className="mono">{decision.runId}</dd></div>
            <div><dt>Season</dt><dd className="mono">{decision.seasonId}</dd></div>
            <div><dt>Decision packet</dt><dd className="mono">{decision.decisionPacketId}</dd></div>
            <div><dt>Packet SHA-256</dt><dd className="mono hash-value">{decision.packetSha256}</dd></div>
            <div><dt>Market snapshot</dt><dd className="mono">{decision.snapshotId}</dd></div>
            <div><dt>Data cutoff</dt><dd>{formatDateTime(decision.dataCutoffAt)}</dd></div>
            <div><dt>Bundle SHA-256</dt><dd className="mono hash-value">{decision.bundleSha256}</dd></div>
          </dl>
          <div className="panel-footer">
            <span>页面不读取更新的 snapshot。</span>
            <Link className="text-link" href="/data">查看真实市场数据</Link>
          </div>
        </section>

        <section className="panel agent-budget-panel">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">Tree budget</p>
              <h2>全树预算执行</h2>
            </div>
            <StatusBadge label={budgetState.label} tone={budgetState.tone} />
          </div>
          <div className="agent-budget-tracks">
            <BudgetTrack
              label="Provider 请求"
              used={projection.budget.usedProviderRequests}
              maximum={projection.budget.maxProviderRequests}
            />
            <BudgetTrack
              label="计费 Token"
              used={projection.budget.usedBillableTokens}
              maximum={projection.budget.maxBillableTokens}
            />
            {projection.budget.usedEstimatedCostUsd !== null ? (
              <BudgetTrack
                label="估算 USD 成本"
                used={projection.budget.usedEstimatedCostUsd}
                maximum={projection.budget.maxEstimatedCostUsd}
                formatter={formatUsdCost}
              />
            ) : (
              <div className="agent-budget-track">
                <div><span>估算 USD 成本</span><strong>未定价</strong></div>
                <p>预算上限 {formatUsdCost(projection.budget.maxEstimatedCostUsd)}</p>
              </div>
            )}
          </div>
          <dl className="definition-list arena-definition-list budget-definition-list">
            <div><dt>Active descendants</dt><dd>{formatInteger(projection.budget.activeDescendants)} / {formatInteger(projection.budget.maxDescendants)}</dd></div>
            <div><dt>未缓存输入</dt><dd>{formatInteger(projection.treeUsage.uncachedInputTokens)}</dd></div>
            <div><dt>缓存读取</dt><dd>{formatInteger(projection.treeUsage.cacheReadTokens)}</dd></div>
            <div><dt>缓存写入</dt><dd>{formatInteger(projection.treeUsage.cacheWriteTokens)}</dd></div>
            <div><dt>输出</dt><dd>{formatInteger(projection.treeUsage.outputTokens)}</dd></div>
            <div><dt>推理（输出子集）</dt><dd>{formatInteger(projection.treeUsage.reasoningTokens)}</dd></div>
          </dl>
        </section>
      </div>

      <section className="panel agent-tree-panel" aria-label="Agent Session 树">
        <div className="section-heading compact-heading">
          <div>
            <p className="eyebrow">Root / descendants</p>
            <h2>实时 Agent Tree</h2>
          </div>
          <p>每个物理 Provider attempt 只计入一个节点。</p>
        </div>
        <ol className="agent-tree-root">
          <AgentBranch node={root} childrenByParent={childrenByParent} />
        </ol>
      </section>

      {data.acceptedSubmission ? (
        <section className="panel accepted-target-panel" aria-label="已接受目标组合">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">Accepted portfolio</p>
              <h2>已接受目标组合</h2>
            </div>
            <div className="accepted-target-summary-metrics">
              <span>{formatInteger(String(data.acceptedSubmission.targets.length))} 只股票</span>
              <span>现金 {formatWeightBps(data.acceptedSubmission.cashWeightBps)}</span>
            </div>
          </div>
          <p className="accepted-target-decision-summary">
            {data.acceptedSubmission.decisionSummary}
          </p>
          <ol className="accepted-target-list">
            {data.acceptedSubmission.targets.map((target) => (
              <li key={target.symbol}>
                <div>
                  <strong className="mono">{target.symbol}</strong>
                  <span className="tabular">{formatWeightBps(target.targetWeightBps)}</span>
                </div>
                <p>{target.rationale}</p>
              </li>
            ))}
          </ol>
          <dl className="definition-list arena-definition-list accepted-target-evidence">
            <div><dt>Submission SHA-256</dt><dd className="mono hash-value">{data.acceptedSubmission.submissionSha256}</dd></div>
            <div><dt>接受时间</dt><dd>{formatDateTime(data.acceptedSubmission.acceptedAt)}</dd></div>
          </dl>
        </section>
      ) : null}

      <div className="two-column-grid arena-evidence-grid">
        <section className="panel submission-panel">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">Arena broker</p>
              <h2>目标组合提交</h2>
            </div>
            <StatusBadge label={submissionState.label} tone={submissionState.tone} />
          </div>
          <dl className="definition-list arena-definition-list">
            <div><dt>状态</dt><dd>{projection.submission.status}</dd></div>
            <div><dt>Accepted submission ID</dt><dd className="mono">{projection.submission.acceptedSubmissionId ?? "未记录"}</dd></div>
            <div><dt>接受时间</dt><dd>{projection.submission.acceptedAt ? formatDateTime(projection.submission.acceptedAt) : "未记录"}</dd></div>
            <div><dt>拒绝代码</dt><dd className="mono">{projection.submission.rejectionCode ?? "无"}</dd></div>
          </dl>
          <p className="table-note">这里只显示 Arena broker 的接受事实；不代表真实或模拟订单已经成交。</p>
        </section>

        <section className="panel projection-evidence-panel">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">Projection evidence</p>
              <h2>投影读取证据</h2>
            </div>
            <StatusBadge label="schemaVersion 1" tone="neutral" />
          </div>
          <dl className="definition-list arena-definition-list">
            <div><dt>State SHA-256</dt><dd className="mono hash-value">{data.evidence.stateHash}</dd></div>
            <div><dt>Last event</dt><dd className="mono">{data.evidence.lastEventId ?? "未记录"}</dd></div>
            <div><dt>Projection updated</dt><dd>{formatDateTime(data.evidence.projectionUpdatedAt)}</dd></div>
            <div><dt>State updated</dt><dd>{formatDateTime(projection.updatedAt)}</dd></div>
          </dl>
          <ConnectionNote connection={data.connection} />
        </section>
      </div>
    </div>
  );
}
