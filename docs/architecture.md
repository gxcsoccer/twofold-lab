# Twofold Lab architecture

Status: private Arena, bounded serverless execution, corporate-action ledger
application, and causal replay gates implemented, 2026-08-29.

## Runtime topology

```text
Vercel / Next.js dashboard
  -> Supabase Auth and row-level security
  -> read projections and alerts
  -> observe the live root/descendant Agent tree and tree-wide budget projection
  -> append control-command intents
  -> authenticated one-minute cron invokes one bounded Arena tick

Supabase Postgres
  -> append-only Twofold business events
  -> configuration versions and frozen manifests
  -> current projections, commands, worker leases, artifact metadata
  -> immutable model-pricing versions and per-request Token/cost facts
  -> immutable market source versions, Raw deliveries, facts, and snapshots
  -> contestant-bundle manifests, Session lineage, and Arena budget state
  -> immutable seven-phase tick observations and derived operational health
  -> immutable Round-structure readiness and fail-closed start gate
  -> Realtime only as an invalidation signal

Bounded Twofold Arena worker
  -> claims commands and scheduled jobs idempotently
  -> launches the trusted frozen host Bundle as a root Session tree
  -> brokers packet data, tree budget, and target submission capabilities
  -> runs pinned DeepSeek Harness in-process for the audited host Bundle
  -> exact accepted-target -> S1/S2 -> ledger -> NAV Core
  -> content-addressed cycle commit and decision projection
  -> causal accepted-target seed-readiness read boundary
  -> deployed primitive: ledger-backed atomic S2 BUY settlement
  -> durable evidence-aware scheduling and non-overlapping Round provisioning
  -> target: isolated execution profiles for external Bundles
  -> writes business events and content-addressed artifacts
```

Vercel Functions run bounded Arena ticks, including the trusted agent and
accounting engine. They do not own durable scheduling state: Postgres owns work
requests, deadlines, leases, exact completion fingerprints, and idempotent
commits. Each pass renews a short liveness lease before work and records one
complete phase outcome afterward. The private health API derives green/red
state from those records plus queue, scan, and recovery evidence. A persistent
local worker is an alternative executor of the same state machine, not a second
source of truth.

Every Alpaca and ECB call is additionally bounded by one shared 20-second
provider deadline. This is deliberately shorter than both the 180-second health
lease and the 800-second serverless limit: a stalled upstream becomes a
retryable evidence failure while the tick can still advance independent work.
The parent abort signal always takes precedence, and provider response bytes
must still pass the same origin, content-type, time-fence, and hash checks.

Operational liveness and competition readiness are deliberately separate
contracts. Liveness asks whether the executor and due work are healthy now;
readiness asks whether a selected immutable Round has its rulebook, one genesis,
equal account heads, stable universe, every entrant seat, exact eight-phase DAG,
accepted target, and frozen S1 plan. The operator start gate requires both and
also binds the active Season and Worker identities, so a green cron cannot mask
an incomplete Round. The same gate computes nominal lane capacity from the
actual entrant count and frozen work windows, reserves dependency and retry
ticks, and rejects a competition that could not drain before its deadlines even
if every row were otherwise present.

## Product modes and unit of competition

The primary Arena entrant is a complete, immutable DSH Agent Bundle, not a
prompt fragment or a single Skill file. One decision invocation starts a root
Harness Session for that Bundle; any child or deeper descendant Sessions it
creates remain part of the same contestant execution tree. The frozen entrant
manifest identifies the Bundle hash, Harness compatibility version, permitted
model routes, declared capabilities, and root Agent entrypoint.

`Controlled Lab` is a separate ablation mode. It runs instruction-only variants
such as No Skill, UZI, or ai-berkshire inside the same standardized host runner
to isolate the marginal effect of instructions. Controlled Lab results must not
be presented as though they were full-Bundle Arena results: native planners,
subagents, tools, memory, and orchestration are intentionally removed there.

This distinction is an accepted product contract. The current repository has a
single trusted host-side Twofold bundle with separate `twofold` Controlled Lab
and `twofold-orchestrator` Agent League presets. The Worker now owns execution
of that orchestrated Session tree; a general contestant registry/loader and the
Controlled Lab adapters remain incomplete.

## DeepSeek Harness integration

Twofold currently ships an out-of-tree host `dsh.bundle`; it does not fork or
patch the Harness agent loop. Both shipped presets pin:

```text
provider = deepseek-official
model    = deepseek-v4-pro
```

