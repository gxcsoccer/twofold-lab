# Implementation status

Updated: 2026-08-28.

## Complete in Milestone 0

- Out-of-tree DeepSeek Harness bundle and dedicated `twofold` preset.
- `deepseek-official/deepseek-v4-pro` catalog, default, and request-hook locks.
- Two model-facing domain tools with a deny-by-default capability boundary.
- Separate `twofold-orchestrator` preset with one foreground-only, depth-one,
  tool-free research subagent and a descendant-aware deny-all executor guard.
- Canonical decimal-string contracts for weights and durable JSON values.
- Supabase append-only event, projection, control-command, worker-lease, and
  artifact migration with RLS and audited RPC boundaries.
- Exact Harness Token normalization, high-precision cost estimation,
  immutable pricing/usage tables, and idempotent registration RPCs.
- Persistent worker command-claim/lease scaffold.
- Next.js operational console with real-data status, Setup Required, Season,
  Run, Audit, Settings, Token/cost metrics and budgets, health, and
  Realtime-invalidation states; runtime demo data has been removed.
- Alpaca SIP/raw/1Day adapter with lossless JSON-number normalization, trusted
  origin/redirect protection, complete pagination, private content-addressed
  Storage upload, completed-session checks, and one-shot ingestion.
- Immutable source-version, Raw artifact, delivery observation, reusable
  daily-bar fact, delivery/fact edge, same-session sealed snapshot, and exact
  snapshot-member provenance with service-role-only RPCs.
- Dedicated `twofold-lab` Supabase project in Singapore with all twelve
  migrations applied, including the Arena decision slice, frozen V4 Pro price
  card, exact projection retry, database-arrival submission deadline,
  accounting kernel, atomic S2 settlement, and UUID-helper hardening. Migration
  013 replaces the cycle admission function in place of editing applied history.
- Real Alpaca SIP ingestion verified for the completed 2026-08-21 session:
  30 daily-bar facts were archived for the lookback window and one sealed
  LULU/QQQ/SPY snapshot was persisted with its private Raw object and exact
  delivery/fact provenance.
- Remote transactional pgTAP runner that works without local Docker; current
  control-plane, market-data, Arena, accounting, and settlement/cycle contracts
  pass 19/19, 41/41, 46/46, 92/92, and 105/105 respectively (303/303 total),
  including after real market/Agent rows exist.
- Keyless typecheck, unit-test, production-build, Harness-contract, and profile
  composition checks.
- Trusted-host `twofold-orchestrator` runtime with one root Session, exactly one
  foreground research child, a packet-scoped read tool, and root-only durable
  target submission.
- Worker persistence for decision packet/Bundle artifacts, root/child lineage,
  exact physical model attempts, immutable usage facts, and a redacted live
  Agent-tree projection.
- Tree-wide pre-dispatch reservation for provider requests, conservative input
  Token bounds, maximum output Tokens, and versioned estimated USD cost. Missing
  pricing or provider usage fails closed.
- Real Agent dogfood succeeded on sealed Alpaca snapshot
  `4ddd7b7f-6d16-48f7-8952-b61bd06f88d0`: decision
  `30908825-6f45-4551-b677-6df4b047384b` produced one root plus one child,
  four priced requests, 13,641 billable Tokens, estimated cost `$0.012078132`,
  and one accepted paper target portfolio. No dogfood/runtime frozen-plan
  registration, fill, or accounting event exists.
- Dashboard decision route renders the real immutable fence, Session tree,
  per-Agent Token/cost attribution, shared budget, and accepted-submission fact.

## Implemented accounting kernel slice (not yet end-to-end settlement)

- BigInt-backed exact decimal arithmetic rejects JavaScript/JSON numbers at
  financial boundaries.
- Source-bound `twofold.initial_portfolio/v1` validation, deterministic FIFO
  lot ordering, balanced opening journals, and a read-only CLI. No holdings are
  imported because no real Futu statement/tax-lot file has been supplied.
- Immutable balanced ledger replay with duplicate protection, integer security
  quantities, no shorts, and no negative ASSET balance/no implicit margin.
- Versioned Futu fee formulas and golden cases. Plans retain exact canonical fee
  terms; simulations restore those frozen bytes, so a later registry edit does
  not alter historical replay.
- Strict per-disposition FIFO shadow-tax reserve, dividend state, three NAV
  views, liquidation estimates, and Round/Season reducers. Same-id/date exact
  retries are idempotent; changed payloads fail closed.
