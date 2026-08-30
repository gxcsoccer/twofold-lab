# Implementation plan

## Milestone 0: executable foundation

- Monorepo, strict TypeScript, keyless tests, and reproducible local commands.
- DeepSeek Harness bundle, dedicated preset, V4 Pro pin, and domain tool schemas.
- Supabase event, projection, command, lease, artifact, and RLS baseline.
- Exact Token buckets, versioned model pricing, estimated-cost records, and
  per-decision budget configuration.
- Real-data-only Dashboard setup state with no runtime fixture fallback.
- Alpaca SIP raw daily-bar adapter, content-addressed Raw archive, normalized
  market facts, and point-in-time snapshot contract.

Exit: `pnpm verify` passes without credentials; the dashboard reports real
configuration gaps without showing fabricated values.

## Milestone 1: deterministic accounting kernel

- Holdings and FIFO tax-lot import.
- Balanced cash, security, fee, and shadow-tax ledger entries.
- Futu fee schedule golden cases.
- Broker, Tax-reserved, and Liquidation NAV.
- Round boundary reducer and baseline strategies.
- Replay from immutable market and business events.

Exit: the Phase A acceptance tests in the product specification pass without a model call.

Current: the pure arithmetic, portfolio validation, fee/FIFO-tax/NAV/Round
reducers, one deterministic accepted-target -> S1/S2 -> ledger -> NAV cycle,
frozen-plan admission, a content-addressed cycle commit/projection, and one
ledger-head-backed atomic final-cycle boundary are implemented. The private
Arena freezes the user-selected 150 LULU opening state and has real calendar,
market/FX evidence, runtime scheduling, and ranking. The general exit is not
met: reusable Futu statement import and corporate-action handling remain.

## Milestone 2: decision orchestration

- Frozen decision packets and data-visibility timestamps.
- No-skill and instruction-only Skill adapters with exact content hashes.
- One logical DeepSeek V4 Pro decision invocation, metered provider steps,
  schema validation, and one format-only repair.
- Two-stage S1/S2 order generation and deterministic cash-limited fills.
- Worker handoff primitives that register both plans and commit one exact cycle
  artifact are implemented and called by the durable runtime. The database
  admits the final artifact and S2-close score only under the locked strategy
  ledger head; stage-specific real-evidence authorization is enforced.
- Stored Harness transcript evidence linked to the Twofold decision event.

Exit: a complete keyless replay and one credentialed sandbox decision produce the same stored execution path after the model output is frozen.

## Milestone 3: forward paper trading

- Exchange-calendar scheduler and missed-deadline fail-closed behavior.
- Versioned market, corporate-action, FX, fee, and tax providers.
- Alerts, daily/round/season reports, model-billing reconciliation, and restatement.
- Private deployment of the dashboard and a durable worker deployment.

Exit: a dry-run Season completes with no real-broker capability and every displayed number traces to its source event.

Current: the private Arena has the exchange-calendar scheduler, eight-stage
leased DAG, automatic non-overlapping next-Round provisioning, and authoritative
Liquidation-NAV ranking. Remaining forward-operation work is persistent hosting,
alerts, corporate actions, and authenticated private production access.

## Milestone 4: evidence-driven self-evolution

- Six-hour scheduled observation across agents and platform capabilities.
- Immutable experience and negative-result ledger.
- Preregistered local replay and human-gated online-shadow experiments.
- Separate hypothesis, guardrail, result, and promotion state.
- Immutable submission admission evidence with explicit freshness, jump,
  stability, target-delta, and cooldown observations.
- Content-addressed official/candidate decision diffs that require one shared
  evidence snapshot and can be bound to a local trial before it starts.
- Same-input portfolio replay evaluation across constraint violations, turnover,
  simulated slippage/fees/tax, terminal NAV, drawdown, and terminal failures;
  immutable evidence may recommend `PROMOTE_CANDIDATE` but cannot promote.
- No official entrant, Round entry, account, or ranking mutation from shadow work.

Exit: one production analysis and one real local replay are durable; the online
path rejects model approval and official ranking scope, and the private dashboard
shows the full evidence chain. Current: exit is met. The first online shadow
execution remains intentionally pending named-human approval.
