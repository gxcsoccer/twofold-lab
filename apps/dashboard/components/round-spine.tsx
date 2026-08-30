import { deriveRoundSpine } from "@/lib/data/round-spine";
import type { SpineNodeState } from "@/lib/data/round-spine";
import { formatClock, formatDateTime } from "@/lib/format";
import { loadSeasonOverview } from "@/lib/repositories";

function nodeClass(state: SpineNodeState): string {
  if (state === "sealed") return "spine-node";
  if (state === "current") return "spine-node spine-node-current";
  if (state === "breached") return "spine-node spine-node-breached";
  return "spine-node spine-node-upcoming";
}

/**
 * 状态脊 — the always-visible round tape.
 *
 * Round timing is cross-page state: settings only affect the *next* season, so
 * seeing which fence is next prevents editing the wrong thing. When there is no
 * frozen round it says so instead of drawing a plausible tape.
 */
export async function RoundSpine() {
  let data: Awaited<ReturnType<typeof loadSeasonOverview>> | null = null;
  try {
    data = await loadSeasonOverview();
  } catch {
    // Rendered outside a request scope (Next's built-in error page), so the
    // projection cannot be read. Say so; never draw a plausible tape.
    data = null;
  }
  const spine = data === null ? null : deriveRoundSpine(data.overview);

  if (spine === null) {
    return (
      <div className="spine" aria-label="当前轮次状态">
        <span className="spine-round">Round —</span>
        <p className="spine-note">
          {data === null
            ? "轮次时点当前不可判定。"
            : data.overview === null
              ? "尚无可读的赛季投影，轮次时点不可判定。"
              : "当前赛季还没有冻结的 Round。"}
        </p>
      </div>
    );
  }

  return (
    <div className="spine" aria-label="当前轮次状态">
      <span className="spine-round">
        Round {spine.roundIndex.padStart(2, "0")}
      </span>
      <div className="spine-tape">
        {spine.nodes.map((node, index) => (
          <span className="spine-node-group" key={node.id}>
            {index > 0 ? <span className="spine-dash" /> : null}
            <span className={nodeClass(node.state)}>
              <i />
              {node.label}
            </span>
          </span>
        ))}
      </div>
      <span className="spine-now">NOW {formatClock(spine.asOf)}</span>
      {spine.boundaryLabel && spine.boundaryAt ? (
        <span className="spine-next">
          下一时点 {spine.boundaryLabel}{" "}
          <strong>{formatDateTime(spine.boundaryAt)}</strong>
        </span>
      ) : (
        <span className="spine-next">本轮已无待等待时点</span>
      )}
    </div>
  );
}
