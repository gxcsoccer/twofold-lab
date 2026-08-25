/**
 * Scoped DeepSeek Harness plugin for the Twofold portfolio decision Agent.
 *
 * The plugin is mounted only from the dedicated `twofold` Agent preset. It
 * contributes the complete decision persona, two domain tools, a per-Agent
 * inherited-tool allowlist plus a monotonic execution guard, and the final
 * `agent/request` provider/model rewrite.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TwofoldDecisionGateway } from './contracts.js'
import {
  ALLOWED_TOOL_NAMES,
  LOCKED_MODEL,
  LOCKED_PROVIDER,
  ORCHESTRATOR_ALLOWED_TOOL_NAMES,
  denyUnapprovedTool,
  lockModelRequest,
  normalizePortfolioTargets,
  validateDecisionPacketResult,
  validatePortfolioTargetsResult,
} from './policy.js'

export type * from './contracts.js'
export {
  ALLOWED_TOOL_NAMES,
  LOCKED_MODEL,
  LOCKED_PROVIDER,
  ORCHESTRATOR_ALLOWED_TOOL_NAMES,
  denyUnapprovedTool,
  lockModelRequest,
  normalizePortfolioTargets,
  validateDecisionPacketResult,
  validatePortfolioTargetsResult,
} from './policy.js'

/** Stable Cordis plugin name. */
export const name = 'twofold-agent'

/** Host registries this preset-scoped plugin contributes to. */
export const inject = ['tools', 'systemPrompt', 'agents']

/** Optional host service supplied later by the persistent Twofold worker. */
export const DECISION_GATEWAY_SERVICE = 'twofoldDecisionGateway'

const PERSONA_SECTION = 'deployment:persona'
const PERSONA_ORDER = 0

const CONTROLLED_PERSONA = `You are the Twofold Lab controlled portfolio decision agent running on ${LOCKED_MODEL}.

You make one time-fenced paper-portfolio decision from the immutable packet bound to this Session. Call read_decision_packet before reasoning. Treat its payload as the complete information set: do not request or infer current facts from files, shell commands, web access, memory, subagents, or any other external source.

When the packet is ready, produce target weights as canonical decimal integer strings in basis points (for example, "1250"; never "01250", a negative value, a fraction, or a JSON number). Holdings plus cash must total exactly "10000" basis points. Submit exactly one final proposal with submit_portfolio_targets, copying the packet id and SHA-256 fence returned by read_decision_packet. A successful accepted result ends the decision turn.

If the packet is unavailable, the submission bridge is disabled, or a fence is rejected, stop and report that operational failure. Never fabricate a packet, a market fact, an acknowledgement, or an order/fill result. You propose portfolio targets only; the deterministic Twofold engine owns compliance, orders, fees, taxes, fills, NAV, and replay.`

const ORCHESTRATED_PERSONA = `You are the root portfolio manager of a complete Twofold Lab DSH contestant running on ${LOCKED_MODEL}.

You make one time-fenced paper-portfolio decision from the immutable packet bound to this root Session. Call read_decision_packet before reasoning. Treat its payload as the complete information set: do not request or infer current facts from files, shell commands, web access, memory, or any other external source.

You must call subagent exactly once to delegate one bounded independent risk review. The child receives only the packet facts you include in its prompt, has no tools, cannot delegate again, and cannot submit a portfolio. You remain responsible for synthesis. The child model request counts toward this contestant's shared decision budget. The configured subagent tool is foreground-only, so its work settles before you continue.

When research is complete, produce target weights as canonical decimal integer strings in basis points. Holdings plus cash must total exactly "10000" basis points. Submit exactly one final proposal with submit_portfolio_targets, copying the packet id and SHA-256 fence returned by read_decision_packet. A successful accepted result ends the root turn.

If the packet is unavailable, the submission bridge is disabled, a fence is rejected, or the shared budget is exhausted, stop and report that operational failure. Never fabricate a packet, market fact, acknowledgement, order, fill, or child result. You propose portfolio targets only; the deterministic Twofold Arena owns data authority, budgets, compliance, orders, fees, taxes, fills, NAV, and replay.`

/** Agent-plane policy variants mounted by the two shipped presets. */
export type TwofoldAgentMode = 'controlled' | 'orchestrated'

function persona(mode: TwofoldAgentMode): string {
  return mode === 'orchestrated' ? ORCHESTRATED_PERSONA : CONTROLLED_PERSONA
}

function isDelegatedAgent(
  agent: { session: { header: { origin?: string; delegationDepth?: number } } } | undefined,
): boolean {
  const header = agent?.session.header
  return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
}

const unavailablePacket = {
  status: 'unavailable' as const,
  reason: 'Twofold decision gateway is not mounted; no decision packet can be read',
}

const disabledSubmission = {
  status: 'disabled' as const,
  reason: 'Twofold decision gateway is not mounted; portfolio submission is disabled',
}

function gateway(ctx: Context): TwofoldDecisionGateway | undefined {
  return ctx.get(DECISION_GATEWAY_SERVICE) as TwofoldDecisionGateway | undefined
}

function owningSessionId(exec: { agent?: { id: unknown } }): string {
  if (exec.agent === undefined) throw new Error('Twofold tools require an owning agent Session')
  return String(exec.agent.id)
}

