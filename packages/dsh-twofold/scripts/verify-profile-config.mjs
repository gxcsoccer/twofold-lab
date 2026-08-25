import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const repositoryRoot = resolve(packageRoot, '../..')
const harnessRoot = resolve(process.env.DEEPSEEK_HARNESS_SOURCE
  ?? resolve(here, '../../../../../deepseek-ai/deepseek-harness'))

function parse(path) {
  const value = load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  assert.ok(Array.isArray(value), `${path} must parse as an entry/patch list`)
  return value
}

const warnings = []
const warn = (message, ...args) => warnings.push([message, ...args].join(' '))
let entries = applyEntryPatches([], parse(resolve(harnessRoot, 'packages/bundle/base/cordis.patch.yml')), warn)
entries = applyEntryPatches(entries, parse(resolve(packageRoot, 'cordis.patch.yml')), warn)
entries = applyEntryPatches(entries, parse(resolve(repositoryRoot, 'profiles/twofold/cordis.patch.yml')), warn)
assert.deepEqual(warnings, [], `profile composition emitted unmatched patch warnings: ${warnings.join('; ')}`)

const rows = new Map(entries.map(entry => [entry.id, entry]))
assert.deepEqual(rows.get('agent-default-model')?.config, {
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
})
assert.equal(rows.get('settings')?.disabled, true)
assert.equal(rows.get('llm-pi-ai')?.disabled, true)
assert.deepEqual(rows.get('llm-deepseek')?.config?.models?.map(model => model.id), ['deepseek-v4-pro'])
assert.deepEqual(rows.get('llm-deepseek')?.config?.retryPolicy, { mode: 'normal', maxRetries: 0 })

for (const id of [
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'tool-str-replace-editor',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-workflow',
  'tool-ralph',
  'tool-web',
]) {
  assert.equal(rows.get(id)?.disabled, true, `${id} must be disabled in the composed profile`)
}

const roster = rows.get('agent-presets')
assert.equal(roster?.name, '@deepseek-ai/dsh-agent-presets')
assert.equal(roster?.config?.default, 'twofold')
assert.equal(roster?.config?.includeUserRoot, false)

const preset = parse(resolve(repositoryRoot, 'profiles/twofold/agent-presets/twofold/agent.cordis.yml'))
assert.deepEqual(preset, [{ id: 'twofold-agent', name: '@twofold-lab/dsh-twofold/agent' }])

const orchestratorPreset = parse(resolve(
  repositoryRoot,
  'profiles/twofold/agent-presets/twofold-orchestrator/agent.cordis.yml',
))
assert.equal(orchestratorPreset.length, 2)
assert.deepEqual(orchestratorPreset[0], {
  id: 'twofold-research-subagent',
  name: '@deepseek-ai/dsh-tool-subagent',
  config: {
    provider: 'spawn',
    toolName: 'subagent',
    enableRunInBackground: false,
    backgroundMode: 'one-shot',
    maxDepth: 1,
    agentOptions: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      maxTokens: 8192,
    },
    toolFilter: { allow: [] },
    persona: orchestratorPreset[0].config.persona,
  },
})
assert.match(orchestratorPreset[0].config.persona, /research subagent/)
assert.deepEqual(orchestratorPreset[1], {
  id: 'twofold-orchestrator-agent',
  name: '@twofold-lab/dsh-twofold/orchestrator',
})

process.stdout.write('Twofold profile composition verified with Harness patch semantics\n')
