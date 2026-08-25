begin;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'twofold-private-artifacts',
  'twofold-private-artifacts',
  false,
  6291456,
  array['application/json']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

do $$
declare
  v_bucket_is_public boolean;
begin
  select bucket.public
    into v_bucket_is_public
    from storage.buckets as bucket
   where bucket.id = 'twofold-private-artifacts'
     and bucket.name = 'twofold-private-artifacts';

  if not found or v_bucket_is_public is distinct from false then
    raise exception 'twofold-private-artifacts must exist as a private bucket'
      using errcode = '55000';
  end if;
end;
$$;

create table public.data_source_version (
  source_version_id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('alpaca')),
  dataset text not null check (dataset in ('us_stock_daily_bars')),
  version_key text not null check (version_key <> ''),
  endpoint_base_url text not null check (endpoint_base_url ~ '^https://'),
  feed text not null check (feed in ('sip', 'iex')),
  adjustment text not null check (adjustment = 'raw'),
  timeframe text not null check (timeframe = '1Day'),
  normalizer_version text not null check (normalizer_version <> ''),
  license_scope text not null check (license_scope <> ''),
  config_sha256 text not null check (config_sha256 ~ '^[0-9a-f]{64}$'),
  effective_from timestamptz not null,
  registered_at timestamptz not null default clock_timestamp(),
  constraint data_source_version_key_unique
    unique (provider, dataset, version_key)
);

comment on table public.data_source_version is
  'Immutable provider/feed/normalizer contract frozen before market facts are ingested.';

create table public.raw_artifact (
  raw_artifact_id uuid primary key default gen_random_uuid(),
  storage_bucket text not null
    check (storage_bucket = 'twofold-private-artifacts'),
  object_path text not null check (object_path <> ''),
  content_type text not null check (content_type = 'application/json'),
  byte_size bigint not null check (byte_size > 0),
  response_sha256 text not null check (response_sha256 ~ '^[0-9a-f]{64}$'),
  first_stored_at timestamptz not null default clock_timestamp(),
  constraint raw_artifact_content_addressed_path check (
    object_path = 'raw/alpaca/' || left(response_sha256, 2) || '/'
      || response_sha256 || '.json'
  ),
  constraint raw_artifact_content_unique unique (response_sha256),
  constraint raw_artifact_object_unique unique (storage_bucket, object_path)
);

comment on table public.raw_artifact is
  'One immutable content-addressed Storage object. Repeated observations reference this row instead of duplicating artifact identity.';

create table public.source_delivery (
  delivery_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key <> ''),
  source_version_id uuid not null
    references public.data_source_version(source_version_id),
  raw_artifact_id uuid not null
    references public.raw_artifact(raw_artifact_id),
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_request_id text,
  http_status integer not null check (http_status between 200 and 299),
  retrieved_at timestamptz not null,
  first_observed_at timestamptz not null,
  available_at timestamptz not null,
  normalized_manifest_sha256 text not null
    check (normalized_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  etag text,
  last_modified text,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint source_delivery_observation_order check (
    retrieved_at >= first_observed_at
    and available_at >= retrieved_at
  )
);

comment on table public.source_delivery is
  'One immutable successful provider observation. Raw identity and canonical facts are linked separately so repeated bytes/facts remain observable.';

create index source_delivery_source_time_idx
  on public.source_delivery (
    source_version_id,
    available_at desc,
    retrieved_at desc,
    delivery_id
  );

