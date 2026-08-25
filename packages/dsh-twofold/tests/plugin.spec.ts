import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import {
  ALLOWED_TOOL_NAMES,
  DECISION_GATEWAY_SERVICE,
  LOCKED_MODEL,
  LOCKED_PROVIDER,
  ORCHESTRATOR_ALLOWED_TOOL_NAMES,
  apply,
  renderDecisionPacketResult,
} from '../src/index.js'
import { apply as applyOrchestrator } from '../src/orchestrator.js'

interface GuardExecution {
  name: string
  agent?: { session: { header: { origin?: string; delegationDepth?: number } } }
}

interface HarnessDouble {
  ctx: Context
  definitions: Map<string, ToolDefinition>
  requestHook: (payload: unknown, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>
  guard: (exec: GuardExecution) => string | undefined
  announceAgent: (header?: { origin?: string; delegationDepth?: number }) => void
  presentAs: ReturnType<typeof vi.fn>
  restrict: ReturnType<typeof vi.fn>
  section: ReturnType<typeof vi.fn>
  suppressRuntimeContext: ReturnType<typeof vi.fn>
}

function harnessDouble(
  gateway?: unknown,
  mount: (ctx: Context) => void = apply,
): HarnessDouble {
  const definitions = new Map<string, ToolDefinition>()
  let requestHook: HarnessDouble['requestHook'] | undefined
  let guard: HarnessDouble['guard'] | undefined
  let agentCreated: ((payload: {
    agent: GuardExecution['agent'] & { ctx: Context }
  }) => void) | undefined
  const presentAs = vi.fn()
  const restrict = vi.fn()
  const section = vi.fn()
  const suppressRuntimeContext = vi.fn()
  const ctx = {
    tools: {
      presentAs,
      restrict,
      guard: (candidate: HarnessDouble['guard']) => { guard = candidate },
      register: (definition: ToolDefinition) => { definitions.set(definition.name, definition) },
    },
    systemPrompt: { section, suppressRuntimeContext },
    on: (event: string, listener: unknown) => {
      if (event === 'agent/request') requestHook = listener as HarnessDouble['requestHook']
      if (event === 'agent/created') agentCreated = listener as typeof agentCreated
    },
    get: (service: string) => service === DECISION_GATEWAY_SERVICE ? gateway : undefined,
  } as unknown as Context
  mount(ctx)
  if (requestHook === undefined || guard === undefined || agentCreated === undefined) {
    throw new Error('plugin did not install its policy')
  }
  return {
    ctx,
    definitions,
    requestHook,
    guard,
    announceAgent: (header = {}) => {
      agentCreated?.({
        agent: {
          session: { header },
          ctx: { tools: { restrict } } as unknown as Context,
        },
      })
    },
    presentAs,
    restrict,
    section,
    suppressRuntimeContext,
  }
}

function execution(sessionId = 'session-1') {
  return {
    agent: { id: sessionId },
    signal: new AbortController().signal,
    concludeTurn: vi.fn(),
  }
}

describe('assembled Twofold preset plugin', () => {
  it('renders the complete packet payload into the model transcript', () => {
    const rendered = renderDecisionPacketResult({
      status: 'ready',
      decision_packet_id: 'packet-1',
      packet_sha256: 'a'.repeat(64),
      available_at: '2026-08-23T00:00:00Z',
      payload: {
        market_snapshot: {
          symbols: ['LULU', 'QQQ', 'SPY'],
          bars: [{ symbol: 'LULU', close_price: '195.3' }],
        },
      },
    })

    expect(rendered).toContain('"decision_packet_id":"packet-1"')
    expect(rendered).toContain('"symbols":["LULU","QQQ","SPY"]')
    expect(rendered).toContain('"close_price":"195.3"')
  })

  it('defers the exact inherited allowlist to Agent publication after registering both domain tools', () => {
    const plugin = harnessDouble()
    expect(plugin.presentAs).toHaveBeenCalledWith('native')
    expect(plugin.restrict).not.toHaveBeenCalled()
    plugin.announceAgent()
    expect(plugin.restrict).toHaveBeenCalledWith({ allow: [...ALLOWED_TOOL_NAMES] })
    expect(plugin.section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deployment:persona',
      complete: true,
    }))
    expect(plugin.suppressRuntimeContext).toHaveBeenCalledOnce()
    expect([...plugin.definitions.keys()]).toEqual(ALLOWED_TOOL_NAMES)
    expect(plugin.guard({ name: 'bash' })).toMatch(/may execute only/)
  })

  it('rewrites the request after downstream listeners return', async () => {
    const plugin = harnessDouble()
    await expect(plugin.requestHook({}, async () => ({
      provider: 'other',
      model: 'other',
      maxTokens: 1234,
    }))).resolves.toEqual({
      provider: LOCKED_PROVIDER,
      model: LOCKED_MODEL,
      maxTokens: 1234,
    })
  })