The pin is enforced at three layers: the visible model catalog, the
default-model service, and an `agent/request` hook. The `twofold` preset exposes
only packet read and final submission. The `twofold-orchestrator` scaffold adds
one preset-scoped, foreground-only, depth-one `subagent` capability; each child
has an empty tool set and a research-only persona, while a descendant-aware
executor guard rejects every child tool call. Shell, filesystem, Web, dynamic
Skills, background work, fork, generic Workflow, and Ralph remain denied. This
trusted-host preset now runs end to end through a Worker-owned Session tree,
gateway, and tree-wide budget. External untrusted Bundles remain out of scope
until process/container isolation exists.

In the target Arena, each scheduled decision uses a new root Harness Session, an immutable
`decision_packet_id`, and a frozen Bundle identity. Descendants inherit the
root invocation's data fence and budget account; they cannot obtain a newer
packet or submit around the root's Arena boundary. Accounting replay consumes
the stored, accepted normalized output; it never calls the Bundle again. A new
execution receives a new root identity and Session tree.

Harness Session logs are model-execution evidence, not the trading ledger.
Arena records the root/parent Session relationship and accepted submission as
Twofold business evidence without inventing custom Harness events. External
plugins must not append unregistered `twofold/*` Session events because current
Harness persistence rejects unknown non-ignorable event types during recovery.

Usage is buffered until `step/end` for each
`(harness_session_id, turn, step, attempt)`: a finalized `assistant/message`
replaces an earlier stream sample; the last usage chunk is retained only when
the request fails before a final message. Harness input, cache-read,
cache-write, and output buckets are disjoint; reasoning tokens are a subset of
output and are never billed twice. The target Arena aggregate sums every
physical provider attempt from the root and all descendants exactly once and
attributes it to the same Bundle invocation. Price-card estimates and later
provider billing facts stay separate. Per-attempt normalization, Session
lineage, and tree-wide aggregation exist for the trusted-host slice. See
[data-integration.md](data-integration.md).

## Controlled Lab compatibility policy

Planned UZI and ai-berkshire `instruction-only` adapters are pinned to exact
commits and selected source files. They receive the same frozen decision packet
inside the Controlled Lab runner. Their native network, scripts, subagents, and
repeated-model workflows are deliberately removed for this ablation. Full
versions may enter the main Arena only as complete Bundles under the same Arena
data and budget contracts as every other entrant.

## Terminal entrant failure

A contestant-local failure must not become a fabricated strategy and must not
stop the other contestants. The recovery contract is:

1. preserve the Strategy Account ledger head byte-for-byte; do not synthesize
   an accepted target, order, fill, settlement, or successful work phase;
2. continue capturing the Round-shared S1/S2 market evidence independently;
3. after the shared S2 close, value the unchanged portfolio with the frozen
   Season fee/tax/ranking policy;
4. persist an explicit no-trade reason linked to the terminal work item and show
   it beside the economic Liquidation-NAV rank;
5. treat that evidence-backed S2 valuation as a terminal Round outcome so the
   other entrants and next non-overlapping Round can continue.

Migrations 038 and 039 implement this as a leased recovery queue, an atomic
unchanged-ledger S2 valuation boundary, and a versioned Dashboard read model.
The Worker advertises `RECOVER_NO_TRADE_ENTRY` and needs no model credential for
this path. Manual queue edits or backdated completions remain forbidden.

## Corporate actions on raw market bars

Migrations 040 through 048 keep splits, dividends, mergers, and reorganizations outside the
price-bar normalizer. The Worker stores every paginated Alpaca scan and every
content-addressed revision, then the database gates each contestant-local phase
inside the Season-bounded economic window. Missing, stale, unsupported, revised, or not-yet-
applied evidence leaves the phase unclaimed; it never becomes an implicit price
adjustment or ordinary no-trade outcome. Split and ordinary USD cash-dividend
interpreters advance the same portfolio ledger. Dividend entitlement is frozen
before ex-date open; one immutable ECB cross and database-owned instrument/tax
material are shared by all entrants and bound again by an insert guard.

## Versioned execution realism

Execution policy belongs to the immutable Season rulebook, not to contestant
code or a mutable Worker flag. The original three-symbol Season's v1 rulebook
uses the shared first regular-session minute open plus fixed slippage. The
Liquid 100 Season's v2 rulebook
uses the shared Alpaca SIP first-minute VWAP and whole-share volume, with maximum
fill capacity:

```text
min(requested whole shares, floor(observed whole-share volume * bps / 10000))
```

There is no artificial minimum fill. A zero-volume or sub-one-share capacity
therefore produces no fill, and available cash is checked separately. Every
entrant receives the same immutable market fact and an independent hypothetical
participation limit. A shared depleting pool would make outcomes depend on
entrant processing order and would model a multi-agent matching market rather
than comparable counterfactual strategies.

