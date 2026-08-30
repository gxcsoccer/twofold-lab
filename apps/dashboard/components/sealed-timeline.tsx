import type { CSSProperties } from "react";

import type { SealedTimeline } from "@/lib/data/sealed-timeline";

/** Inline geometry: --a start %, --b span %, --p point %. Keeping it in custom
 *  properties leaves the stylesheet free of layout arithmetic. */
type Geometry = CSSProperties & Record<"--a" | "--b" | "--p", string>;

function span(startPct: number, spanPct: number): Geometry {
  return { "--a": `${startPct}%`, "--b": `${spanPct}%`, "--p": "0%" } as Geometry;
}

function point(atPct: number): Geometry {
  return { "--a": "0%", "--b": "0%", "--p": `${atPct}%` } as Geometry;
}

/**
 * 封存时序尺 — the sealing ruler.
 *
 * Horizontal distance is time. Every frozen deadline is a dotted fence tick,
 * non-market hours are compressed and hatched, and each entrant gets its own
 * lane so one entrant breaching while the other continues is visible at a
 * glance. Below 920px the plot is hidden by CSS and the phase list carries the
 * same facts — see DIRECTION.md §3.4.
 */
export function SealedTimelinePlot({ timeline }: { timeline: SealedTimeline }) {
  return (
    <>
      <div className="ruler-plot">
        <div className="ruler-scale" aria-hidden="true">
          {timeline.bands.map((band) => (
            <span
              key={band.key}
              className={band.compressed ? "ruler-band ruler-band-gutter" : "ruler-band"}
              style={span(band.startPct, band.spanPct)}
            >
              {band.label}
            </span>
          ))}
        </div>

        <div className="ruler-lanes">
          {timeline.lanes.map((lane) => (
            <div className="ruler-lane" key={lane.entrantId}>
              <p className="ruler-lane-name">
                {lane.entrantCode}
                <span>{lane.executionLabel}</span>
              </p>
              <div className="ruler-track">
                {lane.fences.map((fence) => (
                  <i
                    key={fence.key}
                    className={fence.breached ? "ruler-fence ruler-fence-breached" : "ruler-fence"}
                    style={point(fence.atPct)}
                  />
                ))}
                {lane.segments.map((segment, index) => (
                  <span
                    key={segment.phase}
                    className={`ruler-seg ruler-seg-${segment.breached ? "failed" : segment.status.toLowerCase()}`}
                    style={{
                      ...span(segment.startPct, segment.spanPct),
                      animationDelay: `${index * 45}ms`,
                    }}
                    title={segment.title}
                  >
                    {segment.spanPct >= 12 ? segment.label : null}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        {timeline.nowPct === null ? null : (
          <div className="ruler-overlay" aria-hidden="true">
            <span
              className={timeline.nowIsLate ? "ruler-now ruler-now-late" : "ruler-now"}
              style={point(timeline.nowPct)}
            >
              <span>{timeline.nowLabel}</span>
            </span>
          </div>
        )}
      </div>

      <div className="ruler-legend">
        <span><i className="swatch-succeeded" />已封存</span>
        <span><i className="swatch-claimed" />执行中</span>
        <span><i className="swatch-requested" />等待时点</span>
        <span><i className="swatch-failed" />已越界 / 已取消</span>
        <span><i className="swatch-gutter" />非交易时段（已压缩）</span>
        <span><i className="swatch-fence" />冻结截止线</span>
      </div>

      <div className="ruler-fallback">
        <span>时序尺需要横向空间；本轮各阶段的排程、截止与状态见下方执行链。</span>
        <a className="text-link" href="#phase-list">查看执行链 ↓</a>
      </div>
    </>
  );
}
