# Twofold DeepSeek Harness bundle

`@twofold-lab/dsh-twofold` is an out-of-tree DeepSeek Harness bundle. It layers the dedicated Twofold decision policy over `@deepseek-ai/dsh-base` without changing Harness source.

The model is locked three times:

1. `llm-deepseek.models` advertises only `deepseek-v4-pro`;
2. `agent-default-model` selects `deepseek-official/deepseek-v4-pro`;
3. the preset-scoped `agent/request` listener rewrites the final request route after downstream listeners return.

The `twofold` preset is the Controlled Lab entrypoint. It exposes only `read_decision_packet` and `submit_portfolio_targets`, removes inherited global tools, and applies a monotonic executor guard so generic shell, filesystem, web, skill, job, workflow, and subagent calls fail even if a later Host layer accidentally makes one visible.

The `twofold-orchestrator` preset is the bounded Agent League entrypoint. Its root receives the same two domain tools plus one preset-scoped `subagent` tool. Delegations are foreground-only, stop at depth one, run on the locked model, and receive an empty child tool set with a research-only persona. A descendant-aware monotonic guard rejects every child tool execution even if a later composition accidentally widens the child's filter. Shell, filesystem, web, dynamic skills, background jobs, continuations, fork, generic workflow, and Ralph remain unavailable.

Both tools fail closed until the persistent worker provides `ctx.twofoldDecisionGateway`. The gateway binds packet reads to the owning Harness Session and fences submissions with the packet id and SHA-256. Target and cash weights cross this boundary only as canonical decimal integer strings; validation uses `BigInt`, so JavaScript numbers never become durable financial values. No API key is needed to build, typecheck, test, inspect configuration, or boot up to the point of an actual model request.

The worker must create a fresh Agent with `setup: agentCtx => ctx.agentPresets.mount(agentCtx, run.agent_preset)`, where the frozen Run manifest explicitly names `twofold` or `twofold-orchestrator`. It records that preset in the Session header and provides the gateway before dispatch. It must not append new `twofold/*` Harness Session events; Twofold business events belong in the external append-only ledger. Before the orchestrated preset can execute a real decision, the worker must also own the root/descendant Session tree, aggregate every descendant request into the root decision budget, and reject child submissions.
