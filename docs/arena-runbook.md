# Private Arena runbook

Updated: 2026-08-29.

## Start gate

The Arena may start only when all server-side credentials are present:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `ALPACA_API_KEY_ID`
- `ALPACA_API_SECRET_KEY`
- `DEEPSEEK_API_KEY`

Never print their values, put them in a browser variable, or persist them in an
event/database payload. Run the credentialed provider smoke before starting a
new decision window:

```bash
pnpm smoke:deepseek
```

After registration and before allowing S1 execution, run the fail-closed Round
gate with the same production Worker identity:

```bash
TWOFOLD_WORKER_ID=twofold-vercel-arena pnpm round:readiness -- --round=1
```

Proceed only when it exits zero and prints `ready: true`. The gate combines two
independent proofs: immutable Round readiness (one rulebook/genesis, equal
accounts, every entrant/seat, the exact eight-phase DAG, accepted targets, and
frozen S1 plans), nominal one-minute tick capacity with five retry slots, plus
current operational health (the intended Worker is live,
the active Season matches, and there are no alerts). A healthy cron alone is
not proof that a Round is structurally complete.

## Registering a deterministic baseline

A baseline is a ranked contestant that runs no model. It cannot be added to a
live Season: `season_entrant` is immutable, so a baseline joins at the next
Season activation alongside the Agent entrants.

The `entrants` array is hand-authored (only the season/round/universe blocks
come from `pnpm season:prepare:liquid100`). Add one entry per baseline, using
fresh `entrantId`/`runId` UUIDs and the frozen policy's content address as
`bundleSha256`:

```json
{
  "entrantId": "<fresh uuid>",
  "entrantCode": "baseline-hold-lulu",
  "runId": "<fresh uuid>",
  "bundleId": "twofold-baseline-hold-genesis@1.0.0",
  "bundleSha256": "14a7e54b2244e417e48b653a27742ce41038855a306e8b4ad2ff1da7b6016b39",
  "presetId": "none",
  "provider": "none",
  "model": "none",
  "executionClass": "DETERMINISTIC_BASELINE",
  "track": "MAIN_ARENA",
  "baselinePolicy": {
    "policyId": "hold-genesis",
    "rule": "HOLD_GENESIS",
    "symbol": null
  }
}
```

`bundleSha256` must equal the SHA-256 of the canonical policy bytes. The seat
loader recomputes it on every claim, so a `baselinePolicy` edited after
registration fails closed rather than competing under a strategy that differs
from the one on record. Recompute it for a new policy with:

```bash
node -e "const{createHash}=require('crypto');const d={policyId:'all-in-spy',rule:'ALL_IN_SYMBOL',schema:'twofold.deterministic_baseline_policy/v1',symbol:'SPY'};const j=JSON.stringify(d);console.log(createHash('sha256').update(j,'utf8').digest('hex'))"
```

`provider` and `model` must both be the literal `none`: the database binds that
sentinel to `DETERMINISTIC_BASELINE` by equivalence, so a baseline naming a real
route and an Agent hiding behind the sentinel are both rejected at registration.

Then follow the ordinary sequence - `season:register`, `season:genesis`,
`round:register`, `round:entries`, `round:work`, `round:value:opening`. Each
baseline receives the same equal-start genesis account and the same eight-phase
DAG as an Agent entrant, and `round:readiness` counts it like any other seat.

Two operational limits:

- Only `HOLD_GENESIS` is usable today. An `ALL_IN_SYMBOL` baseline needs its
  instrument inside the decision universe; sealing an extra symbol into the
  snapshot is not sufficient and would fail `PREPARE_S1_ORDERS` for every
  entrant in the Round. See the known constraints in architecture.md.
- The Worker still advertises `RUN_AGENT_DECISION` only when `DEEPSEEK_API_KEY`
  is set, so a baseline is claimed only by a keyed Worker. That is satisfied
  whenever baselines share a Round with Agent entrants.

## Worker operation

One diagnostic lease cycle:

```bash
pnpm arena:tick
```

For local operation, the process must remain alive across decision, S1
open/close, S2 open/close, final valuation, and next-Round provisioning:

```bash
pnpm dev:arena-worker
```

Production uses the authenticated `/api/arena/tick` Vercel cron once per minute.
The tick output must include these seven runner outcomes:

- `agent`
- `cycle`
- `market`
- `corporateActionScan`
- `corporateActionAccount`
- `recovery`
- `season`

and the capability list must include `RECONCILE_CORPORATE_ACTIONS`,
`RECOVER_NO_TRADE_ENTRY`, and `PROVISION_NEXT_ROUND`. `idle` is healthy when no
work boundary is due.

Each tick first renews `worker_lease` for 180 seconds, then stores one immutable
`arena_tick_observation`. The private `/api/health` route derives its status
from Supabase and returns HTTP 503 for any of these critical conditions:

- `TICK_MISSING` or `TICK_STALE` (no completed pass within three minutes);
- `WORKER_LEASE_EXPIRED`;
- `LAST_TICK_FAILED`;
- `CORPORATE_ACTION_SCAN_STALE` during an active Season;
- `MISSED_DEADLINE`;
- `TERMINAL_WORK_FAILURE` without a successful no-trade carry-forward.