Core owns the financial derivation. Migrations 050-052 preserve the source
volume in market evidence, independently enforce the frozen rulebook and fill
capacity in Postgres, and expose dedicated v2 S1 plan/checkpoint registration
boundaries. The v1 RPC shapes remain unchanged for replay compatibility. A new
Season explicitly selects v2; an existing Season can never be upgraded in
place.

## Frozen decision universe

`US Liquid 100` is a data artifact, not an environment variable. A builder
joins active/tradable Alpaca US assets with Nasdaq's stock catalog and traded-
security directory, rejects ETFs/test issues/non-common-stock forms, requires
at least 120 daily sessions, a $5 close, and $20M 20-session median dollar
volume, then ranks deterministically by that liquidity measure. The current
holding LULU is mandatory only if it still passes every eligibility gate.

The artifact freezes 100 instrument identities, source URLs and hashes,
selection reasons, and research features. The database snapshot freezes the
same 100 decision bars. Runtime credentials are deployment-scoped, while every
market/corporate-action request derives symbols from its Round or active Season;
multiple universes therefore coexist without a global symbol switch.

## Arena enforcement boundary

Arena, rather than contestant code, owns four non-bypassable boundaries:

- **Data:** the root and every descendant read only the packet and snapshot
  bound to the invocation. Direct Provider, database, ambient Web, or local
  secret access is denied unless a league manifest grants the same versioned
  capability to every comparable entrant.
- **Budget:** provider requests, billable Token buckets, estimated cost,
  wall-clock time, descendant count, concurrency, and tool quotas are charged
  to one root budget. Arena checks and reserves the remaining allowance before
  a child Session, model request, or metered tool call starts. The per-request
  output allowance and tree-wide billable-token ceiling grow linearly with the
  frozen symbol count after a 32-symbol floor, then stop at explicit hard caps.
  A larger decision surface therefore receives enough room to summarize its
  own immutable packet without turning budget into an unbounded model setting.
- **Submission:** only the invocation's Arena submission broker can accept the
  schema-validated final target portfolio. Descendants may advise the root but
  cannot create an additional accepted submission or change the decision ID.
- **Execution:** order construction, fills, fees, tax, NAV, and Round state stay
  in the deterministic Twofold engine. A Bundle never receives broker
  credentials or a live-order capability.

External or otherwise untrusted Bundles must run outside the Arena control
process in a separate OS process or container with a minimal filesystem,
explicit network policy, scoped IPC, resource limits, deadline enforcement,
and no inherited host/Worker secrets. In-process loading is reserved for
audited, trusted host code. This isolation layer is target architecture and is
not implemented in the current worker.

## Control plane

The dashboard never mutates a Run, order, fill, or NAV row directly. It appends a version-checked command intent. The worker claims the command and emits authoritative events.

Initial command allowlist:

- pause after the next safe point;
- resume;
- cancel pending simulated orders;
- run a data repair;
- freeze a draft configuration;
- create a restatement.

There is deliberately no action to rerun a model after observing later market data, manually place a trade, or edit an active Season configuration.

## Self-evolution control plane

Self-evolution is a second control loop around the Arena, not permission for a
model to edit production or join the official leaderboard. Every six-hour UTC
window follows one generic sequence:

`observe -> diagnose -> hypothesize -> preregister -> experiment -> evaluate -> retain`

The Worker harvests exact agent, queue, model-usage, tick, data, and accounting
facts into an `evolution_cycle`. Findings and experiences are append-only.
Experiments freeze their hypothesis, baseline/treatment references, primary
metric, guardrails, expiry, and evidence design before execution. Failed and
inconclusive results remain in the same hypothesis graph as successful ones.

`LOCAL_REPLAY` reads sealed historical evidence and can be scheduled
automatically. `ONLINE_SHADOW` requires an explicit human approval and may only
write the isolated `evolution_trial` ledger. That table deliberately has no
`entrant_id` or `round_entry_id`; it cannot affect official work gates, accounts,
NAV, or rankings. Promotion of any candidate is a separate human-only action.
This keeps hard risk limits in code and makes the experiment log authoritative,
matching the preregistration discipline of clinical trials rather than allowing
the evaluator to move the goalposts after seeing a result.

### Decision admission and challenger evidence

Every newly accepted target portfolio now carries one immutable
`twofold.decision_admission_evidence/v1` receipt. The receipt binds the exact
portfolio decision, Agent Bundle policy reference, decision snapshot, observed
time, and five explicit observations: input age, maximum packet-bar jump,
snapshot stability window, maximum marked-portfolio target delta, and remaining
cooldown. Core derives `ALLOW` or `BLOCK` from the frozen thresholds; only an
`ALLOW` receipt may cross the database acceptance boundary. The production
service role cannot execute the older evidence-free acceptance RPC.

