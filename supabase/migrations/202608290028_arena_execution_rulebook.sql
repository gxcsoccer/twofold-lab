-- One immutable execution/ranking policy per Season. Agent output may choose
-- targets, but it can never choose its own fill model, slippage, fee schedule,
-- tax method, or ranking NAV.

begin;

create table public.arena_execution_rulebook (
  rulebook_id uuid primary key,
  idempotency_key text not null unique check (idempotency_key <> ''),
  season_id uuid not null unique references public.arena_season(season_id),
  rulebook_schema text not null check (
    rulebook_schema = 'twofold.arena_execution_rulebook/v1'
  ),
  rulebook_canonical_json text not null check (rulebook_canonical_json <> ''),
  rulebook jsonb not null,
  rulebook_sha256 text not null check (rulebook_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint arena_execution_rulebook_object check (
    jsonb_typeof(rulebook) = 'object'
  ),
  constraint arena_execution_rulebook_decimal_safe check (
    not public.jsonb_contains_number(rulebook)
  ),
  constraint arena_execution_rulebook_exact check (
    rulebook = rulebook_canonical_json::jsonb
    and rulebook_sha256 = encode(
      extensions.digest(
        convert_to(rulebook_canonical_json, 'UTF8'), 'sha256'
      ),
      'hex'
    )
  ),
  constraint arena_execution_rulebook_id_deterministic check (
    rulebook_id = public.deterministic_uuid_from_sha256(
      'twofold.arena_execution_rulebook/v1', season_id::text
    )
  )
);

comment on table public.arena_execution_rulebook is
  'Immutable Season-wide execution, fees, shadow-tax, and liquidation-ranking contract shared by every entrant.';

create trigger arena_execution_rulebook_is_immutable
before update or delete on public.arena_execution_rulebook
for each row execute function public.reject_immutable_mutation();
create trigger arena_execution_rulebook_rejects_truncate
before truncate on public.arena_execution_rulebook
for each statement execute function public.reject_immutable_mutation();

create or replace function public.register_arena_execution_rulebook(
  p_idempotency_key text,
  p_season_id uuid,
  p_rulebook_canonical_json text,
  p_rulebook_sha256 text,
  p_recorded_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_rulebook jsonb;
  v_existing public.arena_execution_rulebook%rowtype;
  v_rulebook_id uuid;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_season_id is null
    or p_rulebook_canonical_json is null or p_rulebook_canonical_json = ''
    or p_rulebook_canonical_json is distinct from btrim(p_rulebook_canonical_json)
    or p_rulebook_sha256 !~ '^[0-9a-f]{64}$'
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid Arena execution rulebook header'
      using errcode = '22023';
  end if;
  begin
    v_rulebook := p_rulebook_canonical_json::jsonb;
  exception when others then
    raise exception 'Arena execution rulebook is not valid JSON'
      using errcode = '22023';
  end;
  if jsonb_typeof(v_rulebook) <> 'object'
    or public.jsonb_contains_number(v_rulebook)
    or not (v_rulebook ?& array[
      'schema', 'executionModel', 'openReferenceMethod', 'slippageBps',
      'fillPriceScale', 'feeScheduleId', 'taxRulesetId',
      'taxAllocationScale', 'rankingNav'
    ]::text[])
    or (select count(*) from jsonb_object_keys(v_rulebook)) <> 9
    or exists (
      select 1 from jsonb_each(v_rulebook) as field(name, value)
       where jsonb_typeof(field.value) <> 'string'
    )
    or v_rulebook->>'schema'
      <> 'twofold.arena_execution_rulebook/v1'
    or v_rulebook->>'executionModel' <> 'SIMULATED_SLIPPAGE'
    or v_rulebook->>'openReferenceMethod'
      <> 'ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE'
    or v_rulebook->>'slippageBps' !~ '^(0|[1-9][0-9]{0,3}|10000)$'
    or (v_rulebook->>'slippageBps')::integer not between 0 and 10000
    or v_rulebook->>'fillPriceScale' !~ '^(0|[1-9]|1[0-2])$'
    or v_rulebook->>'feeScheduleId'
      <> 'futu_hk_us_equity_fixed_2026-08-23'
    or v_rulebook->>'taxRulesetId'
      <> 'cn_resident_direct_foreign_securities_strict_v1'
    or v_rulebook->>'taxAllocationScale' !~ '^(0|[1-9]|1[0-2])$'
    or v_rulebook->>'rankingNav' <> 'LIQUIDATION_NAV'
    or p_rulebook_sha256 <> encode(
      extensions.digest(
        convert_to(p_rulebook_canonical_json, 'UTF8'), 'sha256'
      ),
      'hex'
    )
    or not exists (
      select 1 from public.arena_season where season_id = p_season_id
    )
  then
    raise exception 'Arena execution rulebook violates the supported v1 policy'
      using errcode = '22023';
  end if;

  v_rulebook_id := public.deterministic_uuid_from_sha256(
    'twofold.arena_execution_rulebook/v1', p_season_id::text
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'arena-execution-rulebook:' || p_season_id::text, 0
  ));
  select * into v_existing from public.arena_execution_rulebook
   where idempotency_key = p_idempotency_key
      or rulebook_id = v_rulebook_id
      or season_id = p_season_id
   order by (idempotency_key = p_idempotency_key) desc
   limit 1;
  if found then
    if v_existing.idempotency_key is distinct from p_idempotency_key
      or v_existing.rulebook_id is distinct from v_rulebook_id
      or v_existing.season_id is distinct from p_season_id
      or v_existing.rulebook_canonical_json
        is distinct from p_rulebook_canonical_json
      or v_existing.rulebook is distinct from v_rulebook
      or v_existing.rulebook_sha256 is distinct from p_rulebook_sha256
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'Arena rulebook identity was reused with different content'
        using errcode = '23505';
    end if;
  else
    insert into public.arena_execution_rulebook (
      rulebook_id, idempotency_key, season_id, rulebook_schema,
      rulebook_canonical_json, rulebook, rulebook_sha256, recorded_by
    ) values (
      v_rulebook_id, p_idempotency_key, p_season_id,
      'twofold.arena_execution_rulebook/v1', p_rulebook_canonical_json,
      v_rulebook, p_rulebook_sha256, p_recorded_by
    ) returning * into v_existing;
  end if;

  return jsonb_build_object(
    'schema', 'twofold.arena_execution_rulebook_result/v1',
    'rulebookId', v_existing.rulebook_id::text,
    'seasonId', v_existing.season_id::text,
    'rulebookSha256', v_existing.rulebook_sha256,
    'rulebook', v_existing.rulebook,
    'recordedBy', v_existing.recorded_by,
    'recordedAt', to_char(
      v_existing.recorded_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
end;
$$;

alter table public.arena_execution_rulebook enable row level security;
revoke all on table public.arena_execution_rulebook
  from public, anon, authenticated, service_role;
grant select on table public.arena_execution_rulebook to service_role;
revoke all on function public.register_arena_execution_rulebook(
  text, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.register_arena_execution_rulebook(
  text, uuid, text, text, text
) to service_role;

commit;