create table public.market_bar_fact (
  fact_id uuid primary key default gen_random_uuid(),
  source_version_id uuid not null
    references public.data_source_version(source_version_id),
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.-]{0,14}$'),
  timeframe text not null check (timeframe = '1Day'),
  bar_start timestamptz not null,
  bar_date date not null,
  currency text not null check (currency = 'USD'),
  open_price text not null,
  high_price text not null,
  low_price text not null,
  close_price text not null,
  volume text not null,
  trade_count text not null,
  vwap text,
  normalizer_version text not null check (normalizer_version <> ''),
  fact_sha256 text not null check (fact_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint market_bar_fact_decimal_strings check (
    open_price ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    and high_price ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    and low_price ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    and close_price ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    and volume ~ '^(0|[1-9][0-9]*)$'
    and trade_count ~ '^(0|[1-9][0-9]*)$'
    and (vwap is null or vwap ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$')
  ),
  constraint market_bar_fact_positive_prices check (
    open_price::numeric > 0
    and high_price::numeric > 0
    and low_price::numeric > 0
    and close_price::numeric > 0
    and (vwap is null or vwap::numeric > 0)
  ),
  constraint market_bar_fact_time_consistency check (
    bar_date = (bar_start at time zone 'UTC')::date
  ),
  constraint market_bar_fact_ohlc_order check (
    high_price::numeric >= open_price::numeric
    and high_price::numeric >= low_price::numeric
    and high_price::numeric >= close_price::numeric
    and low_price::numeric <= open_price::numeric
    and low_price::numeric <= close_price::numeric
  ),
  constraint market_bar_fact_content_unique
    unique (source_version_id, fact_sha256)
);

comment on table public.market_bar_fact is
  'One immutable canonical Alpaca daily-bar fact. Observation timing belongs to source_delivery, not the fact.';

create index market_bar_fact_selection_idx
  on public.market_bar_fact (
    source_version_id,
    symbol,
    timeframe,
    bar_date,
    bar_start desc,
    fact_id
  );

create table public.delivery_fact (
  delivery_id uuid not null references public.source_delivery(delivery_id),
  fact_id uuid not null references public.market_bar_fact(fact_id),
  fact_index integer not null check (fact_index >= 0),
  primary key (delivery_id, fact_id),
  constraint delivery_fact_order_unique unique (delivery_id, fact_index)
);

comment on table public.delivery_fact is
  'Immutable many-to-many observation edge. Different deliveries may observe the same canonical market fact.';

create index delivery_fact_fact_idx
  on public.delivery_fact (fact_id, delivery_id);

create table public.market_snapshot (
  snapshot_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key <> ''),
  source_version_id uuid not null
    references public.data_source_version(source_version_id),
  snapshot_kind text not null check (snapshot_kind in ('market_close')),
  cutoff_at timestamptz not null,
  target_session_date date not null,
  symbols text[] not null check (cardinality(symbols) > 0),
  selection_policy text not null check (selection_policy <> ''),
  manifest_schema text not null
    check (manifest_schema = 'twofold.market_snapshot/v2'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  sealed_at timestamptz not null default clock_timestamp(),
  constraint market_snapshot_target_not_after_cutoff check (
    target_session_date <= (cutoff_at at time zone 'UTC')::date
  ),
  constraint market_snapshot_logical_unique unique (
    source_version_id,
    snapshot_kind,
    cutoff_at,
    target_session_date,
    symbols,
    selection_policy
  )
);

create table public.market_snapshot_member (
  snapshot_id uuid not null references public.market_snapshot(snapshot_id),
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.-]{0,14}$'),
  delivery_id uuid not null,
  fact_id uuid not null references public.market_bar_fact(fact_id),
  member_index integer not null check (member_index >= 0),
  primary key (snapshot_id, symbol),
  constraint market_snapshot_member_observation_fk
    foreign key (delivery_id, fact_id)
    references public.delivery_fact(delivery_id, fact_id),
  constraint market_snapshot_member_order_unique
    unique (snapshot_id, member_index),
  constraint market_snapshot_member_fact_unique
    unique (snapshot_id, fact_id)
);

comment on table public.market_snapshot is
  'Sealed point-in-time market snapshot for one explicit trading session. Members and reproducibility manifest are immutable.';

create trigger data_source_version_is_immutable
before update or delete on public.data_source_version
for each row execute function public.reject_immutable_mutation();

create trigger raw_artifact_is_immutable
before update or delete on public.raw_artifact
for each row execute function public.reject_immutable_mutation();

create trigger source_delivery_is_immutable
before update or delete on public.source_delivery
for each row execute function public.reject_immutable_mutation();

create trigger market_bar_fact_is_immutable
before update or delete on public.market_bar_fact
for each row execute function public.reject_immutable_mutation();

create trigger delivery_fact_is_immutable
before update or delete on public.delivery_fact
for each row execute function public.reject_immutable_mutation();

create trigger market_snapshot_is_immutable
before update or delete on public.market_snapshot
for each row execute function public.reject_immutable_mutation();

create trigger market_snapshot_member_is_immutable
before update or delete on public.market_snapshot_member
for each row execute function public.reject_immutable_mutation();