Official and candidate target portfolios are represented by separately hashed
`portfolio_decision_evidence` values. A comparison is legal only when both name
the same `evidenceSnapshotId`. Core then emits stable per-symbol deltas, the cash
delta, maximum absolute delta, and one-way turnover. The full comparison bytes
and their SHA-256 are immutable in `decision_comparison_artifact`. A
`LOCAL_REPLAY` trial can register this artifact before it starts, so evaluation
cannot silently substitute a later market snapshot or change either decision
after seeing the result.

Migration 060 closes the next evidence gap. A portfolio-policy `LOCAL_REPLAY`
must bind that comparison to two content-addressed replay outcomes created from
the same replay-input SHA, replay policy, snapshot, and NAV currency. The
evaluation preregisters terminal NAV as its primary metric and evaluates every
candidate on the same fixed surface: constraint violations, turnover, simulated
slippage, fees, tax, maximum drawdown, and terminal failures. Constraint
violations and terminal failures have an absolute candidate ceiling of zero, so
an equally broken baseline cannot make a broken candidate look acceptable.
Postgres rechecks every metric/result binding and recommendation before storing
the exact bytes in `decision_evolution_evaluation`.

The strongest automated outcome remains `PROMOTE_CANDIDATE`. Registration does
not complete or promote an experiment and the evaluation table has no entrant,
Round-entry, account, or ranking identity. The existing human-only `PROMOTE`
transition remains a separate authorization boundary.

## Realtime and recovery

Supabase Realtime is a notification channel, not a ledger or queue authority. The UI tracks a projection sequence, refetches after reconnect, and treats Postgres projections as authoritative. Commands and worker work claims use database idempotency keys and leases.

Harness live Agent state is observed locally through its established
host/session streams. The GUI shows a live root/descendant tree with
Agent status, parentage, elapsed time, provider-request count, Token buckets,
estimated cost, reservations, and remaining tree budget. Only this whitelisted,
non-sensitive projection is mirrored into Twofold; raw prompts, tool arguments,
credentials, local paths, and private child messages are not broadcast to
Supabase.

## Secrets

The DeepSeek API key is stored only in the Harness credential store or the worker's secret environment. The dashboard can display `configured`, source, and last-check time, but never receives the value. Supabase service credentials are worker-only in the target architecture; browser code uses the publishable key and RLS. Local private dogfood may use a server-only dashboard secret only when `NODE_ENV != production`, `TWOFOLD_LOCAL_DOGFOOD=true`, and the dev server is bound to loopback, never as a browser variable. The dashboard ignores this secret in production, which must use authenticated least-privilege reads.

## Known constraints

- DeepSeek Harness is a developer preview. The exact version and commit are pinned and upgrades require a compatibility change.
- `deepseek-v4-pro` is a provider alias. The manifest records the alias, request timestamp, and provider request id; it cannot claim immutable model weights.
- One model across three Skill conditions plus four non-AI baselines is a useful MVP, but it does not yet satisfy the specification's two-model Definition of Done.
- A general Arena Bundle loader and untrusted Bundle isolation remain
  unimplemented; the current execution path is restricted to the audited host
  `twofold-orchestrator` Bundle.
- Formal Season startup still requires holdings tax lots, cash, dates, Skill commits, data providers, broker fee facts, and tax assumptions.
- Core is the single financial-derivation authority for the accepted-target
  replay cycle. Supabase atomically admits its exact bytes only after both plans
  exist and verifies identity, content hash, the artifact plan bytes against the
  admitted frozen plans, stage/order conservation, NAV arithmetic, run-stream CAS,
  and the locked strategy ledger head. The head is the balance-derivation fence:
  run-stream CAS orders events only, so without it two decisions could each
  derive from the same balances. The older per-fill SQL boundary remains S2-only.
- Postgres still verifies rather than recomputes. It does not re-derive tax, fees,
  or NAV, which means the published NAV magnitudes are Core-asserted; the checks
  it can make independently are identity, exact bytes, durable bindings, the NAV
  subtraction identities, and the ledger head.
- S1 Core settlement requires acquisition and disposition USD/CNY evidence and
  applies the frozen strict FIFO tax ruleset; missing evidence fails closed.
  Trusted live ingestion and a real pre-positioned opening account remain absent.
- Realized capital-gains tax is an accounting balance in CNY. The
  trading-currency reserve that gates S2 buying power and appears as a NAV
  deduction is converted at each disposition's own FX rate, so it is a
  conservative per-disposition reserve and not a filed tax figure; annual netting
  exists only as a separately labelled sensitivity view.
