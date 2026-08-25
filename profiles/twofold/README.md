# Twofold Harness profile

This directory is a native DeepSeek Harness profile under `$DSH_HOME/profiles/twofold` when the repository root is used as `DSH_HOME`.

Build and inspect it without an API key:

```sh
pnpm --dir packages/dsh-twofold build
pnpm --dir profiles/twofold install --lockfile=false
DSH_HOME="$PWD" pnpm --dir ../../deepseek-ai/deepseek-harness dsh --profile twofold --dump-config
```

The profile ships two preset compositions:

- `twofold` is the Controlled Lab one-shot Agent with only packet read and portfolio submission.
- `twofold-orchestrator` is the Agent League root with one foreground, depth-one, tool-free research subagent capability.

The persistent worker, rather than this profile, owns Agent creation and dispatch. It must explicitly freeze and mount the selected preset during `agents.create(...).setup`, provide `twofoldDecisionGateway`, aggregate the complete root/descendant Session tree for budgets and usage, and keep `DEEPSEEK_API_KEY` only in the worker environment or Harness credential store. An absent key does not affect keyless tests or configuration inspection; the first real model request fails closed until the credential exists.