create or replace function public.register_data_source_version(
  p_provider text,
  p_dataset text,
  p_version_key text,
  p_endpoint_base_url text,
  p_feed text,
  p_adjustment text,
  p_timeframe text,
  p_normalizer_version text,
  p_license_scope text,
  p_config_sha256 text,
  p_effective_from timestamptz
)
returns public.data_source_version
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_existing public.data_source_version%rowtype;
  v_inserted public.data_source_version%rowtype;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(
      'data-source-version:' || p_provider || ':' || p_dataset || ':' || p_version_key,
      0
    )
  );

  select source.* into v_existing
    from public.data_source_version as source
   where source.provider = p_provider
     and source.dataset = p_dataset
     and source.version_key = p_version_key;

  if found then
    if v_existing.endpoint_base_url is distinct from p_endpoint_base_url
      or v_existing.feed is distinct from p_feed
      or v_existing.adjustment is distinct from p_adjustment
      or v_existing.timeframe is distinct from p_timeframe
      or v_existing.normalizer_version is distinct from p_normalizer_version
      or v_existing.license_scope is distinct from p_license_scope
      or v_existing.config_sha256 is distinct from p_config_sha256
      or v_existing.effective_from is distinct from p_effective_from
    then
      raise exception 'source version key was reused with different content'
        using errcode = '23505';
    end if;
    return v_existing;
  end if;

  insert into public.data_source_version (
    provider,
    dataset,
    version_key,
    endpoint_base_url,
    feed,
    adjustment,
    timeframe,
    normalizer_version,
    license_scope,
    config_sha256,
    effective_from
  ) values (
    p_provider,
    p_dataset,
    p_version_key,
    p_endpoint_base_url,
    p_feed,
    p_adjustment,
    p_timeframe,
    p_normalizer_version,
    p_license_scope,
    p_config_sha256,
    p_effective_from
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

create or replace function public.register_market_delivery(
  p_idempotency_key text,
  p_source_version_id uuid,
  p_request_fingerprint text,
  p_provider_request_id text,
  p_http_status integer,
  p_retrieved_at timestamptz,
  p_first_observed_at timestamptz,
  p_available_at timestamptz,
  p_storage_bucket text,
  p_object_path text,
  p_content_type text,
  p_byte_size bigint,
  p_response_sha256 text,
  p_normalized_manifest_sha256 text,
  p_etag text,
  p_last_modified text,
  p_facts jsonb
)
returns public.source_delivery
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_existing public.source_delivery%rowtype;
  v_inserted public.source_delivery%rowtype;
  v_source public.data_source_version%rowtype;
  v_artifact public.raw_artifact%rowtype;
  v_fact_row public.market_bar_fact%rowtype;
  v_input_fact jsonb;
  v_expected_fact_sha256 text;
  v_computed_manifest_sha256 text;
  v_fact_index integer;
begin
  if p_storage_bucket is distinct from 'twofold-private-artifacts'
    or p_object_path is distinct from (
      'raw/alpaca/' || left(p_response_sha256, 2) || '/'
        || p_response_sha256 || '.json'
    )
  then
    raise exception 'raw artifact must use the private content-addressed path'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
      from storage.buckets as bucket
     where bucket.id = 'twofold-private-artifacts'
       and bucket.name = 'twofold-private-artifacts'
       and bucket.public is false
  ) then
    raise exception 'twofold-private-artifacts is not a private bucket'
      using errcode = '55000';
  end if;

  if jsonb_typeof(p_facts) <> 'array'
    or jsonb_array_length(p_facts) = 0
    or public.jsonb_contains_number(p_facts)
  then
    raise exception 'facts must be a non-empty, number-free JSON array'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_facts) with ordinality as facts(item, item_index)
     where case
       when jsonb_typeof(facts.item) <> 'object' then true
       else (
         (select count(*) from jsonb_object_keys(facts.item)) <> 13
         or not (
           facts.item ?& array[
             'symbol', 'timeframe', 'barStart', 'barDate', 'currency',
             'openPrice', 'highPrice', 'lowPrice', 'closePrice', 'volume',
             'tradeCount', 'vwap', 'factSha256'
           ]
         )
         or exists (
           select 1
             from jsonb_each(facts.item) as fields(field_name, field_value)
            where jsonb_typeof(fields.field_value) <> 'string'
         )
       )
     end
  ) then
    raise exception 'each market fact must contain exactly the canonical string fields'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_facts) with ordinality as facts(item, item_index)
     where facts.item_index <> (
       select ordered.expected_index
         from (
           select candidate.item,
                  candidate.item_index,
                  row_number() over (
                    order by (candidate.item->>'symbol') collate "C",
                             (candidate.item->>'barStart') collate "C"
                  ) as expected_index
             from jsonb_array_elements(p_facts) with ordinality
               as candidate(item, item_index)
         ) as ordered
        where ordered.item_index = facts.item_index
     )
  ) then
    raise exception 'market facts must be sorted by symbol and barStart'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_facts) as facts(item)
     group by facts.item->>'symbol', facts.item->>'timeframe', facts.item->>'barStart'
    having count(*) > 1
  ) then
    raise exception 'a delivery cannot contain duplicate logical market facts'
      using errcode = '22023';
  end if;

  select source.* into strict v_source
    from public.data_source_version as source
   where source.source_version_id = p_source_version_id;

  if p_retrieved_at < v_source.effective_from then
    raise exception 'delivery predates the source-version effective window'
      using errcode = '22023';
  end if;

  for v_input_fact, v_fact_index in
    select facts.item, (facts.item_index - 1)::integer
      from jsonb_array_elements(p_facts) with ordinality as facts(item, item_index)
     order by facts.item_index
  loop
    if coalesce(v_input_fact->>'symbol', '') !~ '^[A-Z][A-Z0-9.-]{0,14}$'
      or v_input_fact->>'timeframe' is distinct from '1Day'
      or coalesce(v_input_fact->>'barStart', '')
        !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      or coalesce(v_input_fact->>'barDate', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or v_input_fact->>'currency' is distinct from 'USD'
      or coalesce(v_input_fact->>'openPrice', '') !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
      or coalesce(v_input_fact->>'highPrice', '') !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
      or coalesce(v_input_fact->>'lowPrice', '') !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
      or coalesce(v_input_fact->>'closePrice', '') !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
      or coalesce(v_input_fact->>'volume', '') !~ '^(0|[1-9][0-9]*)$'
      or coalesce(v_input_fact->>'tradeCount', '') !~ '^(0|[1-9][0-9]*)$'
      or coalesce(v_input_fact->>'vwap', '') !~ '^$|^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
      or coalesce(v_input_fact->>'factSha256', '') !~ '^[0-9a-f]{64}$'
    then
      raise exception 'market fact contains a non-canonical field for %',
        coalesce(v_input_fact->>'symbol', '<unknown>')
        using errcode = '22023';
    end if;

    begin
      if to_char(
           (v_input_fact->>'barStart')::timestamptz at time zone 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         ) is distinct from v_input_fact->>'barStart'
      then
        raise exception 'barStart is not a canonical UTC millisecond timestamp for %',
          v_input_fact->>'symbol'
          using errcode = '22023';
      end if;

      if (v_input_fact->>'barDate')::date
        is distinct from ((v_input_fact->>'barStart')::timestamptz at time zone 'UTC')::date
      then
        raise exception 'barDate does not match barStart for %',
          v_input_fact->>'symbol'
          using errcode = '22023';
      end if;
    exception
      when datetime_field_overflow or invalid_datetime_format then
        raise exception 'market fact contains an invalid timestamp or date for %',
          v_input_fact->>'symbol'
          using errcode = '22023';
    end;

    v_expected_fact_sha256 := encode(
      digest(
        (v_input_fact->>'symbol') || chr(31)
        || (v_input_fact->>'timeframe') || chr(31)
        || (v_input_fact->>'barStart') || chr(31)
        || (v_input_fact->>'barDate') || chr(31)
        || (v_input_fact->>'currency') || chr(31)
        || (v_input_fact->>'openPrice') || chr(31)
        || (v_input_fact->>'highPrice') || chr(31)
        || (v_input_fact->>'lowPrice') || chr(31)
        || (v_input_fact->>'closePrice') || chr(31)
        || (v_input_fact->>'volume') || chr(31)
        || (v_input_fact->>'tradeCount') || chr(31)
        || (v_input_fact->>'vwap') || chr(31)
        || v_source.normalizer_version,
        'sha256'
      ),
      'hex'
    );

    if v_input_fact->>'factSha256' is distinct from v_expected_fact_sha256 then
      raise exception 'market fact hash does not match canonical fields for %',
        v_input_fact->>'symbol'
        using errcode = '22023';
    end if;
  end loop;

  select encode(
           digest(
             string_agg(
               facts.item->>'factSha256',
               '|' order by (facts.item->>'symbol') collate "C",
                            (facts.item->>'barStart') collate "C"
             ),
             'sha256'
           ),
           'hex'
         )
    into v_computed_manifest_sha256
    from jsonb_array_elements(p_facts) as facts(item);

  if v_computed_manifest_sha256 is distinct from p_normalized_manifest_sha256 then
    raise exception 'normalized fact manifest hash does not match facts'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('market-delivery:' || p_idempotency_key, 0)
  );

  select delivery.* into v_existing
    from public.source_delivery as delivery
   where delivery.idempotency_key = p_idempotency_key;

  if found then
    select artifact.* into strict v_artifact
      from public.raw_artifact as artifact
     where artifact.raw_artifact_id = v_existing.raw_artifact_id;

    if v_existing.source_version_id is distinct from p_source_version_id
      or v_existing.request_fingerprint is distinct from p_request_fingerprint
      or v_existing.provider_request_id is distinct from p_provider_request_id
      or v_existing.http_status is distinct from p_http_status
      or v_existing.retrieved_at is distinct from p_retrieved_at
      or v_existing.first_observed_at is distinct from p_first_observed_at
      or v_existing.available_at is distinct from p_available_at
      or v_existing.normalized_manifest_sha256
        is distinct from p_normalized_manifest_sha256
      or v_existing.etag is distinct from p_etag
      or v_existing.last_modified is distinct from p_last_modified
      or v_artifact.storage_bucket is distinct from p_storage_bucket
      or v_artifact.object_path is distinct from p_object_path
      or v_artifact.content_type is distinct from p_content_type
      or v_artifact.byte_size is distinct from p_byte_size
      or v_artifact.response_sha256 is distinct from p_response_sha256
      or (select count(*) from public.delivery_fact as link
           where link.delivery_id = v_existing.delivery_id)
        is distinct from jsonb_array_length(p_facts)::bigint
      or exists (
        select 1
          from jsonb_array_elements(p_facts) with ordinality as facts(item, item_index)
         where not exists (
           select 1
             from public.delivery_fact as link
             join public.market_bar_fact as fact on fact.fact_id = link.fact_id
            where link.delivery_id = v_existing.delivery_id
              and link.fact_index = facts.item_index - 1
              and fact.source_version_id = p_source_version_id
              and fact.fact_sha256 = facts.item->>'factSha256'
         )
      )
    then
      raise exception 'delivery idempotency key was reused with different content'
        using errcode = '23505';
    end if;
    return v_existing;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('raw-artifact:' || p_response_sha256, 0)
  );

  select artifact.* into v_artifact
    from public.raw_artifact as artifact
   where artifact.response_sha256 = p_response_sha256;

  if found then
    if v_artifact.storage_bucket is distinct from p_storage_bucket
      or v_artifact.object_path is distinct from p_object_path
      or v_artifact.content_type is distinct from p_content_type
      or v_artifact.byte_size is distinct from p_byte_size
    then
      raise exception 'raw artifact hash was reused with different metadata'
        using errcode = '23505';
    end if;
  else
    if exists (
      select 1
        from public.raw_artifact as artifact
       where artifact.storage_bucket = p_storage_bucket
         and artifact.object_path = p_object_path
    ) then
      raise exception 'raw artifact object path already contains another hash'
        using errcode = '23505';
    end if;

    insert into public.raw_artifact (
      storage_bucket,
      object_path,
      content_type,
      byte_size,
      response_sha256
    ) values (
      p_storage_bucket,
      p_object_path,
      p_content_type,
      p_byte_size,
      p_response_sha256
    )
    returning * into v_artifact;
  end if;

  insert into public.source_delivery (
    idempotency_key,
    source_version_id,
    raw_artifact_id,
    request_fingerprint,
    provider_request_id,
    http_status,
    retrieved_at,
    first_observed_at,
    available_at,
    normalized_manifest_sha256,
    etag,
    last_modified
  ) values (
    p_idempotency_key,
    p_source_version_id,
    v_artifact.raw_artifact_id,
    p_request_fingerprint,
    p_provider_request_id,
    p_http_status,
    p_retrieved_at,
    p_first_observed_at,
    p_available_at,
    p_normalized_manifest_sha256,
    p_etag,
    p_last_modified
  )
  returning * into v_inserted;

  for v_input_fact, v_fact_index in
    select facts.item, (facts.item_index - 1)::integer
      from jsonb_array_elements(p_facts) with ordinality as facts(item, item_index)
     order by facts.item_index
  loop
    insert into public.market_bar_fact (
      source_version_id,
      symbol,
      timeframe,
      bar_start,
      bar_date,
      currency,
      open_price,
      high_price,
      low_price,
      close_price,
      volume,
      trade_count,
      vwap,
      normalizer_version,
      fact_sha256
    ) values (
      p_source_version_id,
      v_input_fact->>'symbol',
      v_input_fact->>'timeframe',
      (v_input_fact->>'barStart')::timestamptz,
      (v_input_fact->>'barDate')::date,
      v_input_fact->>'currency',
      v_input_fact->>'openPrice',
      v_input_fact->>'highPrice',
      v_input_fact->>'lowPrice',
      v_input_fact->>'closePrice',
      v_input_fact->>'volume',
      v_input_fact->>'tradeCount',
      nullif(v_input_fact->>'vwap', ''),
      v_source.normalizer_version,
      v_input_fact->>'factSha256'
    )
    on conflict (source_version_id, fact_sha256) do nothing
    returning * into v_fact_row;

    if not found then
      select fact.* into strict v_fact_row
        from public.market_bar_fact as fact
       where fact.source_version_id = p_source_version_id
         and fact.fact_sha256 = v_input_fact->>'factSha256';

      if v_fact_row.symbol is distinct from v_input_fact->>'symbol'
        or v_fact_row.timeframe is distinct from v_input_fact->>'timeframe'
        or v_fact_row.bar_start is distinct from (v_input_fact->>'barStart')::timestamptz
        or v_fact_row.bar_date is distinct from (v_input_fact->>'barDate')::date
        or v_fact_row.currency is distinct from v_input_fact->>'currency'
        or v_fact_row.open_price is distinct from v_input_fact->>'openPrice'
        or v_fact_row.high_price is distinct from v_input_fact->>'highPrice'
        or v_fact_row.low_price is distinct from v_input_fact->>'lowPrice'
        or v_fact_row.close_price is distinct from v_input_fact->>'closePrice'
        or v_fact_row.volume is distinct from v_input_fact->>'volume'
        or v_fact_row.trade_count is distinct from v_input_fact->>'tradeCount'
        or coalesce(v_fact_row.vwap, '') is distinct from v_input_fact->>'vwap'
        or v_fact_row.normalizer_version is distinct from v_source.normalizer_version
      then
        raise exception 'canonical market fact hash collision for %',
          v_input_fact->>'symbol'
          using errcode = '23505';
      end if;
    end if;

    insert into public.delivery_fact (delivery_id, fact_id, fact_index)
    values (v_inserted.delivery_id, v_fact_row.fact_id, v_fact_index);
  end loop;

  return v_inserted;
