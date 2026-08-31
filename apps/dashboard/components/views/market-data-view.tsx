import { Fragment } from "react";
import Link from "next/link";

import {
  ConnectionNote,
  Note,
  PageHeader,
  ReadoutCell,
  SectionHeading,
  StatusBadge,
  Unsealed,
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
        eyebrow="Real data · evidence chain"
        title="市场数据证据链"
        subtitle={
          data.source
            ? `${data.source.provider} · ${data.source.feed} · ${data.source.timeframe} · adjustment=${data.source.adjustment}`
            : undefined
        }
        description="这里只列出已从 Provider 取回、私有归档、规范化，并按可见时间封存的数据；不存在运行时演示回退。"
        actions={<StatusBadge label={statusLabel(data.status)} tone={statusTone(data.status)} />}
      />

      {data.status !== "READY" ? (
        <section className="panel">
          <SectionHeading eyebrow="Fail closed" title="真实数据尚不可用" compact />
          <ul className="risk-list">
            {data.issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
          <Note title="所需 Worker 配置" tone="informative">
            <p className="mono">
              SUPABASE_URL · SUPABASE_SECRET_KEY · ALPACA_API_KEY_ID ·
              ALPACA_API_SECRET_KEY
            </p>
          </Note>
          <div className="panel-footer">
            <span>Provider 凭证只进入 Worker，不进入浏览器、模型提示词或事件 payload。</span>
            <Link className="text-link" href="/data">重新读取状态 →</Link>
          </div>
        </section>
      ) : null}

      {data.source ? (
        <section className="panel panel-flush" aria-label="真实数据源状态">
          <div className="ruler-readout ruler-readout-last">
            <ReadoutCell
              label="Provider / feed"
              value={`${data.source.provider.toUpperCase()} · ${data.source.feed.toUpperCase()}`}
              detail={`${data.source.timeframe} · adjustment=${data.source.adjustment}`}
            />
            <ReadoutCell
              label="贡献 Delivery"
              value={formatInteger(String(data.deliveries.length))}
              detail={
                mostRecentDelivery
                  ? `最近取回 ${formatDateTime(mostRecentDelivery.retrievedAt)}`
                  : "尚无封存快照来源"
              }
            />
            <ReadoutCell
              label="已封存标的"
              value={data.snapshot ? formatInteger(String(data.snapshot.symbols.length)) : "0"}
              detail={
                data.snapshot
                  ? `目标交易日 ${data.snapshot.targetSessionDate}`
                  : "等待完整快照"
              }
            />
            <ReadoutCell
              label="快照截止时间"
              value={
                data.snapshot
                  ? formatDateTime(data.snapshot.cutoffAt)
                  : <Unsealed label="尚未封存" pending />
              }
              detail="只接受 available_at 不晚于截止的事实"
              text={data.snapshot === null}
            />
          </div>
        </section>
      ) : null}

      {data.bars.length > 0 ? (
        <section className="panel panel-flush">
          <SectionHeading
            eyebrow="Sealed members"
            title={
              `${data.source?.adjustment === "raw" ? "未复权" : data.source?.adjustment ?? ""} `
              + `${data.source?.feed.toUpperCase() ?? ""} 日线`
            }
            note={<span>货币 USD · 价格为规范化十进制字符串</span>}
          />
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
                    <td className="mono">{bar.barDate}</td>
                    <td className="numeric tabular">{bar.openPrice}</td>
                    <td className="numeric tabular">{bar.highPrice}</td>
                    <td className="numeric tabular">{bar.lowPrice}</td>
                    <td className="numeric tabular">{bar.closePrice}</td>
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
          {data.snapshot && data.bars.length < data.snapshot.symbols.length ? (
            <div className="panel-footer">
              <span>
                显示 {data.bars.length} / {data.snapshot.symbols.length} 条 ·
                完整成员清单由 snapshot manifest 决定
              </span>
            </div>
          ) : null}
        </section>
      ) : null}

      {data.source ? (
        <div className="two-column-grid">
          <div className="column-stack">
            <section className="panel panel-flush">
              <SectionHeading
                eyebrow="Raw archive"
                title="贡献 Delivery"
                note={
                  <p>
                    对快照有贡献的原始响应
                    <br />
                    逐字节归档，内容寻址
                  </p>
                }
              />
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Delivery / request ID</th>
                      <th scope="col">类型</th>
                      <th scope="col">归档路径</th>
                      <th scope="col" className="numeric">字节</th>
                      <th scope="col">取回 / 可用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.deliveries.map((delivery) => (
                      <Fragment key={delivery.deliveryId}>
                        <tr>
                          <td>
                            <div className="run-name">
                              <strong className="mono hash-value">{delivery.deliveryId}</strong>
                              {delivery.providerRequestId === null
                                ? (
                                    <Unsealed
                                      label="Provider 未返回"
                                      reason="REQUEST_ID_MISSING"
                                    />
                                  )
                                : <span>request {delivery.providerRequestId}</span>}
                            </div>
                          </td>
                          <td className="mono">{delivery.contentType}</td>
                          <td className="mono">
                            {delivery.storageBucket}/{delivery.objectPath}
                          </td>
                          <td className="numeric tabular">
                            {formatInteger(delivery.byteSize)}
                          </td>
                          <td className="mono">
                            {formatDateTime(delivery.retrievedAt)}
                            <br />
                            {formatDateTime(delivery.availableAt)}
                          </td>
                        </tr>
                        <tr className="delivery-evidence">
                          <td colSpan={5}>
                            <dl className="definition-list">
                              <div>
                                <dt>Raw artifact</dt>
                                <dd className="mono hash-value">{delivery.rawArtifactId}</dd>
                              </div>
                              <div>
                                <dt>响应 SHA-256</dt>
                                <dd className="mono hash-value">{delivery.responseSha256}</dd>
                              </div>
                              <div>
                                <dt>Normalized manifest SHA-256</dt>
                                <dd className="mono hash-value">{delivery.normalizedManifestSha256}</dd>
                              </div>
                              <div>
                                <dt>首次观测</dt>
                                <dd className="mono">{formatDateTime(delivery.firstObservedAt)}</dd>
                              </div>
                              <div>
                                <dt>首次归档</dt>
                                <dd className="mono">{formatDateTime(delivery.firstStoredAt)}</dd>
                              </div>
                            </dl>
                          </td>
                        </tr>
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="panel-footer">
                <span>
                  Provider request ID 由响应头带回；缺失的以未封存标记如实呈现，不推断补全。
                </span>
              </div>
            </section>
          </div>

          <div className="column-stack">
            <section className="panel">
              <SectionHeading
                eyebrow="Snapshot"
                title="封存凭据"
                note={
                  data.snapshot
                    ? <StatusBadge label="已封存" tone="positive" />
                    : <StatusBadge label="尚未封存" tone="warning" />
                }
                compact
              />
              <dl className="definition-list">
                <div>
                  <dt>Snapshot ID</dt>
                  <dd className="mono hash-value">
                    {data.snapshot?.snapshotId ?? <Unsealed label="尚未封存" pending />}
                  </dd>
                </div>
                <div>
                  <dt>Manifest SHA-256</dt>
                  <dd className="mono hash-value">
                    {data.snapshot
                      ? shortHash(data.snapshot.manifestSha256)
                      : <Unsealed label="尚未封存" pending />}
                  </dd>
                </div>
                <div>
                  <dt>Manifest schema</dt>
                  <dd className="mono">{data.snapshot?.manifestSchema ?? "—"}</dd>
                </div>
                <div>
                  <dt>Selection policy</dt>
                  <dd className="mono">{data.snapshot?.selectionPolicy ?? "—"}</dd>
                </div>
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
                <div>
                  <dt>封存时间</dt>
                  <dd className="mono">
                    {data.snapshot
                      ? formatDateTime(data.snapshot.sealedAt)
                      : <Unsealed label="尚未封存" pending />}
                  </dd>
                </div>
              </dl>
              <ConnectionNote connection={data.connection} />
            </section>
          </div>
        </div>
      ) : (
        <ConnectionNote connection={data.connection} />
      )}

      {data.source ? (
        <section className="panel">
          <SectionHeading
            eyebrow="Boundary"
            title="这条链上谁能碰什么"
            note={<span>凭证只往一个方向流动</span>}
            compact
          />
          <div className="principle-grid">
            <Note title="Worker 持有凭证" tone="informative">
              Alpaca 与 Supabase 密钥只存在于 Worker 的密钥层，不进入浏览器、模型提示词或事件 payload。
            </Note>
            <Note title="浏览器只收到状态" tone="warning">
              控制台读的是 Supabase 投影，不是 Provider。缺一页就整批不封存，也不补写。
            </Note>
            <Note title="快照只增不改" tone="critical">
              修订以新版本追加；旧快照永远可以被重新解释一遍，得到同一个账本。
            </Note>
          </div>
        </section>
      ) : null}
    </div>
  );
}
