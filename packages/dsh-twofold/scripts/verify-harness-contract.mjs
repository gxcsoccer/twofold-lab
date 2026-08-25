import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_COMMIT = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
const here = dirname(fileURLToPath(import.meta.url))
const defaultRoot = resolve(here, '../../../../../deepseek-ai/deepseek-harness')
const root = resolve(process.env.DEEPSEEK_HARNESS_SOURCE ?? defaultRoot)

if (!existsSync(root)) {
  throw new Error(`DeepSeek Harness source not found at ${root}; set DEEPSEEK_HARNESS_SOURCE`)
}

const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (commit !== EXPECTED_COMMIT) {
  throw new Error(`DeepSeek Harness commit mismatch: expected ${EXPECTED_COMMIT}, got ${commit}`)
}

function assertContains(relativePath, needles) {
  const text = readFileSync(resolve(root, relativePath), 'utf8')
  for (const needle of needles) {
    if (!text.includes(needle)) {
      throw new Error(`${relativePath} no longer contains ${JSON.stringify(needle)}`)
    }
  }
}

assertContains('packages/bundle/README.md', [
  '"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }',
  'out-of-tree bundles install into a profile',
])
assertContains('packages/preset/agent-presets/src/discovery.ts', [
  "export const COMPOSITION_FILE = 'agent.cordis.yml'",
])
assertContains('packages/core/agent/src/runtime-types.ts', [
  "'agent/request'",
  'next: () => Promise<LlmCallConfig>',
])
assertContains('packages/core/tools/src/index.ts', [
  'restrict(filter: ToolRestriction)',
  'guard(guard: ToolGuard)',
])
assertContains('packages/core/tools/src/schema.ts', [
  'export function defineTool',
])
assertContains('packages/subagent/subagent/src/child-agent.ts', [
  'composeFrom(childCtx, parent.ctx)',
  "origin: 'subagent'",
  'delegationDepth: childDepth',
])
assertContains('packages/subagent/tool-subagent/src/index.ts', [
  'enableRunInBackground?: boolean',
  'toolFilter?: {',
  'maxDepth?: number',
])
assertContains('packages/llm/llm-deepseek/src/index.ts', [
  "id: 'deepseek-v4-pro'",
])

process.stdout.write(`DeepSeek Harness contract verified at ${commit}\n`)
