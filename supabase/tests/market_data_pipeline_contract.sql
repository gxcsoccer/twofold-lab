-- Real-data evidence-chain contract tests. Fixed values are provider-contract
-- fixtures only; the runtime has no fallback path to them.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
set local timezone = 'UTC';

create or replace function pg_temp.contract_fact(
  p_symbol text,
  p_bar_start text,
  p_open text,
  p_high text,
  p_low text,
  p_close text,
  p_volume text,
  p_trade_count text,
  p_vwap text
)
returns jsonb
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'symbol', p_symbol,
    'timeframe', '1Day',
    'barStart', p_bar_start,
    'barDate', left(p_bar_start, 10),
    'currency', 'USD',
    'openPrice', p_open,
    'highPrice', p_high,
    'lowPrice', p_low,
    'closePrice', p_close,
    'volume', p_volume,
    'tradeCount', p_trade_count,
    'vwap', p_vwap,
    'factSha256', encode(
      digest(
        p_symbol || chr(31)
        || '1Day' || chr(31)
        || p_bar_start || chr(31)
        || left(p_bar_start, 10) || chr(31)
        || 'USD' || chr(31)
        || p_open || chr(31)
        || p_high || chr(31)
        || p_low || chr(31)
        || p_close || chr(31)
        || p_volume || chr(31)
        || p_trade_count || chr(31)
        || p_vwap || chr(31)
        || 'alpaca-bars-v1',
        'sha256'
      ),
      'hex'
    )
  )
$$;

create or replace function pg_temp.contract_facts(p_fixture text)
returns jsonb
language plpgsql
immutable
set search_path = public, extensions, pg_temp
as $$
begin
  case p_fixture
    when 'day21-two' then
      return jsonb_build_array(
        pg_temp.contract_fact(
          'LULU', '2026-08-21T04:00:00.000Z',
          '191.1', '196.2', '190.5', '195.3',
          '1234567', '23456', '194.21'
        ),
        pg_temp.contract_fact(
          'SPY', '2026-08-21T04:00:00.000Z',
          '640.1', '644.2', '639.5', '643.3',
          '76543210', '345678', '642.51'
        )
      );
    when 'day21-overlap' then
      return jsonb_build_array(
        pg_temp.contract_fact(
          'LULU', '2026-08-21T04:00:00.000Z',
          '191.1', '196.2', '190.5', '195.3',
          '1234567', '23456', '194.21'
        ),
        pg_temp.contract_fact(
          'QQQ', '2026-08-21T04:00:00.000Z',
          '572.1', '576.2', '571.5', '575.3',
          '45678901', '245678', '574.51'
        ),
        pg_temp.contract_fact(
          'SPY', '2026-08-21T04:00:00.000Z',
          '640.1', '644.2', '639.5', '643.3',
          '76543210', '345678', '642.51'
        )
      );
    when 'mixed-days' then
      return jsonb_build_array(
        pg_temp.contract_fact(
          'LULU', '2026-08-20T04:00:00.000Z',
          '195.3', '198.2', '194.5', '197.1',
          '1134567', '21456', '196.42'
        ),
        pg_temp.contract_fact(
          'SPY', '2026-08-19T04:00:00.000Z',
          '643.3', '646.2', '642.5', '645.1',
          '70543210', '325678', '644.61'
        )
      );
    else
      raise exception 'unknown contract fixture %', p_fixture;
  end case;
end;
$$;

create or replace function pg_temp.contract_fact_manifest(p_facts jsonb)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
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
  from jsonb_array_elements(p_facts) as facts(item)
$$;

create or replace function pg_temp.register_contract_delivery(
  p_idempotency_key text,
  p_request_seed text,
  p_provider_request_id text,
  p_available_at timestamptz,
  p_response_sha256 text,
  p_facts jsonb
)
returns public.source_delivery
language sql
volatile
set search_path = public, extensions, pg_temp
as $$
  select public.register_market_delivery(
    p_idempotency_key,
    (
      select source_version_id
        from public.data_source_version
       where version_key = 'contract-sip-raw-v1'
    ),
    repeat(p_request_seed, 64),
    p_provider_request_id,
    200,
    p_available_at,
    p_available_at - interval '1 second',
    p_available_at,
    'twofold-private-artifacts',
    'raw/alpaca/' || left(p_response_sha256, 2) || '/'
      || p_response_sha256 || '.json',
    'application/json',
    512,
    p_response_sha256,
    pg_temp.contract_fact_manifest(p_facts),
    null,
    null,
    p_facts
  )