An `idle` latest outcome with an unexpired lease and no alerts is healthy. Do
not replace the database-derived check with a static HTTP liveness response.

All external Alpaca and ECB requests have one 20-second Worker-side deadline,
independent of the outer 800-second Vercel function limit. Parent shutdown or
platform abort still wins immediately. A provider timeout returns the leased
phase as a sanitized retryable failure; the durable queue retries it on the
one-minute cadence without holding the remaining runners hostage.

Each market runner and contestant-cycle runner claims at most one item per
tick, but they run concurrently. For the current two-entrant Round, S1/S2 open
capture drains in at most two healthy ticks; a shared close plus both dependent
entrant settlements drains in at most three. This is safely inside the frozen
388-minute open-reference and 1,030-minute S1-close-to-S2-open windows. Recheck
this capacity when materially increasing entrant count or cron interval.

Corporate-action reconciliation runs before contestant-local work. It scans
every 15 minutes with a 45-day process-date lookback and horizon. If the latest
covering scan is absent, stale, or contains an unapplied action effective for a
phase, Postgres leaves that phase unclaimed while shared market capture keeps
running. A deadline under this gate is an explicit competition halt and cannot
be converted into no-trade carry-forward.

For a payable ordinary USD dividend, the Worker freezes one ECB source envelope
and USD/CNY cross for the Season/action/revision, then reuses it for every
entrant. The application uses the entitlement captured before ex-date open and
the stable instrument identity. Missing provider currency, record date,
instrument tax residence, or a supported ordinary classification is an
explicit failed reconciliation; never substitute a current quote or hand-edit
cash.

## Deadline semantics

Every phase with a deadline is fail-closed:

- a request not claimed by its deadline becomes `CANCELED / DEADLINE_EXPIRED`;
- a handler claimed before but completed after its deadline becomes
  `FAILED / DEADLINE_EXPIRED_DURING_EXECUTION`;
- a late success can never publish orders, fills, settlement, or ranking;
- a lost completion response is retried only with the exact stored completion
  fingerprint; changed retry content fails.

Before a deadline, a crashed Worker can restart and safely reclaim an expired
lease. After a deadline, do not edit queue rows or backdate timestamps. Preserve
the evidence and investigate the underlying Worker/provider outage.

## Current Round 1 boundaries

- Decision closes: `2026-08-31T13:15:00.000Z` (21:15 Asia/Shanghai).
- S1 open/reference: `2026-08-31T13:30:00.000Z` / `13:32:00.000Z`.
- S1 close evidence: after `2026-08-31T20:20:00.000Z`.
- S2 open/reference: `2026-09-01T13:30:00.000Z` / `13:32:00.000Z`.
- S2 final evidence/ranking: after `2026-09-01T20:20:00.000Z`.

The authenticated Vercel Dashboard is the production read-only operational
view; <http://127.0.0.1:3210> is the local equivalent. It must show both
entrants, exactly `150 LULU`, and all eight work phases.

## Liquid 100 v2 activation

Never upgrade an active Season in place. Create a new config with new Season,
Round, entrant, Run, and genesis identities; bind a completed opening snapshot,
the intended dates, and the exact opening lots. Keep the current S1 config as
immutable evidence.

Each `config/private-us-liquid-100-*.json` selects the implemented
volume-participation rulebook:

```json
{
  "schema": "twofold.arena_execution_rulebook/v2",
  "executionModel": "SIMULATED_MINUTE_PARTICIPATION",
  "openReferenceMethod": "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE",
  "maxParticipationBps": "100",
  "slippageBps": "5",
  "fillPriceScale": "8",
  "feeScheduleId": "futu_hk_us_equity_fixed_2026-08-23",
  "taxRulesetId": "cn_resident_direct_foreign_securities_strict_v1",
  "taxAllocationScale": "12",
  "rankingNav": "LIQUIDATION_NAV"
}
```

`100` means at most 1% of the observed whole-share volume in that symbol's
first regular-session minute. It is the recommended first policy, not a hidden
default. The capacity is applied independently to every entrant against the
same frozen market fact; this is a counterfactual competition, not a shared
matching engine whose volume is consumed in entrant evaluation order.

Before writing production identities, run the one-command rehearsal. It starts
both entrants from independent copies of exactly 150 LULU, runs different
targets against the same minute VWAP/volume evidence, covers partial and
zero-capacity fills, proves evaluation-order independence and deterministic
Liquidation-NAV ranking, checks the Worker/Dashboard adapters, and runs all v2
database boundaries plus finalization/ranking inside rollback transactions:

```bash
pnpm test:v2-season-rehearsal
```

The frozen universe and Season activation are deliberately separate. Reuse an
already-sealed 100-symbol snapshot without refetching or changing the research
artifact, and choose a preparation buffer long enough to finish registration
and deployment before the decision window opens:

