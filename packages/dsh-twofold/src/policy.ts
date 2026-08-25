import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {
  DecisionPacketResult,
  PortfolioTarget,
  PortfolioTargetsResult,
  PortfolioTargetsSubmission,
} from './contracts.js'

/** The only provider route the Twofold decision agent may call. */
export const LOCKED_PROVIDER = 'deepseek-official'

/** The only model id the Twofold decision agent may call. */
export const LOCKED_MODEL = 'deepseek-v4-pro'

/** Domain tools available to every Twofold decision Agent. */
export const ALLOWED_TOOL_NAMES = Object.freeze([
  'read_decision_packet',
  'submit_portfolio_targets',
] as const)

/** Additional inherited Harness capability available to the orchestrated preset. */
export const ORCHESTRATOR_ALLOWED_TOOL_NAMES = Object.freeze([
  ...ALLOWED_TOOL_NAMES,
  'subagent',
] as const)

const CONTROLLED_TOOL_SET: ReadonlySet<string> = new Set(ALLOWED_TOOL_NAMES)
const ORCHESTRATOR_TOOL_SET: ReadonlySet<string> = new Set(ORCHESTRATOR_ALLOWED_TOOL_NAMES)
const SYMBOL = /^[A-Z][A-Z0-9.-]*$/
const SHA256 = /^[0-9a-f]{64}$/
const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/
const FULL_WEIGHT_BPS = 10_000n

/**
 * Apply the final provider/model lock after every downstream request listener.
 * @param request - Request configuration proposed by the Agent waterfall.
 * @returns A detached request retaining non-routing options and forcing the locked route.
 */
export function lockModelRequest(request: LlmCallConfig): LlmCallConfig {
  return {
    ...request,
    provider: LOCKED_PROVIDER,
    model: LOCKED_MODEL,
  }
}

/**
 * Final monotonic tool guard for the decision Agent.
 * @param toolName - Name reaching the Harness executor.
 * @param mode - Preset policy that owns the execution.
 * @returns A denial for every non-Twofold capability, otherwise `undefined`.
 */
export function denyUnapprovedTool(
  toolName: string,
  mode: 'controlled' | 'orchestrated' = 'controlled',
): string | undefined {
  const allowed = mode === 'orchestrated' ? ORCHESTRATOR_TOOL_SET : CONTROLLED_TOOL_SET
  if (allowed.has(toolName)) return undefined
  const names = mode === 'orchestrated' ? ORCHESTRATOR_ALLOWED_TOOL_NAMES : ALLOWED_TOOL_NAMES
  return `Twofold ${mode} decision agents may execute only ${names.join(', ')}`
}

/** Raw arguments inferred from the submit tool's model-facing schema. */
export interface SubmitPortfolioTargetsArgs {
  decision_packet_id: string
  packet_sha256: string
  targets: Array<{
    symbol: string
    target_weight_bps: string
    rationale?: string
  }>
  cash_weight_bps: string
  decision_summary: string
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`${field} must be a non-empty string`)
  return normalized
}

function basisPoints(value: string, field: string, allowZero: boolean): bigint {
  if (!CANONICAL_UNSIGNED_INTEGER.test(value)) {
    throw new Error(`${field} must be a canonical non-negative decimal integer string`)
  }
  const parsed = BigInt(value)
  if ((!allowZero && parsed === 0n) || parsed > FULL_WEIGHT_BPS) {
    throw new Error(`${field} must be ${allowZero ? 'from 0' : 'from 1'} through 10000 basis points`)
  }
  return parsed
}

/**
 * Validate and normalize model-supplied target weights before the worker boundary.
 * @param args - Schema-validated tool arguments.
 * @param sessionId - Session that owns the immutable decision packet binding.
 * @returns A canonical submission whose security and weight invariants are satisfied.
 */
export function normalizePortfolioTargets(
  args: SubmitPortfolioTargetsArgs,
  sessionId: string,
): PortfolioTargetsSubmission {
  const decisionPacketId = nonEmpty(args.decision_packet_id, 'decision_packet_id')
  if (!SHA256.test(args.packet_sha256)) {
    throw new Error('packet_sha256 must be exactly 64 lowercase hexadecimal characters')
  }
  const cash = basisPoints(args.cash_weight_bps, 'cash_weight_bps', true)

  const seen = new Set<string>()
  let invested = 0n
  const targets: PortfolioTarget[] = args.targets.map((target, index) => {
    if (!SYMBOL.test(target.symbol)) {
      throw new Error(`targets[${index}].symbol must be an uppercase ticker symbol`)
    }
    if (seen.has(target.symbol)) {
      throw new Error(`targets contains duplicate symbol ${JSON.stringify(target.symbol)}`)
    }
    seen.add(target.symbol)
    invested += basisPoints(target.target_weight_bps, `targets[${index}].target_weight_bps`, false)
    const rationale = target.rationale?.trim()
    return {
      symbol: target.symbol,
      target_weight_bps: target.target_weight_bps,
      ...(rationale === undefined || rationale.length === 0 ? {} : { rationale }),
    }
  })

  const total = invested + cash
  if (total !== FULL_WEIGHT_BPS) {
    throw new Error(`target weights plus cash_weight_bps must total exactly 10000 (got ${total.toString()})`)
  }

  return {
    session_id: nonEmpty(sessionId, 'session_id'),
    decision_packet_id: decisionPacketId,
    packet_sha256: args.packet_sha256,
    targets,
    cash_weight_bps: args.cash_weight_bps,
    decision_summary: nonEmpty(args.decision_summary, 'decision_summary'),
  }
}

/**
 * Validate the worker's packet response before exposing it to the model.
 * @param result - Untrusted bridge result.
 * @returns The same result after discriminant and fence validation.
 */
export function validateDecisionPacketResult(result: DecisionPacketResult): DecisionPacketResult {
  if (result.status === 'unavailable') {
    nonEmpty(result.reason, 'reason')
    return result
  }
  nonEmpty(result.decision_packet_id, 'decision_packet_id')
  nonEmpty(result.available_at, 'available_at')
  if (!SHA256.test(result.packet_sha256)) {
    throw new Error('decision gateway returned an invalid packet_sha256')
  }
  return result
}

/**
 * Validate the worker's submit acknowledgement before exposing it to the model.
 * @param result - Untrusted bridge result.
 * @returns The same result after discriminant-specific validation.
 */
export function validatePortfolioTargetsResult(result: PortfolioTargetsResult): PortfolioTargetsResult {
  if (result.status === 'accepted') {
    nonEmpty(result.submission_id, 'submission_id')
    return result
  }
  nonEmpty(result.reason, 'reason')
  return result
}
