"use client";

import { useEffect, useState } from "react";

import {
  ConnectionNote,
  Note,
  PageHeader,
  SectionHeading,
  StatusBadge,
  Unsealed,
} from "@/components/ui";
import type { SettingsData } from "@/lib/data/contracts";

const DRAFT_STORAGE_KEY = "twofold-lab-settings-draft";
const DRAFT_FIELDS = [
  "seasonName",
  "startAt",
  "endAt",
  "timezone",
  "decisionCadence",
  "slippageBps",
  "feeProfile",
  "taxProfile",
  "marketDataProvider",
  "maxProviderRequestsPerDecision",
  "maxBillableTokensPerDecision",
  "maxEstimatedCostUsdPerDecision",
] as const satisfies readonly (keyof SettingsData["draft"])[];

function loadBrowserDraft(fallback: SettingsData["draft"]): SettingsData["draft"] {
  try {
    const stored = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!stored) return fallback;
    const candidate: unknown = JSON.parse(stored);
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return fallback;
    }

    const values = candidate as Record<string, unknown>;
    const restored = { ...fallback };
    for (const field of DRAFT_FIELDS) {
      if (typeof values[field] === "string") restored[field] = values[field];
    }
    return restored;
  } catch {
    return fallback;
  }
}

function setupStatusLabel(status: SettingsData["checklist"][number]["status"]): string {
  if (status === "ready") return "已就绪";
  if (status === "pending") return "待处理";
  return "缺失";
}

