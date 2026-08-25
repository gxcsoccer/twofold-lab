/** Bounded full-Agent preset for the Twofold Agent League. */

import type { Context } from '@deepseek-ai/cordis'
import { applyAgentPolicy } from './index.js'

/** Stable Cordis plugin name. */
export const name = 'twofold-orchestrator-agent'

/** Host registries this preset-scoped plugin contributes to. */
export const inject = ['tools', 'systemPrompt']

/** Mount the bounded orchestration policy. */
export function apply(ctx: Context): void {
  applyAgentPolicy(ctx, 'orchestrated')
}