$$;

select plan(41);

select has_table('public', 'data_source_version', 'data_source_version exists');
select has_table('public', 'raw_artifact', 'raw_artifact exists');
select has_table('public', 'source_delivery', 'source_delivery exists');
select has_table('public', 'market_bar_fact', 'market_bar_fact exists');
select has_table('public', 'delivery_fact', 'delivery_fact exists');
select has_table('public', 'market_snapshot', 'market_snapshot exists');
select has_table('public', 'market_snapshot_member', 'market_snapshot_member exists');

select is(
  (
    select bucket.public
      from storage.buckets as bucket
     where bucket.id = 'twofold-private-artifacts'
  ),
  false,
  'the raw-artifact bucket fails closed as private'
);

select is(
  (
    public.register_data_source_version(
      'alpaca',
      'us_stock_daily_bars',
      'contract-sip-raw-v1',
      'https://data.alpaca.markets',
      'sip',
      'raw',
      '1Day',
      'alpaca-bars-v1',
      'private-research',
      repeat('a', 64),
      '2026-08-23T00:00:00Z'
    )
  ).provider,
  'alpaca',
  'register_data_source_version freezes an Alpaca source contract'
);

select is(
  (
    pg_temp.register_contract_delivery(
      'contract:delivery:1',
      'b',
      'provider-request-1',
      '2026-08-23T00:10:01Z',
      repeat('c', 64),
      pg_temp.contract_facts('day21-two')
    )
  ).http_status,
  200,
  'the first provider observation is registered'
);

select is(
  (
    select count(*)
      from public.raw_artifact as artifact
     where artifact.raw_artifact_id in (
       select delivery.raw_artifact_id
         from public.source_delivery as delivery
         join public.data_source_version as source
           on source.source_version_id = delivery.source_version_id
        where source.version_key = 'contract-sip-raw-v1'
     )
  ),
  1::bigint,
  'a delivery registers one content-addressed raw artifact'
);

select is(
  (
    select count(*)
      from public.market_bar_fact as fact
     where fact.source_version_id = (
       select source_version_id
         from public.data_source_version
        where version_key = 'contract-sip-raw-v1'
     )
  ),
  2::bigint,
  'the first delivery publishes two canonical facts'
);

select is(
  (
    select count(*)
      from public.delivery_fact as link
      join public.source_delivery as delivery
        on delivery.delivery_id = link.delivery_id
      join public.data_source_version as source
        on source.source_version_id = delivery.source_version_id
     where source.version_key = 'contract-sip-raw-v1'
  ),
  2::bigint,
  'the first delivery links both observed facts atomically'
);

select is(
  (
    pg_temp.register_contract_delivery(
      'contract:delivery:1',
      'b',
      'provider-request-1',
      '2026-08-23T00:10:01Z',
      repeat('c', 64),
      pg_temp.contract_facts('day21-two')
    )
  ).delivery_id,
  (
    select delivery_id
      from public.source_delivery
     where idempotency_key = 'contract:delivery:1'
  ),
  'an exact delivery retry returns the original observation'
);

select throws_ok(
  $$
    select pg_temp.register_contract_delivery(
      'contract:delivery:1',
      'b',
      'provider-request-1',
      '2026-08-23T00:10:01Z',
      repeat('c', 64),
      jsonb_set(
        pg_temp.contract_facts('day21-two'),
        '{0,closePrice}',
        '"195.31"'::jsonb
      )
    )
  $$,
  '22023',
  'market fact hash does not match canonical fields for LULU',
  'an idempotent retry cannot tamper with canonical fact fields'
);

