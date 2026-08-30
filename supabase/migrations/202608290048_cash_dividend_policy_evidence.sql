-- Cash dividends become account cash only from one season-shared, immutable
-- ECB cross and database-owned instrument/provider facts. The Worker derives
-- accounting bytes, but cannot choose a per-entrant FX rate or ticker policy.

begin;

create table public.corporate_action_dividend_fx_reference (
  fx_reference_id uuid primary key,
  fact_id uuid not null unique,
  idempotency_key text not null unique check (
    idempotency_key <> '' and idempotency_key = btrim(idempotency_key)
  ),
  season_id uuid not null references public.arena_season(season_id),
  source_action_id uuid not null,
  revision_sha256 text not null check (revision_sha256 ~ '^[0-9a-f]{64}$'),
  source_version_id text not null check (
    source_version_id = 'ecb-eurofxref-hist-90d-v1'
  ),
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
  bound_by text not null check (bound_by <> '' and bound_by = btrim(bound_by)),
  bound_at timestamptz not null default clock_timestamp(),
  foreign key (source_action_id, revision_sha256)
    references public.corporate_action_revision(source_action_id, revision_sha256),
  foreign key (source_artifact_id, source_content_sha256)
    references public.artifact_metadata(artifact_id, sha256),
  unique (season_id, source_action_id, revision_sha256),
  constraint corporate_action_dividend_fx_id_deterministic check (
    fx_reference_id = public.deterministic_uuid_from_sha256(
      'twofold.corporate_action_dividend_fx_reference/v1',
      season_id::text || ':' || source_action_id::text || ':' || revision_sha256
    )
  ),
  constraint corporate_action_dividend_fx_fact_id_deterministic check (
    fact_id = public.deterministic_uuid_from_sha256(
      'twofold.corporate_action_dividend_fx_fact/v1',
      season_id::text || ':' || source_action_id::text || ':' || revision_sha256
    )
  ),
  constraint corporate_action_dividend_fx_cross_exact check (
    jsonb_typeof(cross_evidence) = 'object'
    and not public.jsonb_contains_number(cross_evidence)
    and cross_evidence = cross_canonical_json::jsonb
    and cross_sha256 = encode(extensions.digest(
      convert_to(cross_canonical_json, 'UTF8'), 'sha256'
    ), 'hex')
  )
);

comment on table public.corporate_action_dividend_fx_reference is
  'One immutable ECB USD/CNY reference shared by every entrant for one payable cash-dividend revision. ESTIMATED describes the source; the bound application policy treats these frozen bytes as final evidence.';

create trigger corporate_action_dividend_fx_reference_is_immutable
before update or delete on public.corporate_action_dividend_fx_reference
for each row execute function public.reject_immutable_mutation();
create trigger corporate_action_dividend_fx_reference_rejects_truncate
before truncate on public.corporate_action_dividend_fx_reference
for each statement execute function public.reject_immutable_mutation();