end;
$$;

create or replace function public.seal_market_snapshot(
  p_idempotency_key text,
  p_source_version_id uuid,
  p_snapshot_kind text,
  p_cutoff_at timestamptz,
  p_target_session_date date,
  p_symbols text[],
  p_selection_policy text
)
returns public.market_snapshot
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_existing public.market_snapshot%rowtype;
  v_inserted public.market_snapshot%rowtype;
  v_source public.data_source_version%rowtype;
  v_symbols text[];
  v_symbol text;
  v_fact_id uuid;
  v_delivery_id uuid;
  v_fact public.market_bar_fact%rowtype;
  v_delivery public.source_delivery%rowtype;
  v_raw_artifact public.raw_artifact%rowtype;
  v_fact_ids uuid[] := '{}'::uuid[];
  v_delivery_ids uuid[] := '{}'::uuid[];
  v_member_manifest text := '';
  v_manifest_material text;
  v_manifest_sha256 text;
  v_index integer := 0;
begin
  select array_agg(symbol order by symbol collate "C")
    into v_symbols
    from (
      select distinct upper(trim(input_symbol)) as symbol
        from unnest(p_symbols) as requested(input_symbol)
    ) as normalized;

  if v_symbols is null
    or p_symbols is distinct from v_symbols
    or exists (
      select 1 from unnest(v_symbols) as requested(symbol)
       where requested.symbol !~ '^[A-Z][A-Z0-9.-]{0,14}$'
    )
  then
    raise exception 'snapshot symbols must be unique, sorted, uppercase symbols'
      using errcode = '22023';
  end if;

  if p_target_session_date is null
    or p_target_session_date > (p_cutoff_at at time zone 'UTC')::date
  then
    raise exception 'target session date must not be after the snapshot cutoff'
      using errcode = '22023';
  end if;

  select source.* into strict v_source
    from public.data_source_version as source
   where source.source_version_id = p_source_version_id;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'market-snapshot:' || p_source_version_id::text || ':'
        || p_snapshot_kind || ':' || p_cutoff_at::text || ':'
        || p_target_session_date::text || ':' || array_to_string(v_symbols, ',')
        || ':' || p_selection_policy,
      0
    )
  );

  select snapshot.* into v_existing
    from public.market_snapshot as snapshot
   where snapshot.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.source_version_id is distinct from p_source_version_id
      or v_existing.snapshot_kind is distinct from p_snapshot_kind
      or v_existing.cutoff_at is distinct from p_cutoff_at
      or v_existing.target_session_date is distinct from p_target_session_date
      or v_existing.symbols is distinct from v_symbols
      or v_existing.selection_policy is distinct from p_selection_policy
      or v_existing.manifest_schema is distinct from 'twofold.market_snapshot/v2'
    then
      raise exception 'snapshot idempotency key was reused with different content'
        using errcode = '23505';
    end if;
    return v_existing;
  end if;

  foreach v_symbol in array v_symbols
  loop
    select fact.fact_id, delivery.delivery_id
      into v_fact_id, v_delivery_id
      from public.market_bar_fact as fact
      join public.delivery_fact as link on link.fact_id = fact.fact_id
      join public.source_delivery as delivery
        on delivery.delivery_id = link.delivery_id
     where fact.source_version_id = p_source_version_id
       and delivery.source_version_id = p_source_version_id
       and fact.symbol = v_symbol
       and fact.timeframe = '1Day'
       and fact.bar_date = p_target_session_date
       and delivery.available_at <= p_cutoff_at
     order by delivery.available_at desc,
              delivery.retrieved_at desc,
              delivery.first_observed_at desc,
              delivery.idempotency_key collate "C" desc,
              fact.fact_sha256 collate "C"
     limit 1;

    if not found then
      raise exception 'required market fact is missing for symbol % on target session % at cutoff %',
        v_symbol, p_target_session_date, p_cutoff_at
        using errcode = 'P0002';
    end if;

    select fact.* into strict v_fact
      from public.market_bar_fact as fact
     where fact.fact_id = v_fact_id;

    select delivery.* into strict v_delivery
      from public.source_delivery as delivery
     where delivery.delivery_id = v_delivery_id;

    if v_fact.bar_date is distinct from p_target_session_date then
      raise exception 'snapshot member session-date mismatch for symbol %', v_symbol
        using errcode = '22023';
    end if;

    select artifact.* into strict v_raw_artifact
      from public.raw_artifact as artifact
     where artifact.raw_artifact_id = v_delivery.raw_artifact_id;

    v_fact_ids := array_append(v_fact_ids, v_fact.fact_id);
    v_delivery_ids := array_append(v_delivery_ids, v_delivery.delivery_id);
    v_member_manifest := v_member_manifest
      || case when v_member_manifest = '' then '' else chr(30) end
      || v_symbol || chr(31)
      || v_fact.fact_sha256 || chr(31)
      || v_delivery.idempotency_key || chr(31)
      || v_delivery.request_fingerprint || chr(31)
      || v_raw_artifact.response_sha256 || chr(31)
      || to_char(
           v_delivery.available_at at time zone 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         );
  end loop;

  v_manifest_material :=
    'twofold.market_snapshot/v2' || chr(31)
    || v_source.provider || chr(31)
    || v_source.dataset || chr(31)
    || v_source.version_key || chr(31)
    || v_source.endpoint_base_url || chr(31)
    || v_source.feed || chr(31)
    || v_source.adjustment || chr(31)
    || v_source.timeframe || chr(31)
    || v_source.normalizer_version || chr(31)
    || v_source.license_scope || chr(31)
    || v_source.config_sha256 || chr(31)
    || to_char(
         v_source.effective_from at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) || chr(31)
    || p_snapshot_kind || chr(31)
    || to_char(
         p_cutoff_at at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) || chr(31)
    || p_target_session_date::text || chr(31)
    || p_selection_policy || chr(31)
    || v_member_manifest;
  v_manifest_sha256 := encode(digest(v_manifest_material, 'sha256'), 'hex');

  insert into public.market_snapshot (
    idempotency_key,
    source_version_id,
    snapshot_kind,
    cutoff_at,
    target_session_date,
    symbols,
    selection_policy,
    manifest_schema,
    manifest_sha256
  ) values (
    p_idempotency_key,
    p_source_version_id,
    p_snapshot_kind,
    p_cutoff_at,
    p_target_session_date,
    v_symbols,
    p_selection_policy,
    'twofold.market_snapshot/v2',
    v_manifest_sha256
  )
  returning * into v_inserted;

  while v_index < cardinality(v_symbols)
  loop
    insert into public.market_snapshot_member (
      snapshot_id,
      symbol,
      delivery_id,
      fact_id,
      member_index
    ) values (
      v_inserted.snapshot_id,
      v_symbols[v_index + 1],
      v_delivery_ids[v_index + 1],
      v_fact_ids[v_index + 1],
      v_index
    );
    v_index := v_index + 1;
  end loop;

  return v_inserted;
