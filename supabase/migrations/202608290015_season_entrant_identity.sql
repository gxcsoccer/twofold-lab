-- Durable competition identity. A Season is shared by entrants; one entrant
-- owns one stable Strategy Run for the Season, and that Run survives every
-- decision/Round. Runtime decisions must stop inventing a new run per call.

begin;

create table public.arena_season (
  season_id uuid primary key,
  idempotency_key text not null unique check (idempotency_key <> ''),
  season_code text not null unique check (
    season_code ~ '^[a-z0-9][a-z0-9._-]{1,63}$'
  ),
  display_name text not null check (display_name <> ''),
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  decision_cadence text not null check (
    decision_cadence = 'US_EQUITY_DAILY_AFTER_CLOSE'
  ),
  market_timezone text not null check (market_timezone = 'America/New_York'),
  config jsonb not null,
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint arena_season_window check (closes_at > opens_at),
  constraint arena_season_config_object check (jsonb_typeof(config) = 'object'),
  constraint arena_season_config_decimal_safe check (
    not public.jsonb_contains_number(config)
  )
);

comment on table public.arena_season is
  'Immutable shared competition scope and cadence. Operational state is derived from time/events, not mutable labels.';

create table public.season_entrant (
  entrant_id uuid primary key,
  idempotency_key text not null unique check (idempotency_key <> ''),
  season_id uuid not null references public.arena_season(season_id),
  entrant_code text not null check (
    entrant_code ~ '^[a-z0-9][a-z0-9._-]{1,63}$'
  ),
  run_id uuid not null unique references public.run_manifest(run_id),
  bundle_id text not null check (bundle_id <> ''),
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  preset_id text not null check (preset_id <> ''),
  provider text not null check (provider <> ''),
  model text not null check (model <> ''),
  execution_class text not null check (execution_class in (
    'ROOT_ONLY',
    'ORCHESTRATED'
  )),
  metadata jsonb not null,
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint season_entrant_code_unique unique (season_id, entrant_code),
  constraint season_entrant_run_unique unique (season_id, run_id),
  constraint season_entrant_metadata_object check (
    jsonb_typeof(metadata) = 'object'
  ),
  constraint season_entrant_metadata_decimal_safe check (
    not public.jsonb_contains_number(metadata)
  )
);

comment on table public.season_entrant is
  'Immutable entrant identity. One stable run_id carries the contestant account and ledger across every Round in one Season.';

alter table public.competition_genesis
  add constraint competition_genesis_season_fk
  foreign key (season_id) references public.arena_season(season_id);

create trigger arena_season_is_immutable
before update or delete on public.arena_season
for each row execute function public.reject_immutable_mutation();
create trigger arena_season_rejects_truncate
before truncate on public.arena_season
for each statement execute function public.reject_immutable_mutation();
create trigger season_entrant_is_immutable
before update or delete on public.season_entrant
for each row execute function public.reject_immutable_mutation();
create trigger season_entrant_rejects_truncate
before truncate on public.season_entrant
for each statement execute function public.reject_immutable_mutation();

create or replace function public.register_arena_season(
  p_idempotency_key text,
  p_season_id uuid,
  p_season_code text,
  p_display_name text,
  p_opens_at timestamptz,
  p_closes_at timestamptz,
  p_decision_cadence text,
  p_market_timezone text,
  p_config jsonb,
  p_recorded_by text
)
returns public.arena_season
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_existing public.arena_season%rowtype;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_season_id is null
    or p_season_code is null
      or p_season_code !~ '^[a-z0-9][a-z0-9._-]{1,63}$'
    or p_display_name is null or btrim(p_display_name) = ''
    or p_opens_at is null or p_closes_at is null
      or p_closes_at <= p_opens_at
    or p_decision_cadence
      is distinct from 'US_EQUITY_DAILY_AFTER_CLOSE'
    or p_market_timezone is distinct from 'America/New_York'
    or jsonb_typeof(p_config) is distinct from 'object'
    or public.jsonb_contains_number(p_config)
    or p_recorded_by is null or btrim(p_recorded_by) = ''
  then
    raise exception 'invalid immutable Arena Season'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('twofold-arena-season', 0));
  select * into v_existing
    from public.arena_season
   where idempotency_key = p_idempotency_key
      or season_id = p_season_id
      or season_code = p_season_code
   order by (idempotency_key = p_idempotency_key) desc
   limit 1;
  if found then
    if v_existing.season_id is distinct from p_season_id
      or v_existing.season_code is distinct from p_season_code
      or v_existing.display_name is distinct from p_display_name
      or v_existing.opens_at is distinct from p_opens_at
      or v_existing.closes_at is distinct from p_closes_at
      or v_existing.decision_cadence is distinct from p_decision_cadence
      or v_existing.market_timezone is distinct from p_market_timezone
      or v_existing.config is distinct from p_config
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'Arena Season identity was reused with different content'
        using errcode = '23505';
    end if;
    return v_existing;
  end if;

  insert into public.arena_season (
    season_id, idempotency_key, season_code, display_name, opens_at,
    closes_at, decision_cadence, market_timezone, config, recorded_by
  ) values (
    p_season_id, p_idempotency_key, p_season_code, p_display_name,
    p_opens_at, p_closes_at, p_decision_cadence, p_market_timezone,
    p_config, p_recorded_by
  ) returning * into v_existing;
  return v_existing;