  it('mounts bounded orchestration while denying every child tool execution', () => {
    const plugin = harnessDouble(undefined, applyOrchestrator)
    const root = { session: { header: {} } }
    const child = { session: { header: { origin: 'subagent', delegationDepth: 1 } } }

    expect(plugin.restrict).not.toHaveBeenCalled()
    plugin.announceAgent()
    plugin.announceAgent({ origin: 'subagent', delegationDepth: 1 })
    expect(plugin.restrict).toHaveBeenNthCalledWith(1, {
      allow: [...ORCHESTRATOR_ALLOWED_TOOL_NAMES],
    })
    expect(plugin.restrict).toHaveBeenNthCalledWith(2, { allow: [] })
    expect([...plugin.definitions.keys()]).toEqual(ALLOWED_TOOL_NAMES)
    expect(plugin.guard({ name: 'subagent', agent: root })).toBeUndefined()
    expect(plugin.guard({ name: 'read_decision_packet', agent: root })).toBeUndefined()
    expect(plugin.guard({ name: 'web_search', agent: root })).toMatch(/may execute only/)
    expect(plugin.guard({ name: 'read_decision_packet', agent: child })).toMatch(/may not execute tools/)
    expect(plugin.guard({ name: 'submit_portfolio_targets', agent: child })).toMatch(/may not execute tools/)
    expect(plugin.guard({ name: 'subagent', agent: child })).toMatch(/may not execute tools/)
    expect(plugin.section).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('root portfolio manager'),
      complete: true,
    }))
  })

  it('fails closed without a worker bridge and never needs an API key', async () => {
    const plugin = harnessDouble()
    const read = plugin.definitions.get('read_decision_packet')
    const submit = plugin.definitions.get('submit_portfolio_targets')
    if (read === undefined || submit === undefined) throw new Error('missing Twofold tools')

    await expect(read.execute({}, execution() as never)).resolves.toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('not mounted'),
    })
    await expect(submit.execute({
      decision_packet_id: 'packet-1',
      packet_sha256: 'a'.repeat(64),
      targets: [{ symbol: 'LULU', target_weight_bps: '9000' }],
      cash_weight_bps: '1000',
      decision_summary: 'packet-grounded decision',
    }, execution() as never)).resolves.toEqual({
      status: 'disabled',
      reason: expect.stringContaining('not mounted'),
    })
  })

  it('keeps every portfolio weight as a string at the model and gateway boundary', async () => {
    const plugin = harnessDouble()
    const submit = plugin.definitions.get('submit_portfolio_targets')
    if (submit === undefined) throw new Error('missing submit tool')
    const parameters = submit.parameters as {
      properties: {
        targets: { items: { properties: { target_weight_bps: { type: string } } } }
        cash_weight_bps: { type: string }
      }
    }
    expect(parameters.properties.targets.items.properties.target_weight_bps.type).toBe('string')
    expect(parameters.properties.cash_weight_bps.type).toBe('string')
    await expect(submit.execute({
      decision_packet_id: 'packet-1',
      packet_sha256: 'a'.repeat(64),
      targets: [{ symbol: 'LULU', target_weight_bps: 9000 }],
      cash_weight_bps: 1000,
      decision_summary: 'numbers are forbidden',
    }, execution() as never)).rejects.toThrow()
  })

  it('binds gateway calls to the owning Session and concludes only an accepted submission', async () => {
    const gateway = {
      readDecisionPacket: vi.fn().mockResolvedValue({
        status: 'ready',
        decision_packet_id: 'packet-1',
        packet_sha256: 'a'.repeat(64),
        available_at: '2026-08-23T00:00:00Z',
        payload: { positions: [] },
      }),
      submitPortfolioTargets: vi.fn().mockResolvedValue({
        status: 'accepted',
        submission_id: 'submission-1',
      }),
    }
    const plugin = harnessDouble(gateway)
    const read = plugin.definitions.get('read_decision_packet')
    const submit = plugin.definitions.get('submit_portfolio_targets')
    if (read === undefined || submit === undefined) throw new Error('missing Twofold tools')
    const exec = execution('session-bound')

    await read.execute({}, exec as never)
    expect(gateway.readDecisionPacket).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-bound',
    }))

    await submit.execute({
      decision_packet_id: 'packet-1',
      packet_sha256: 'a'.repeat(64),
      targets: [{ symbol: 'LULU', target_weight_bps: '9000' }],
      cash_weight_bps: '1000',
      decision_summary: 'packet-grounded decision',
    }, exec as never)
    expect(gateway.submitPortfolioTargets).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'session-bound',
      decision_packet_id: 'packet-1',
    }))
    expect(exec.concludeTurn).toHaveBeenCalledOnce()
  })
})