- D-close S1 sell planning and S1-close S2 buy planning with frozen slippage,
  precision, tax rules, dates, prices, fee terms, buying-power evidence, and a
  complete canonical engine fingerprint. Pure S1/S2 simulations cover FIFO
  sells, tax locks, stable buy priority, cash-limited fills, and new lots.
- Tested Worker adapter and exact-retry RPC repository primitives
  create/register the exact database order-plan envelope, including
  run/decision/accepted-submission identity, engine fingerprint SHA, and each
  fee-terms SHA. The database contract stores exact bytes immutably. These
  primitives are not yet wired into the dogfood decision runtime or scheduler.

## Implemented atomic S2 settlement slice (not runtime-wired)

- `settle_paper_fill` locks one strategy-account ledger head, enforces CAS and
  strict frozen order priority, and derives S2 simulated BUY results from
  trusted official-open evidence. It never accepts caller-supplied fill amounts,
  fees, postings, lots, or balances.
- Current ledger cash and frozen remaining buying power form a hard `min(...)`
  fence. The database derives the maximum affordable integer shares, exact
  frozen per-order Futu fees, cash journal, lot, acquisition USD/CNY evidence
  binding, and next head atomically.
- A zero-affordable order is persisted as `CANCELED_CASH_LIMIT`, advances the
  audit head once, and creates no fill quantity, journal, lot, fee, or claimed
  FX use. Positive fills require acquisition FX evidence.
- Settlement, journal, and lot IDs use deterministic UUIDv8 derivation. Genesis,
  request, settlement, and chained-head hashes bind stable idempotency/content
  identities rather than random row UUIDs, so clean-database logical replay
  reproduces the same hashes.
- Worker responses are exact-field, string-only contracts. UUIDv8, lowercase
  canonical inputs, millisecond timestamps, arithmetic reconciliation,
  initialization identity, stale-head handling, and commit-after-client-reject
  recovery are covered by tests.
- Evidence authority is source-kind matched and immutable. Alpaca daily bars
  cannot enter the official-auction boundary; service role cannot self-report
  official price or tax-FX evidence or bypass settlement with standalone lots
  or generic fill journals.
- Remote production tables currently contain zero ledger heads, official-price
  evidence rows, tax-FX evidence rows, and settlements. No demo or test trade
  was retained.

## Implemented accepted-target replay cycle

- `runAcceptedTargetCycle` consumes one already accepted submission and frozen
  opening/evidence state, derives S1 sells, strict CNY FIFO tax reserve, S2 buys,
  one replayed ledger, final positions, and all three NAVs without another model call.
- Opening and settlement journals now share the same generic account IDs and
  gross-cost inventory semantics, so one ledger replay covers the whole lifecycle.
- Array order inside the hashed artifact is compared by code point, never by
  `localeCompare`: ICU collation is locale- and version-dependent (it orders
  `equity:opening-balance` before `equity.opening_balance`), so the content
  address would otherwise depend on the host runtime. One frozen digest in the
  Core suite pins this.
- The Worker primitives register both frozen plans and commit one exact cycle
  artifact with deterministic UUIDv8 identity and one byte-identical recovery
  attempt. Nothing in the runtime calls them yet; see "Deliberately not complete".
- Supabase migration 011 validates the submission/account/plan bindings, exact
  bytes/hash, READY order conservation, ledger/final-head shape, and NAV arithmetic,
  then atomically appends the run event and `dashboard.accepted_target_cycle` projection.
- Supabase migration 013 closes four gaps in that admission function: both
  `plan.orders` arrays must exist (a missing key made `jsonb_array_length` return
  NULL and silently disabled the conservation comparison); the artifact's plan
  bytes are bound to `engine_plan_fingerprint`, which is the complete canonical
  plan JSON rather than a label; the strategy ledger head is locked, matched
  against the artifact's opening head, required to advance exactly once per
  settlement, and moved to `finalLedgerHead` in the same transaction; and
  `source_stream_seq` no longer participates in the idempotent-replay identity
  comparison, so a restarted Worker's byte-identical retry is not misreported as
  a content conflict. Without the head fence two decisions in one run could each
  derive from the same balances, because the run-stream CAS orders events only.
- Realized tax is an accounting balance in CNY only. The trading-currency reserve
  that feeds the NAV deduction and the S2 buying-power fence is converted at each
  disposition's own FX rate, so once a cycle sells at more than one rate no single
  rate reconciles the two views. The cycle asserts the exact side: every CNY the
  settlements accrue must appear in the replayed `liability.china_tax_accrual`,
  and inventory must equal the summed gross cost.
