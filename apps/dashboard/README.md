# Twofold Lab dashboard

Read-only operational console for real market-data evidence, Season status,
Strategy Runs, the immutable audit stream, and versioned settings. Runtime
fixtures and demo fallbacks are intentionally absent: missing credentials,
deliveries, snapshots, or projections remain visibly unavailable.

## Environment

Copy `.env.example` to `.env.local` when a Supabase project is available. The
server may use a server-only secret only when `NODE_ENV` is not `production`
and `TWOFOLD_LOCAL_DOGFOOD=true`; it must never be prefixed with
`NEXT_PUBLIC_`. The dashboard ignores that secret in production. Production
onboarding requires Supabase Auth and least-privilege reads.

`/data` reads the latest immutable Alpaca source version and sealed market
snapshot, then follows snapshot members to their facts and exact contributing
delivery/fact edges, delivery observations, and Raw artifacts available by the
snapshot cutoff. It never attaches an unrelated "latest delivery" to snapshot
evidence. If any layer is absent or inconsistent, the page fails closed instead
of synthesizing data.

The worker writes dashboard state into the shared `public.projection` table
using these projection names:

- `dashboard.season_overview` — latest row wins;
- `dashboard.run_detail` — `entity_id` is the Run UUID;
- `dashboard.audit` — latest row wins;
- `dashboard.settings` — latest row wins.
- `dashboard.arena_decision` — `entity_id` is the exact Decision UUID; the
  `/arena/decisions/[decisionId]` route never falls back to the latest row.

Arena decision state must satisfy the complete runtime-validated
`schemaVersion: "1"` contract before any Agent node is rendered. Projection row
metadata (`state_hash`, `last_event_id`, and `updated_at`) is displayed as
separate read evidence, not merged into authoritative state. Missing rows remain
`NOT_READY`; malformed or internally inconsistent trees fail closed.

Every numeric business value inside `state` is a canonical decimal string.
Realtime subscriptions only invalidate the UI and trigger a refetch; they are
not treated as the ledger or a command queue.

Model credentials do not belong in this app. They are injected into the
private Harness worker at runtime and are never returned to the browser.