select throws_ok(
  $$
    select pg_temp.register_contract_delivery(
      'contract:delivery:1',
      'b',
      'provider-request-1',
      '2026-08-23T00:10:01Z',
      repeat('c', 64),
      jsonb_build_array(
        pg_temp.contract_fact(
          'LULU', '2026-08-21T04:00:00.000Z',
          '191.1', '196.2', '190.5', '195.31',
          '1234567', '23456', '194.21'
        ),
        pg_temp.contract_fact(
          'SPY', '2026-08-21T04:00:00.000Z',
          '640.1', '644.2', '639.5', '643.3',
          '76543210', '345678', '642.51'
        )
      )
    )
  $$,
  '23505',
  'delivery idempotency key was reused with different content',
  'an idempotent retry also rejects a different valid canonical fact set'
);

select throws_ok(
  $$
    select pg_temp.register_contract_delivery(
      'contract:delivery:noncanonical-decimal',
      'b',
      'provider-request-noncanonical-decimal',
      '2026-08-23T00:11:01Z',
      repeat('9', 64),
      jsonb_set(
        pg_temp.contract_facts('day21-two'),
        '{0,openPrice}',
        '"191.10"'::jsonb
      )
    )
  $$,
  '22023',
  'market fact contains a non-canonical field for LULU',
  'decimal strings with a redundant trailing zero are rejected'
);

select throws_ok(
  $$
    select pg_temp.register_contract_delivery(
      'contract:delivery:noncanonical-time',
      'b',
      'provider-request-noncanonical-time',
      '2026-08-23T00:12:01Z',
      repeat('0', 64),
      jsonb_set(
        pg_temp.contract_facts('day21-two'),
        '{0,barStart}',
        '"2026-08-21T04:00:00Z"'::jsonb
      )
    )
  $$,
  '22023',
  'market fact contains a non-canonical field for LULU',
  'barStart must use the Worker toISOString millisecond form'
);

select is(
  (
    pg_temp.register_contract_delivery(
      'contract:delivery:2',
      'd',
      'provider-request-2',
      '2026-08-23T00:20:01Z',
      repeat('e', 64),
      pg_temp.contract_facts('day21-overlap')
    )
  ).idempotency_key,
  'contract:delivery:2',
  'a second delivery may overlap facts from the first'
);

select is(
  (
    select count(*)
      from public.market_bar_fact as fact
     where fact.source_version_id = (
       select source_version_id
         from public.data_source_version
        where version_key = 'contract-sip-raw-v1'
     )
  ),
  3::bigint,
  'overlap reuses two facts and adds only the new canonical fact'
);

select is(
  (
    select count(*)
      from public.delivery_fact as link
      join public.source_delivery as delivery
        on delivery.delivery_id = link.delivery_id
      join public.data_source_version as source
        on source.source_version_id = delivery.source_version_id
     where source.version_key = 'contract-sip-raw-v1'
  ),
  5::bigint,
  'each overlapping observation retains its own fact links'
);

select is(
  (
    pg_temp.register_contract_delivery(
      'contract:delivery:3',
      'f',
      'provider-request-3',
      '2026-08-23T00:30:01Z',
      repeat('c', 64),
      pg_temp.contract_facts('day21-two')
    )
  ).idempotency_key,
  'contract:delivery:3',
  'the same raw bytes can be observed by a later distinct delivery'
);

select is(
  (
    select count(*)
      from public.raw_artifact as artifact
     where artifact.raw_artifact_id in (
       select delivery.raw_artifact_id
         from public.source_delivery as delivery
         join public.data_source_version as source
           on source.source_version_id = delivery.source_version_id
        where source.version_key = 'contract-sip-raw-v1'
     )
  ),
  2::bigint,
  're-observing the same raw content does not duplicate the artifact'
);

select is(
  (
    select first_delivery.raw_artifact_id
      from public.source_delivery as first_delivery
     where first_delivery.idempotency_key = 'contract:delivery:1'
  ),
  (
    select repeated_delivery.raw_artifact_id
      from public.source_delivery as repeated_delivery
     where repeated_delivery.idempotency_key = 'contract:delivery:3'
  ),
  'repeated raw observations reference the same content-addressed row'
);

select is(
  (
    pg_temp.register_contract_delivery(
      'contract:delivery:4',
      '1',
      'provider-request-4',
      '2026-08-24T00:40:01Z',
      repeat('2', 64),
      pg_temp.contract_facts('mixed-days')
    )
  ).idempotency_key,
  'contract:delivery:4',
  'historical deliveries may contain facts from multiple session dates'
);

