import { describe, expect, it } from 'vitest'
import {
  LOCKED_MODEL,
  LOCKED_PROVIDER,
  ORCHESTRATOR_ALLOWED_TOOL_NAMES,
  PortfolioSubmissionArgumentError,
  denyUnapprovedTool,
  lockModelRequest,
  normalizePortfolioTargets,
  validateDecisionPacketResult,
  validatePortfolioTargetsResult,
} from '../src/index.js'
import type { SubmitPortfolioTargetsArgs } from '../src/index.js'

describe('DeepSeek V4 Pro request lock', () => {
  it('overwrites provider and model while preserving other request settings', () => {
    expect(lockModelRequest({
      provider: 'other-provider',
      model: 'other-model',
      maxTokens: 4096,
    })).toEqual({
      provider: LOCKED_PROVIDER,
      model: LOCKED_MODEL,
      maxTokens: 4096,
    })
  })
})

describe('tool execution policy', () => {
  it('allows only the two Twofold tools', () => {
    expect(denyUnapprovedTool('read_decision_packet')).toBeUndefined()
    expect(denyUnapprovedTool('submit_portfolio_targets')).toBeUndefined()
    expect(denyUnapprovedTool('bash')).toMatch(/may execute only/)
    expect(denyUnapprovedTool('web_search')).toMatch(/may execute only/)
    expect(denyUnapprovedTool('subagent')).toMatch(/may execute only/)
  })

  it('adds only bounded subagent delegation for the orchestrated preset', () => {
    expect(ORCHESTRATOR_ALLOWED_TOOL_NAMES).toEqual([
      'read_decision_packet',
      'submit_portfolio_targets',
      'subagent',
    ])
    expect(denyUnapprovedTool('subagent', 'orchestrated')).toBeUndefined()
    expect(denyUnapprovedTool('subagent_fork', 'orchestrated')).toMatch(/may execute only/)
    expect(denyUnapprovedTool('workflow', 'orchestrated')).toMatch(/may execute only/)
  })
})

describe('portfolio target validation', () => {
  const valid = {
    decision_packet_id: 'packet-1',
    packet_sha256: 'a'.repeat(64),
    targets: [
      { symbol: 'LULU', target_weight_bps: '7000', rationale: '  packet evidence  ' },
      { symbol: 'SPY', target_weight_bps: '2000' },
    ],
    cash_weight_bps: '1000',
    decision_summary: '  rebalance  ',
  }

  it('normalizes a fully invested basis-point portfolio', () => {
    expect(normalizePortfolioTargets(valid, 'session-1')).toEqual({
      session_id: 'session-1',
      decision_packet_id: 'packet-1',
      packet_sha256: 'a'.repeat(64),
      targets: [
        { symbol: 'LULU', target_weight_bps: '7000', rationale: 'packet evidence' },
        { symbol: 'SPY', target_weight_bps: '2000' },
      ],
      cash_weight_bps: '1000',
      decision_summary: 'rebalance',
    })
  })

  it('rejects duplicate tickers, malformed fences, and incomplete weights', () => {
    expect(() => normalizePortfolioTargets({
      ...valid,
      targets: [...valid.targets, { symbol: 'SPY', target_weight_bps: '1' }],
      cash_weight_bps: '999',
    }, 'session-1')).toThrow(/duplicate symbol/)
    expect(() => normalizePortfolioTargets({ ...valid, packet_sha256: 'ABC' }, 'session-1'))
      .toThrow(/64 lowercase hexadecimal/)
    expect(() => normalizePortfolioTargets({ ...valid, cash_weight_bps: '999' }, 'session-1'))
      .toThrow(/exactly 10000/)
  })

  it('rejects leading zeroes and negative decimal strings', () => {
    expect(() => normalizePortfolioTargets({ ...valid, cash_weight_bps: '01000' }, 'session-1'))
      .toThrow(/canonical non-negative decimal integer string/)
    expect(() => normalizePortfolioTargets({
      ...valid,
      targets: [{ symbol: 'LULU', target_weight_bps: '-9000' }],
      cash_weight_bps: '1000',
    }, 'session-1')).toThrow(/canonical non-negative decimal integer string/)
  })
})

describe('structured submission argument rejections', () => {
  const valid: SubmitPortfolioTargetsArgs = {
    decision_packet_id: 'packet-1',
    packet_sha256: 'a'.repeat(64),
    targets: [{ symbol: 'LULU', target_weight_bps: '9000' }],
    cash_weight_bps: '1000',
    decision_summary: 'rebalance',
  }

  function rejection(args: SubmitPortfolioTargetsArgs): PortfolioSubmissionArgumentError {
    try {
      normalizePortfolioTargets(args, 'session-1')
    } catch (error) {
      if (error instanceof PortfolioSubmissionArgumentError) return error
      throw error
    }
    throw new Error('normalizePortfolioTargets accepted an invalid submission')
  }

  it('names one durable code and the offending field for every refusal', () => {
    const cases: Array<[SubmitPortfolioTargetsArgs, string]> = [
      [{ ...valid, decision_packet_id: '  ' }, 'decision_packet_id'],
      [{ ...valid, packet_sha256: 'ABC' }, 'packet_sha256'],
      [{ ...valid, cash_weight_bps: '01000' }, 'cash_weight_bps'],
      [{ ...valid, targets: [{ symbol: 'lulu', target_weight_bps: '9000' }] }, 'targets[0].symbol'],
      [
        {
          ...valid,
          targets: [
            { symbol: 'LULU', target_weight_bps: '9000' },
            { symbol: 'LULU', target_weight_bps: '1' },
          ],
        },
        'targets[1].symbol',
      ],
      [
        { ...valid, targets: [{ symbol: 'LULU', target_weight_bps: '-9000' }] },
        'targets[0].target_weight_bps',
      ],
      [{ ...valid, decision_summary: ' ' }, 'decision_summary'],
      [{ ...valid, cash_weight_bps: '999' }, 'total_weight_bps'],
    ]
    for (const [args, field] of cases) {
      const error = rejection(args)
      expect(error.code).toBe('SUBMISSION_ARGUMENTS_INVALID')
      expect(error.field).toBe(field)
      expect(error.message.length).toBeGreaterThan(0)
      expect(error).toBeInstanceOf(TypeError)
    }
  })

  it('keeps a valid submission free of any rejection', () => {
    expect(normalizePortfolioTargets(valid, 'session-1').cash_weight_bps).toBe('1000')
  })
})

describe('worker bridge result validation', () => {
  it('accepts fenced packet and submission acknowledgements', () => {
    expect(validateDecisionPacketResult({
      status: 'ready',
      decision_packet_id: 'packet-1',
      packet_sha256: 'b'.repeat(64),
      available_at: '2026-08-23T00:00:00Z',
      payload: { symbol: 'LULU' },
    }).status).toBe('ready')
    expect(validatePortfolioTargetsResult({
      status: 'accepted',
      submission_id: 'submission-1',
    }).status).toBe('accepted')
  })

  it('rejects malformed bridge results', () => {
    expect(() => validateDecisionPacketResult({
      status: 'ready',
      decision_packet_id: 'packet-1',
      packet_sha256: 'bad',
      available_at: '2026-08-23T00:00:00Z',
      payload: {},
    })).toThrow(/invalid packet_sha256/)
    expect(() => validatePortfolioTargetsResult({
      status: 'accepted',
      submission_id: ' ',
    })).toThrow(/non-empty/)
  })
})