create or replace function public.get_corporate_action_dividend_fx_reference(
  p_season_id uuid,
  p_source_action_id uuid,
  p_revision_sha256 text
)
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
set row_security = off
as $$
  select jsonb_build_object(
    'schema','twofold.corporate_action_dividend_fx_reference/v1',
    'seasonId',reference.season_id::text,
    'sourceActionId',reference.source_action_id::text,
    'revisionSha256',reference.revision_sha256,
    'fxRateId',reference.fx_reference_id::text,
    'factId',reference.fact_id::text,
    'sourceVersionId',reference.source_version_id,
    'sourceArtifactId',reference.source_artifact_id::text,
    'sourceContentSha256',reference.source_content_sha256,
    'rawBodySha256',reference.raw_body_sha256,
    'baseCurrency',reference.base_currency,
    'quoteCurrency',reference.quote_currency,
    'cnyPerBaseUnit',reference.cny_per_usd,
    'effectiveAt',reference.effective_date::text || 'T00:00:00.000Z',
    'visibleAt',to_char(reference.available_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'status','FINAL',
    'sourceStatus',reference.status,
    'authority',reference.authority,
    'crossSha256',reference.cross_sha256,
    'boundBy',reference.bound_by,
    'boundAt',to_char(reference.bound_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  from public.corporate_action_dividend_fx_reference as reference
  where reference.season_id = p_season_id
    and reference.source_action_id = p_source_action_id
    and reference.revision_sha256 = p_revision_sha256
$$;

create or replace function public.get_corporate_action_dividend_policy_material(
  p_season_id uuid,
  p_source_action_id uuid,
  p_revision_sha256 text,
  p_instrument_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_season public.arena_season%rowtype;
  v_revision public.corporate_action_revision%rowtype;
  v_instrument public.instrument%rowtype;
  v_currency text;
  v_subtype text;
  v_classification text;
begin
  select * into v_season from public.arena_season where season_id = p_season_id;
  select * into v_revision from public.corporate_action_revision
   where source_action_id = p_source_action_id
     and revision_sha256 = p_revision_sha256;
  select * into v_instrument from public.instrument
   where instrument_id = p_instrument_id;
  if v_season.season_id is null or v_revision.source_action_id is null
    or v_instrument.instrument_id is null
    or v_revision.action_type <> 'CASH_DIVIDEND'
    or v_revision.interpretation <> 'CASH_DIVIDEND'
    or v_revision.evidence_status <> 'COMPLETE'
    or v_revision.ex_date <
      (v_season.opens_at at time zone v_season.market_timezone)::date
    or v_revision.ex_date >
      (v_season.closes_at at time zone v_season.market_timezone)::date
    or not exists (
      select 1 from public.instrument_symbol_version as symbol
       where symbol.instrument_id = p_instrument_id
         and symbol.symbol = v_revision.symbol
         and symbol.effective_from <= v_revision.ex_date
         and (symbol.effective_to is null or symbol.effective_to > v_revision.ex_date)
    )
  then
    raise exception 'cash-dividend policy identity is invalid'
      using errcode = '23503';
  end if;
  v_currency := nullif(upper(btrim(v_revision.raw_action->>'currency')), '');
  v_subtype := nullif(lower(btrim(v_revision.raw_action->>'sub_type')), '');
  if v_currency is distinct from v_instrument.trading_currency
    or v_currency <> 'USD'
    or v_instrument.instrument_type not in ('common_stock','adr','etf')
    or v_instrument.issuer_tax_residency is null
    or v_subtype not in ('interest','return_of_capital') and v_subtype is not null
  then
    raise exception 'cash-dividend provider or instrument policy is incomplete'
      using errcode = '55000';
  end if;
  v_classification := case v_subtype
    when 'interest' then 'interest_related_dividend'
    when 'return_of_capital' then 'return_of_capital'
    else 'ordinary_dividend' end;
  return jsonb_build_object(
    'schema','twofold.corporate_action_dividend_policy_material/v1',
    'seasonId',p_season_id::text,
    'sourceActionId',p_source_action_id::text,
    'revisionSha256',p_revision_sha256,
    'instrumentId',p_instrument_id::text,
    'currency',v_currency,
    'instrumentKind',v_instrument.instrument_type,
    'issuerTaxResidenceCountry',v_instrument.issuer_tax_residency,
    'distributionClassification',v_classification,
    'foreignWithholdingRate',case
      when v_instrument.issuer_tax_residency = 'US'
        and v_classification = 'ordinary_dividend' then '0.1'
      else '0' end,
    'treatyOrLocalCapRate',case
      when v_instrument.issuer_tax_residency = 'US'
        and v_classification = 'ordinary_dividend' then '0.1'
      else '0' end,
    'foreignTaxCreditEvidenceStatus','EVIDENCE_PENDING'
  );
end;
$$;

create or replace function public.register_corporate_action_dividend_fx_reference(
  p_idempotency_key text,
  p_season_id uuid,
  p_source_action_id uuid,
  p_revision_sha256 text,
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
  v_season public.arena_season%rowtype;
  v_revision public.corporate_action_revision%rowtype;
  v_artifact public.artifact_metadata%rowtype;
  v_existing public.corporate_action_dividend_fx_reference%rowtype;
  v_cross jsonb;
  v_effective_date date;
  v_observed_at timestamptz;
  v_available_at timestamptz;
  v_payable_open timestamptz;
  v_expected_fields text[] := array[
    'authority','availableAt','cnyPerUsd','derivation','effectiveDate',
    'eurToCny','eurToUsd','observedAt','schema','status'
  ];
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_season_id is null or p_source_action_id is null
    or p_revision_sha256 !~ '^[0-9a-f]{64}$'
    or p_source_artifact_id is null
    or p_source_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_raw_body_sha256 !~ '^[0-9a-f]{64}$'
    or p_cross_canonical_json is null or p_cross_canonical_json = ''
    or p_cross_sha256 !~ '^[0-9a-f]{64}$'
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then raise exception 'invalid cash-dividend FX registration' using errcode = '22023';
  end if;
  begin
    v_cross := p_cross_canonical_json::jsonb;
    v_effective_date := (v_cross->>'effectiveDate')::date;
    v_observed_at := (v_cross->>'observedAt')::timestamptz;
    v_available_at := (v_cross->>'availableAt')::timestamptz;
  exception when others then
    raise exception 'cash-dividend FX cross is not valid evidence'
      using errcode = '22023';
  end;
  if jsonb_typeof(v_cross) <> 'object'
    or public.jsonb_contains_number(v_cross)
    or not (v_cross ?& v_expected_fields)
    or v_cross - v_expected_fields <> '{}'::jsonb
    or exists (select 1 from jsonb_each(v_cross) as field(name,value)
      where jsonb_typeof(field.value) <> 'string')
    or v_cross->>'schema' <> 'twofold.ecb_usd_cny_reference_cross/v1'
    or v_cross->>'derivation' <> 'EUR_CNY_DIV_EUR_USD_HALF_UP_12'
    or v_cross->>'authority' <> 'ECB_REFERENCE_CROSS'
    or v_cross->>'status' <> 'ESTIMATED'
    or v_cross->>'eurToUsd' !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    or v_cross->>'eurToCny' !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    or v_cross->>'cnyPerUsd' !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    or (v_cross->>'eurToUsd')::numeric <= 0
    or (v_cross->>'eurToCny')::numeric <= 0
    or (v_cross->>'cnyPerUsd')::numeric <> round(
      (v_cross->>'eurToCny')::numeric / (v_cross->>'eurToUsd')::numeric, 12)
    or v_effective_date::text <> v_cross->>'effectiveDate'
    or to_char(v_observed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> v_cross->>'observedAt'
    or to_char(v_available_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> v_cross->>'availableAt'
    or v_available_at < v_observed_at
    or p_cross_sha256 <> encode(extensions.digest(
      convert_to(p_cross_canonical_json, 'UTF8'), 'sha256'), 'hex')
  then raise exception 'cash-dividend FX cross has invalid shape or derivation'
    using errcode = '22023';
  end if;

  select * into v_season from public.arena_season where season_id = p_season_id;
  select * into v_revision from public.corporate_action_revision
   where source_action_id = p_source_action_id
     and revision_sha256 = p_revision_sha256;
  select * into v_artifact from public.artifact_metadata
   where artifact_id = p_source_artifact_id
     and sha256 = p_source_artifact_sha256;
  if v_season.season_id is null or v_revision.source_action_id is null
    or v_revision.action_type <> 'CASH_DIVIDEND'
    or v_revision.interpretation <> 'CASH_DIVIDEND'
    or v_revision.evidence_status <> 'COMPLETE'
    or v_revision.payable_date is null
    or nullif(upper(btrim(v_revision.raw_action->>'currency')), '') <> 'USD'
    or v_artifact.artifact_id is null
    or v_artifact.season_id is distinct from p_season_id
    or v_artifact.run_id is not null
    or v_artifact.artifact_kind <> 'official_tax_fx_rate'
    or v_artifact.storage_bucket <> 'twofold-private-artifacts'
    or v_artifact.content_type <> 'application/json'
    or v_artifact.object_path is distinct from
      'competition-sources/ecb/' || p_source_artifact_sha256 || '.json'
    or v_artifact.metadata->>'schema' <> 'twofold.ecb_reference_source/v1'
    or v_artifact.metadata->>'sourceUrl' <>
      'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml'
    or v_artifact.metadata->>'effectiveDate' <> v_effective_date::text
    or v_artifact.metadata->>'observedAt' <> v_cross->>'observedAt'
    or v_artifact.metadata->>'rawBodySha256' <> p_raw_body_sha256
  then raise exception 'cash-dividend FX source or action is missing or mismatched'
    using errcode = '23503';
  end if;
  v_payable_open := (v_revision.payable_date + time '09:30')
    at time zone v_season.market_timezone;
  if v_effective_date > v_revision.payable_date
    or v_effective_date < v_revision.payable_date - 7
    or v_observed_at < v_payable_open
  then raise exception 'cash-dividend FX crosses its payable-date fence'
    using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'corporate-action-dividend-fx:' || p_season_id::text || ':'
      || p_source_action_id::text || ':' || p_revision_sha256, 0));
  select * into v_existing from public.corporate_action_dividend_fx_reference
   where idempotency_key = p_idempotency_key
      or (season_id = p_season_id and source_action_id = p_source_action_id
        and revision_sha256 = p_revision_sha256)
   limit 1;
  if found then
    if v_existing.idempotency_key is distinct from p_idempotency_key
      or v_existing.source_artifact_id is distinct from p_source_artifact_id
      or v_existing.source_content_sha256 is distinct from p_source_artifact_sha256
      or v_existing.raw_body_sha256 is distinct from p_raw_body_sha256
      or v_existing.cross_canonical_json is distinct from p_cross_canonical_json
      or v_existing.cross_sha256 is distinct from p_cross_sha256
      or v_existing.bound_by is distinct from p_recorded_by
    then raise exception 'cash-dividend FX identity was reused with different content'
      using errcode = '23505';
    end if;
    return public.get_corporate_action_dividend_fx_reference(
      p_season_id,p_source_action_id,p_revision_sha256);
  end if;
  insert into public.corporate_action_dividend_fx_reference (
    fx_reference_id,fact_id,idempotency_key,season_id,source_action_id,
    revision_sha256,source_version_id,source_artifact_id,
    source_content_sha256,raw_body_sha256,effective_date,base_currency,
    quote_currency,cny_per_usd,authority,status,observed_at,available_at,
    cross_canonical_json,cross_evidence,cross_sha256,bound_by
  ) values (
    public.deterministic_uuid_from_sha256(
      'twofold.corporate_action_dividend_fx_reference/v1',
      p_season_id::text || ':' || p_source_action_id::text || ':' || p_revision_sha256),
    public.deterministic_uuid_from_sha256(
      'twofold.corporate_action_dividend_fx_fact/v1',
      p_season_id::text || ':' || p_source_action_id::text || ':' || p_revision_sha256),
    p_idempotency_key,p_season_id,p_source_action_id,p_revision_sha256,
    'ecb-eurofxref-hist-90d-v1',p_source_artifact_id,p_source_artifact_sha256,
    p_raw_body_sha256,v_effective_date,'USD','CNY',v_cross->>'cnyPerUsd',
    'ECB_REFERENCE_CROSS','ESTIMATED',v_observed_at,v_available_at,
    p_cross_canonical_json,v_cross,p_cross_sha256,p_recorded_by
  );
  return public.get_corporate_action_dividend_fx_reference(
    p_season_id,p_source_action_id,p_revision_sha256);
end;
$$;

create or replace function public.guard_cash_dividend_application_policy()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_season_id uuid;
  v_reference public.corporate_action_dividend_fx_reference%rowtype;
  v_policy jsonb;
  v_expected_fx jsonb;
begin
  if new.action_type <> 'CASH_DIVIDEND' then return new; end if;
  select entrant.season_id into v_season_id
    from public.season_entrant as entrant
    join public.arena_season as season on season.season_id = entrant.season_id
    join public.corporate_action_revision as revision
      on revision.source_action_id = new.source_action_id
     and revision.revision_sha256 = new.revision_sha256
   where entrant.run_id = new.run_id
     and revision.ex_date between
       (season.opens_at at time zone season.market_timezone)::date and
       (season.closes_at at time zone season.market_timezone)::date
   limit 1;
  select * into v_reference
    from public.corporate_action_dividend_fx_reference
   where season_id = v_season_id
     and source_action_id = new.source_action_id
     and revision_sha256 = new.revision_sha256;
  v_policy := new.application#>'{application,taxPolicy}';
  v_expected_fx := jsonb_build_object(
    'fxRateId',v_reference.fx_reference_id::text,
    'sourceContentSha256',v_reference.source_content_sha256,
    'baseCurrency',v_reference.base_currency,
    'quoteCurrency',v_reference.quote_currency,
    'cnyPerBaseUnit',v_reference.cny_per_usd,
    'effectiveAt',v_reference.effective_date::text || 'T00:00:00.000Z',
    'visibleAt',to_char(v_reference.available_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'status','FINAL'
  );
  if v_season_id is null or v_reference.fx_reference_id is null
    or jsonb_typeof(v_policy) <> 'object'
    or v_policy->>'schema' <> 'twofold.cash_dividend_tax_policy/v1'
    or v_policy->>'rulesetId' <>
      'cn_resident_direct_foreign_securities_strict_v1'
    or v_policy->>'cashScale' <> '2'
    or v_policy->>'taxScale' <> '8'
    or v_policy->>'reserveScale' <> '12'
    or v_policy->'fx' is distinct from v_expected_fx
  then raise exception 'cash-dividend application lacks the shared frozen policy'
    using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger corporate_action_application_dividend_policy_guard
before insert on public.corporate_action_account_application
for each row execute function public.guard_cash_dividend_application_policy();

alter table public.corporate_action_dividend_fx_reference enable row level security;
revoke all on table public.corporate_action_dividend_fx_reference
  from public,anon,authenticated,service_role;
grant select on table public.corporate_action_dividend_fx_reference to service_role;
revoke all on function public.get_corporate_action_dividend_fx_reference(uuid,uuid,text)
  from public,anon,authenticated;
revoke all on function public.get_corporate_action_dividend_policy_material(uuid,uuid,text,uuid)
  from public,anon,authenticated;
revoke all on function public.register_corporate_action_dividend_fx_reference(
  text,uuid,uuid,text,uuid,text,text,text,text,text
) from public,anon,authenticated;
revoke all on function public.guard_cash_dividend_application_policy()
  from public,anon,authenticated,service_role;
grant execute on function public.get_corporate_action_dividend_fx_reference(uuid,uuid,text)
  to service_role;
grant execute on function public.get_corporate_action_dividend_policy_material(uuid,uuid,text,uuid)
  to service_role;
grant execute on function public.register_corporate_action_dividend_fx_reference(
  text,uuid,uuid,text,uuid,text,text,text,text,text
) to service_role;

commit;
