# Twofold Lab architecture

Status: accepted-target replay cycle and causal seed-readiness gate implemented
with explicit live-data gaps, 2026-08-28.

## Runtime topology

```text
Vercel / Next.js dashboard
  -> Supabase Auth and row-level security
  -> read projections and alerts
  -> observe the live root/descendant Agent tree and tree-wide budget projection
  -> append control-command intents

Supabase Postgres
  -> append-only Twofold business events
  -> configuration versions and frozen manifests
  -> current projections, commands, worker leases, artifact metadata
  -> immutable model-pricing versions and per-request Token/cost facts
  -> immutable market source versions, Raw deliveries, facts, and snapshots
  -> contestant-bundle manifests, Session lineage, and Arena budget state
  -> Realtime only as an invalidation signal

Persistent Twofold Arena / worker
  -> claims commands and scheduled jobs idempotently
  -> launches the trusted frozen host Bundle as a root Session tree
  -> brokers packet data, tree budget, and target submission capabilities
  -> runs pinned DeepSeek Harness in-process for the audited host Bundle
  -> exact accepted-target -> S1/S2 -> ledger -> NAV Core
  -> content-addressed cycle commit and decision projection
  -> causal accepted-target seed-readiness read boundary
  -> deployed primitive: ledger-backed atomic S2 BUY settlement
  -> target: durable evidence-aware scheduling for real cycles
  -> target: isolated execution profiles for external Bundles
  -> writes business events and content-addressed artifacts
```

Vercel Functions do not run the agent, scheduler, or accounting engine. Those jobs require durable process ownership, deterministic deadlines, and controlled credentials.

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

## Arena enforcement boundary

Arena, rather than contestant code, owns four non-bypassable boundaries:

- **Data:** the root and every descendant read only the packet and snapshot
  bound to the invocation. Direct Provider, database, ambient Web, or local
  secret access is denied unless a league manifest grants the same versioned
  capability to every comparable entrant.
- **Budget:** provider requests, billable Token buckets, estimated cost,
  wall-clock time, descendant count, concurrency, and tool quotas are charged
  to one root budget. Arena checks and reserves the remaining allowance before
  a child Session, model request, or metered tool call starts.
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
  exist and verifies identity, content hash, stage/order conservation, NAV
  arithmetic, and run-stream CAS. The older per-fill SQL boundary remains S2-only.
- S1 Core settlement requires acquisition and disposition USD/CNY evidence and
  applies the frozen strict FIFO tax ruleset; missing evidence fails closed.
  Trusted live ingestion and a real pre-positioned opening account remain absent.
