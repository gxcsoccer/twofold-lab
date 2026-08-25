import type {} from '@deepseek-ai/cordis'

/** JSON values accepted by DeepSeek Harness tool results. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** One immutable packet bound to the current decision Session. */
export interface ReadyDecisionPacket {
  status: 'ready'
  decision_packet_id: string
  packet_sha256: string
  available_at: string
  payload: { [key: string]: JsonValue }
}

/** Fail-closed packet response used before the worker bridge is mounted. */
export interface UnavailableDecisionPacket {
  status: 'unavailable'
  reason: string
}

/** Result of reading the packet bound to the current decision Session. */
export type DecisionPacketResult = ReadyDecisionPacket | UnavailableDecisionPacket

/** One normalized target weight expressed in basis points. */
export interface PortfolioTarget {
  symbol: string
  /** Canonical non-zero decimal integer string; JavaScript numbers never cross the gateway. */
  target_weight_bps: string
  rationale?: string
}

/** Canonical submission passed from the model-facing tool to the worker bridge. */
export interface PortfolioTargetsSubmission {
  session_id: string
  decision_packet_id: string
  packet_sha256: string
  targets: PortfolioTarget[]
  /** Canonical decimal integer string from `0` through `10000`. */
  cash_weight_bps: string
  decision_summary: string
}

/** A submission durably accepted by the worker-side command boundary. */
export interface AcceptedPortfolioTargets {
  status: 'accepted'
  submission_id: string
}

/** A submission refused by domain validation or stale packet fencing. */
export interface RejectedPortfolioTargets {
  status: 'rejected'
  reason: string
}

/** Fail-closed result used until a real worker-side bridge is mounted. */
export interface DisabledPortfolioTargets {
  status: 'disabled'
  reason: string
}

/** Result of attempting to submit a target portfolio. */
export type PortfolioTargetsResult =
  | AcceptedPortfolioTargets
  | RejectedPortfolioTargets
  | DisabledPortfolioTargets

/**
 * Host-provided capability used by the two model-facing tools.
 *
 * The bridge derives packet authority from `sessionId`; the read tool cannot
 * name an arbitrary packet, and the submit path carries the packet id plus its
 * digest for stale-input fencing. Implementations live in the persistent
 * Twofold worker, not in this Harness adapter package.
 */
export interface TwofoldDecisionGateway {
  readDecisionPacket(input: {
    sessionId: string
    signal: AbortSignal
  }): Promise<DecisionPacketResult>

  submitPortfolioTargets(input: PortfolioTargetsSubmission & {
    signal: AbortSignal
  }): Promise<PortfolioTargetsResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional worker-owned service read through `ctx.get` by the preset tools. */
    twofoldDecisionGateway: TwofoldDecisionGateway
  }
}
