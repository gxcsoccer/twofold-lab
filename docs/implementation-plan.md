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
reducers, S1/S2 plan simulation, frozen-plan database admission contract, and
one deployed ledger-head-backed atomic S2 BUY settlement slice are implemented.
The exit is not met: real Futu holdings, pre-positioned head initialization,
trusted official-price/FX ingestion, exchange calendars, atomic S1 FIFO/CNY tax
settlement, and runtime scheduling remain required.

## Milestone 2: decision orchestration

- Frozen decision packets and data-visibility timestamps.
- No-skill and instruction-only Skill adapters with exact content hashes.
- One logical DeepSeek V4 Pro decision invocation, metered provider steps,
  schema validation, and one format-only repair.
- Two-stage S1/S2 order generation and deterministic cash-limited fills.
- Durable handoff into the deployed S2 settlement boundary; the current Worker
  has exact RPC primitives but does not schedule or auto-authorize settlement.
- Stored Harness transcript evidence linked to the Twofold decision event.

Exit: a complete keyless replay and one credentialed sandbox decision produce the same stored execution path after the model output is frozen.

## Milestone 3: forward paper trading

- Exchange-calendar scheduler and missed-deadline fail-closed behavior.
- Versioned market, corporate-action, FX, fee, and tax providers.
- Alerts, daily/round/season reports, model-billing reconciliation, and restatement.
- Private deployment of the dashboard and a durable worker deployment.

Exit: a dry-run Season completes with no real-broker capability and every displayed number traces to its source event.