export function SettingsView({ initialData }: { initialData: SettingsData }) {
  const data = initialData;
  const [draft, setDraft] = useState(data.draft);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(loadBrowserDraft(data.draft));
    setSaved(false);
  }, [data]);

  function updateDraft<Key extends keyof SettingsData["draft"]>(
    key: Key,
    value: SettingsData["draft"][Key],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  function saveDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    setSaved(true);
  }

  const readyCount = data.checklist.filter((item) => item.status === "ready").length;
  const missingCount = data.checklist.filter((item) => item.status === "missing").length;
  const projectionBadge = data.connection.readStatus === "ERROR"
    ? { label: "投影读取异常", tone: "critical" as const }
    : data.connection.readStatus === "NOT_READY"
      ? { label: "等待真实投影", tone: "warning" as const }
      : data.setupRequired
        ? { label: "需要完成设置", tone: "warning" as const }
        : { label: "真实配置已冻结", tone: "positive" as const };

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Next season contract"
        title="冻结下一赛季契约"
        subtitle="草稿只留在这台浏览器 · 保存不会激活任何赛季"
        description="活动赛季的规则不可变。在这里填的是下一个赛季的候选输入；任何修改都会形成新版本，激活仍需要单独一步。"
        actions={
          <StatusBadge
            label={projectionBadge.label}
            tone={projectionBadge.tone}
          />
        }
      />

      {/* The clearest thing this page can say: it does not touch the live round. */}
      <Note title="本页不会影响正在进行的赛季" tone="warning">
        活动赛季的规则在激活时已经冻结。这里的改动最早在下一个赛季生效，且需要单独的注册与激活步骤。
      </Note>

      {data.connection.readStatus === "ERROR"
        || data.connection.readStatus === "NOT_READY" ? (
          <ConnectionNote connection={data.connection} />
        ) : null}

      <form className="settings-form" onSubmit={saveDraft}>
        <div className="settings-main">
          <section className="panel settings-section">
            <SectionHeading
              eyebrow="Season window"
              title="时间窗口与频率"
              note={<StatusBadge label="已版本化" tone="informative" />}
              compact
            />
            <div className="form-grid">
              <label className="field field-span-two">
                <span>赛季名称</span>
                <input
                  value={draft.seasonName}
                  onChange={(event) => updateDraft("seasonName", event.target.value)}
                  placeholder="赛季 01"
                />
              </label>
              <label className="field">
                <span>开始日期</span>
                <input
                  type="date"
                  value={draft.startAt}
                  onChange={(event) => updateDraft("startAt", event.target.value)}
                />
              </label>
              <label className="field">
                <span>结束日期</span>
                <input
                  type="date"
                  value={draft.endAt}
                  onChange={(event) => updateDraft("endAt", event.target.value)}
                />
              </label>
              <label className="field">
                <span>市场时区</span>
                <select
                  value={draft.timezone}
                  onChange={(event) => updateDraft("timezone", event.target.value)}
                >
                  <option value="America/New_York">America/New_York</option>
                </select>
              </label>
              <label className="field">
                <span>决策频率</span>
                <select
                  value={draft.decisionCadence}
                  onChange={(event) => updateDraft("decisionCadence", event.target.value)}
                >
                  <option value="Weekly · final trading day at 16:15">
                    每周 · 最后一个交易日 16:15
                  </option>
                </select>
              </label>
            </div>
            <p className="form-note">
              只有 S1 和 S2 都能落在这个窗口内，才会为该轮排程两阶段再平衡。
            </p>
          </section>

          <section className="panel settings-section">
            <SectionHeading
              eyebrow="Execution &amp; valuation"
              title="已冻结的规则集输入"
              compact
            />
            <div className="form-grid">
              <label className="field">
                <span>滑点（基点）</span>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9]+([.][0-9]+)?"
                  value={draft.slippageBps}
                  onChange={(event) => updateDraft("slippageBps", event.target.value)}
                />
              </label>
              <label className="field">
                <span>市场数据源</span>
                <select
                  value={draft.marketDataProvider}
                  onChange={(event) => updateDraft("marketDataProvider", event.target.value)}
                >
                  <option value="Not selected">未选择</option>
                  <option value="Alpaca SIP raw daily bars">
                    Alpaca SIP 未复权日线
                  </option>
                  <option value="Supabase snapshot registry">Supabase 快照注册表</option>
                </select>
              </label>
              <label className="field field-span-two">
                <span>费用配置</span>
                <select
                  value={draft.feeProfile}
                  onChange={(event) => updateDraft("feeProfile", event.target.value)}
                >
                  <option value="Futu HK · US stocks fixed platform fee">
                    Futu HK · 美股固定平台费
                  </option>
                </select>
              </label>
              <label className="field field-span-two">
                <span>影子税配置</span>
                <select
                  value={draft.taxProfile}
                  onChange={(event) => updateDraft("taxProfile", event.target.value)}
                >
                  <option value="Mainland China individual · shadow reserve">
                    中国大陆个人 · 影子税准备金
                  </option>
                </select>
              </label>
            </div>
            <Note title="只填名称不足以开赛" tone="critical">
              每项配置还需要来源快照、生效日期和不可变哈希；缺一项，赛季就停在未就绪。
            </Note>
          </section>

          <section className="panel settings-section">
            <SectionHeading
              eyebrow="Model &amp; skills"
              title="Harness 运行时边界"
              note={<StatusBadge label="由工作进程管理" tone="neutral" />}
              compact
            />
            <dl className="definition-list">
              <div>
                <dt>模型</dt>
                <dd>{data.model.displayName}</dd>
              </div>
              <div>
                <dt>精确模型 ID</dt>
                <dd className="mono">{data.model.id}</dd>
              </div>
              <div>
                <dt>实验条件</dt>
                <dd>No Skill · UZI · ai-berkshire</dd>
              </div>
              <div>
                <dt>凭证</dt>
                <dd>
                  {data.model.credentialStatus === "worker_managed"
                    ? "已在私有工作进程中配置"
                    : <Unsealed label="未配置" reason="WORKER_CREDENTIAL_MISSING" />}
                </dd>
              </div>
              <div>
                <dt>Token 口径</dt>
                <dd>Harness turn/step · 缓存分桶 · 推理不重复计费</dd>
              </div>
              <div>
                <dt>模型定价</dt>
                <dd className="mono">
                  {data.model.pricingStatus === "versioned"
                    ? data.model.pricingVersion
                    : <Unsealed label="未配置" reason="PRICING_VERSION_MISSING" />}
                </dd>
              </div>
            </dl>
            <div className="form-grid usage-budget-fields">
              <label className="field">
                <span>每次决策最多 Provider 请求</span>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]+"
                  value={draft.maxProviderRequestsPerDecision}
                  onChange={(event) =>
                    updateDraft("maxProviderRequestsPerDecision", event.target.value)
                  }
                />
              </label>
              <label className="field">
                <span>每次决策计费 Token 上限</span>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]+"
                  value={draft.maxBillableTokensPerDecision}
                  onChange={(event) =>
                    updateDraft("maxBillableTokensPerDecision", event.target.value)
                  }
                />
              </label>
              <label className="field field-span-two">
                <span>每次决策估算成本上限（USD）</span>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9]+([.][0-9]+)?"
                  value={draft.maxEstimatedCostUsdPerDecision}
                  onChange={(event) =>
                    updateDraft("maxEstimatedCostUsdPerDecision", event.target.value)
                  }
                />
              </label>
            </div>
            <p className="form-note">
              三项预算随赛季冻结并应用到所有模型运行；工作进程在发起下一次 Provider 请求前检查剩余额度。
            </p>
            <Note title="控制台不接收密钥" tone="informative">
              模型凭证在运行时注入私有 Harness 工作进程。浏览器和 Supabase 投影只接收状态，永不接收凭证值。
            </Note>
            <Note title="估算成本不等于实际账单" tone="informative">
              每次请求按生效的不可变费率版本估算；供应商账单到达后只追加对账事实，不覆盖历史用量。
            </Note>
          </section>
        </div>

        <aside className="settings-sidebar">
          <section className="panel settings-summary">
            <p className="eyebrow">Readiness</p>
            <div className="setup-score">
              <strong>{readyCount}/{data.checklist.length}</strong>
              <span>
                正式输入就绪
                {missingCount > 0 ? ` · ${missingCount} 项缺失` : ""}
              </span>
            </div>
            <div className="settings-checklist">
              {data.checklist.map((item) => (
                <div className="settings-check-row" key={item.id}>
                  <span
                    className={"setup-marker setup-marker-" + item.status}
                    aria-hidden="true"
                  />
                  <div>
                    <strong>{item.label}</strong>
                    <span>{setupStatusLabel(item.status)}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel connection-panel">
            <p className="eyebrow">Projection store</p>
            <ConnectionNote connection={data.connection} />
          </section>

          <div className="save-panel">
            {/* Deliberately not the primary style: this writes localStorage and
                activates nothing, so it must not be the loudest thing here. */}
            <button className="button button-full" type="submit">
              保存浏览器草稿
            </button>
            <p aria-live="polite">
              {saved
                ? "草稿已保存到本机。它不会写 Supabase，也不会激活或修改赛季。"
                : "在此保存不会写入 Supabase，也不会启动运行。"}
            </p>
          </div>
        </aside>
      </form>
    </div>
  );
}