```bash
pnpm season:prepare:liquid100 -- \
  --artifact=config/universes/us-liquid-100-2026-08-28.json \
  --snapshot-id=<sealed-100-symbol-snapshot-uuid> \
  --season-code=private-us-liquid-100-s2 \
  --display-name="Private US Liquid 100 S2" \
  --output=config/private-us-liquid-100-s2.json \
  --activation-delay-minutes=15

export TWOFOLD_COMPETITION_CONFIG=config/private-us-liquid-100-s2.json

pnpm season:register -- --config="$TWOFOLD_COMPETITION_CONFIG"
pnpm season:genesis
pnpm round:register -- --config="$TWOFOLD_COMPETITION_CONFIG" --round=1
pnpm round:entries -- --config="$TWOFOLD_COMPETITION_CONFIG" --round=1
pnpm round:value:opening -- --config="$TWOFOLD_COMPETITION_CONFIG" --round=1
pnpm round:work -- --config="$TWOFOLD_COMPETITION_CONFIG" --round=1
vercel --prod --yes
```

Account initialization must complete before both `season.opensAt` and the
Round decision timestamp. The preparation command binds an exact artifact,
snapshot member set, and activation timestamp; it refuses a 99/100 or
date-mismatched snapshot. Never move an already-registered timestamp backward.

After both Agent decisions and S1 plans are durable, run the final start gate:

```bash
TWOFOLD_WORKER_ID=twofold-vercel-arena pnpm round:readiness -- --round=1
```

Stop on the first mismatch; do not repair exact-write failures by editing rows.
Do not open the competition when the readiness command exits nonzero; use its
explicit Round blockers or operational alerts to find the missing evidence.
The deployed Worker discovers the config by the claimed Season identity, so the
three-symbol and Liquid 100 Seasons can coexist without a global config switch.
After registration, redeploy and verify one healthy tick before the decision
window closes. In addition to the standard rehearsal, the release gate must
retain the existing cash-limited, exact-retry, and no-trade recovery contracts.

## No-trade recovery

A terminal contestant-local decision, S1-plan, S1-checkpoint, or finalization
failure automatically creates one `arena_no_trade_recovery` request. It cannot
run before the shared S2 close is sealed. The recovery Worker then:

1. reads the unchanged Strategy Account and exact S2 snapshot;
2. rebuilds Liquidation NAV with the same frozen fee/tax/ranking policy;
3. atomically stores the S2 valuation and explicit no-trade reason;
4. cancels only the entrant-local unfinished phases, without marking any of
   them successful or canceling shared market evidence work;
5. allows next-Round provisioning only after every entrant has an S2 valuation
   and either normal finalization or successful recovery.

`REQUESTED` or `CLAIMED` at the S2 boundary is normal while recovery is in
flight. A terminal `FAILED` recovery requires investigation of its stored,
sanitized error and the shared evidence; never edit queue rows, backdate a
completion, or mark the failed phase successful.

## Self-evolution operations

The one-minute Arena cron contains an independent eighth phase. It requests one
deterministic six-hour UTC analysis window, claims at most one due cycle, derives
metrics from durable production facts, and stores an immutable report plus its
experience records. Exact retries reuse the same cycle identity.

Run and inspect it locally without changing official competition state:

```bash
npm run arena:tick
npm run evolution:experiment:local -- \
  config/experiments/runtime-surface-scaling-replay-v1.json
```

The checked-in replay preregisters s2+s3 as baseline and s4 as a temporal
holdout treatment. Its `PROMOTE_CANDIDATE` result is evidence, not authorization.
When a local plan includes `decisionComparison`, both decisions must bind the
same immutable snapshot. The runner stores the comparison before transitioning
the trial to `RUNNING`; a snapshot mismatch or persistence mismatch stops the
trial. Inspect `decision_comparison_artifact` for the exact target deltas and
artifact hashes, and `decision_admission_evidence` for the official submission's
five guard observations. Never call the legacy evidence-free submission RPC;
production service credentials intentionally lack that permission.

A portfolio-policy replay is stricter than the generic legacy experiment form.
Its plan omits the free-form `evaluation` block and supplies
`decisionComparison.officialOutcome` plus `candidateOutcome`. Both outcomes must
name the same `replayInputSha256`, replay policy, evidence snapshot, and NAV
currency, while each remains bound to its own decision SHA. The experiment spec
must preregister terminal NAV as the primary metric and exactly these guardrails:

- constraint-violation count, with candidate maximum `0`;
- turnover bps;
- simulated slippage, fee, and tax cost in NAV currency;
- maximum drawdown bps;
- terminal-failure count, with candidate maximum `0`.

The runner validates the complete evaluation before its first database write,
stores the decision diff before `RUNNING`, then stores
`decision_evolution_evaluation` while the trial is running and before either
trial or experiment completion. A `PROMOTE_CANDIDATE` result is the end of
automation; only a separately authenticated named human may invoke promotion.

The online proposal in
`config/experiments/evolution-observer-online-shadow-v1.json` stays `PROPOSED`
until a named human approves it. Never approve by editing a row, impersonating a
human actor in automation, or inserting a temporary official Season entrant.
