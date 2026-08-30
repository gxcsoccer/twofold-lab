# Twofold Lab

Twofold Lab is an after-tax paper-trading experiment platform for comparing fixed `Model x Skill` conditions on one auditable market path.

The repository is an implementation scaffold. It currently targets:

- DeepSeek Harness `0.1.1-rc.2` at commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`;
- a dedicated out-of-tree Harness bundle and `twofold` Agent preset;
- DeepSeek V4 Pro as the only enabled model route;
- Supabase Postgres as the business event and control-plane store;
- a Next.js dashboard suitable for Vercel;
- a persistent worker for scheduling, market-data ingestion, model execution, and accounting.

No live-broker order path is included. No API key is required for keyless tests
or local UI development. The runtime never falls back to demo market or
portfolio values.

## Repository layout

```text
apps/dashboard/       Web control plane
apps/worker/          Persistent command worker scaffold
packages/core/        Domain events, states, and pure reducers
packages/dsh-twofold/ DeepSeek Harness bundle and plugins
profiles/twofold/     Dedicated Agent preset assets
scripts/              Explicit operational smoke checks
supabase/             Database configuration and migrations
docs/                 Architecture and delivery notes
```

## Development

```bash
pnpm install
pnpm verify
pnpm dev
```

如果本机 3000 端口已占用，可直接使用 dogfood 端口：

```bash
pnpm dev:dogfood
```

控制台地址为 <http://127.0.0.1:3210>。

若本地私有 dogfood 需要 Dashboard 服务端读取受限表，必须显式设置
`TWOFOLD_LOCAL_DOGFOOD=true`。该开关与 server secret 在 production 中均被
Dashboard 忽略；生产环境必须使用 Supabase Auth 与最小权限读取。

An optional credentialed provider smoke test calls only
`deepseek-v4-pro` with a 32-token response cap:

```bash
IFS= read -r -s DEEPSEEK_API_KEY
export DEEPSEEK_API_KEY
pnpm smoke:deepseek
unset DEEPSEEK_API_KEY
```

This checks provider/model connectivity, not a full portfolio decision. A full
decision uses the latest sealed real market snapshot, persists the complete
root/child Agent tree and model usage, and ends at an accepted paper target
portfolio (it never places a live order):

```bash
pnpm dogfood:agent
```

The command prints the exact `/arena/decisions/<decision-id>` path for the
local Dashboard. Missing provider credentials, missing real snapshots, stale
packet fences, budget exhaustion, and unreported pricing all fail closed.

## Real market-data ingestion

After applying the Supabase migrations, configure the server-only variables
from `.env.example`, then ingest the latest completed Alpaca SIP daily bars:

```bash
pnpm ingest:market
```

也可以显式锁定要封存的已完成交易日：

```bash
pnpm ingest:market -- --session-date=2026-08-21
```

The remote database contracts can be rerun against the linked Supabase project
without Docker. Every suite executes inside a transaction and rolls back its
fixtures:

```bash
pnpm test:db:remote
```

## Real initial-portfolio validation

Twofold does not synthesize opening holdings. Before an initial Futu
statement/tax-lot file is imported, bind a normalized
`twofold.initial_portfolio/v1` JSON snapshot to the exact original file bytes:

```bash
pnpm portfolio:validate -- \
  --snapshot=/absolute/path/to/normalized-portfolio.json \
  --source=/absolute/path/to/original-futu-statement-or-csv
```

The validator rejects JSON numbers, fractional shares, malformed dates,
duplicate lots, unverifiable source hashes, and unbalanced opening entries. It
is read-only and prints only the source-bound holdings summary; database import
remains a separate explicit step.

## Deterministic accepted-target cycle

The keyless Core now runs one accepted target through D-close S1 sells, strict
CNY FIFO tax reserve, S1-close S2 buys, one replayed ledger, and Broker /
Tax-reserved / Liquidation NAV. The result is byte-stable and content-addressed;
array order inside the hashed artifact is compared by code point so the content
address cannot depend on the host's ICU collation.

The private Arena Worker now owns the real-time DAG from Agent decision through
S1 order freeze, shared first-minute open reference, S1 close and tax-FX
settlement, S2 order freeze, S2 open/close evidence, atomic final cycle commit,
Liquidation NAV, and ranking. Each phase is durable, leased, prerequisite-gated,
deadline-aware, idempotent, and scheduled from the frozen exchange calendar.
Work completed after a frozen deadline is recorded as failure and can never
retroactively publish a simulated fill. Completion responses have an exact
database fingerprint, so transport retries cannot duplicate or alter a phase.
After every entrant reaches the shared S2 close, the Worker also provisions the
next non-overlapping Round from that exact close snapshot. It freezes a new
content-addressed Alpaca calendar, skips any already-missed decision cutoff, and
creates the Round, entrant seats, and full work DAG in one database transaction.
If one entrant's local Agent or settlement phase terminates, a separate recovery
queue preserves its ledger byte-for-byte, values the unchanged portfolio at the
same shared S2 close, publishes an explicit no-trade result beside its rank, and
allows the other entrants and next Round to continue. It never converts failed
work into a synthetic successful target, order, fill, or settlement.

Postgres validates exact identities and bytes, plan/order conservation,
ledger/NAV invariants, market-evidence bindings, run-stream CAS, and the strategy
ledger head. Final cycle publication and the S2-close ranking valuation commit in
one database transaction. Realized tax remains a conservative CNY accounting
reserve rather than a filed tax figure.

The private Arena can host multiple immutable Seasons. The original
three-symbol Season and an early failed Liquid 100 activation are retained as
audit evidence. The current Liquid 100 config freezes a real 100-stock US
liquid universe while preserving the same equal start: every entrant receives
an independent ledger with exactly `150 LULU` and zero cash.
Its decision packet carries the same 100-symbol close plus frozen 5/20/60-day
returns and 20-session median dollar volume. Submissions must hold 5–10 stocks,
cap each position at 20%, and retain at least 5% cash.

The Liquid 100 Season selects the v2 execution rulebook. It prices
against the shared Alpaca SIP first-minute VWAP and limits each integer fill to
the configured fraction of that minute's whole-share volume. Core derives the
partial fill and Postgres independently enforces the same capacity. The active
three-symbol Season remains immutable on v1.

To rebuild a future frozen pool from the four authoritative source feeds:

```bash
pnpm universe:liquid100 -- \
  --session-date=YYYY-MM-DD \
  --persist-snapshot \
  --season-config=config/private-us-liquid-100-s1.json
