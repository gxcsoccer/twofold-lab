import Link from "next/link";

import {
  ConnectionNote,
  MetricCard,
  PageHeader,
  StatusBadge,
} from "@/components/ui";
import type { MarketDataPageData, StatusTone } from "@/lib/data/contracts";
import { formatDateTime, formatInteger } from "@/lib/format";

function statusLabel(status: MarketDataPageData["status"]): string {
  if (status === "READY") return "快照已封存";
  if (status === "WAITING") return "等待真实数据";
  if (status === "ERROR") return "接入异常";
  return "尚未配置";
}

function statusTone(status: MarketDataPageData["status"]): StatusTone {
  if (status === "READY") return "positive";
  if (status === "ERROR") return "critical";
  return "warning";
}

function shortHash(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-8)}`;
}

export function MarketDataView({ data }: { data: MarketDataPageData }) {
  const mostRecentDelivery = data.deliveries.reduce<(typeof data.deliveries)[number] | null>(
    (latest, delivery) => (
      !latest || Date.parse(delivery.retrievedAt) > Date.parse(latest.retrievedAt)
        ? delivery
        : latest
    ),
    null,
  );

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="真实数据"
        title="市场数据证据链"
        description="这里只展示已从 Provider 获取、私有归档、规范化并按可见时间封存的数据；不存在运行时演示回退。"
        actions={<StatusBadge label={statusLabel(data.status)} tone={statusTone(data.status)} />}
      />

      {data.status !== "READY" ? (
        <section className="panel">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">Fail closed</p>
              <h2>真实数据尚不可用</h2>
            </div>
          </div>
          <ul className="risk-list">
            {data.issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
          <div className="security-note">
            <strong>所需 Worker 配置</strong>
            <p className="mono">
              SUPABASE_URL · SUPABASE_SECRET_KEY · ALPACA_API_KEY_ID ·
              ALPACA_API_SECRET_KEY
            </p>
          </div>
          <div className="panel-footer">
            <span>Provider 凭证只进入 Worker，不进入浏览器、模型提示词或事件 payload。</span>
            <Link className="text-link" href="/data">重新读取状态</Link>
          </div>
        </section>
      ) : null}

      {data.source ? (
        <section className="metrics-grid" aria-label="真实数据源状态">
          <MetricCard
            label="Provider / Feed"
            value={`${data.source.provider.toUpperCase()} · ${data.source.feed.toUpperCase()}`}
            detail={`${data.source.timeframe} · adjustment=${data.source.adjustment}`}
          />
          <MetricCard
            label="贡献 Delivery"
            value={formatInteger(String(data.deliveries.length))}
            detail={
              mostRecentDelivery
                ? `最近 ${formatDateTime(mostRecentDelivery.retrievedAt)}`
                : "尚无封存快照来源"
            }
          />
          <MetricCard
            label="已封存标的"
            value={data.snapshot ? formatInteger(String(data.snapshot.symbols.length)) : "0"}
            detail={data.snapshot?.symbols.join(" · ") ?? "等待完整快照"}
          />
          <MetricCard
            label="快照截止时间"
            value={data.snapshot ? formatDateTime(data.snapshot.cutoffAt) : "尚未封存"}
            detail="只允许 available_at 不晚于 cutoff 的事实"
          />
        </section>
      ) : null}

      {data.bars.length > 0 ? (
        <section className="panel leaderboard-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">封存成员</p>
              <h2>
                {data.source?.adjustment === "raw" ? "未复权" : data.source?.adjustment}
                {" "}{data.source?.feed.toUpperCase()} 日线
              </h2>
            </div>
            <span>货币 USD</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">标的</th>
                  <th scope="col">交易日</th>
                  <th scope="col" className="numeric">开盘</th>
                  <th scope="col" className="numeric">最高</th>
                  <th scope="col" className="numeric">最低</th>
                  <th scope="col" className="numeric">收盘</th>
                  <th scope="col" className="numeric">成交量</th>
                  <th scope="col">Raw delivery</th>
                  <th scope="col">Fact hash</th>
                </tr>
              </thead>
              <tbody>
                {data.bars.map((bar) => (
                  <tr key={bar.factId}>
                    <td><strong>{bar.symbol}</strong></td>
                    <td className="tabular">{bar.barDate}</td>
                    <td className="numeric tabular">${bar.openPrice}</td>
                    <td className="numeric tabular">${bar.highPrice}</td>
                    <td className="numeric tabular">${bar.lowPrice}</td>
                    <td className="numeric tabular">${bar.closePrice}</td>
                    <td className="numeric tabular">{formatInteger(bar.volume)}</td>
                    <td className="mono">
                      {bar.deliveryIds.map(shortHash).join(" · ")}
                    </td>
                    <td className="mono">{shortHash(bar.factSha256)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {data.source ? (
        <section className="panel">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">可审计证据</p>
              <h2>版本、Raw 与 Snapshot</h2>
            </div>
          </div>
          <dl className="definition-list usage-definition-list">
            <div>
              <dt>Source version</dt>
              <dd className="mono">{data.source.versionKey}</dd>
            </div>
            <div>
              <dt>Normalizer</dt>
              <dd className="mono">{data.source.normalizerVersion}</dd>
            </div>
            <div>
              <dt>License scope</dt>
              <dd>{data.source.licenseScope}</dd>
            </div>
            {data.deliveries.map((delivery, index) => (
              <div key={delivery.deliveryId}>
                <dt>贡献 Delivery / Raw #{index + 1}</dt>
                <dd>
                  <span className="mono">{delivery.deliveryId}</span>
                  <br />
                  <span className="mono">artifact {delivery.rawArtifactId}</span>
                  <br />
                  <span className="mono">SHA-256 {delivery.responseSha256}</span>
                  <br />
                  <span className="mono">
                    manifest {delivery.normalizedManifestSha256}
                  </span>
                  <br />
                  <span className="mono">
                    {delivery.storageBucket}/{delivery.objectPath}
                  </span>
                  <br />
                  <span>
                    获取于 {formatDateTime(delivery.retrievedAt)}
                    {` · 可用于 ${formatDateTime(delivery.availableAt)}`}
                    {delivery.providerRequestId
                      ? ` · request ${delivery.providerRequestId}`
                      : " · Provider 未返回 request ID"}
                  </span>
                  <br />
                  <span className="mono">
                    {delivery.contentType} · {formatInteger(delivery.byteSize)} bytes
                  </span>
                </dd>
              </div>
            ))}
            <div>
              <dt>Snapshot ID</dt>
              <dd className="mono">{data.snapshot?.snapshotId ?? "尚未封存"}</dd>
            </div>
            <div>
              <dt>Snapshot manifest</dt>
              <dd className="mono">{data.snapshot?.manifestSha256 ?? "尚未封存"}</dd>
            </div>
            <div>
              <dt>Manifest schema</dt>
              <dd className="mono">{data.snapshot?.manifestSchema ?? "尚未封存"}</dd>
            </div>
            <div>
              <dt>Target session</dt>
              <dd className="mono">{data.snapshot?.targetSessionDate ?? "尚未封存"}</dd>
            </div>
            <div>
              <dt>Selection policy</dt>
              <dd className="mono">{data.snapshot?.selectionPolicy ?? "尚未封存"}</dd>
            </div>
          </dl>
          <ConnectionNote connection={data.connection} />
        </section>
      ) : (
        <ConnectionNote connection={data.connection} />
      )}
    </div>
  );
}
