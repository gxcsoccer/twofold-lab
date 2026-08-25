# DeepSeek Harness compatibility

This package targets DeepSeek Harness commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` and published package line `0.1.1-rc.2`.

The integration relies on these source-verified interfaces:

- out-of-tree bundle identity from `package.json.dsh.bundle.patch`;
- profile patch layers and `agent.cordis.yml` preset discovery;
- preset-scoped `ctx.tools.register`, `restrict`, `guard`, and `presentAs`;
- the scoped `agent/request` waterfall returning `LlmCallConfig`;
- the DeepSeek adapter's advisory `models` catalog and `deepseek-official` route.
- child Agent composition inheriting the root preset and durable
  `origin`/`delegationDepth` lineage metadata;
- the spawn subagent tool's foreground-only, `maxDepth`, persona, and
  `toolFilter` deployment controls.

Run `pnpm verify:harness` with the source checkout at its sibling default path, or set `DEEPSEEK_HARNESS_SOURCE` to another checkout. Run `pnpm verify:profile` to compose the official base patch, this bundle, and the dedicated profile through Harness's own `applyEntryPatches` implementation and assert the final locks. An upgrade must change the pinned commit only after both checks and the keyless tests pass against the new source.