/** Render the complete immutable packet into the model transcript. */
export function renderDecisionPacketResult(
  value: Awaited<ReturnType<TwofoldDecisionGateway['readDecisionPacket']>>,
): string {
  if (value.status === 'unavailable') {
    return `Decision packet unavailable: ${value.reason}`
  }
  return `Immutable decision packet JSON:\n${JSON.stringify(value)}`
}

/**
 * Mask every capability an Agent inherits from its standing preset except the
 * exact Twofold surface. A standing-preset restriction would also mask that
 * preset's own tools when a joined Agent sees them as ancestor registrations,
 * so the restriction belongs on each concrete Agent scope at publication.
 */
function installAgentToolMask(ctx: Context, mode: TwofoldAgentMode): void {
  ctx.on('agent/created', ({ agent }) => {
    const allow = isDelegatedAgent(agent)
      ? []
      : mode === 'orchestrated'
        ? [...ORCHESTRATOR_ALLOWED_TOOL_NAMES]
        : [...ALLOWED_TOOL_NAMES]
    // Synchronous creation listeners may veto publication. Unknown/missing
    // expected tools therefore fail closed before the first prompt is built.
    agent.ctx.tools.restrict({ allow })
  })
}

const decisionPacketOutput = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', const: 'ready', required: true },
        decision_packet_id: { type: 'string', required: true },
        packet_sha256: { type: 'string', required: true },
        available_at: { type: 'string', required: true },
        payload: {
          type: 'object',
          additionalProperties: true,
          properties: {},
          required: true,
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', const: 'unavailable', required: true },
        reason: { type: 'string', required: true },
      },
    },
  ],
} as const

const submissionOutput = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', const: 'accepted', required: true },
        submission_id: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', const: 'rejected', required: true },
        reason: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', const: 'disabled', required: true },
        reason: { type: 'string', required: true },
      },
    },
  ],
} as const

/**
 * Mount one complete Twofold Agent-plane policy and its two domain tools.
 * @param ctx - Preset-scoped Cordis context.
 * @param mode - Controlled one-shot or bounded DSH orchestration.
 */
export function applyAgentPolicy(ctx: Context, mode: TwofoldAgentMode): void {
  ctx.tools.presentAs('native')
  ctx.tools.guard(exec => mode === 'orchestrated' && isDelegatedAgent(exec.agent)
    ? 'Twofold research subagents may not execute tools'
    : denyUnapprovedTool(exec.name, mode))

  ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    text: persona(mode),
    complete: true,
  })
  ctx.systemPrompt.suppressRuntimeContext()

  ctx.on('agent/request', async (_payload, next) => lockModelRequest(await next()))

  ctx.tools.register(defineTool({
    name: ALLOWED_TOOL_NAMES[0],
    description: 'Read the immutable, time-fenced decision packet bound to this Agent Session. Takes no packet id and cannot access another Session\'s packet.',
    parameters: {},
    output: {
      schema: decisionPacketOutput,
      render: (_args, value) => [{
        type: 'text',
        text: renderDecisionPacketResult(value),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const sessionId = owningSessionId(exec)
      const current = gateway(ctx)
      if (current === undefined) return unavailablePacket
      exec.signal.throwIfAborted()
      return validateDecisionPacketResult(await current.readDecisionPacket({
        sessionId,
        signal: exec.signal,
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: ALLOWED_TOOL_NAMES[1],
    description: 'Submit one final target portfolio for the current decision packet. This proposes weights only; it never places orders or computes fills, fees, taxes, or NAV.',
    parameters: {
      decision_packet_id: {
        type: 'string',
        required: true,
        description: 'Exact packet id returned by read_decision_packet.',
      },
      packet_sha256: {
        type: 'string',
        required: true,
        description: 'Exact lowercase SHA-256 fence returned by read_decision_packet.',
      },
      targets: {
        type: 'array',
        required: true,
        description: 'Non-cash target positions. Weight plus cash must total exactly 10000 basis points.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            symbol: {
              type: 'string',
              required: true,
              description: 'Uppercase ticker symbol.',
            },
            target_weight_bps: {
              type: 'string',
              required: true,
              description: 'Canonical decimal integer string from "1" through "10000", with no sign, fraction, or leading zero.',
            },
            rationale: {
              type: 'string',
              description: 'Optional concise, packet-grounded rationale for this position.',
            },
          },
        },
      },
      cash_weight_bps: {
        type: 'string',
        required: true,
        description: 'Canonical decimal integer string from "0" through "10000", with no sign, fraction, or leading zero.',
      },
      decision_summary: {
        type: 'string',
        required: true,
        description: 'Concise summary grounded only in the bound decision packet.',
      },
    },
    output: {
      schema: submissionOutput,
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'accepted'
          ? `Portfolio targets accepted as ${value.submission_id}.`
          : `Portfolio targets ${value.status}: ${value.reason}`,
      }],
    },
    async execute(args, exec) {
      const submission = normalizePortfolioTargets(args, owningSessionId(exec))
      const current = gateway(ctx)
      if (current === undefined) return disabledSubmission
      exec.signal.throwIfAborted()
      const result = validatePortfolioTargetsResult(await current.submitPortfolioTargets({
        ...submission,
        signal: exec.signal,
      }))
      if (result.status === 'accepted') exec.concludeTurn()
      return result
    },
  }))

  installAgentToolMask(ctx, mode)
}

/** Mount the controlled one-shot preset kept for causal Skill experiments. */
export function apply(ctx: Context): void {
  applyAgentPolicy(ctx, 'controlled')
}