```

The generated artifact is content-addressed; registration refuses any config
whose inline universe differs from those exact bytes.

To activate a new Season from an existing frozen artifact and matching sealed
snapshot, prepare a future opening boundary first:

```bash
pnpm season:prepare:liquid100 -- \
  --artifact=config/universes/us-liquid-100-YYYY-MM-DD.json \
  --snapshot-id=<sealed-snapshot-uuid> \
  --season-code=private-us-liquid-100-s2 \
  --display-name="Private US Liquid 100 S2" \
  --output=config/private-us-liquid-100-s2.json \
  --activation-delay-minutes=15
```

Register the Season and initialize both accounts before registering its Round.
The preparation step rejects a snapshot whose session or exact 100-symbol set
differs from the artifact; it also gives deployment a bounded pre-open buffer.

The rollback-only release rehearsal is one command:

```bash
pnpm test:v2-season-rehearsal
```

Before S1, prove both immutable Round completeness and current Worker health:

```bash
TWOFOLD_WORKER_ID=twofold-vercel-arena pnpm round:readiness -- --round=1
```

The command is read-only and exits nonzero unless the configured Round has all
entrants, equal genesis-bound accounts, the exact eight-phase work DAG,
accepted decisions and frozen S1 plans, while the intended production Worker is
live on the same active Season with no operational alerts. It also rejects an
entrant fan-out that cannot drain on the frozen one-minute cadence with
dependency and retry reserve before every deadline.

To run the persistent competition loop, the Worker credential layer still needs
`DEEPSEEK_API_KEY` and the Worker process must remain running:

```bash
pnpm dev:arena-worker
```

Without that credential, Agent decision work remains visibly queued and no
fallback strategy is fabricated. `pnpm arena:tick` runs one observable lease
cycle; `pnpm dev:arena-worker` keeps all Agent, market, settlement, and Season
provisioning runners alive.

For the gated browser contract fixture (development only):

```bash
pnpm dev:e2e
# open http://127.0.0.1:3211/e2e-test/accepted-target-cycle
```

Production always returns 404 for this route.

The repeatable backend contract (Core cycle, Worker handoff, Dashboard schema,
and rollback-only remote Supabase commit) is one command:

```bash
pnpm test:e2e:cycle
```

The market-ingestion command requests `LULU,SPY,QQQ` with `timeframe=1Day`, `feed=sip`, and
`adjustment=raw`; archives the exact response in private content-addressed
Storage; follows all response pages; publishes decimal-string facts; and seals
a point-in-time snapshot for one common session date. It refuses to label a
same-day daily bar as complete before 16:20 America/New_York, and fails if
credentials, symbols, pages, facts, or the snapshot are incomplete.

For local dashboard reads of the private evidence tables, set
`TWOFOLD_LOCAL_DOGFOOD=true`. The root dev commands bind to `127.0.0.1`; the
dashboard ignores the service secret in production.

Copy environment templates rather than committing credentials. DeepSeek credentials belong in the Harness or worker credential layer, never in browser-visible variables or the event ledger.

See [docs/architecture.md](docs/architecture.md) for the runtime boundaries,
[docs/data-integration.md](docs/data-integration.md) for the evidence-chain and
Token/cost plan, and [docs/implementation-plan.md](docs/implementation-plan.md)
for staged delivery.
The exact implemented/not-yet-implemented boundary is tracked in
[docs/status.md](docs/status.md).
Start, restart, and missed-deadline operations are documented in
[docs/arena-runbook.md](docs/arena-runbook.md).
