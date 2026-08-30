-- Add a dormant v2 execution policy and immutable first-minute VWAP/volume
-- evidence. Existing v1 Seasons keep their exact payload and response shapes.

begin;

alter table public.arena_execution_rulebook
  drop constraint arena_execution_rulebook_rulebook_schema_check,
  add constraint arena_execution_rulebook_rulebook_schema_check check (
    rulebook_schema in (
      'twofold.arena_execution_rulebook/v1',
      'twofold.arena_execution_rulebook/v2'
    )
  );

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
  v_schema text;
  v_is_volume_participation boolean;
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
  v_schema := v_rulebook->>'schema';
  v_is_volume_participation :=
    v_schema = 'twofold.arena_execution_rulebook/v2';
  if jsonb_typeof(v_rulebook) <> 'object'
    or public.jsonb_contains_number(v_rulebook)
    or v_schema is null
    or v_schema not in (
      'twofold.arena_execution_rulebook/v1',
      'twofold.arena_execution_rulebook/v2'
    )
    or not (v_rulebook ?& array[
      'schema', 'executionModel', 'openReferenceMethod', 'slippageBps',
      'fillPriceScale', 'feeScheduleId', 'taxRulesetId',
      'taxAllocationScale', 'rankingNav'
    ]::text[])
    or (
      v_is_volume_participation
      and (
        not (v_rulebook ? 'maxParticipationBps')
        or (select count(*) from jsonb_object_keys(v_rulebook)) <> 10
        or v_rulebook->>'executionModel'
          <> 'SIMULATED_MINUTE_PARTICIPATION'
        or v_rulebook->>'openReferenceMethod'
          <> 'ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE'
        or v_rulebook->>'maxParticipationBps'
          !~ '^([1-9][0-9]{0,3}|10000)$'
        or (v_rulebook->>'maxParticipationBps')::integer not between 1 and 10000
      )
    )
    or (
      not v_is_volume_participation
      and (
        (select count(*) from jsonb_object_keys(v_rulebook)) <> 9
        or v_rulebook->>'executionModel' <> 'SIMULATED_SLIPPAGE'
        or v_rulebook->>'openReferenceMethod'
          <> 'ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE'
      )
    )
    or exists (
      select 1 from jsonb_each(v_rulebook) as field(name, value)
       where jsonb_typeof(field.value) <> 'string'
    )
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
    raise exception 'Arena execution rulebook violates the supported policy'
      using errcode = '22023';
  end if;

  -- Keep the Season identity namespace stable across policy schema revisions.
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
      or v_existing.rulebook_schema is distinct from v_schema
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
      v_schema, p_rulebook_canonical_json,
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

alter table public.market_open_reference_snapshot
  drop constraint market_open_reference_snapshot_method_check,
  add constraint market_open_reference_snapshot_method_check check (
    method in (
      'ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE',
      'ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE'
    )
  );

alter table public.market_open_reference_fact
  add column observed_volume text,
  add constraint market_open_reference_fact_observed_volume_check check (
    observed_volume is null or observed_volume ~ '^(0|[1-9][0-9]*)$'
  );

