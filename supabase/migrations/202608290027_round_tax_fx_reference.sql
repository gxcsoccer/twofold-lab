-- Tax-basis conversion is captured at settlement time from one shared ECB
-- reference cross. It is an ESTIMATED simulation input, never labelled a
-- final Chinese tax authority rate. Raw XML lives in the immutable artifact.

begin;

create table public.arena_round_tax_fx_reference (
  fx_reference_id uuid primary key,
  fact_id uuid not null unique,
  idempotency_key text not null unique check (idempotency_key <> ''),
  round_id uuid not null,
  season_id uuid not null,
  stage text not null check (stage in ('S1_DISPOSITION', 'S2_ACQUISITION')),
  source_version_id text not null
    check (source_version_id = 'ecb-eurofxref-hist-90d-v1'),
  source_artifact_id uuid not null,
  source_content_sha256 text not null check (
    source_content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  raw_body_sha256 text not null check (raw_body_sha256 ~ '^[0-9a-f]{64}$'),
  effective_date date not null,
  base_currency text not null check (base_currency = 'USD'),
  quote_currency text not null check (quote_currency = 'CNY'),
  cny_per_usd text not null check (
    cny_per_usd ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    and cny_per_usd::numeric > 0
  ),
  authority text not null check (authority = 'ECB_REFERENCE_CROSS'),
  status text not null check (status = 'ESTIMATED'),
  observed_at timestamptz not null,
  available_at timestamptz not null check (available_at >= observed_at),
  cross_canonical_json text not null check (cross_canonical_json <> ''),
  cross_evidence jsonb not null,
  cross_sha256 text not null check (cross_sha256 ~ '^[0-9a-f]{64}$'),
  bound_by text not null check (bound_by <> ''),
  bound_at timestamptz not null default clock_timestamp(),
  constraint arena_round_tax_fx_round_fk foreign key (round_id, season_id)
    references public.arena_round(round_id, season_id),
  constraint arena_round_tax_fx_artifact_fk foreign key (
    source_artifact_id, source_content_sha256
  ) references public.artifact_metadata(artifact_id, sha256),
  constraint arena_round_tax_fx_stage_unique unique (round_id, stage),
  constraint arena_round_tax_fx_id_deterministic check (
    fx_reference_id = public.deterministic_uuid_from_sha256(
      'twofold.arena_round_tax_fx_reference/v1', round_id::text || ':' || stage
    )
  ),
  constraint arena_round_tax_fx_fact_id_deterministic check (
    fact_id = public.deterministic_uuid_from_sha256(
      'twofold.arena_round_tax_fx_fact/v1', round_id::text || ':' || stage
    )
  ),
  constraint arena_round_tax_fx_cross_object check (
    jsonb_typeof(cross_evidence) = 'object'
  ),
  constraint arena_round_tax_fx_cross_decimal_safe check (
    not public.jsonb_contains_number(cross_evidence)
  ),
  constraint arena_round_tax_fx_cross_exact check (
    cross_evidence = cross_canonical_json::jsonb
    and cross_sha256 = encode(
      extensions.digest(convert_to(cross_canonical_json, 'UTF8'), 'sha256'),
      'hex'
    )
  )
);

comment on table public.arena_round_tax_fx_reference is
  'One raw-artifact-backed ECB USD/CNY estimated reference shared by every entrant at each Round settlement stage.';

create trigger arena_round_tax_fx_reference_is_immutable
before update or delete on public.arena_round_tax_fx_reference
for each row execute function public.reject_immutable_mutation();
create trigger arena_round_tax_fx_reference_rejects_truncate
before truncate on public.arena_round_tax_fx_reference
for each statement execute function public.reject_immutable_mutation();

create or replace function public.get_arena_round_tax_fx_reference(
  p_round_id uuid,
  p_stage text
)
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
set row_security = off
as $$
  select jsonb_build_object(
    'schema', 'twofold.arena_round_tax_fx_reference/v1',
    'roundId', reference.round_id::text,
    'seasonId', reference.season_id::text,
    'stage', reference.stage,
    'fxRateId', reference.fx_reference_id::text,
    'factId', reference.fact_id::text,
    'sourceVersionId', reference.source_version_id,
    'sourceArtifactId', reference.source_artifact_id::text,
    'sourceContentSha256', reference.source_content_sha256,
    'rawBodySha256', reference.raw_body_sha256,
    'baseCurrency', reference.base_currency,
    'quoteCurrency', reference.quote_currency,
    'cnyPerBaseUnit', reference.cny_per_usd,
    'effectiveAt', reference.effective_date::text || 'T00:00:00.000Z',
    'visibleAt', to_char(
      reference.available_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'status', reference.status,
    'authority', reference.authority,
    'crossSha256', reference.cross_sha256,
    'boundBy', reference.bound_by,
    'boundAt', to_char(
      reference.bound_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  )
  from public.arena_round_tax_fx_reference as reference
  where reference.round_id = p_round_id and reference.stage = p_stage
$$;

create or replace function public.register_arena_round_tax_fx_reference(
  p_idempotency_key text,
  p_round_id uuid,
  p_stage text,
  p_source_artifact_id uuid,
  p_source_artifact_sha256 text,
  p_raw_body_sha256 text,
  p_cross_canonical_json text,
  p_cross_sha256 text,
  p_recorded_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_round public.arena_round%rowtype;
  v_artifact public.artifact_metadata%rowtype;
  v_existing public.arena_round_tax_fx_reference%rowtype;
  v_cross jsonb;
  v_effective_date date;
  v_observed_at timestamptz;
  v_available_at timestamptz;
  v_stage_available_at timestamptz;
  v_stage_deadline_at timestamptz;
  v_expected_fields text[] := array[
    'authority', 'availableAt', 'cnyPerUsd', 'derivation', 'effectiveDate',
    'eurToCny', 'eurToUsd', 'observedAt', 'schema', 'status'
  ];
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_round_id is null
    or p_stage not in ('S1_DISPOSITION', 'S2_ACQUISITION')
    or p_source_artifact_id is null
    or p_source_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_raw_body_sha256 !~ '^[0-9a-f]{64}$'
    or p_cross_canonical_json is null or p_cross_canonical_json = ''
    or p_cross_sha256 !~ '^[0-9a-f]{64}$'
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid Arena tax-FX registration' using errcode = '22023';
  end if;
  begin
    v_cross := p_cross_canonical_json::jsonb;
    v_effective_date := (v_cross->>'effectiveDate')::date;
    v_observed_at := (v_cross->>'observedAt')::timestamptz;
    v_available_at := (v_cross->>'availableAt')::timestamptz;
  exception when others then
    raise exception 'Arena tax-FX cross is not valid canonical evidence'
      using errcode = '22023';
  end;
  if jsonb_typeof(v_cross) <> 'object'
    or public.jsonb_contains_number(v_cross)
    or not (v_cross ?& v_expected_fields)
    or v_cross - v_expected_fields <> '{}'::jsonb
    or exists (
      select 1 from jsonb_each(v_cross) as field(name, value)
       where jsonb_typeof(field.value) <> 'string'
    )
    or v_cross->>'schema' <> 'twofold.ecb_usd_cny_reference_cross/v1'
    or v_cross->>'derivation' <> 'EUR_CNY_DIV_EUR_USD_HALF_UP_12'
    or v_cross->>'authority' <> 'ECB_REFERENCE_CROSS'
    or v_cross->>'status' <> 'ESTIMATED'
    or v_cross->>'eurToUsd' !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    or v_cross->>'eurToCny' !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    or v_cross->>'cnyPerUsd' !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    or (v_cross->>'eurToUsd')::numeric <= 0
    or (v_cross->>'eurToCny')::numeric <= 0
    or (v_cross->>'cnyPerUsd')::numeric
      <> round((v_cross->>'eurToCny')::numeric
        / (v_cross->>'eurToUsd')::numeric, 12)
    or v_effective_date::text <> v_cross->>'effectiveDate'
    or to_char(v_observed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> v_cross->>'observedAt'
    or to_char(v_available_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> v_cross->>'availableAt'
    or v_available_at < v_observed_at
    or p_cross_sha256 <> encode(
      extensions.digest(convert_to(p_cross_canonical_json, 'UTF8'), 'sha256'),
      'hex'
    )
  then
    raise exception 'Arena tax-FX cross has invalid shape or derivation'
      using errcode = '22023';
  end if;

  select * into v_round from public.arena_round where round_id = p_round_id;
  select * into v_artifact from public.artifact_metadata
   where artifact_id = p_source_artifact_id
     and sha256 = p_source_artifact_sha256;
  if v_round.round_id is null or v_artifact.artifact_id is null
    or v_artifact.season_id is distinct from v_round.season_id
    or v_artifact.run_id is not null
    or v_artifact.artifact_kind <> 'official_tax_fx_rate'
    or v_artifact.storage_bucket <> 'twofold-private-artifacts'
    or v_artifact.content_type <> 'application/json'
    or v_artifact.object_path is distinct from
      'competition-sources/ecb/' || p_source_artifact_sha256 || '.json'
    or v_artifact.metadata->>'schema' <> 'twofold.ecb_reference_source/v1'
    or v_artifact.metadata->>'sourceUrl'
      <> 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml'
    or v_artifact.metadata->>'effectiveDate' <> v_effective_date::text
    or v_artifact.metadata->>'observedAt' <> v_cross->>'observedAt'
    or v_artifact.metadata->>'rawBodySha256' <> p_raw_body_sha256
  then
    raise exception 'Arena tax-FX source artifact is missing or mismatched'
      using errcode = '23503';
  end if;

  if p_stage = 'S1_DISPOSITION' then
    v_stage_available_at := v_round.s1_close_available_at;
    v_stage_deadline_at := v_round.s2_open_at;
    if v_effective_date <> v_round.s1_session_date then
      raise exception 'S1 disposition FX date differs from the Round'
        using errcode = '22023';
    end if;
  else
    v_stage_available_at := v_round.cycle_ready_at;
    v_stage_deadline_at := null;
    if v_effective_date <> v_round.s2_session_date then
      raise exception 'S2 acquisition FX date differs from the Round'
        using errcode = '22023';
    end if;
  end if;
  if v_observed_at < v_stage_available_at
    or (v_stage_deadline_at is not null and v_available_at > v_stage_deadline_at)
  then
    raise exception 'tax-FX was observed outside the frozen settlement window'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'arena-round-tax-fx:' || p_round_id::text || ':' || p_stage, 0
  ));
  select * into v_existing from public.arena_round_tax_fx_reference
   where idempotency_key = p_idempotency_key
      or (round_id = p_round_id and stage = p_stage)
   order by case when idempotency_key = p_idempotency_key then 0 else 1 end
   limit 1;
  if found then
    if v_existing.idempotency_key is distinct from p_idempotency_key
      or v_existing.round_id is distinct from p_round_id
      or v_existing.stage is distinct from p_stage
      or v_existing.source_artifact_id is distinct from p_source_artifact_id
      or v_existing.source_content_sha256
        is distinct from p_source_artifact_sha256
      or v_existing.raw_body_sha256 is distinct from p_raw_body_sha256
      or v_existing.cross_canonical_json
        is distinct from p_cross_canonical_json
      or v_existing.cross_sha256 is distinct from p_cross_sha256
      or v_existing.bound_by is distinct from p_recorded_by
    then
      raise exception 'Arena tax-FX identity was reused with different content'
        using errcode = '23505';
    end if;
    return public.get_arena_round_tax_fx_reference(p_round_id, p_stage);
  end if;

  insert into public.arena_round_tax_fx_reference (
    fx_reference_id, fact_id, idempotency_key, round_id, season_id, stage,
    source_version_id, source_artifact_id, source_content_sha256,
    raw_body_sha256, effective_date, base_currency, quote_currency,
    cny_per_usd, authority, status, observed_at, available_at,
    cross_canonical_json, cross_evidence, cross_sha256, bound_by
  ) values (
    public.deterministic_uuid_from_sha256(
      'twofold.arena_round_tax_fx_reference/v1', p_round_id::text || ':' || p_stage
    ),
    public.deterministic_uuid_from_sha256(
      'twofold.arena_round_tax_fx_fact/v1', p_round_id::text || ':' || p_stage
    ),
    p_idempotency_key, p_round_id, v_round.season_id, p_stage,
    'ecb-eurofxref-hist-90d-v1', p_source_artifact_id,
    p_source_artifact_sha256, p_raw_body_sha256, v_effective_date,
    'USD', 'CNY', v_cross->>'cnyPerUsd', 'ECB_REFERENCE_CROSS',
    'ESTIMATED', v_observed_at, v_available_at,
    p_cross_canonical_json, v_cross, p_cross_sha256, p_recorded_by
  );
  return public.get_arena_round_tax_fx_reference(p_round_id, p_stage);
end;
$$;

alter table public.arena_round_tax_fx_reference enable row level security;
revoke all on table public.arena_round_tax_fx_reference
  from public, anon, authenticated, service_role;
grant select on table public.arena_round_tax_fx_reference to service_role;
revoke all on function public.get_arena_round_tax_fx_reference(uuid, text)
  from public, anon, authenticated;
revoke all on function public.register_arena_round_tax_fx_reference(
  text, uuid, text, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.get_arena_round_tax_fx_reference(uuid, text)
  to service_role;
grant execute on function public.register_arena_round_tax_fx_reference(
  text, uuid, text, uuid, text, text, text, text, text
) to service_role;

commit;