- Supabase migration 012 adds one read-only causal readiness boundary. It reports
  only the first durable blocker (`decision` → accepted submission → strategy
  account → ledger head), `READY_FOR_INPUT_BUILD`, or the exact completed cycle.
  It deliberately does not pre-approve later official-open, calendar, or FX evidence.
- The decision page renders completed S1/S2 counts, ledger head, artifact hash,
  and Broker/Tax-reserved/Liquidation NAV. Before completion it renders the exact
  causal readiness code instead of a generic execution placeholder.
- A development-only E2E route is guarded by both `NODE_ENV != production` and
  `TWOFOLD_E2E=true`; Ego Lite verified blocked and completed fixtures plus the
  real `STRATEGY_ACCOUNT_MISSING` decision at desktop and 390px widths.

## Confirmed product direction (architecture, not implementation)

- The primary Arena entrant is a complete, immutable DSH Agent Bundle. One
  decision consists of its root Harness Session and every descendant Session in
  the resulting Agent tree.
- Controlled Lab is a separate instruction-only ablation track; its No Skill,
  UZI, and ai-berkshire variants are not substitutes for full-Bundle Arena
  entrants.
- Arena owns the non-bypassable data fence, tree-wide budget, single accepted
  submission, and deterministic execution boundary.
- All descendant provider usage must be attributed to the root invocation and
  aggregated exactly once. External untrusted Bundles require process/container
  isolation. The GUI already exposes the trusted-host redacted Agent tree and
  remaining budget; the same contract must extend to general entrants.

The general multi-entrant product contract remains broader than this trusted
host dogfood slice; the runtime and GUI bullets above are implemented today.

## Deliberately not complete

- The causal seed-readiness gate is deployed, but its Worker input builder and
  durable scheduler wiring still do not load real opening state or authorize
  trusted execution/calendar/FX evidence before invoking the cycle handoff.
  Concretely: nothing in `worker.ts`, `main.ts`, `dogfood-agent.ts`, or
  `arena-runtime.ts` calls `executeAcceptedTargetCycle` or
  `getAcceptedTargetCycleReadiness`, so no runtime path can commit a cycle. The
  primitives and the database boundary are implemented and tested; the loop is
  not connected.
- `executeAcceptedTargetCycle` spans three durable RPCs (register S1, register
  S2, commit cycle) and is not atomic across them. `frozen_order_plan` is
  immutable and unique per `(decision_id, stage)`, so a crash after a plan
  registration commits that plan forever and recovery needs byte-identical
  re-derivation from the same frozen inputs; changed inputs strand the decision.
  Folding all three writes into one RPC is the follow-up that removes this.
- Per-fill SQL S1 settlement remains unsupported by `settle_paper_fill` and still
  fails closed with `0A000`; S1 is currently durable only inside the immutable,
  Core-derived full-cycle artifact. That artifact now advances the shared
  `strategy_ledger_head`, but it writes no `accounting_transaction`,
  `position_lot_origin`, or `paper_fill_settlement` rows, so per-posting kernel
  provenance for cycle settlements lives in the artifact bytes only and the head's
  kernel row counters deliberately do not move.
- Exchange-calendar/holiday adjacency and trusted official open/close auction
  facts. Existing Alpaca SIP daily bars have explicitly different semantics.
- Official, source-hashed Futu fee evidence and account-entitlement snapshot;
  formulas and frozen terms exist, provenance capture is incomplete.
- Database import of a real Futu opening portfolio; no statement/tax-lot source
  has been provided and no substitute data is generated.
- FX/corporate-action providers and a full decision packet containing holdings,
  tax lots, fees, and accounting state beyond the current market-only slice.
- Durable scheduled work queue; the first real Alpaca slice is currently a
  one-shot Worker command (`pnpm ingest:market`).
- Monthly provider billing reconciliation and import of provider invoice facts.
- General contestant Bundle registry/validation and dynamic loading beyond the
  trusted, commit-pinned host `twofold-orchestrator` Bundle.
- Ledger-head initialization for a real pre-positioned Futu opening portfolio.
  The deployed v1 initializer intentionally accepts only one reconciled,
  artifact-bound, positive all-cash opening journal.
- Process/container isolation, network/filesystem policy, resource limits, and
  secret separation for external untrusted Bundles.
- Controlled Lab's UZI and ai-berkshire commit-pinned instruction adapters and
  its separate ablation reporting.
- Authenticated production console onboarding and a durable worker deployment.
- Vercel or other remote deployment.

The local 3210 dogfood console is connected to real Supabase/Alpaca and now has
real Agent, usage, cost, and accepted-target facts. Missing decisions and data
still fail closed; the UI never substitutes demo values.