create or replace function public.get_arena_round_open_reference(
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
    'schema', case
      when snapshot.method = 'ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE'
        then 'twofold.arena_round_open_reference/v2'
      else 'twofold.arena_round_open_reference/v1'
    end,
    'roundId', binding.round_id::text,
    'seasonId', binding.season_id::text,
    'stage', binding.stage,
    'referenceSnapshotId', snapshot.reference_snapshot_id::text,
    'sourceVersionId', snapshot.source_version_id::text,
    'sourceArtifactId', snapshot.raw_artifact_id::text,
    'sourceContentSha256', artifact.response_sha256,
    'requestFingerprint', snapshot.request_fingerprint,
    'method', snapshot.method,
    'sessionDate', snapshot.session_date::text,
    'expectedOpenAt', to_char(
      snapshot.expected_open_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'observedAt', to_char(
      snapshot.observed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'contentSha256', snapshot.content_sha256,
    'references', coalesce((
      select jsonb_agg(
        case
          when snapshot.method
            = 'ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE'
          then jsonb_build_object(
            'factId', fact.fact_id::text,
            'symbol', fact.symbol,
            'barStart', to_char(
              fact.bar_start at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ),
            'sessionDate', fact.session_date::text,
            'currency', fact.currency,
            'value', fact.value,
            'observedVolume', fact.observed_volume,
            'factSha256', fact.fact_sha256
          )
          else jsonb_build_object(
            'factId', fact.fact_id::text,
            'symbol', fact.symbol,
            'barStart', to_char(
              fact.bar_start at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ),
            'sessionDate', fact.session_date::text,
            'currency', fact.currency,
            'value', fact.value,
            'factSha256', fact.fact_sha256
          )
        end order by fact.fact_index
      )
      from public.market_open_reference_fact as fact
      where fact.reference_snapshot_id = snapshot.reference_snapshot_id
    ), '[]'::jsonb),
    'boundBy', binding.bound_by,
    'boundAt', to_char(
      binding.bound_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  )
  from public.arena_round_open_reference as binding
  join public.market_open_reference_snapshot as snapshot
    on snapshot.reference_snapshot_id = binding.reference_snapshot_id
  join public.raw_artifact as artifact
    on artifact.raw_artifact_id = snapshot.raw_artifact_id
  where binding.round_id = p_round_id and binding.stage = p_stage
$$;

create or replace function public.register_arena_round_open_reference(
  p_idempotency_key text,
  p_round_id uuid,
  p_stage text,
  p_source_version_id uuid,
  p_storage_bucket text,
  p_object_path text,
  p_byte_size bigint,
  p_response_sha256 text,
  p_canonical_json text,
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
  v_rulebook public.arena_execution_rulebook%rowtype;
  v_source public.data_source_version%rowtype;
  v_artifact public.raw_artifact%rowtype;
  v_existing public.market_open_reference_snapshot%rowtype;
  v_snapshot public.market_open_reference_snapshot%rowtype;
  v_binding public.arena_round_open_reference%rowtype;
  v_payload jsonb;
  v_content_sha256 text;
  v_reference_snapshot_id uuid;
  v_expected_open_at timestamptz;
  v_observed_at timestamptz;
  v_session_date date;
  v_symbols text[];
  v_expected_symbols text[];
  v_available_at timestamptz;
  v_stage_deadline timestamptz;
  v_reference jsonb;
  v_index integer;
  v_expected_fact_sha256 text;
  v_fact_id uuid;
  v_is_volume_participation boolean;
  v_all_fields text[] := array[
    'expectedOpenAt', 'feed', 'method', 'observedAt', 'references',
    'requestFingerprint', 'responseSha256', 'schema', 'sessionDate',
    'sourceVersionKey'
  ];
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_round_id is null
    or p_stage not in ('S1_OPEN_REFERENCE', 'S2_OPEN_REFERENCE')
    or p_source_version_id is null
    or p_storage_bucket is distinct from 'twofold-private-artifacts'
    or p_response_sha256 !~ '^[0-9a-f]{64}$'
    or p_object_path is distinct from (
      'raw/alpaca/' || left(p_response_sha256, 2) || '/'
        || p_response_sha256 || '.json'
    )
    or p_byte_size is null or p_byte_size <= 0
    or p_canonical_json is null or p_canonical_json = ''
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid Arena open-reference registration'
      using errcode = '22023';
  end if;
  begin
    v_payload := p_canonical_json::jsonb;
  exception when others then
    raise exception 'Arena open reference is not valid JSON'
      using errcode = '22023';
  end;
  v_is_volume_participation :=
    v_payload->>'schema' = 'twofold.alpaca_open_reference_delivery/v2';
  if jsonb_typeof(v_payload) <> 'object'
    or public.jsonb_contains_number(v_payload)
    or not (v_payload ?& v_all_fields)
    or v_payload - v_all_fields <> '{}'::jsonb
    or v_payload->>'schema' is null
    or v_payload->>'schema' not in (
      'twofold.alpaca_open_reference_delivery/v1',
      'twofold.alpaca_open_reference_delivery/v2'
    )
    or (
      v_is_volume_participation
      and v_payload->>'method'
        <> 'ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE'
    )
    or (
      not v_is_volume_participation
      and v_payload->>'method'
        <> 'ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE'
    )
    or v_payload->>'responseSha256' <> p_response_sha256
    or v_payload->>'requestFingerprint' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(v_payload->'references') <> 'array'
    or jsonb_array_length(v_payload->'references') = 0
  then
    raise exception 'Arena open-reference payload has an invalid shape'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_payload->'references') as item(value)
     where jsonb_typeof(item.value) <> 'object'
       or (
         v_is_volume_participation
         and (
           not (item.value ?& array[
             'barStart', 'currency', 'factSha256', 'symbol', 'value',
             'observedVolume'
           ])
           or item.value - array[
             'barStart', 'currency', 'factSha256', 'symbol', 'value',
             'observedVolume'
           ] <> '{}'::jsonb
         )
       )
       or (
         not v_is_volume_participation
         and (
           not (item.value ?& array[
             'barStart', 'currency', 'factSha256', 'symbol', 'value'
           ])
           or item.value - array[
             'barStart', 'currency', 'factSha256', 'symbol', 'value'
           ] <> '{}'::jsonb
         )
       )
       or exists (
         select 1 from jsonb_each(item.value) as field(name, value)
          where jsonb_typeof(field.value) <> 'string'
       )
  ) then
    raise exception 'Arena open-reference fact has an invalid shape'
      using errcode = '22023';
  end if;

  begin
    v_expected_open_at := (v_payload->>'expectedOpenAt')::timestamptz;
    v_observed_at := (v_payload->>'observedAt')::timestamptz;
    v_session_date := (v_payload->>'sessionDate')::date;
  exception when others then
    raise exception 'Arena open-reference timing is invalid'
      using errcode = '22023';
  end;
  if to_char(v_expected_open_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> v_payload->>'expectedOpenAt'
    or to_char(v_observed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> v_payload->>'observedAt'
    or v_session_date::text <> v_payload->>'sessionDate'
    or v_session_date <> (v_expected_open_at at time zone 'UTC')::date
  then
    raise exception 'Arena open-reference timing is not canonical'
      using errcode = '22023';
  end if;

  select source.* into v_source from public.data_source_version as source
   where source.source_version_id = p_source_version_id;
  select round.* into v_round from public.arena_round as round
   where round.round_id = p_round_id;
  select rulebook.* into v_rulebook
    from public.arena_execution_rulebook as rulebook
   where rulebook.season_id = v_round.season_id;
  if v_source.source_version_id is null or v_round.round_id is null
    or v_rulebook.rulebook_id is null
    or v_source.provider <> 'alpaca'
    or v_source.dataset <> 'us_stock_intraday_open_references'
    or v_source.timeframe <> '1Min'
    or v_source.adjustment <> 'raw'
    or v_payload->>'feed' <> v_source.feed
    or v_payload->>'sourceVersionKey' <> v_source.version_key
    or v_payload->>'method' <> v_rulebook.rulebook->>'openReferenceMethod'
  then
    raise exception 'Arena open-reference source, rulebook, or Round is invalid'
      using errcode = '23503';
  end if;
  select snapshot.symbols into v_expected_symbols
    from public.market_snapshot as snapshot
   where snapshot.snapshot_id = v_round.decision_snapshot_id;
  if p_stage = 'S1_OPEN_REFERENCE' then
    v_available_at := v_round.s1_reference_available_at;
    v_stage_deadline := v_round.s1_close_at;
    if v_session_date <> v_round.s1_session_date
      or v_expected_open_at <> v_round.s1_open_at
    then
      raise exception 'S1 open reference does not match the frozen Round'
        using errcode = '22023';
    end if;
  else
    v_available_at := v_round.s2_reference_available_at;
    v_stage_deadline := v_round.s2_close_at;
    if v_session_date <> v_round.s2_session_date
      or v_expected_open_at <> v_round.s2_open_at
    then
      raise exception 'S2 open reference does not match the frozen Round'
        using errcode = '22023';
    end if;
  end if;
  if v_observed_at < v_available_at or v_observed_at > v_stage_deadline then
    raise exception 'open reference was observed outside the frozen window'
      using errcode = '22023';
  end if;

  select array_agg(item.value->>'symbol' order by item.ordinality)
    into v_symbols
    from jsonb_array_elements(v_payload->'references') with ordinality
      as item(value, ordinality);
  if v_symbols is distinct from v_expected_symbols
    or exists (
      select 1 from unnest(v_symbols) with ordinality as symbol(value, ordinality)
       where ordinality > 1 and value <= v_symbols[ordinality - 1]
    )
  then
    raise exception 'open references must cover the exact sorted Round universe'
      using errcode = '22023';
  end if;

  for v_reference, v_index in
    select item.value, (item.ordinality - 1)::integer
      from jsonb_array_elements(v_payload->'references') with ordinality
        as item(value, ordinality)
     order by item.ordinality
  loop
    if v_reference->>'symbol' !~ '^[A-Z][A-Z0-9.-]{0,14}$'
      or v_reference->>'currency' <> 'USD'
      or v_reference->>'barStart' <> v_payload->>'expectedOpenAt'
      or v_reference->>'value'
        !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
      or (v_reference->>'value')::numeric <= 0
      or v_reference->>'factSha256' !~ '^[0-9a-f]{64}$'
      or (
        v_is_volume_participation
        and v_reference->>'observedVolume' !~ '^(0|[1-9][0-9]*)$'
      )
    then
      raise exception 'open-reference fact is not canonical'
        using errcode = '22023';
    end if;
    v_expected_fact_sha256 := encode(extensions.digest(convert_to(
      (v_reference->>'symbol') || chr(31)
        || (v_reference->>'barStart') || chr(31)
        || (v_reference->>'currency') || chr(31)
        || (v_reference->>'value') || chr(31)
        || case when v_is_volume_participation
             then (v_reference->>'observedVolume') || chr(31)
             else ''
           end
        || v_source.normalizer_version,
      'UTF8'
    ), 'sha256'), 'hex');
    if v_reference->>'factSha256' <> v_expected_fact_sha256 then
      raise exception 'open-reference fact hash does not match content'
        using errcode = '22023';
    end if;
  end loop;

  v_content_sha256 := encode(extensions.digest(
    convert_to(p_canonical_json, 'UTF8'), 'sha256'
  ), 'hex');
  v_reference_snapshot_id := public.deterministic_uuid_from_sha256(
    'twofold.market_open_reference_snapshot/v1', v_content_sha256
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'arena-open-reference:' || p_round_id::text || ':' || p_stage, 0
  ));
  select * into v_binding from public.arena_round_open_reference
   where round_id = p_round_id and stage = p_stage;
  if found then
    select * into strict v_existing from public.market_open_reference_snapshot
     where reference_snapshot_id = v_binding.reference_snapshot_id;
    if v_existing.reference_snapshot_id <> v_reference_snapshot_id
      or v_existing.canonical_json <> p_canonical_json
      or v_binding.bound_by <> p_recorded_by
    then
      raise exception 'Round open-reference stage already has different evidence'
        using errcode = '23505';
    end if;
    return public.get_arena_round_open_reference(p_round_id, p_stage);
  end if;

  select * into v_existing from public.market_open_reference_snapshot
   where idempotency_key = p_idempotency_key
      or reference_snapshot_id = v_reference_snapshot_id
   order by (idempotency_key = p_idempotency_key) desc
   limit 1;
  if found and (
    v_existing.source_version_id <> p_source_version_id
    or v_existing.canonical_json <> p_canonical_json
    or v_existing.recorded_by <> p_recorded_by
  ) then
    raise exception 'open-reference identity was reused with different content'
      using errcode = '23505';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'raw-artifact:' || p_response_sha256, 0
  ));
  select * into v_artifact from public.raw_artifact
   where response_sha256 = p_response_sha256;
  if found then
    if v_artifact.storage_bucket <> p_storage_bucket
      or v_artifact.object_path <> p_object_path
      or v_artifact.content_type <> 'application/json'
      or v_artifact.byte_size <> p_byte_size
    then
      raise exception 'raw open-reference artifact metadata changed'
        using errcode = '23505';
    end if;
  else
    insert into public.raw_artifact (
      storage_bucket, object_path, content_type, byte_size, response_sha256
    ) values (
      p_storage_bucket, p_object_path, 'application/json',
      p_byte_size, p_response_sha256
    ) returning * into v_artifact;
  end if;

  if v_existing.reference_snapshot_id is null then
    insert into public.market_open_reference_snapshot (
      reference_snapshot_id, idempotency_key, source_version_id,
      raw_artifact_id, request_fingerprint, method,
      session_date, expected_open_at, observed_at, symbols,
      canonical_json, delivery, content_sha256, recorded_by
    ) values (
      v_reference_snapshot_id, p_idempotency_key, p_source_version_id,
      v_artifact.raw_artifact_id, v_payload->>'requestFingerprint',
      v_payload->>'method', v_session_date, v_expected_open_at,
      v_observed_at, v_symbols, p_canonical_json, v_payload,
      v_content_sha256, p_recorded_by
    ) returning * into v_snapshot;

    for v_reference, v_index in
      select item.value, (item.ordinality - 1)::integer
        from jsonb_array_elements(v_payload->'references') with ordinality
          as item(value, ordinality)
       order by item.ordinality
    loop
      v_fact_id := public.deterministic_uuid_from_sha256(
        'twofold.market_open_reference_fact/v1',
        v_reference_snapshot_id::text || ':' || (v_reference->>'symbol')
      );
      insert into public.market_open_reference_fact (
        fact_id, reference_snapshot_id, symbol, bar_start, session_date,
        currency, value, observed_volume, fact_sha256, fact_index
      ) values (
        v_fact_id, v_reference_snapshot_id, v_reference->>'symbol',
        (v_reference->>'barStart')::timestamptz, v_session_date,
        v_reference->>'currency', v_reference->>'value',
        case when v_is_volume_participation
          then v_reference->>'observedVolume' else null end,
        v_reference->>'factSha256', v_index
      );
    end loop;
  else
    v_snapshot := v_existing;
  end if;

  insert into public.arena_round_open_reference (
    round_id, season_id, stage, reference_snapshot_id, bound_by
  ) values (
    v_round.round_id, v_round.season_id, p_stage,
    v_snapshot.reference_snapshot_id, p_recorded_by
  );
  return public.get_arena_round_open_reference(p_round_id, p_stage);
end;
$$;

comment on column public.market_open_reference_fact.observed_volume is
  'Canonical first-minute whole-share volume. Required only by the v2 participation-capped execution policy.';

commit;