end;
$$;

alter table public.data_source_version enable row level security;
alter table public.raw_artifact enable row level security;
alter table public.source_delivery enable row level security;
alter table public.market_bar_fact enable row level security;
alter table public.delivery_fact enable row level security;
alter table public.market_snapshot enable row level security;
alter table public.market_snapshot_member enable row level security;

revoke all on table public.data_source_version from public, anon, authenticated;
revoke all on table public.raw_artifact from public, anon, authenticated;
revoke all on table public.source_delivery from public, anon, authenticated;
revoke all on table public.market_bar_fact from public, anon, authenticated;
revoke all on table public.delivery_fact from public, anon, authenticated;
revoke all on table public.market_snapshot from public, anon, authenticated;
revoke all on table public.market_snapshot_member from public, anon, authenticated;

revoke insert, update, delete, truncate, references, trigger
  on table public.data_source_version from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.raw_artifact from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.source_delivery from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.market_bar_fact from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.delivery_fact from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.market_snapshot from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.market_snapshot_member from service_role;

grant select on table public.data_source_version to service_role;
grant select on table public.raw_artifact to service_role;
grant select on table public.source_delivery to service_role;
grant select on table public.market_bar_fact to service_role;
grant select on table public.delivery_fact to service_role;
grant select on table public.market_snapshot to service_role;
grant select on table public.market_snapshot_member to service_role;

revoke all on function public.register_data_source_version(
  text, text, text, text, text, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.register_market_delivery(
  text, uuid, text, text, integer, timestamptz, timestamptz, timestamptz,
  text, text, text, bigint, text, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.seal_market_snapshot(
  text, uuid, text, timestamptz, date, text[], text
) from public, anon, authenticated;

grant execute on function public.register_data_source_version(
  text, text, text, text, text, text, text, text, text, text, timestamptz
) to service_role;
grant execute on function public.register_market_delivery(
  text, uuid, text, text, integer, timestamptz, timestamptz, timestamptz,
  text, text, text, bigint, text, text, text, text, jsonb
) to service_role;
grant execute on function public.seal_market_snapshot(
  text, uuid, text, timestamptz, date, text[], text
) to service_role;

alter table public.source_delivery replica identity full;
alter table public.market_snapshot replica identity full;

do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'source_delivery'
  ) then
    alter publication supabase_realtime add table public.source_delivery;
  end if;

  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'market_snapshot'
  ) then
    alter publication supabase_realtime add table public.market_snapshot;
  end if;
end;
$$;

commit;
