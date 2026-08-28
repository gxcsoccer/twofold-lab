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

Tested Worker primitives can register both frozen plans and commit that exact
cycle through one idempotent Supabase boundary. Postgres validates identity,
hashes, the plan bytes against the admitted frozen plans, stage/order
conservation, ledger/NAV invariants, run-stream CAS, and the strategy ledger head
before atomically publishing the immutable artifact, business event, and decision
projection. The head is locked, required to match the artifact's opening head,
advanced exactly once per settlement, and moved to the artifact's final head in
the same transaction, so two decisions in one run cannot derive from the same
balances.

These primitives are not wired into the dogfood runtime: nothing in the worker or
scheduler calls them, so no live path can commit a cycle yet.

The remote database now exposes one atomic settlement boundary for simulated
S2 USD BUY orders. Under a per-account ledger-head lock it re-derives current
cash, applies the lower of current and frozen buying power, derives the largest
affordable integer fill and frozen Futu fees, and commits the journal, lot,
acquisition CNY FX binding, outcome, and next hash-chain head in one transaction.
Zero-affordable orders become auditable cancellations without a fake fill.

The generic cycle handoff exists as tested primitives plus a deployed database
boundary; it is not connected to the live dogfood scheduler, which also cannot
authorize a real cycle yet: pre-positioned opening-account import, trusted
official-auction/FX ingestion, exchange calendars, and a real Futu statement
remain required. The handoff also spans three durable RPCs and is not atomic
across them, so a crash between plan registration and cycle commit leaves an
immutable plan that only a byte-identical re-derivation can follow. The older
per-fill database RPC still supports only atomic S2 BUY; S1 is committed as part
of the Core-derived replay artifact, not misrepresented as a per-fill SQL
settlement. Realized tax is an accounting balance in CNY only — the
trading-currency reserve shown as a NAV deduction is converted at each
disposition's own rate and is a conservative reserve, not a filed tax figure.
Alpaca daily bars are never admitted as official execution-price evidence, and no
test cycle is retained.

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