do $$
begin
  perform public.seal_market_snapshot(
    'contract:snapshot:1',
    (
      select source_version_id
        from public.data_source_version
       where version_key = 'contract-sip-raw-v1'
    ),
    'market_close',
    '2026-08-23T00:35:00Z',
    '2026-08-21',
    array['LULU', 'QQQ', 'SPY'],
    'latest-observation-for-target-session-v2'
  );
end;
$$;

select is(
  (
    select count(*)
      from public.market_snapshot_member
     where snapshot_id = (
       select snapshot_id
         from public.market_snapshot
        where idempotency_key = 'contract:snapshot:1'
     )
  ),
  3::bigint,
  'snapshot sealing selects one required fact and observation per symbol'
);

select is(
  (
    select target_session_date
      from public.market_snapshot
     where idempotency_key = 'contract:snapshot:1'
  ),
  '2026-08-21'::date,
  'the snapshot explicitly freezes its target trading session'
);

select is(
  (
    select count(distinct fact.bar_date)
      from public.market_snapshot_member as member
      join public.market_bar_fact as fact on fact.fact_id = member.fact_id
     where member.snapshot_id = (
       select snapshot_id
         from public.market_snapshot
        where idempotency_key = 'contract:snapshot:1'
     )
  ),
  1::bigint,
  'all snapshot members share one bar_date'
);

select is(
  (
    select min(fact.bar_date)
      from public.market_snapshot_member as member
      join public.market_bar_fact as fact on fact.fact_id = member.fact_id
     where member.snapshot_id = (
       select snapshot_id
         from public.market_snapshot
        where idempotency_key = 'contract:snapshot:1'
     )
  ),
  '2026-08-21'::date,
  'the common member bar_date equals target_session_date'
);

select is(
  (
    select string_agg(
             member.symbol || '=' || delivery.idempotency_key,
             ',' order by member.member_index
           )
      from public.market_snapshot_member as member
      join public.source_delivery as delivery
        on delivery.delivery_id = member.delivery_id
     where member.snapshot_id = (
       select snapshot_id
         from public.market_snapshot
        where idempotency_key = 'contract:snapshot:1'
     )
  ),
  'LULU=contract:delivery:3,QQQ=contract:delivery:2,SPY=contract:delivery:3',
  'each member freezes the exact contributing delivery selected at cutoff'
);

select is(
  (
    public.seal_market_snapshot(
      'contract:snapshot:1',
      (
        select source_version_id
          from public.data_source_version
         where version_key = 'contract-sip-raw-v1'
      ),
      'market_close',
      '2026-08-23T00:35:00Z',
      '2026-08-21',
      array['LULU', 'QQQ', 'SPY'],
      'latest-observation-for-target-session-v2'
    )
  ).snapshot_id,
  (
    select snapshot_id
      from public.market_snapshot
     where idempotency_key = 'contract:snapshot:1'
  ),
  'an exact snapshot retry returns the original sealed snapshot'
);

select is(
  (
    select snapshot.manifest_schema
      from public.market_snapshot as snapshot
     where snapshot.idempotency_key = 'contract:snapshot:1'
  ),
  'twofold.market_snapshot/v2',
  'snapshot manifest schema is explicit and versioned'
);