end;
$$;

create or replace function public.register_season_entrant(
  p_idempotency_key text,
  p_entrant_id uuid,
  p_season_id uuid,
  p_entrant_code text,
  p_run_id uuid,
  p_bundle_id text,
  p_bundle_sha256 text,
  p_preset_id text,
  p_provider text,
  p_model text,
  p_execution_class text,
  p_metadata jsonb,
  p_recorded_by text
)
returns public.season_entrant
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_existing public.season_entrant%rowtype;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_entrant_id is null or p_season_id is null
    or p_entrant_code is null
      or p_entrant_code !~ '^[a-z0-9][a-z0-9._-]{1,63}$'
    or p_run_id is null
    or p_bundle_id is null or btrim(p_bundle_id) = ''
    or p_bundle_sha256 is null or p_bundle_sha256 !~ '^[0-9a-f]{64}$'
    or p_preset_id is null or btrim(p_preset_id) = ''
    or p_provider is null or btrim(p_provider) = ''
    or p_model is null or btrim(p_model) = ''
    or p_execution_class not in ('ROOT_ONLY', 'ORCHESTRATED')
    or jsonb_typeof(p_metadata) is distinct from 'object'
    or public.jsonb_contains_number(p_metadata)
    or p_recorded_by is null or btrim(p_recorded_by) = ''
  then
    raise exception 'invalid immutable Season entrant'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.arena_season where season_id = p_season_id
  ) or not exists (
    select 1 from public.run_manifest where run_id = p_run_id
  ) then
    raise exception 'Season entrant requires its Season and Run manifest'
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('twofold-season-entrant', 0));
  select * into v_existing
    from public.season_entrant
   where idempotency_key = p_idempotency_key
      or entrant_id = p_entrant_id
      or run_id = p_run_id
      or (season_id = p_season_id and entrant_code = p_entrant_code)
   order by (idempotency_key = p_idempotency_key) desc
   limit 1;
  if found then
    if v_existing.entrant_id is distinct from p_entrant_id
      or v_existing.season_id is distinct from p_season_id
      or v_existing.entrant_code is distinct from p_entrant_code
      or v_existing.run_id is distinct from p_run_id
      or v_existing.bundle_id is distinct from p_bundle_id
      or v_existing.bundle_sha256 is distinct from p_bundle_sha256
      or v_existing.preset_id is distinct from p_preset_id
      or v_existing.provider is distinct from p_provider
      or v_existing.model is distinct from p_model
      or v_existing.execution_class is distinct from p_execution_class
      or v_existing.metadata is distinct from p_metadata
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'Season entrant identity was reused with different content'
        using errcode = '23505';
    end if;
    return v_existing;
  end if;

  insert into public.season_entrant (
    entrant_id, idempotency_key, season_id, entrant_code, run_id,
    bundle_id, bundle_sha256, preset_id, provider, model, execution_class,
    metadata, recorded_by
  ) values (
    p_entrant_id, p_idempotency_key, p_season_id, p_entrant_code, p_run_id,
    p_bundle_id, p_bundle_sha256, p_preset_id, p_provider, p_model,
    p_execution_class, p_metadata, p_recorded_by
  ) returning * into v_existing;
  return v_existing;
end;
$$;

alter table public.arena_season enable row level security;
alter table public.season_entrant enable row level security;
revoke all on table public.arena_season
  from public, anon, authenticated, service_role;
revoke all on table public.season_entrant
  from public, anon, authenticated, service_role;
grant select on table public.arena_season to service_role;
grant select on table public.season_entrant to service_role;

revoke all on function public.register_arena_season(
  text, uuid, text, text, timestamptz, timestamptz, text, text, jsonb, text
) from public, anon, authenticated;
revoke all on function public.register_season_entrant(
  text, uuid, uuid, text, uuid, text, text, text, text, text, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.register_arena_season(
  text, uuid, text, text, timestamptz, timestamptz, text, text, jsonb, text
) to service_role;
grant execute on function public.register_season_entrant(
  text, uuid, uuid, text, uuid, text, text, text, text, text, text, jsonb, text
) to service_role;

commit;