select is(
  (
    select snapshot.manifest_sha256
      from public.market_snapshot as snapshot
     where snapshot.idempotency_key = 'contract:snapshot:1'
  ),
  (
    select encode(
      digest(
        'twofold.market_snapshot/v2' || chr(31)
        || source.provider || chr(31)
        || source.dataset || chr(31)
        || source.version_key || chr(31)
        || source.endpoint_base_url || chr(31)
        || source.feed || chr(31)
        || source.adjustment || chr(31)
        || source.timeframe || chr(31)
        || source.normalizer_version || chr(31)
        || source.license_scope || chr(31)
        || source.config_sha256 || chr(31)
        || to_char(
             source.effective_from at time zone 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) || chr(31)
        || snapshot.snapshot_kind || chr(31)
        || to_char(
             snapshot.cutoff_at at time zone 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) || chr(31)
        || snapshot.target_session_date::text || chr(31)
        || snapshot.selection_policy || chr(31)
        || members.member_manifest,
        'sha256'
      ),
      'hex'
    )
      from public.market_snapshot as snapshot
      join public.data_source_version as source
        on source.source_version_id = snapshot.source_version_id
      cross join lateral (
        select string_agg(
                 member.symbol || chr(31)
                 || fact.fact_sha256 || chr(31)
                 || delivery.idempotency_key || chr(31)
                 || delivery.request_fingerprint || chr(31)
                 || artifact.response_sha256 || chr(31)
                 || to_char(
                      delivery.available_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                    ),
                 chr(30) order by member.member_index
               ) as member_manifest
          from public.market_snapshot_member as member
          join public.market_bar_fact as fact on fact.fact_id = member.fact_id
          join public.source_delivery as delivery
            on delivery.delivery_id = member.delivery_id
          join public.raw_artifact as artifact
            on artifact.raw_artifact_id = delivery.raw_artifact_id
         where member.snapshot_id = snapshot.snapshot_id
      ) as members
     where snapshot.idempotency_key = 'contract:snapshot:1'
  ),
  'manifest commits schema, source config, cutoff, target date, policy, facts, deliveries, and raw hashes'
);

select isnt(
  (
    public.seal_market_snapshot(
      'contract:snapshot:cutoff-context',
      (
        select source_version_id
          from public.data_source_version
         where version_key = 'contract-sip-raw-v1'
      ),
      'market_close',
      '2026-08-23T00:31:00Z',
      '2026-08-21',
      array['LULU', 'QQQ', 'SPY'],
      'latest-observation-for-target-session-v2'
    )
  ).manifest_sha256,
  (
    select manifest_sha256
      from public.market_snapshot
     where idempotency_key = 'contract:snapshot:1'
  ),
  'changing cutoff changes the manifest even when selected members are unchanged'
);

select throws_ok(
  $$
    select public.seal_market_snapshot(
      'contract:snapshot:mixed-day',
      (
        select source_version_id
          from public.data_source_version
         where version_key = 'contract-sip-raw-v1'
      ),
      'market_close',
      '2026-08-24T00:45:00Z',
      '2026-08-22',
      array['LULU', 'SPY'],
      'latest-observation-for-target-session-v2'
    )
  $$,
  'P0002',
  'required market fact is missing for symbol LULU on target session 2026-08-22 at cutoff 2026-08-24 00:45:00+00',
  'a snapshot cannot fill a missing symbol with another session date'
);

select throws_ok(
  $$
    select public.seal_market_snapshot(
      'contract:snapshot:too-early',
      (
        select source_version_id
          from public.data_source_version
         where version_key = 'contract-sip-raw-v1'
      ),
      'market_close',
      '2026-08-23T00:09:59Z',
      '2026-08-21',
      array['LULU', 'SPY'],
      'latest-observation-for-target-session-v2'
    )
  $$,
  'P0002',
  'required market fact is missing for symbol LULU on target session 2026-08-21 at cutoff 2026-08-23 00:09:59+00',
  'facts observed after cutoff cannot enter an older snapshot'
);

select throws_ok(
  $$update public.market_bar_fact set close_price = '1'$$,
  '55000',
  'market_bar_fact is append-only; append a compensating or superseding record instead',
  'normalized market facts are immutable'
);

select throws_ok(
  $$update public.raw_artifact set byte_size = 1$$,
  '55000',
  'raw_artifact is append-only; append a compensating or superseding record instead',
  'content-addressed raw artifacts are immutable'
);

select throws_ok(
  $$
    select public.register_data_source_version(
      'alpaca',
      'us_stock_daily_bars',
      'contract-sip-raw-v1',
      'https://data.alpaca.markets',
      'iex',
      'raw',
      '1Day',
      'alpaca-bars-v1',
      'private-research',
      repeat('a', 64),
      '2026-08-23T00:00:00Z'
    )
  $$,
  '23505',
  'source version key was reused with different content',
  'a source-version key cannot be reused with another feed'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.register_market_delivery(text,uuid,text,text,integer,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,text,bigint,text,text,text,text,jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute the delivery registration boundary'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.seal_market_snapshot(text,uuid,text,timestamp with time zone,date,text[],text)',
    'EXECUTE'
  ),
  'service_role alone can execute the snapshot sealing boundary'
);

select * from finish();
rollback;
