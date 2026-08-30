-- Shared Round/data/calendar fence contract. Every fixture rolls back.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(251);

select has_table('public', 'arena_round', 'competition Rounds are durable');
select has_column(
  'public', 'arena_round', 'schedule',
  'Round freezes the two-stage exchange calendar'
);
select has_column(
  'public', 'arena_round', 'decision_snapshot_id',
  'Round freezes one shared decision snapshot'
);
select has_function(
  'public', 'register_arena_round',
  array[
    'text', 'uuid', 'uuid', 'bigint', 'uuid', 'timestamp with time zone',
    'timestamp with time zone', 'uuid', 'text', 'jsonb', 'text'
  ],
  'Round registration has one audited service boundary'
);
select has_table(
  'public', 'arena_round_entry',
  'every entrant has one durable seat in a Round'
);
select has_column(
  'public', 'arena_round_entry', 'decision_id',
  'the Round seat allocates a stable decision identity'
);
select has_function(
  'public', 'register_arena_round_entry',
  array['text', 'uuid', 'uuid', 'text'],
  'Round entry registration has one service boundary'
);

select public.register_arena_season(
  'arena-round-contract:season',
  'd1000000-0000-4000-8000-000000000001',
  'arena-round-contract', 'Arena Round Contract',
  '2026-08-28T21:00:00.000Z', '2026-09-26T00:00:00.000Z',
  'US_EQUITY_DAILY_AFTER_CLOSE', 'America/New_York',
  '{"fixture":"arena-round","openingHolding":"150 LULU","openingCash":"0"}',
  'arena-round-contract'
);
select public.register_run_manifest(
  'arena-round-contract:run',
  'd1100000-0000-4000-8000-000000000001',
  'twofold.run_manifest/v1',
  '{"engine_version":"arena-round-contract","lot_method":"FIFO"}',
  'arena-round-contract', repeat('a', 64)
);
select public.register_season_entrant(
  'arena-round-contract:entrant',
  'd1200000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001',
  'arena-round-contract-entrant',
  'd1100000-0000-4000-8000-000000000001',
  'twofold@contract', repeat('b', 64), 'twofold',
  'deepseek-official', 'deepseek-v4-pro', 'ROOT_ONLY',
  '{"track":"MAIN_ARENA"}', 'arena-round-contract'
);
insert into public.data_source_version (
  source_version_id, provider, dataset, version_key, endpoint_base_url,
  feed, adjustment, timeframe, normalizer_version, license_scope,
  config_sha256, effective_from
) values (
  'd2000000-0000-4000-8000-000000000001', 'alpaca',
  'us_stock_daily_bars', 'arena-round-contract',
  'https://data.alpaca.markets', 'sip', 'raw', '1Day',
  'arena-round-contract', 'private-research', repeat('1', 64),
  '2026-08-28T00:00:00.000Z'
);
insert into public.market_snapshot (
  snapshot_id, idempotency_key, source_version_id, snapshot_kind,
  cutoff_at, target_session_date, symbols, selection_policy,
  manifest_schema, manifest_sha256, sealed_at
) values (
  'd3000000-0000-4000-8000-000000000001',
  'arena-round-contract:snapshot',
  'd2000000-0000-4000-8000-000000000001', 'market_close',
  '2026-08-28T21:00:00.000Z', '2026-08-28', array['LULU'],
  'arena-round-contract', 'twofold.market_snapshot/v2', repeat('2', 64),
  '2026-08-28T22:00:00.000Z'
);

-- Seed one empty, covering company-action observation before any contestant
-- work is claimed. The later tests append a split revision and prove the same
-- gate then blocks its effective date.
set local role service_role;
create temporary table corporate_action_source on commit drop as
select public.register_data_source_version(
  'alpaca', 'us_corporate_actions', 'arena-contract-corporate-actions-v1',
  'https://data.alpaca.markets', 'none', 'raw', 'Event',
  'alpaca-corporate-actions-v1', 'private-research', repeat('4', 64),
  '2026-08-01T00:00:00.000Z'
) as value;
create temporary table corporate_action_clear_fixture on commit drop as
select
  jsonb_build_array(jsonb_build_object(
    'pageIndex', '0', 'providerRequestId', null,
    'storageBucket', 'twofold-private-artifacts',
    'objectPath', 'raw/alpaca/fe/'
      || 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
      || '.json',
    'byteSize', '2',
    'responseSha256',
      'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
  )) as pages,
  jsonb_build_object(
    'schema', 'twofold.alpaca_corporate_action_scan/v1',
    'source', jsonb_build_object(
      'provider', 'alpaca', 'dataset', 'us_corporate_actions',
      'versionKey', 'arena-contract-corporate-actions-v1',
      'endpointBaseUrl', 'https://data.alpaca.markets',
      'feed', 'none', 'adjustment', 'raw', 'timeframe', 'Event',
      'normalizerVersion', 'alpaca-corporate-actions-v1',
      'licenseScope', 'private-research',
      'configSha256', repeat('4', 64),
      'effectiveFrom', '2026-08-01T00:00:00.000Z'
    ),
    'processDateStart', '2026-08-01',
    'processDateEnd', '2026-09-30',
    'observedAt', '2026-08-28T22:00:00.000Z',
    'requestFingerprint', repeat('0', 64),
    'pageResponseSha256', jsonb_build_array(
      'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
    ),
    'actions', '[]'::jsonb
  )::text as canonical_json;
create temporary table corporate_action_clear_commit on commit drop as
select public.register_corporate_action_scan(
  'arena-round-contract:corporate-action-scan:clear',
  (select (value).source_version_id from corporate_action_source),
  repeat('0', 64), '2026-08-01', '2026-09-30',
  '2026-08-28T22:00:00.000Z', fixture.canonical_json,
  encode(extensions.digest(convert_to(fixture.canonical_json, 'UTF8'),
    'sha256'), 'hex'), fixture.pages, '[]'::jsonb,
  'arena-round-contract'
) as value
from corporate_action_clear_fixture as fixture;
reset role;
insert into public.artifact_metadata (
  artifact_id, idempotency_key, season_id, artifact_kind, storage_bucket,
  object_path, content_type, byte_size, sha256, created_by, metadata
) values (
  'd4000000-0000-4000-8000-000000000001',
  'arena-round-contract:calendar',
  'd1000000-0000-4000-8000-000000000001',
  'exchange_calendar_schedule', 'twofold-private-artifacts',
  'arena/calendar/contract.json', 'application/json', 1,
  repeat('3', 64), 'arena-round-contract', '{"provider":"alpaca"}'
);

set local role service_role;
create temporary table arena_round_result on commit drop as
select public.register_arena_round(
  'arena-round-contract:round:1',
  'd5000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001', 1,
  'd3000000-0000-4000-8000-000000000001',
  '2026-08-28T22:23:53.027Z', '2026-08-31T13:15:00.000Z',
  'd4000000-0000-4000-8000-000000000001', repeat('3', 64),
  '{
    "schema":"twofold.two_stage_cycle_calendar/v1",
    "decisionSessionDate":"2026-08-28",
    "s1SessionDate":"2026-08-31",
    "s1OpenAt":"2026-08-31T13:30:00.000Z",
    "s1ReferenceAvailableAt":"2026-08-31T13:32:00.000Z",
    "s1CloseAt":"2026-08-31T20:00:00.000Z",
    "s1CloseAvailableAt":"2026-08-31T20:20:00.000Z",
    "s2SessionDate":"2026-09-01",
    "s2OpenAt":"2026-09-01T13:30:00.000Z",
    "s2ReferenceAvailableAt":"2026-09-01T13:32:00.000Z",
    "s2CloseAt":"2026-09-01T20:00:00.000Z",
    "cycleReadyAt":"2026-09-01T20:20:00.000Z"
  }',
  'arena-round-contract'
) as value;
reset role;

set local role service_role;
create temporary table arena_round_entry_result on commit drop as
select public.register_arena_round_entry(
  'arena-round-contract:round:1:entrant',
  'd5000000-0000-4000-8000-000000000001',
  'd1200000-0000-4000-8000-000000000001',
  'arena-round-contract'
) as value;
reset role;

select is((select count(*) from public.arena_round_entry
  where round_id = 'd5000000-0000-4000-8000-000000000001'), 1::bigint,
  'one Round entry is stored for the entrant');
select ok((
  select round_id = 'd5000000-0000-4000-8000-000000000001'
     and season_id = 'd1000000-0000-4000-8000-000000000001'
     and entrant_id = 'd1200000-0000-4000-8000-000000000001'
     and run_id = 'd1100000-0000-4000-8000-000000000001'
    from public.arena_round_entry
   where round_id = 'd5000000-0000-4000-8000-000000000001'
), 'Round entry binds the shared Round to the stable entrant Run');
select ok((
  select round_entry_id = public.deterministic_uuid_from_sha256(
           'twofold.arena_round_entry/v1',
           round_id::text || ':' || entrant_id::text
         )
     and decision_id = public.deterministic_uuid_from_sha256(
           'twofold.arena_round_entry.decision/v1',
           round_id::text || ':' || entrant_id::text
         )
    from public.arena_round_entry
   where round_id = 'd5000000-0000-4000-8000-000000000001'
), 'entry and decision identities are deterministic');
select is(
  (public.register_arena_round_entry(
    'arena-round-contract:round:1:entrant',
    'd5000000-0000-4000-8000-000000000001',
    'd1200000-0000-4000-8000-000000000001',
    'arena-round-contract'
  )->>'decisionId'),
  (select value->>'decisionId' from arena_round_entry_result),
  'an exact Round entry retry returns the same decision'
);
select throws_ok(
  $$update public.arena_round_entry
       set decision_id = 'd1300000-0000-4000-8000-000000000001'
     where round_id = 'd5000000-0000-4000-8000-000000000001'$$,
  '55000',
  'arena_round_entry is append-only; append a compensating or superseding record instead',
  'Round entry cannot be reassigned'
);
select ok(
  not public.jsonb_contains_number(
    (select value from arena_round_entry_result)
  ),
  'Round entry result contains no JSON number tokens'
);

set local role anon;
select throws_ok($$select * from public.arena_round_entry$$, '42501', null,
  'anonymous callers cannot read private Round entries');
select throws_ok(
  $$select public.register_arena_round_entry(
    'anon', 'd5000000-0000-4000-8000-000000000001',
    'd1200000-0000-4000-8000-000000000001', 'anon'
  )$$,
  '42501', null, 'anonymous callers cannot register a Round entry'
);
reset role;

set local role service_role;
select is((select count(*) from public.arena_round_entry
  where round_id = 'd5000000-0000-4000-8000-000000000001'), 1::bigint,
  'service worker can read the private Round entry');
reset role;
select is(
  (select value->>'schema' from arena_round_entry_result),
  'twofold.arena_round_entry_result/v1',
  'Round entry result schema is explicit'
);

select has_table(
  'public', 'arena_valuation',
  'competition scores are durable immutable valuations'
);
select has_function(
  'public', 'register_arena_valuation',
  array['text', 'uuid', 'text', 'uuid', 'text', 'text'],
  'valuation registration has one exact service boundary'
);
select has_function(
  'public', 'get_arena_leaderboard', array['uuid'],
  'the leaderboard has one authoritative query boundary'
);

do $$
begin
  if not exists (
    select 1 from public.instrument_symbol_version
     where symbol = 'LULU'
       and effective_from <= '2026-08-28'
       and (effective_to is null or effective_to > '2026-08-28')
  ) then
    perform public.register_instrument(
      'arena-round-contract:instrument:lulu',
      'd6300000-0000-4000-8000-000000000001',
      'common_stock', 'NASDAQ', 'USD', 'US',
      '{"issuer":"lululemon athletica inc."}', 'arena-round-contract'
    );
    perform public.register_instrument_symbol_version(
      'arena-round-contract:symbol:lulu',
      'd6300000-0000-4000-8000-000000000001',
      'LULU', 'NASDAQ', '2007-07-27', null,
      '{"source":"arena-round-contract"}', 'arena-round-contract'
    );
  end if;
end;
$$;
create temporary table arena_lulu_instrument on commit drop as
select instrument_id
  from public.instrument_symbol_version
 where symbol = 'LULU'
   and effective_from <= '2026-08-28'
   and (effective_to is null or effective_to > '2026-08-28')
 order by effective_from desc, symbol_version_id
 limit 1;
insert into public.artifact_metadata (
  artifact_id, idempotency_key, season_id, artifact_kind, storage_bucket,
  object_path, content_type, byte_size, sha256, created_by, metadata
) values
  (
    'd6100000-0000-4000-8000-000000000001',
    'arena-round-contract:opening-state',
    'd1000000-0000-4000-8000-000000000001',
    'paper_account_opening_state', 'twofold-private-artifacts',
    'arena/contract/opening-state.json', 'application/json', 1,
    repeat('e', 64), 'arena-round-contract', '{}'
  ),
  (
    'd6200000-0000-4000-8000-000000000001',
    'arena-round-contract:opening-fx-source',
    'd1000000-0000-4000-8000-000000000001',
    'official_tax_fx_rate', 'twofold-private-artifacts',
    'arena/contract/opening-fx.json', 'application/json', 1,
    repeat('f', 64), 'arena-round-contract', '{}'
  );

create temporary table arena_genesis_fixture on commit drop as
select payload::text as canonical_json,
       encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'),
              'hex') as sha256
  from (select jsonb_build_object(
    'schema', 'twofold.competition_economic_state/v1',
    'genesisId', 'arena-round-contract:lulu-150',
    'seasonId', 'd1000000-0000-4000-8000-000000000001',
    'openingStateArtifactId', 'd6100000-0000-4000-8000-000000000001',
    'snapshot', jsonb_build_object(
      'snapshotId', 'arena-round-contract:lulu-150',
      'schema', 'twofold.initial_portfolio/v1',
      'asOf', '2026-08-28T22:10:00.000Z',
      'brokerLegalEntity', 'FUTU_HK',
      'accountRegion', 'HK',
      'baseCurrency', 'USD',
      'sourceArtifactSha256', repeat('e', 64),
      'cashBalances', '[]'::jsonb,
      'lots', jsonb_build_array(jsonb_build_object(
        'lotId', 'arena-round-contract-lulu-lot',
        'instrumentId', (select instrument_id::text
                           from arena_lulu_instrument),
        'symbol', 'LULU',
        'acquiredOn', '2026-08-28',
        'acquisitionSequence', '1',
        'quantity', '150',
        'purchasePricePerShare', '120.81',
        'grossPurchasePrice', '18121.5',
        'buyFees', '0',
        'taxBasis', '18121.5',
        'currency', 'USD'
      ))
    ),
    'acquisitionFxBindings', jsonb_build_array(jsonb_build_object(
      'lotId', 'arena-round-contract-lulu-lot',
      'instrumentId', (select instrument_id::text
                         from arena_lulu_instrument),
      'effectiveDate', '2026-08-28',
      'cnyPerUsd', '7.1234',
      'acquisitionTaxBasisCny', '129086.6931',
      'authority', 'ECB_REFERENCE_CROSS',
      'sourceArtifactId', 'd6200000-0000-4000-8000-000000000001',
      'sourceSha256', repeat('f', 64),
      'observedAt', '2026-08-28T22:09:00.000Z',
      'availableAt', '2026-08-28T22:10:00.000Z'
    ))
  ) as payload) as genesis;
grant select on arena_genesis_fixture to service_role;

set local role service_role;
create temporary table arena_strategy_account_result on commit drop as
select public.initialize_competition_strategy_account(
  'arena-round-contract:strategy-account',
  'd1100000-0000-4000-8000-000000000001',
  'ARENA-CONTRACT', 'FUTU_HK', 'HK', canonical_json, sha256,
  'arena-round-contract'
) as value
from arena_genesis_fixture;
reset role;

create temporary table arena_opening_valuation_payload on commit drop as
select jsonb_build_object(
  'brokerNav', '18121.5',
  'estimatedCloseFees', '2.84',
  'estimatedUnrealizedLiquidationTax', '0',
  'feeScheduleIds', jsonb_build_array(
    'futu_hk_us_equity_fixed_2026-08-23'
  ),
  'ledgerSequence', head.head_sequence::text,
  'ledgerSha256', head.head_sha256,
  'liquidationNav', '18118.66',
  'portfolioAsOf', to_char(head.updated_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'positionMarketValue', '18121.5',
  'reportingCurrency', 'USD',
  'schema', 'twofold.arena_valuation/v1',
  'scoreBaseLiquidationNav', '18118.66',
  'settledCash', '0',
  'taxReserve', '0',
  'taxReservedNav', '18121.5',
  'valuationAt', to_char(head.updated_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'valuationDate', '2026-08-28'
)::text as canonical_json
from public.strategy_account as account
join public.strategy_ledger_head as head
  on head.strategy_account_id = account.strategy_account_id
where account.run_id = 'd1100000-0000-4000-8000-000000000001';
grant select on arena_opening_valuation_payload to service_role;

set local role service_role;
create temporary table arena_valuation_result on commit drop as
select public.register_arena_valuation(
  'arena-round-contract:round:1:entrant:opening',
  (select round_entry_id from public.arena_round_entry
    where round_id = 'd5000000-0000-4000-8000-000000000001'),
  'OPENING', 'd3000000-0000-4000-8000-000000000001',
  (select canonical_json from arena_opening_valuation_payload),
  'arena-round-contract'
) as value;
reset role;

select is((select count(*) from public.arena_valuation
  where round_id = 'd5000000-0000-4000-8000-000000000001'), 1::bigint,
  'one opening valuation is stored for the entrant');
select ok((
  select broker_nav = 18121.5
     and tax_reserved_nav = 18121.5
     and liquidation_nav = 18118.66
     and score_base_liquidation_nav = 18118.66
    from public.arena_valuation
   where round_id = 'd5000000-0000-4000-8000-000000000001'
), 'stored NAV columns exactly bind the canonical valuation bytes');
select is(
  (public.register_arena_valuation(
    'arena-round-contract:round:1:entrant:opening',
    (select round_entry_id from public.arena_round_entry
      where round_id = 'd5000000-0000-4000-8000-000000000001'),
    'OPENING', 'd3000000-0000-4000-8000-000000000001',
    (select canonical_json from public.arena_valuation
      where round_id = 'd5000000-0000-4000-8000-000000000001'),
    'arena-round-contract'
  )->>'valuationId'),
  (select value->>'valuationId' from arena_valuation_result),
  'an exact valuation retry returns the same identity'
);
select throws_ok(
  $$update public.arena_valuation set liquidation_nav = 1
     where round_id = 'd5000000-0000-4000-8000-000000000001'$$,
  '55000',
  'arena_valuation is append-only; append a compensating or superseding record instead',
  'a recorded score cannot be edited'
);
select ok(
  not public.jsonb_contains_number(
    (select value from arena_valuation_result)
  ),
  'valuation result contains no JSON number tokens'
);
select is(
  (public.get_arena_leaderboard(
    'd1000000-0000-4000-8000-000000000001'
  )->0->>'rank'),
  '1', 'the first exact score receives rank one'
);
select is(
  (public.get_arena_leaderboard(
    'd1000000-0000-4000-8000-000000000001'
  )->0->>'returnMultiple'),
  '1', 'opening liquidation friction is normalized to a 1x score base'
);
select is(
  (select value->>'schema' from arena_valuation_result),
  'twofold.arena_valuation_result/v1',
  'valuation result schema is explicit'
);
select throws_ok(
  $$select public.register_arena_valuation(
    'arena-round-contract:round:1:entrant:opening',
    (select round_entry_id from public.arena_round_entry
      where round_id = 'd5000000-0000-4000-8000-000000000001'),
    'OPENING', 'd3000000-0000-4000-8000-000000000001',
    replace(
      (select canonical_json from public.arena_valuation
        where round_id = 'd5000000-0000-4000-8000-000000000001'),
      'futu_hk_us_equity_fixed_2026-08-23',
      'futu_hk_us_equity_fixed_conflict'
    ), 'arena-round-contract'
  )$$,
  '23505', 'Arena valuation identity was reused with different content',
  'an idempotency key cannot hide changed valuation bytes'
);

set local role anon;
select throws_ok($$select * from public.arena_valuation$$, '42501', null,
  'anonymous callers cannot read private valuations');
select throws_ok(
  $$select public.get_arena_leaderboard(
    'd1000000-0000-4000-8000-000000000001'
  )$$,
  '42501', null, 'anonymous callers cannot read the private leaderboard'
);
reset role;
set local role service_role;
select is(jsonb_array_length(public.get_arena_leaderboard(
  'd1000000-0000-4000-8000-000000000001'
)), 1, 'service worker reads exactly one latest entrant score');
reset role;

-- The decision close is immutable point-in-time evidence, not a later S1/S2
-- execution mark. The accepted target is bound to this exact shared snapshot.
insert into public.raw_artifact (
  raw_artifact_id, storage_bucket, object_path, content_type,
  byte_size, response_sha256, first_stored_at
) values (
  'd7200000-0000-4000-8000-000000000001',
  'twofold-private-artifacts',
  'raw/alpaca/cc/' || repeat('c', 64) || '.json',
  'application/json', 2, repeat('c', 64),
  '2026-08-28T20:01:00.000Z'
);
insert into public.source_delivery (
  delivery_id, idempotency_key, source_version_id, raw_artifact_id,
  request_fingerprint, http_status, retrieved_at, first_observed_at,
  available_at, normalized_manifest_sha256, recorded_at
) values (
  'd7210000-0000-4000-8000-000000000001',
  'arena-round-contract:decision-close-delivery',
  'd2000000-0000-4000-8000-000000000001',
  'd7200000-0000-4000-8000-000000000001',
  repeat('d', 64), 200,
  '2026-08-28T20:01:00.000Z', '2026-08-28T20:01:00.000Z',
  '2026-08-28T20:01:00.000Z', repeat('e', 64),
  '2026-08-28T20:01:00.000Z'
);
insert into public.market_bar_fact (
  fact_id, source_version_id, symbol, timeframe, bar_start, bar_date,
  currency, open_price, high_price, low_price, close_price, volume,
  trade_count, vwap, normalizer_version, fact_sha256, recorded_at
) values (
  'd7220000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000001',
  'LULU', '1Day', '2026-08-28T04:00:00.000Z', '2026-08-28',
  'USD', '119', '122', '118', '120.81', '100', '10', '120.5',
  'arena-round-contract', repeat('f', 64),
  '2026-08-28T20:01:00.000Z'
);
insert into public.delivery_fact (delivery_id, fact_id, fact_index) values (
  'd7210000-0000-4000-8000-000000000001',
  'd7220000-0000-4000-8000-000000000001', 0
);
insert into public.market_snapshot_member (
  snapshot_id, symbol, delivery_id, fact_id, member_index
) values (
  'd3000000-0000-4000-8000-000000000001', 'LULU',
  'd7210000-0000-4000-8000-000000000001',
  'd7220000-0000-4000-8000-000000000001', 0
);

insert into public.artifact_metadata (
  artifact_id, idempotency_key, run_id, season_id, artifact_kind,
  storage_bucket, object_path, content_type, byte_size, sha256,
  created_by, metadata
)
select
  'd7000000-0000-4000-8000-000000000001',
  'arena-round-contract:decision-packet',
  entry.run_id, entry.season_id, 'decision_packet',
  'twofold-private-artifacts', 'arena/contract/decision-packet.json',
  'application/json', 1, repeat('a', 64), 'arena-round-contract',
  jsonb_build_object(
    'schema', 'twofold.decision_packet/v1',
    'decisionId', entry.decision_id::text,
    'marketSnapshotId', round_.decision_snapshot_id::text,
    'marketManifestSha256', snapshot.manifest_sha256
  )
from public.arena_round_entry as entry
join public.arena_round as round_ on round_.round_id = entry.round_id
join public.market_snapshot as snapshot
  on snapshot.snapshot_id = round_.decision_snapshot_id
where entry.round_id = 'd5000000-0000-4000-8000-000000000001';

insert into public.artifact_metadata (
  artifact_id, idempotency_key, run_id, season_id, artifact_kind,
  storage_bucket, object_path, content_type, byte_size, sha256,
  created_by, metadata
) values (
  'd7100000-0000-4000-8000-000000000001',
  'arena-round-contract:agent-bundle',
  'd1100000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001',
  'dsh_agent_bundle_manifest', 'twofold-private-artifacts',
  'arena/contract/agent-bundle.json', 'application/json', 1,
  repeat('b', 64), 'arena-round-contract', '{}'
);

set local role service_role;
select public.open_decision_invocation(
  'arena-round-contract:decision-invocation',
  (select decision_id from public.arena_round_entry
    where round_id = 'd5000000-0000-4000-8000-000000000001'),
  'd1100000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001', 0,
  'arena-round-contract-root', 'twofold@contract',
  'd7000000-0000-4000-8000-000000000001',
  'd7100000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000001',
  '2026-08-28T22:23:53.027Z', '2026-08-28T21:00:00.000Z',
  '2026-08-31T13:15:00.000Z', array['ROUND_SCHEDULED'],
  '2026-08-28T22:23:53.027Z', 'arena-round-contract'
);
reset role;

-- This fixture remains runnable after the historical Round deadline. Deadline
-- behavior is covered by arena_decision_contract; this contract isolates the
-- stage-gated material boundary and rolls the trigger change back.
alter table public.accepted_target_submission
  disable trigger accepted_target_submission_database_deadline;
-- Migration 059 deliberately revokes this legacy admission function from the
-- production service role. Keep the historical fixture owner-only; the active
-- service path and its evidence requirements are covered by
-- arena_decision_contract.sql.
select public.accept_portfolio_targets(
  'arena-round-contract:accepted-target',
  'd7300000-0000-4000-8000-000000000001',
  'arena-round-contract-root',
  'd7000000-0000-4000-8000-000000000001', repeat('a', 64),
  '[{"symbol":"LULU","target_weight_bps":"10000"}]',
  '0', 'Keep the entire portfolio in the shared LULU starting asset.',
  '2026-08-28T22:30:00.000Z', 1, 'arena-round-contract'
);
alter table public.accepted_target_submission
  enable trigger accepted_target_submission_database_deadline;

select has_table(
  'public', 'arena_work_item',
  'Round cadence is represented by durable work items'
);
select has_column(
  'public', 'arena_work_item', 'phase',
  'work items preserve the real market phase'
);
select has_table(
  'public', 'arena_work_dependency',
  'multi-input Arena work prerequisites are durable data'
);
select has_function(
  'public', 'seed_arena_round_work', array['uuid', 'text'],
  'Round work has one exact seeding boundary'
);
select has_function(
  'public', 'claim_arena_work_item',
  array['text', 'integer', 'timestamp with time zone', 'uuid'],
  'Workers claim due work through a lease boundary'
);
select has_function(
  'public', 'claim_arena_work_item',
  array['text', 'integer', 'timestamp with time zone', 'uuid', 'text[]'],
  'Workers can restrict claims to configured capabilities'
);
select has_function(
  'public', 'complete_arena_work_item',
  array[
    'uuid', 'uuid', 'timestamp with time zone', 'boolean', 'jsonb',
    'text', 'text', 'boolean'
  ],
  'Workers complete leased work through one boundary'
);
select has_column(
  'public', 'arena_work_item', 'completion_fingerprint_sha256',
  'work completion has an exact lost-response retry fence'
);

set local role service_role;
create temporary table arena_work_seed_result on commit drop as
select public.seed_arena_round_work(
  'd5000000-0000-4000-8000-000000000001',
  'arena-round-contract'
) as value;
reset role;
select is(
  (select value->>'schema' from arena_work_seed_result),
  'twofold.arena_work_seed_result/v1',
  'work seed result schema is explicit'
);
select is((select count(*) from public.arena_work_item
  where round_id = 'd5000000-0000-4000-8000-000000000001'), 8::bigint,
  'one entrant receives eight explicit real-cadence phases');
select is((select count(*)
    from public.arena_work_dependency as dependency
    join public.arena_work_item as item
      on item.work_item_id = dependency.work_item_id
   where item.round_id = 'd5000000-0000-4000-8000-000000000001'),
  7::bigint, 'the entrant DAG freezes all seven data dependencies');
select is((select count(*)
    from public.arena_work_dependency as dependency
    join public.arena_work_item as item
      on item.work_item_id = dependency.work_item_id
   where item.round_id = 'd5000000-0000-4000-8000-000000000001'
     and item.phase like 'CAPTURE_%'),
  0::bigint, 'shared market capture never waits on entrant Agent work');
select ok((
  select predecessor_work_item_id is null
    from public.arena_work_item
   where round_id = 'd5000000-0000-4000-8000-000000000001'
     and phase = 'CAPTURE_S1_OPEN_REFERENCE'
), 'shared market capture is independent of entrant Agent completion');
select ok((
  select scheduled_at = '2026-08-28T22:23:53.027Z'::timestamptz
     and deadline_at = '2026-08-31T13:30:00.000Z'::timestamptz
    from public.arena_work_item
   where round_id = 'd5000000-0000-4000-8000-000000000001'
     and phase = 'PREPARE_S1_ORDERS'
), 'S1 orders must freeze after the decision and before the market opens');
select ok((
  select min(scheduled_at) filter (where phase = 'RUN_AGENT_DECISION')
           = '2026-08-28T22:23:53.027Z'::timestamptz
     and min(scheduled_at) filter (
           where phase = 'CAPTURE_S1_OPEN_REFERENCE'
         ) = '2026-08-31T13:32:00.000Z'::timestamptz
     and min(scheduled_at) filter (
           where phase = 'FINALIZE_ACCEPTED_TARGET_CYCLE'
         ) = '2026-09-01T20:20:00.000Z'::timestamptz
    from public.arena_work_item
   where round_id = 'd5000000-0000-4000-8000-000000000001'
), 'work wakes only at decision and evidence-availability boundaries');
select is(
  (public.seed_arena_round_work(
    'd5000000-0000-4000-8000-000000000001',
    'arena-round-contract'
  )->>'workItemCount'),
  '8',
  'an exact work seed retry creates no duplicate phases'
);

set local role service_role;
select is(
  public.claim_arena_work_item(
    'market-only-worker', 60, '2026-08-28T22:24:00.000Z',
    'd5000000-0000-4000-8000-000000000001',
    array['CAPTURE_S1_OPEN_REFERENCE']
  ),
  null::jsonb,
  'a market-only Worker cannot consume due Agent work'
);
create temporary table first_arena_work_claim on commit drop as
select public.claim_arena_work_item(
  'arena-round-contract-worker', 60,
  '2026-08-28T22:24:00.000Z',
  'd5000000-0000-4000-8000-000000000001'
) as value;
reset role;
select is((select value->>'phase' from first_arena_work_claim),
  'RUN_AGENT_DECISION', 'decision is the first claimable phase');
select is(
  public.claim_arena_work_item(
    'arena-round-contract-worker-2', 60,
    '2026-08-28T22:24:00.000Z',
    'd5000000-0000-4000-8000-000000000001'
  ),
  null::jsonb,
  'a successor cannot run while its predecessor is leased'
);

set local role service_role;
create temporary table first_arena_work_completion on commit drop as
select public.complete_arena_work_item(
  (select (value->>'workItemId')::uuid from first_arena_work_claim),
  (select (value->>'leaseToken')::uuid from first_arena_work_claim),
  '2026-08-28T22:24:30.000Z', true,
  '{"outcome":"ACCEPTED_TARGET"}', null, null, false
) as value;
reset role;
select is((select value->>'status' from first_arena_work_completion),
  'SUCCEEDED', 'a valid lease completes exactly one phase');
set local role service_role;
select is(
  (public.complete_arena_work_item(
    (select (value->>'workItemId')::uuid from first_arena_work_claim),
    (select (value->>'leaseToken')::uuid from first_arena_work_claim),
    '2026-08-28T22:24:30.000Z', true,
    '{"outcome":"ACCEPTED_TARGET"}', null, null, false
  )->>'status'),
  'SUCCEEDED',
  'an exact lost-response completion retry returns the same work result'
);
select throws_ok(
  $$select public.complete_arena_work_item(
    (select (value->>'workItemId')::uuid from first_arena_work_claim),
    (select (value->>'leaseToken')::uuid from first_arena_work_claim),
    '2026-08-28T22:24:31.000Z', true,
    '{"outcome":"ACCEPTED_TARGET"}', null, null, false
  )$$,
  '23505',
  'Arena work completion identity was reused with different content',
  'a completion retry cannot change its immutable completion identity'
);
reset role;

set local role service_role;
create temporary table prepare_s1_work_claim on commit drop as
select public.claim_arena_work_item(
  'arena-round-contract-worker', 60,
  '2026-08-28T22:24:31.000Z',
  'd5000000-0000-4000-8000-000000000001'
) as value;
reset role;
select is((select value->>'phase' from prepare_s1_work_claim),
  'PREPARE_S1_ORDERS',
  'the accepted target freezes S1 orders before any open evidence exists');
set local role service_role;
create temporary table prepare_s1_work_completion on commit drop as
select public.complete_arena_work_item(
  (select (value->>'workItemId')::uuid from prepare_s1_work_claim),
  (select (value->>'leaseToken')::uuid from prepare_s1_work_claim),
  '2026-08-28T22:25:00.000Z', true,
  '{"outcome":"S1_PLAN_FROZEN"}', null, null, false
) as value;
reset role;
select is((select value->>'status' from prepare_s1_work_completion),
  'SUCCEEDED', 'the frozen S1 plan is a distinct durable phase');
select is(
  public.claim_arena_work_item(
    'arena-round-contract-worker', 60,
    '2026-08-31T13:31:59.999Z',
    'd5000000-0000-4000-8000-000000000001'
  ),
  null::jsonb,
  'S1 reference cannot run before evidence is available'
);

set local role service_role;
create temporary table second_arena_work_claim on commit drop as
select public.claim_arena_work_item(
  'arena-round-contract-worker', 60,
  '2026-08-31T13:32:00.000Z',
  'd5000000-0000-4000-8000-000000000001'
) as value;
reset role;
select is((select value->>'phase' from second_arena_work_claim),
  'CAPTURE_S1_OPEN_REFERENCE',
  'S1 reference becomes claimable at the frozen availability time');
select throws_ok(
  $$update public.arena_work_item set status = 'SUCCEEDED'
     where round_id = 'd5000000-0000-4000-8000-000000000001'$$,
  '55000', 'arena_work_item may change only through queue RPCs',
  'direct callers cannot bypass queue leases'
);
select ok(
  not public.jsonb_contains_number(
    (select value from second_arena_work_claim)
  ),
  'claimed work contains no JSON number tokens'
);

set local role service_role;
create temporary table late_arena_work_claim on commit drop as
select public.claim_arena_work_item(
  'arena-round-contract-worker', 60,
  '2026-09-01T13:29:59.000Z',
  'd5000000-0000-4000-8000-000000000001',
  array['CAPTURE_S1_CLOSE']
) as value;
reset role;
select is(
  (select value->>'phase' from late_arena_work_claim),
  'CAPTURE_S1_CLOSE',
  'a phase remains claimable immediately before its frozen deadline'
);
select ok((
  select status = 'CANCELED' and error_code = 'DEADLINE_EXPIRED'
    from public.arena_work_item
   where work_item_id = (
     select (value->>'workItemId')::uuid from second_arena_work_claim
   )
), 'one claim sweep expires an abandoned lease whose deadline passed');
set local role service_role;
select throws_ok(
  $$select public.complete_arena_work_item(
    (select (value->>'workItemId')::uuid from late_arena_work_claim),
    (select (value->>'leaseToken')::uuid from late_arena_work_claim),
    '2026-09-01T13:29:58.000Z', true,
    '{"outcome":"IMPOSSIBLE_BACKDATE"}', null, null, false
  )$$,
  '40001',
  'Arena work lease is missing, stale, or expired',
  'a Worker cannot backdate completion before it acquired the lease'
);
select throws_ok(
  $$select public.complete_arena_work_item(
    (select (value->>'workItemId')::uuid from late_arena_work_claim),
    (select (value->>'leaseToken')::uuid from late_arena_work_claim),
    '2026-09-01T13:30:00.001Z', true,
    '{"outcome":"LATE_SUCCESS"}', null, null, false
  )$$,
  '55000',
  'Arena work success missed its deadline',
  'a lease acquired before the deadline cannot publish a late success'
);
create temporary table late_arena_work_failure on commit drop as
select public.complete_arena_work_item(
  (select (value->>'workItemId')::uuid from late_arena_work_claim),
  (select (value->>'leaseToken')::uuid from late_arena_work_claim),
  '2026-09-01T13:30:00.001Z', false,
  '{"outcome":"FAILED"}', 'DEADLINE_EXPIRED_DURING_EXECUTION',
  'Work crossed its frozen deadline', false
) as value;
reset role;
select is(
  (select value->>'status' from late_arena_work_failure),
  'FAILED',
  'a late handler records an explicit failure instead of a retroactive fill'
);

set local role anon;
select throws_ok(
  $$select public.claim_arena_work_item(
    'anon', 60, '2026-08-31T13:32:00.000Z',
    'd5000000-0000-4000-8000-000000000001'
  )$$,
  '42501', null, 'anonymous callers cannot claim work'
);
reset role;
set local role service_role;
select is((select count(*) from public.arena_work_item
  where round_id = 'd5000000-0000-4000-8000-000000000001'), 8::bigint,
  'service worker can inspect the private queue');
reset role;

select is((select count(*) from public.arena_round
  where round_id = 'd5000000-0000-4000-8000-000000000001'), 1::bigint,
  'one shared Round is stored');
select is((select round_index from public.arena_round
  where round_id = 'd5000000-0000-4000-8000-000000000001'), 1::bigint,
  'Round order is explicit');
select is((select decision_session_date::text from public.arena_round
  where round_id = 'd5000000-0000-4000-8000-000000000001'),
  '2026-08-28', 'decision session is frozen');
select is((select s1_session_date::text from public.arena_round
  where round_id = 'd5000000-0000-4000-8000-000000000001'),
  '2026-08-31', 'S1 skips the weekend using the exchange calendar');
select is((select s2_session_date::text from public.arena_round
  where round_id = 'd5000000-0000-4000-8000-000000000001'),
  '2026-09-01', 'S2 uses the next exchange session');
select is((select calendar_artifact_sha256 from public.arena_round
  where round_id = 'd5000000-0000-4000-8000-000000000001'),
  repeat('3', 64), 'Round binds the exact calendar artifact bytes');
select ok(not public.jsonb_contains_number(
  (select schedule from public.arena_round
    where round_id = 'd5000000-0000-4000-8000-000000000001')
), 'Round schedule contains no JSON number tokens');
select is(
  (public.register_arena_round(
    'arena-round-contract:round:1',
    'd5000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001', 1,
    'd3000000-0000-4000-8000-000000000001',
    '2026-08-28T22:23:53.027Z', '2026-08-31T13:15:00.000Z',
    'd4000000-0000-4000-8000-000000000001', repeat('3', 64),
    (select schedule from public.arena_round
      where round_id = 'd5000000-0000-4000-8000-000000000001'),
    'arena-round-contract'
  )->>'roundId'),
  'd5000000-0000-4000-8000-000000000001',
  'an exact Round retry returns the same identity'
);
select throws_ok(
  $$select public.register_arena_round(
    'arena-round-contract:round:1',
    'd5000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001', 1,
    'd3000000-0000-4000-8000-000000000001',
    '2026-08-28T22:24:00.000Z', '2026-08-31T13:15:00.000Z',
    'd4000000-0000-4000-8000-000000000001', repeat('3', 64),
    (select schedule from public.arena_round
      where round_id = 'd5000000-0000-4000-8000-000000000001'),
    'arena-round-contract'
  )$$,
  '23505', 'Arena Round identity was reused with different content',
  'Round timing cannot drift on retry'
);
select throws_ok(
  $$update public.arena_round set round_index = 2
     where round_id = 'd5000000-0000-4000-8000-000000000001'$$,
  '55000',
  'arena_round is append-only; append a compensating or superseding record instead',
  'Round is immutable even for the owner'
);

set local role anon;
select throws_ok($$select * from public.arena_round$$, '42501', null,
  'anonymous callers cannot read private Rounds');
select throws_ok(
  $$select public.register_arena_round(
    'anon', 'd5000000-0000-4000-8000-000000000099',
    'd1000000-0000-4000-8000-000000000001', 2,
    'd3000000-0000-4000-8000-000000000001', now(), now() + interval '1 hour',
    'd4000000-0000-4000-8000-000000000001', repeat('3',64),
    (select schedule from public.arena_round
      where round_id = 'd5000000-0000-4000-8000-000000000001'), 'anon'
  )$$,
  '42501', null, 'anonymous callers cannot register a Round'
);
reset role;

set local role service_role;
select is((select count(*) from public.arena_round
  where round_id = 'd5000000-0000-4000-8000-000000000001'), 1::bigint,
  'service worker can schedule from the private Round');
reset role;
select is(
  (select to_char(decision_window_closes_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from public.arena_round
    where round_id = 'd5000000-0000-4000-8000-000000000001'),
  '2026-08-31T13:15:00.000Z',
  'Round closes target submission before S1 open'
);

select has_table(
  'public', 'market_open_reference_snapshot',
  'first-minute open references are durable shared evidence'
);
select has_table(
  'public', 'arena_round_open_reference',
  'one shared reference is bound to each Round stage'
);
select has_function(
  'public', 'register_arena_round_open_reference',
  array[
    'text', 'uuid', 'text', 'uuid', 'text', 'text', 'bigint',
    'text', 'text', 'text'
  ],
  'open-reference persistence has one exact service boundary'
);

-- Open-reference methods are a Season policy, so the fixture must freeze the
-- v1 rulebook before registering either shared execution snapshot.
set local role service_role;
select public.register_arena_execution_rulebook(
  'arena-round-contract:execution-rulebook',
  'd1000000-0000-4000-8000-000000000001',
  '{"executionModel":"SIMULATED_SLIPPAGE","feeScheduleId":"futu_hk_us_equity_fixed_2026-08-23","fillPriceScale":"8","openReferenceMethod":"ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE","rankingNav":"LIQUIDATION_NAV","schema":"twofold.arena_execution_rulebook/v1","slippageBps":"5","taxAllocationScale":"12","taxRulesetId":"cn_resident_direct_foreign_securities_strict_v1"}',
  encode(extensions.digest(convert_to(
    '{"executionModel":"SIMULATED_SLIPPAGE","feeScheduleId":"futu_hk_us_equity_fixed_2026-08-23","fillPriceScale":"8","openReferenceMethod":"ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE","rankingNav":"LIQUIDATION_NAV","schema":"twofold.arena_execution_rulebook/v1","slippageBps":"5","taxAllocationScale":"12","taxRulesetId":"cn_resident_direct_foreign_securities_strict_v1"}',
    'UTF8'
  ), 'sha256'), 'hex'),
  'arena-round-contract'
);
reset role;

select public.register_data_source_version(
  'alpaca', 'us_stock_intraday_open_references',
  'arena-round-contract-open-reference', 'https://data.alpaca.markets',
  'sip', 'raw', '1Min', 'alpaca-first-minute-open-reference-v1',
  'private-research', repeat('7', 64), '2026-08-23T00:00:00.000Z'
);
create temporary table open_reference_payload on commit drop as
select jsonb_build_object(
  'expectedOpenAt', '2026-08-31T13:30:00.000Z',
  'feed', 'sip',
  'method', 'ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE',
  'observedAt', '2026-08-31T13:32:05.000Z',
  'references', jsonb_build_array(jsonb_build_object(
    'barStart', '2026-08-31T13:30:00.000Z',
    'currency', 'USD',
    'factSha256', encode(extensions.digest(convert_to(
      'LULU' || chr(31) || '2026-08-31T13:30:00.000Z' || chr(31)
        || 'USD' || chr(31) || '120.81' || chr(31)
        || 'alpaca-first-minute-open-reference-v1', 'UTF8'
    ), 'sha256'), 'hex'),
    'symbol', 'LULU', 'value', '120.81'
  )),
  'requestFingerprint', repeat('8', 64),
  'responseSha256', repeat('6', 64),
  'schema', 'twofold.alpaca_open_reference_delivery/v1',
  'sessionDate', '2026-08-31',
  'sourceVersionKey', 'arena-round-contract-open-reference'
)::text as canonical_json;
grant select on open_reference_payload to service_role;

set local role service_role;
create temporary table open_reference_result on commit drop as
select public.register_arena_round_open_reference(
  'arena-round-contract:round:1:s1-open-reference',
  'd5000000-0000-4000-8000-000000000001', 'S1_OPEN_REFERENCE',
  (select source_version_id from public.data_source_version
    where version_key = 'arena-round-contract-open-reference'),
  'twofold-private-artifacts',
  'raw/alpaca/66/' || repeat('6', 64) || '.json', 123, repeat('6', 64),
  (select canonical_json from open_reference_payload),
  'arena-round-contract'
) as value;
reset role;

select is((select count(*) from public.market_open_reference_fact
  where symbol = 'LULU' and session_date = '2026-08-31'), 1::bigint,
  'one exact normalized reference fact is stored');
select ok((
  select stage = 'S1_OPEN_REFERENCE'
     and round_id = 'd5000000-0000-4000-8000-000000000001'
    from public.arena_round_open_reference
   where round_id = 'd5000000-0000-4000-8000-000000000001'
), 'the shared reference is bound to the intended Round stage');
select is(
  (public.register_arena_round_open_reference(
    'arena-round-contract:round:1:s1-open-reference',
    'd5000000-0000-4000-8000-000000000001', 'S1_OPEN_REFERENCE',
    (select source_version_id from public.data_source_version
      where version_key = 'arena-round-contract-open-reference'),
    'twofold-private-artifacts',
    'raw/alpaca/66/' || repeat('6', 64) || '.json', 123, repeat('6', 64),
    (select canonical_json from open_reference_payload),
    'arena-round-contract'
  )->>'referenceSnapshotId'),
  (select value->>'referenceSnapshotId' from open_reference_result),
  'an exact open-reference retry returns one shared snapshot'
);
select ok(not public.jsonb_contains_number(
  (select value from open_reference_result)
), 'open-reference result contains no JSON number tokens');
select is(
  (public.get_arena_round_open_reference(
    'd5000000-0000-4000-8000-000000000001', 'S1_OPEN_REFERENCE'
  )#>>'{references,0,value}'),
  '120.81', 'the cycle reader receives the exact reference value'
);
select throws_ok(
  $$update public.market_open_reference_fact set value = '1'
     where symbol = 'LULU' and session_date = '2026-08-31'$$,
  '55000',
  'market_open_reference_fact is append-only; append a compensating or superseding record instead',
  'normalized open-reference facts cannot be edited'
);
set local role anon;
select throws_ok($$select * from public.market_open_reference_snapshot$$,
  '42501', null, 'anonymous callers cannot read private open references');
select throws_ok(
  $$select public.get_arena_round_open_reference(
    'd5000000-0000-4000-8000-000000000001', 'S1_OPEN_REFERENCE'
  )$$,
  '42501', null, 'anonymous callers cannot read Round execution evidence'
);
reset role;

select has_table(
  'public', 'arena_round_close_snapshot',
  'daily closes are durable Round-shared evidence'
);
select has_function(
  'public', 'register_arena_round_close_snapshot',
  array['text', 'uuid', 'text', 'uuid', 'text'],
  'close-snapshot binding has one exact service boundary'
);
select has_function(
  'public', 'get_arena_round_close_snapshot', array['uuid', 'text'],
  'settlement reads shared closes through one boundary'
);

insert into public.raw_artifact (
  raw_artifact_id, storage_bucket, object_path, content_type,
  byte_size, response_sha256, first_stored_at
) values (
  'd8000000-0000-4000-8000-000000000001',
  'twofold-private-artifacts',
  'raw/alpaca/99/' || repeat('9', 64) || '.json',
  'application/json', 2, repeat('9', 64),
  '2026-08-31T20:20:05.000Z'
);
insert into public.source_delivery (
  delivery_id, idempotency_key, source_version_id, raw_artifact_id,
  request_fingerprint, http_status, retrieved_at, first_observed_at,
  available_at, normalized_manifest_sha256, recorded_at
) values (
  'd8100000-0000-4000-8000-000000000001',
  'arena-round-contract:s1-close-delivery',
  'd2000000-0000-4000-8000-000000000001',
  'd8000000-0000-4000-8000-000000000001',
  repeat('7', 64), 200,
  '2026-08-31T20:20:05.000Z', '2026-08-31T20:20:05.000Z',
  '2026-08-31T20:20:05.000Z', repeat('6', 64),
  '2026-08-31T20:20:05.000Z'
);
insert into public.market_bar_fact (
  fact_id, source_version_id, symbol, timeframe, bar_start, bar_date,
  currency, open_price, high_price, low_price, close_price, volume,
  trade_count, vwap, normalizer_version, fact_sha256, recorded_at
) values (
  'd8200000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000001',
  'LULU', '1Day', '2026-08-31T04:00:00.000Z', '2026-08-31',
  'USD', '120', '121', '118', '118.42', '100', '10', '119.2',
  'arena-round-contract', repeat('8', 64),
  '2026-08-31T20:20:05.000Z'
);
insert into public.delivery_fact (delivery_id, fact_id, fact_index) values (
  'd8100000-0000-4000-8000-000000000001',
  'd8200000-0000-4000-8000-000000000001', 0
);
insert into public.market_snapshot (
  snapshot_id, idempotency_key, source_version_id, snapshot_kind,
  cutoff_at, target_session_date, symbols, selection_policy,
  manifest_schema, manifest_sha256, sealed_at
) values (
  'd8300000-0000-4000-8000-000000000001',
  'arena-round-contract:s1-close-snapshot',
  'd2000000-0000-4000-8000-000000000001', 'market_close',
  '2026-08-31T20:20:05.000Z', '2026-08-31', array['LULU'],
  'arena-round-contract', 'twofold.market_snapshot/v2', repeat('5', 64),
  '2026-08-31T20:20:06.000Z'
);
insert into public.market_snapshot_member (
  snapshot_id, symbol, delivery_id, fact_id, member_index
) values (
  'd8300000-0000-4000-8000-000000000001', 'LULU',
  'd8100000-0000-4000-8000-000000000001',
  'd8200000-0000-4000-8000-000000000001', 0
);

set local role service_role;
create temporary table close_snapshot_result on commit drop as
select public.register_arena_round_close_snapshot(
  'arena-round-contract:round:1:s1-close',
  'd5000000-0000-4000-8000-000000000001', 'S1_CLOSE',
  'd8300000-0000-4000-8000-000000000001',
  'arena-round-contract'
) as value;
reset role;

select is((select count(*) from public.arena_round_close_snapshot
  where round_id = 'd5000000-0000-4000-8000-000000000001'), 1::bigint,
  'one S1 close is bound for every entrant in the Round');
select is(
  (select value#>>'{marks,0,value}' from close_snapshot_result),
  '118.42', 'the shared close preserves the exact decimal mark'
);
select is(
  (public.register_arena_round_close_snapshot(
    'arena-round-contract:round:1:s1-close',
    'd5000000-0000-4000-8000-000000000001', 'S1_CLOSE',
    'd8300000-0000-4000-8000-000000000001',
    'arena-round-contract'
  )->>'snapshotId'),
  'd8300000-0000-4000-8000-000000000001',
  'an exact close-snapshot retry returns the same identity'
);
select throws_ok(
  $$update public.arena_round_close_snapshot set stage = 'S2_CLOSE'
     where round_id = 'd5000000-0000-4000-8000-000000000001'$$,
  '55000',
  'arena_round_close_snapshot is append-only; append a compensating or superseding record instead',
  'a Round close binding cannot be changed'
);
select ok(not public.jsonb_contains_number(
  (select value from close_snapshot_result)
), 'close-snapshot result contains no JSON number tokens');

set local role anon;
select throws_ok($$select * from public.arena_round_close_snapshot$$,
  '42501', null, 'anonymous callers cannot read private close evidence');
select throws_ok(
  $$select public.get_arena_round_close_snapshot(
    'd5000000-0000-4000-8000-000000000001', 'S1_CLOSE'
  )$$,
  '42501', null, 'anonymous callers cannot read settlement marks'
);
reset role;
set local role service_role;
select is(
  (public.get_arena_round_close_snapshot(
    'd5000000-0000-4000-8000-000000000001', 'S1_CLOSE'
  )#>>'{marks,0,sourceContentSha256}'),
  repeat('9', 64), 'service worker receives raw-artifact provenance'
);
reset role;

select has_table(
  'public', 'arena_round_tax_fx_reference',
  'tax-basis FX references are durable Round-shared evidence'
);
select has_function(
  'public', 'register_arena_round_tax_fx_reference',
  array['text', 'uuid', 'text', 'uuid', 'text', 'text', 'text', 'text', 'text'],
  'tax-FX persistence has one exact service boundary'
);
select has_function(
  'public', 'get_arena_round_tax_fx_reference', array['uuid', 'text'],
  'settlement reads shared tax FX through one boundary'
);

insert into public.artifact_metadata (
  artifact_id, idempotency_key, season_id, artifact_kind, storage_bucket,
  object_path, content_type, byte_size, sha256, created_by, metadata
) values (
  'd9000000-0000-4000-8000-000000000001',
  'arena-round-contract:s1-tax-fx-source',
  'd1000000-0000-4000-8000-000000000001',
  'official_tax_fx_rate', 'twofold-private-artifacts',
  'competition-sources/ecb/' || repeat('a', 64) || '.json',
  'application/json', 123, repeat('a', 64), 'arena-round-contract',
  jsonb_build_object(
    'schema', 'twofold.ecb_reference_source/v1',
    'sourceUrl',
      'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml',
    'effectiveDate', '2026-08-31',
    'observedAt', '2026-08-31T20:20:05.000Z',
    'rawBodySha256', repeat('b', 64)
  )
);
create temporary table tax_fx_payload on commit drop as
select
  '{"authority":"ECB_REFERENCE_CROSS","availableAt":"2026-08-31T20:20:05.000Z","cnyPerUsd":"6.741379310345","derivation":"EUR_CNY_DIV_EUR_USD_HALF_UP_12","effectiveDate":"2026-08-31","eurToCny":"7.82","eurToUsd":"1.16","observedAt":"2026-08-31T20:20:05.000Z","schema":"twofold.ecb_usd_cny_reference_cross/v1","status":"ESTIMATED"}'::text
    as canonical_json;
grant select on tax_fx_payload to service_role;

set local role service_role;
create temporary table tax_fx_result on commit drop as
select public.register_arena_round_tax_fx_reference(
  'arena-round-contract:round:1:s1-tax-fx',
  'd5000000-0000-4000-8000-000000000001', 'S1_DISPOSITION',
  'd9000000-0000-4000-8000-000000000001', repeat('a', 64),
  repeat('b', 64), (select canonical_json from tax_fx_payload),
  encode(extensions.digest(convert_to(
    (select canonical_json from tax_fx_payload), 'UTF8'
  ), 'sha256'), 'hex'),
  'arena-round-contract'
) as value;
reset role;

select is((select count(*) from public.arena_round_tax_fx_reference
  where round_id = 'd5000000-0000-4000-8000-000000000001'), 1::bigint,
  'one S1 tax-FX reference is shared by every entrant in the Round');
select is(
  (select value->>'cnyPerBaseUnit' from tax_fx_result),
  '6.741379310345', 'the tax-FX reference preserves the derived decimal cross'
);
select is(
  (select value->>'status' from tax_fx_result),
  'ESTIMATED', 'the ECB reference is never labelled a final tax-authority rate'
);
select is(
  (public.register_arena_round_tax_fx_reference(
    'arena-round-contract:round:1:s1-tax-fx',
    'd5000000-0000-4000-8000-000000000001', 'S1_DISPOSITION',
    'd9000000-0000-4000-8000-000000000001', repeat('a', 64),
    repeat('b', 64), (select canonical_json from tax_fx_payload),
    encode(extensions.digest(convert_to(
      (select canonical_json from tax_fx_payload), 'UTF8'
    ), 'sha256'), 'hex'),
    'arena-round-contract'
  )->>'fxRateId'),
  (select value->>'fxRateId' from tax_fx_result),
  'an exact tax-FX retry returns the same identity'
);
select ok(not public.jsonb_contains_number(
  (select value from tax_fx_result)
), 'tax-FX result contains no JSON number tokens');
select throws_ok(
  $$update public.arena_round_tax_fx_reference set cny_per_usd = '1'
     where round_id = 'd5000000-0000-4000-8000-000000000001'$$,
  '55000',
  'arena_round_tax_fx_reference is append-only; append a compensating or superseding record instead',
  'a Round tax-FX reference cannot be changed'
);
set local role anon;
select throws_ok($$select * from public.arena_round_tax_fx_reference$$,
  '42501', null, 'anonymous callers cannot read private tax-FX evidence');
select throws_ok(
  $$select public.get_arena_round_tax_fx_reference(
    'd5000000-0000-4000-8000-000000000001', 'S1_DISPOSITION'
  )$$,
  '42501', null, 'anonymous callers cannot read settlement tax FX'
);
reset role;
set local role service_role;
select is(
  (public.get_arena_round_tax_fx_reference(
    'd5000000-0000-4000-8000-000000000001', 'S1_DISPOSITION'
  )->>'sourceContentSha256'),
  repeat('a', 64), 'service worker receives raw tax-FX provenance'
);
reset role;

select has_table(
  'public', 'arena_execution_rulebook',
  'each private Arena Season freezes one shared execution rulebook'
);
select has_function(
  'public', 'register_arena_execution_rulebook',
  array['text', 'uuid', 'text', 'text', 'text'],
  'the execution rulebook has one exact service registration boundary'
);
create temporary table execution_rulebook_payload on commit drop as
select
  '{"executionModel":"SIMULATED_SLIPPAGE","feeScheduleId":"futu_hk_us_equity_fixed_2026-08-23","fillPriceScale":"8","openReferenceMethod":"ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE","rankingNav":"LIQUIDATION_NAV","schema":"twofold.arena_execution_rulebook/v1","slippageBps":"5","taxAllocationScale":"12","taxRulesetId":"cn_resident_direct_foreign_securities_strict_v1"}'::text
    as canonical_json;
grant select on execution_rulebook_payload to service_role;

set local role service_role;
create temporary table execution_rulebook_result on commit drop as
select public.register_arena_execution_rulebook(
  'arena-round-contract:execution-rulebook',
  'd1000000-0000-4000-8000-000000000001',
  (select canonical_json from execution_rulebook_payload),
  encode(extensions.digest(convert_to(
    (select canonical_json from execution_rulebook_payload), 'UTF8'
  ), 'sha256'), 'hex'),
  'arena-round-contract'
) as value;
reset role;

select is(
  (select count(*) from public.arena_execution_rulebook
    where season_id = 'd1000000-0000-4000-8000-000000000001'),
  1::bigint, 'one immutable execution rulebook is stored per Season'
);
select is(
  (select value->>'rulebookSha256' from execution_rulebook_result),
  encode(extensions.digest(convert_to(
    (select canonical_json from execution_rulebook_payload), 'UTF8'
  ), 'sha256'), 'hex'),
  'the rulebook preserves the exact canonical-byte digest'
);
select is(
  (select value#>>'{rulebook,slippageBps}' from execution_rulebook_result),
  '5', 'the shared slippage policy remains an exact decimal string'
);
select is(
  (public.register_arena_execution_rulebook(
    'arena-round-contract:execution-rulebook',
    'd1000000-0000-4000-8000-000000000001',
    (select canonical_json from execution_rulebook_payload),
    encode(extensions.digest(convert_to(
      (select canonical_json from execution_rulebook_payload), 'UTF8'
    ), 'sha256'), 'hex'),
    'arena-round-contract'
  )->>'rulebookId'),
  (select value->>'rulebookId' from execution_rulebook_result),
  'an exact rulebook retry returns the same deterministic identity'
);
select ok(not public.jsonb_contains_number(
  (select value from execution_rulebook_result)
), 'the rulebook result contains no JSON number tokens');
select throws_ok(
  $$update public.arena_execution_rulebook set rulebook_sha256 = repeat('0', 64)
     where season_id = 'd1000000-0000-4000-8000-000000000001'$$,
  '55000',
  'arena_execution_rulebook is append-only; append a compensating or superseding record instead',
  'the Season execution rulebook cannot be changed'
);
set local role anon;
select throws_ok($$select * from public.arena_execution_rulebook$$,
  '42501', null, 'anonymous callers cannot read the private Arena rulebook');
select throws_ok(
  $$select public.register_arena_execution_rulebook(
    'arena-round-contract:anonymous-rulebook',
    'd1000000-0000-4000-8000-000000000001', '{}', repeat('0', 64),
    'anonymous'
  )$$,
  '42501', null, 'anonymous callers cannot replace the Arena rulebook'
);
reset role;
set local role service_role;
select is(
  (select rulebook->>'rankingNav' from public.arena_execution_rulebook
    where season_id = 'd1000000-0000-4000-8000-000000000001'),
  'LIQUIDATION_NAV', 'the service worker can read the ranking policy'
);
reset role;

select has_function(
  'public', 'get_arena_cycle_material', array['uuid', 'text'],
  'all deterministic cycle stages share one evidence-gated read boundary'
);

set local role service_role;
create temporary table arena_prepare_material on commit drop as
select public.get_arena_cycle_material(
  (select round_entry_id from public.arena_round_entry
    where round_id = 'd5000000-0000-4000-8000-000000000001'),
  'PREPARE_S1_ORDERS'
) as value;
create temporary table arena_settle_material on commit drop as
select public.get_arena_cycle_material(
  (select round_entry_id from public.arena_round_entry
    where round_id = 'd5000000-0000-4000-8000-000000000001'),
  'SETTLE_S1_AND_PREPARE_S2'
) as value;
reset role;

select is(
  (select value->>'schema' from arena_prepare_material),
  'twofold.arena_cycle_material/v1',
  'S1 preparation receives the explicit cycle material schema'
);
select is(
  (select count(*)::integer
     from arena_prepare_material,
          lateral jsonb_object_keys(value->'evidence') as evidence_key),
  1,
  'S1 planning receives only the prior decision close'
);
select is(
  (select value#>>'{evidence,decisionClose,marks,0,value}'
     from arena_prepare_material),
  '120.81',
  'the decision evidence preserves the exact LULU close string'
);
select is(
  (select jsonb_array_length(value->'universe')
     from arena_prepare_material),
  1,
  'the material includes every stable instrument even independent of holdings'
);
select ok(
  (select value#>>'{universe,0,symbol}' = 'LULU'
     and value#>>'{universe,0,sourceCountry}' = 'US'
     and value#>>'{universe,0,currency}' = 'USD'
   from arena_prepare_material),
  'stable universe identity carries ticker, tax country, and currency'
);
select ok(
  not public.jsonb_contains_number(
    (select value from arena_prepare_material)
  ),
  'cycle material contains no JSON numeric tokens'
);
select ok(
  (select
     value->'evidence' ?& array[
       'decisionClose', 's1Open', 's1Close', 's1DispositionFx'
     ]
     and (select count(*)
            from jsonb_object_keys(value->'evidence')) = 4
     and not (value->'evidence' ? 's2Open')
   from arena_settle_material),
  'S1 settlement receives exactly S1 evidence and no future S2 mark'
);

set local role service_role;
select throws_ok(
  $$select public.get_arena_cycle_material(
    (select round_entry_id from public.arena_round_entry
      where round_id = 'd5000000-0000-4000-8000-000000000001'),
    'FINALIZE_ACCEPTED_TARGET_CYCLE'
  )$$,
  'P0002',
  'Arena cycle material evidence is not ready for requested stage',
  'final settlement fails closed until all S2 evidence exists'
);
reset role;

set local role anon;
select throws_ok(
  $$select public.get_arena_cycle_material(
    (select round_entry_id from public.arena_round_entry limit 1),
    'PREPARE_S1_ORDERS'
  )$$,
  '42501', null,
  'anonymous callers cannot read private deterministic cycle inputs'
);
reset role;

select has_table(
  'public', 'arena_cycle_stage_result',
  'Core stage outputs are durable immutable replay checkpoints'
);
select has_function(
  'public', 'register_arena_s1_plan',
  array['text', 'uuid', 'bigint', 'text', 'text', 'text', 'text', 'text', 'text'],
  'S1 has one Round-aware atomic freeze boundary'
);

create temporary table arena_s1_engine_plan on commit drop as
select jsonb_build_object(
  'schema', 'twofold.frozen_order_plan/v1',
  'decisionId', entry.decision_id::text,
  'stage', 'S1',
  'executionModel', 'SIMULATED_SLIPPAGE',
  'slippageBps', '5',
  'fillPriceScale', '8',
  'taxRulesetId', 'cn_resident_direct_foreign_securities_strict_v1',
  'taxAllocationScale', '12',
  'orders', '[]'::jsonb
) as value
from public.arena_round_entry as entry
where entry.round_id = 'd5000000-0000-4000-8000-000000000001';

create temporary table arena_s1_plan_payload on commit drop as
select jsonb_build_object(
  'manifestSchema', 'twofold.frozen_order_plan/v1',
  'runId', entry.run_id::text,
  'decisionId', entry.decision_id::text,
  'acceptedSubmissionId', submission.submission_id::text,
  'stage', 'S1',
  'plannedAt', to_char(submission.accepted_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'plannedTradeDate', round_.s1_session_date::text,
  'executionModel', 'SIMULATED_SLIPPAGE',
  'slippageBps', '5',
  'fillPriceScale', '8',
  'enginePlanFingerprint', engine.value::text,
  'enginePlanFingerprintSha256', encode(extensions.digest(
    convert_to(engine.value::text, 'UTF8'), 'sha256'
  ), 'hex'),
  'orders', '[]'::jsonb,
  'taxRulesetId', 'cn_resident_direct_foreign_securities_strict_v1',
  'taxAllocationScale', '12'
)::text as canonical_json
from public.arena_round_entry as entry
join public.arena_round as round_ on round_.round_id = entry.round_id
join public.accepted_target_submission as submission
  on submission.decision_id = entry.decision_id
cross join arena_s1_engine_plan as engine
where entry.round_id = 'd5000000-0000-4000-8000-000000000001';

create temporary table arena_s1_result_payload on commit drop as
select jsonb_build_object(
  'schema', 'twofold.accepted_target_cycle_s1_plan/v1',
  'submissionId', submission.submission_id::text,
  'decisionId', entry.decision_id::text,
  'plan', engine.value || jsonb_build_object(
    'planFingerprint', engine.value::text
  ),
  'decisionCloseNav', jsonb_build_object(
    'currency', 'USD',
    'positionMarketValue', '18121.5',
    'brokerNav', '18121.5',
    'taxReserveDeductions', '0',
    'taxReservedNav', '18121.5',
    'liquidationDeductions', '2.84',
    'liquidationNav', '18118.66'
  )
)::text as canonical_json
from public.arena_round_entry as entry
join public.accepted_target_submission as submission
  on submission.decision_id = entry.decision_id
cross join arena_s1_engine_plan as engine
where entry.round_id = 'd5000000-0000-4000-8000-000000000001';
grant select on arena_s1_engine_plan, arena_s1_plan_payload,
  arena_s1_result_payload to service_role;
create temporary table arena_s1_freeze_input on commit drop as
select entry.round_entry_id, head.head_sequence, head.head_sha256
from public.arena_round_entry as entry
join public.strategy_account as account on account.run_id = entry.run_id
join public.strategy_ledger_head as head
  on head.strategy_account_id = account.strategy_account_id
where entry.round_id = 'd5000000-0000-4000-8000-000000000001';
grant select on arena_s1_freeze_input to service_role;

set local role service_role;
create temporary table arena_s1_freeze_result on commit drop as
select public.register_arena_s1_plan(
  'arena-round-contract:s1-plan-freeze',
  input_.round_entry_id,
  input_.head_sequence,
  input_.head_sha256,
  plan_.canonical_json,
  encode(extensions.digest(convert_to(plan_.canonical_json, 'UTF8'), 'sha256'),
    'hex'),
  result_.canonical_json,
  encode(extensions.digest(convert_to(result_.canonical_json, 'UTF8'), 'sha256'),
    'hex'),
  'arena-round-contract'
) as value
from arena_s1_freeze_input as input_
cross join arena_s1_plan_payload as plan_
cross join arena_s1_result_payload as result_
;
reset role;

select is(
  (select value->>'schema' from arena_s1_freeze_result),
  'twofold.arena_cycle_stage_result/v1',
  'S1 freeze returns the explicit durable stage-result schema'
);
select ok((
  select plan.decision_id = entry.decision_id
     and plan.stage = 'S1'
     and plan.engine_plan_fingerprint
           = stage.artifact#>>'{plan,planFingerprint}'
    from public.arena_cycle_stage_result as stage
    join public.frozen_order_plan as plan
      on plan.frozen_order_plan_id = stage.s1_frozen_order_plan_id
    join public.arena_round_entry as entry
      on entry.round_entry_id = stage.round_entry_id
   where stage.phase = 'PREPARE_S1_ORDERS'
     and entry.round_id = 'd5000000-0000-4000-8000-000000000001'
), 'the persisted frozen plan accepts deterministic UUIDv8 Round identity');
select is(
  (select count(*) from public.arena_cycle_stage_result as stage
    join public.arena_round_entry as entry
      on entry.round_entry_id = stage.round_entry_id
    where stage.phase = 'PREPARE_S1_ORDERS'
      and entry.round_id = 'd5000000-0000-4000-8000-000000000001'),
  1::bigint,
  'one immutable S1 plan result is stored for the Round entry'
);
set local role service_role;
select is(
  (public.register_arena_s1_plan(
    'arena-round-contract:s1-plan-freeze',
    input_.round_entry_id, input_.head_sequence, input_.head_sha256,
    plan_.canonical_json,
    encode(extensions.digest(convert_to(plan_.canonical_json, 'UTF8'), 'sha256'),
      'hex'),
    result_.canonical_json,
    encode(extensions.digest(convert_to(result_.canonical_json, 'UTF8'), 'sha256'),
      'hex'),
    'arena-round-contract'
  )->>'stageResultId'),
  (select value->>'stageResultId' from arena_s1_freeze_result),
  'an exact S1 freeze retry returns the same durable identity'
)
from arena_s1_freeze_input as input_
cross join arena_s1_plan_payload as plan_
cross join arena_s1_result_payload as result_
;
select throws_ok(
  $$select public.register_arena_s1_plan(
    'arena-round-contract:s1-plan-freeze', input_.round_entry_id,
    input_.head_sequence, input_.head_sha256, plan_.canonical_json,
    encode(extensions.digest(convert_to(plan_.canonical_json, 'UTF8'), 'sha256'),
      'hex'), result_.canonical_json,
    encode(extensions.digest(convert_to(result_.canonical_json, 'UTF8'), 'sha256'),
      'hex'), 'different-recorder'
  )
  from arena_s1_freeze_input as input_
  cross join arena_s1_plan_payload as plan_
  cross join arena_s1_result_payload as result_
  $$,
  '23505', 'Arena S1 plan identity was reused with different content',
  'an S1 idempotency key cannot hide changed freeze content'
);
reset role;
select ok(
  not public.jsonb_contains_number(
    (select value from arena_s1_freeze_result)
  ),
  'S1 freeze result contains no JSON numeric tokens'
);
set local role anon;
select throws_ok(
  $$select public.register_arena_s1_plan(
    'anon', null, 0, repeat('0', 64), '{}', repeat('0', 64),
    '{}', repeat('0', 64), 'anon'
  )$$,
  '42501', null,
  'anonymous callers cannot freeze private Arena orders'
);
reset role;

select has_function(
  'public', 'register_arena_s1_checkpoint',
  array['text', 'uuid', 'bigint', 'text', 'text', 'text', 'text', 'text', 'text'],
  'S1 settlement and S2 freeze have one atomic Round boundary'
);

create temporary table arena_s2_engine_plan on commit drop as
select jsonb_build_object(
  'schema', 'twofold.frozen_order_plan/v1',
  'decisionId', entry.decision_id::text,
  'stage', 'S2',
  'executionModel', 'SIMULATED_SLIPPAGE',
  'slippageBps', '5',
  'fillPriceScale', '8',
  'buyingPowerEvidence', jsonb_build_object(
    'value', '0',
    'snapshotId', entry.decision_id::text || ':s1-close-ledger',
    'visibleAt', '2026-08-31T20:20:06.000Z'
  ),
  'orders', '[]'::jsonb,
  'initialBuyingPower', '0',
  'reservedBuyingPower', '0',
  'remainingUnreservedBuyingPower', '0'
) as value
from public.arena_round_entry as entry
where entry.round_id = 'd5000000-0000-4000-8000-000000000001';

create temporary table arena_s2_plan_payload on commit drop as
select jsonb_build_object(
  'manifestSchema', 'twofold.frozen_order_plan/v1',
  'runId', entry.run_id::text,
  'decisionId', entry.decision_id::text,
  'acceptedSubmissionId', submission.submission_id::text,
  'stage', 'S2',
  'plannedAt', '2026-08-31T20:20:06.000Z',
  'plannedTradeDate', round_.s2_session_date::text,
  'executionModel', 'SIMULATED_SLIPPAGE',
  'slippageBps', '5',
  'fillPriceScale', '8',
  'enginePlanFingerprint', engine.value::text,
  'enginePlanFingerprintSha256', encode(extensions.digest(
    convert_to(engine.value::text, 'UTF8'), 'sha256'
  ), 'hex'),
  'orders', '[]'::jsonb,
  'buyingPowerEvidence', engine.value->'buyingPowerEvidence',
  'initialBuyingPower', '0',
  'reservedBuyingPower', '0',
  'remainingUnreservedBuyingPower', '0'
)::text as canonical_json
from public.arena_round_entry as entry
join public.arena_round as round_ on round_.round_id = entry.round_id
join public.accepted_target_submission as submission
  on submission.decision_id = entry.decision_id
cross join arena_s2_engine_plan as engine
where entry.round_id = 'd5000000-0000-4000-8000-000000000001';

create temporary table arena_s1_checkpoint_payload on commit drop as
select jsonb_build_object(
  'schema', 'twofold.accepted_target_cycle_s1_checkpoint/v1',
  'submissionId', submission.submission_id::text,
  'decisionId', entry.decision_id::text,
  's1', jsonb_build_object(
    'plan', s1.value || jsonb_build_object('planFingerprint', s1.value::text),
    'settlements', '[]'::jsonb,
    'nav', jsonb_build_object(
      'currency', 'USD',
      'positionMarketValue', '17763',
      'brokerNav', '17763',
      'taxReserveDeductions', '0',
      'taxReservedNav', '17763',
      'liquidationDeductions', '2.84',
      'liquidationNav', '17760.16'
    )
  ),
  's2Plan', s2.value || jsonb_build_object('planFingerprint', s2.value::text),
  'positions', jsonb_build_array(jsonb_build_object(
    'instrumentId', instrument.instrument_id::text,
    'symbol', 'LULU',
    'quantity', '150',
    'grossCost', '18121.5',
    'lots', jsonb_build_array(jsonb_build_object(
      'lotId', 'arena-round-contract-lulu-lot',
      'instrumentId', instrument.instrument_id::text,
      'acquisitionSequence', '1',
      'quantity', '150',
      'grossPurchasePrice', '18121.5',
      'buyFees', '0'
    )),
    'acquisitionFxBindings', jsonb_build_array(jsonb_build_object(
      'lotId', 'arena-round-contract-lulu-lot',
      'acquisitionTradeDate', '2026-08-28',
      'acquisitionSettlementId',
        'competition-genesis:arena-round-contract:lulu-150:arena-round-contract-lulu-lot',
      'remainingGrossPurchasePriceCny', '129086.6931',
      'remainingBuyFeesCny', '0',
      'evidence', jsonb_build_object(
        'fxRateId',
          'competition-genesis:arena-round-contract:lulu-150:arena-round-contract-lulu-lot:fx',
        'factId',
          'competition-genesis:arena-round-contract:lulu-150:arena-round-contract-lulu-lot:fx',
        'sourceVersionId', 'ECB_REFERENCE_CROSS',
        'sourceArtifactId', 'd6200000-0000-4000-8000-000000000001',
        'sourceContentSha256', repeat('f', 64),
        'baseCurrency', 'USD',
        'quoteCurrency', 'CNY',
        'cnyPerBaseUnit', '7.1234',
        'effectiveAt', '2026-08-28T00:00:00.000Z',
        'visibleAt', '2026-08-28T22:10:00.000Z',
        'status', 'ESTIMATED'
      )
    ))
  )),
  'ledger', jsonb_build_object(
    'transactionCount', '1',
    'balances', jsonb_build_array(
      jsonb_build_object(
        'accountId', 'equity.opening_balance', 'accountKind', 'EQUITY',
        'currency', 'USD', 'amount', '18121.5'
      ),
      jsonb_build_object(
        'accountId', 'securities.inventory', 'accountKind', 'ASSET',
        'currency', 'USD', 'amount', '18121.5'
      )
    ),
    'positions', jsonb_build_array(jsonb_build_object(
      'accountId', 'securities.inventory',
      'instrumentId', instrument.instrument_id::text,
      'quantity', '150'
    ))
  ),
  'account', jsonb_build_object(
    'cashAssetBalance', '0',
    'buyingPower', '0',
    'taxReserveBalance', '0',
    'headSequence', input_.head_sequence::text,
    'headHash', input_.head_sha256
  )
)::text as canonical_json
from public.arena_round_entry as entry
join public.accepted_target_submission as submission
  on submission.decision_id = entry.decision_id
cross join arena_s1_engine_plan as s1
cross join arena_s2_engine_plan as s2
cross join arena_lulu_instrument as instrument
cross join arena_s1_freeze_input as input_
where entry.round_id = 'd5000000-0000-4000-8000-000000000001';
grant select on arena_s2_engine_plan, arena_s2_plan_payload,
  arena_s1_checkpoint_payload to service_role;

set local role service_role;
create temporary table arena_s1_checkpoint_result on commit drop as
select public.register_arena_s1_checkpoint(
  'arena-round-contract:s1-checkpoint', input_.round_entry_id,
  input_.head_sequence, input_.head_sha256,
  plan_.canonical_json,
  encode(extensions.digest(convert_to(plan_.canonical_json, 'UTF8'), 'sha256'),
    'hex'),
  checkpoint_.canonical_json,
  encode(extensions.digest(
    convert_to(checkpoint_.canonical_json, 'UTF8'), 'sha256'
  ), 'hex'),
  'arena-round-contract'
) as value
from arena_s1_freeze_input as input_
cross join arena_s2_plan_payload as plan_
cross join arena_s1_checkpoint_payload as checkpoint_;
reset role;

select is(
  (select value->>'schema' from arena_s1_checkpoint_result),
  'twofold.arena_cycle_stage_result/v1',
  'S1 checkpoint returns the explicit durable stage-result schema'
);
select ok((
  select stage.phase = 'SETTLE_S1_AND_PREPARE_S2'
     and plan.stage = 'S2'
     and stage.s1_open_reference_snapshot_id = open_.reference_snapshot_id
     and stage.s1_close_snapshot_id = close_.snapshot_id
     and stage.s1_tax_fx_reference_id = fx.fx_reference_id
    from public.arena_cycle_stage_result as stage
    join public.frozen_order_plan as plan
      on plan.frozen_order_plan_id = stage.s2_frozen_order_plan_id
    join public.arena_round_open_reference as open_
      on open_.round_id = stage.round_id and open_.stage = 'S1_OPEN_REFERENCE'
    join public.arena_round_close_snapshot as close_
      on close_.round_id = stage.round_id and close_.stage = 'S1_CLOSE'
    join public.arena_round_tax_fx_reference as fx
      on fx.round_id = stage.round_id and fx.stage = 'S1_DISPOSITION'
   where stage.phase = 'SETTLE_S1_AND_PREPARE_S2'
     and stage.round_id = 'd5000000-0000-4000-8000-000000000001'
), 'the S1 checkpoint binds the one shared evidence set and frozen S2 plan');
select is(
  (select count(*) from public.arena_cycle_stage_result
    where round_id = 'd5000000-0000-4000-8000-000000000001'),
  2::bigint,
  'the Round entry has exactly one immutable result for each completed stage'
);
set local role service_role;
select is(
  (public.register_arena_s1_checkpoint(
    'arena-round-contract:s1-checkpoint', input_.round_entry_id,
    input_.head_sequence, input_.head_sha256, plan_.canonical_json,
    encode(extensions.digest(convert_to(plan_.canonical_json, 'UTF8'), 'sha256'),
      'hex'), checkpoint_.canonical_json,
    encode(extensions.digest(
      convert_to(checkpoint_.canonical_json, 'UTF8'), 'sha256'
    ), 'hex'), 'arena-round-contract'
  )->>'stageResultId'),
  (select value->>'stageResultId' from arena_s1_checkpoint_result),
  'an exact S1 checkpoint retry returns the same durable identity'
)
from arena_s1_freeze_input as input_
cross join arena_s2_plan_payload as plan_
cross join arena_s1_checkpoint_payload as checkpoint_;
select throws_ok(
  $$select public.register_arena_s1_checkpoint(
    'arena-round-contract:s1-checkpoint', input_.round_entry_id,
    input_.head_sequence, input_.head_sha256, plan_.canonical_json,
    encode(extensions.digest(convert_to(plan_.canonical_json, 'UTF8'), 'sha256'),
      'hex'), checkpoint_.canonical_json,
    encode(extensions.digest(
      convert_to(checkpoint_.canonical_json, 'UTF8'), 'sha256'
    ), 'hex'), 'different-recorder'
  )
  from arena_s1_freeze_input as input_
  cross join arena_s2_plan_payload as plan_
  cross join arena_s1_checkpoint_payload as checkpoint_$$,
  '23505', 'Arena S1 checkpoint identity was reused with different content',
  'an S1 checkpoint idempotency key cannot hide changed content'
);
reset role;
select ok(
  not public.jsonb_contains_number(
    (select value from arena_s1_checkpoint_result)
  ),
  'S1 checkpoint result contains no JSON numeric tokens'
);
select is(
  (select plan.engine_plan_fingerprint
     from public.frozen_order_plan as plan
    where plan.stage = 'S2'),
  (select value::text from arena_s2_engine_plan),
  'the S2 wrapper preserves the exact Core engine fingerprint'
);
set local role anon;
select throws_ok(
  $$select public.register_arena_s1_checkpoint(
    'anon', null, 0, repeat('0', 64), '{}', repeat('0', 64),
    '{}', repeat('0', 64), 'anon'
  )$$,
  '42501', null,
  'anonymous callers cannot freeze a private Arena checkpoint'
);
reset role;

select has_function(
  'public', 'finalize_arena_accepted_target_cycle',
  array[
    'text', 'uuid', 'uuid', 'text', 'text', 'timestamp with time zone',
    'uuid', 'text', 'text'
  ],
  'the final cycle and ranking valuation share one atomic boundary'
);

create temporary table s2_open_reference_payload on commit drop as
select jsonb_build_object(
  'expectedOpenAt', '2026-09-01T13:30:00.000Z',
  'feed', 'sip',
  'method', 'ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE',
  'observedAt', '2026-09-01T13:32:05.000Z',
  'references', jsonb_build_array(jsonb_build_object(
    'barStart', '2026-09-01T13:30:00.000Z',
    'currency', 'USD',
    'factSha256', encode(extensions.digest(convert_to(
      'LULU' || chr(31) || '2026-09-01T13:30:00.000Z' || chr(31)
        || 'USD' || chr(31) || '119' || chr(31)
        || 'alpaca-first-minute-open-reference-v1', 'UTF8'
    ), 'sha256'), 'hex'),
    'symbol', 'LULU', 'value', '119'
  )),
  'requestFingerprint', repeat('3', 64),
  'responseSha256', repeat('4', 64),
  'schema', 'twofold.alpaca_open_reference_delivery/v1',
  'sessionDate', '2026-09-01',
  'sourceVersionKey', 'arena-round-contract-open-reference'
)::text as canonical_json;
grant select on s2_open_reference_payload to service_role;
set local role service_role;
select public.register_arena_round_open_reference(
  'arena-round-contract:round:1:s2-open-reference',
  'd5000000-0000-4000-8000-000000000001', 'S2_OPEN_REFERENCE',
  (select source_version_id from public.data_source_version
    where version_key = 'arena-round-contract-open-reference'),
  'twofold-private-artifacts',
  'raw/alpaca/44/' || repeat('4', 64) || '.json', 123, repeat('4', 64),
  (select canonical_json from s2_open_reference_payload),
  'arena-round-contract'
);
reset role;

insert into public.raw_artifact (
  raw_artifact_id, storage_bucket, object_path, content_type,
  byte_size, response_sha256, first_stored_at
) values (
  'f1000000-0000-4000-8000-000000000001',
  'twofold-private-artifacts',
  'raw/alpaca/55/' || repeat('5', 64) || '.json',
  'application/json', 2, repeat('5', 64),
  '2026-09-01T20:20:05.000Z'
);
insert into public.source_delivery (
  delivery_id, idempotency_key, source_version_id, raw_artifact_id,
  request_fingerprint, http_status, retrieved_at, first_observed_at,
  available_at, normalized_manifest_sha256, recorded_at
) values (
  'f1100000-0000-4000-8000-000000000001',
  'arena-round-contract:s2-close-delivery',
  'd2000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000001',
  repeat('6', 64), 200,
  '2026-09-01T20:20:05.000Z', '2026-09-01T20:20:05.000Z',
  '2026-09-01T20:20:05.000Z', repeat('7', 64),
  '2026-09-01T20:20:05.000Z'
);
insert into public.market_bar_fact (
  fact_id, source_version_id, symbol, timeframe, bar_start, bar_date,
  currency, open_price, high_price, low_price, close_price, volume,
  trade_count, vwap, normalizer_version, fact_sha256, recorded_at
) values (
  'f1200000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000001',
  'LULU', '1Day', '2026-09-01T04:00:00.000Z', '2026-09-01',
  'USD', '119', '122', '118', '121', '100', '10', '120.5',
  'arena-round-contract', repeat('0', 64),
  '2026-09-01T20:20:05.000Z'
);
insert into public.delivery_fact (delivery_id, fact_id, fact_index) values (
  'f1100000-0000-4000-8000-000000000001',
  'f1200000-0000-4000-8000-000000000001', 0
);
insert into public.market_snapshot (
  snapshot_id, idempotency_key, source_version_id, snapshot_kind,
  cutoff_at, target_session_date, symbols, selection_policy,
  manifest_schema, manifest_sha256, sealed_at
) values (
  'f1300000-0000-4000-8000-000000000001',
  'arena-round-contract:s2-close-snapshot',
  'd2000000-0000-4000-8000-000000000001', 'market_close',
  '2026-09-01T20:20:05.000Z', '2026-09-01', array['LULU'],
  'arena-round-contract', 'twofold.market_snapshot/v2', repeat('9', 64),
  '2026-09-01T20:20:06.000Z'
);
insert into public.market_snapshot_member (
  snapshot_id, symbol, delivery_id, fact_id, member_index
) values (
  'f1300000-0000-4000-8000-000000000001', 'LULU',
  'f1100000-0000-4000-8000-000000000001',
  'f1200000-0000-4000-8000-000000000001', 0
);
set local role service_role;
select public.register_arena_round_close_snapshot(
  'arena-round-contract:round:1:s2-close',
  'd5000000-0000-4000-8000-000000000001', 'S2_CLOSE',
  'f1300000-0000-4000-8000-000000000001',
  'arena-round-contract'
);
reset role;

insert into public.artifact_metadata (
  artifact_id, idempotency_key, season_id, artifact_kind, storage_bucket,
  object_path, content_type, byte_size, sha256, created_by, metadata
) values (
  'f2000000-0000-4000-8000-000000000001',
  'arena-round-contract:s2-tax-fx-source',
  'd1000000-0000-4000-8000-000000000001',
  'official_tax_fx_rate', 'twofold-private-artifacts',
  'competition-sources/ecb/' || repeat('c', 64) || '.json',
  'application/json', 123, repeat('c', 64), 'arena-round-contract',
  jsonb_build_object(
    'schema', 'twofold.ecb_reference_source/v1',
    'sourceUrl',
      'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml',
    'effectiveDate', '2026-09-01',
    'observedAt', '2026-09-01T20:20:05.000Z',
    'rawBodySha256', repeat('d', 64)
  )
);
create temporary table s2_tax_fx_payload on commit drop as
select
  '{"authority":"ECB_REFERENCE_CROSS","availableAt":"2026-09-01T20:20:05.000Z","cnyPerUsd":"6.75","derivation":"EUR_CNY_DIV_EUR_USD_HALF_UP_12","effectiveDate":"2026-09-01","eurToCny":"7.83","eurToUsd":"1.16","observedAt":"2026-09-01T20:20:05.000Z","schema":"twofold.ecb_usd_cny_reference_cross/v1","status":"ESTIMATED"}'::text
    as canonical_json;
grant select on s2_tax_fx_payload to service_role;
set local role service_role;
select public.register_arena_round_tax_fx_reference(
  'arena-round-contract:round:1:s2-tax-fx',
  'd5000000-0000-4000-8000-000000000001', 'S2_ACQUISITION',
  'f2000000-0000-4000-8000-000000000001', repeat('c', 64),
  repeat('d', 64), (select canonical_json from s2_tax_fx_payload),
  encode(extensions.digest(convert_to(
    (select canonical_json from s2_tax_fx_payload), 'UTF8'
  ), 'sha256'), 'hex'),
  'arena-round-contract'
);
reset role;

set local role service_role;
create temporary table arena_final_material on commit drop as
select public.get_arena_cycle_material(
  (select round_entry_id from public.arena_round_entry
    where round_id = 'd5000000-0000-4000-8000-000000000001'),
  'FINALIZE_ACCEPTED_TARGET_CYCLE'
) as value;
reset role;
select ok((
  select value->'evidence' ?& array[
    'decisionClose', 's1Open', 's1Close', 's1DispositionFx',
    's2Open', 's2Close', 's2AcquisitionFx'
  ] and (select count(*) from jsonb_object_keys(value->'evidence')) = 7
  from arena_final_material
), 'final settlement receives all seven gated evidence groups exactly once');

create temporary table arena_final_cycle_payload on commit drop as
select jsonb_build_object(
  'schema', 'twofold.accepted_target_cycle/v1',
  'submissionId', checkpoint.artifact->>'submissionId',
  'decisionId', checkpoint.artifact->>'decisionId',
  's1', checkpoint.artifact->'s1',
  's2', jsonb_build_object(
    'plan', checkpoint.artifact->'s2Plan',
    'settlements', '[]'::jsonb
  ),
  'positions', checkpoint.artifact->'positions',
  'ledger', checkpoint.artifact->'ledger',
  'nav', jsonb_build_object(
    'currency', 'USD',
    'positionMarketValue', '18150',
    'brokerNav', '18150',
    'taxReserveDeductions', '0',
    'taxReservedNav', '18150',
    'liquidationDeductions', '7.972',
    'liquidationNav', '18142.028'
  ),
  'finalLedgerHead', jsonb_build_object(
    'sequence', input_.head_sequence::text,
    'sha256', input_.head_sha256
  )
)::text as canonical_json
from public.arena_cycle_stage_result as checkpoint
cross join arena_s1_freeze_input as input_
where checkpoint.round_entry_id = input_.round_entry_id
  and checkpoint.phase = 'SETTLE_S1_AND_PREPARE_S2';

create temporary table arena_final_valuation_payload on commit drop as
select jsonb_build_object(
  'brokerNav', '18150',
  'estimatedCloseFees', '2.84',
  'estimatedUnrealizedLiquidationTax', '5.132',
  'feeScheduleIds', jsonb_build_array(
    'futu_hk_us_equity_fixed_2026-08-23'
  ),
  'ledgerSequence', input_.head_sequence::text,
  'ledgerSha256', input_.head_sha256,
  'liquidationNav', '18142.028',
  'portfolioAsOf', '2026-09-01T20:20:06.000Z',
  'positionMarketValue', '18150',
  'reportingCurrency', 'USD',
  'schema', 'twofold.arena_valuation/v1',
  'scoreBaseLiquidationNav', '18118.66',
  'settledCash', '0',
  'taxReserve', '0',
  'taxReservedNav', '18150',
  'valuationAt', '2026-09-01T20:20:06.000Z',
  'valuationDate', '2026-09-01'
)::text as canonical_json
from arena_s1_freeze_input as input_;
grant select on arena_final_cycle_payload, arena_final_valuation_payload
  to service_role;
create temporary table arena_final_cycle_identity on commit drop as
select cycle_.canonical_json,
  encode(extensions.digest(convert_to(cycle_.canonical_json, 'UTF8'),
    'sha256'), 'hex') as cycle_sha256,
  public.deterministic_uuid_from_sha256(
    'twofold.accepted_target_cycle/v1',
    encode(extensions.digest(convert_to(cycle_.canonical_json, 'UTF8'),
      'sha256'), 'hex')
  ) as cycle_id,
  public.deterministic_uuid_from_sha256(
    'twofold.event.accepted_target_cycle/v1',
    public.deterministic_uuid_from_sha256(
      'twofold.accepted_target_cycle/v1',
      encode(extensions.digest(convert_to(cycle_.canonical_json, 'UTF8'),
        'sha256'), 'hex')
    )::text
  ) as event_id
from arena_final_cycle_payload as cycle_;
grant select on arena_final_cycle_identity to service_role;

set local role service_role;
create temporary table arena_finalization_result on commit drop as
select public.finalize_arena_accepted_target_cycle(
  'arena-round-contract:finalize', input_.round_entry_id,
  identity_.cycle_id, identity_.canonical_json, identity_.cycle_sha256,
  '2026-09-01T20:20:06.000Z',
  identity_.event_id,
  valuation_.canonical_json, 'arena-round-contract'
) as value
from arena_s1_freeze_input as input_
cross join arena_final_cycle_identity as identity_
cross join arena_final_valuation_payload as valuation_;
reset role;

select is(
  (select value->>'schema' from arena_finalization_result),
  'twofold.arena_cycle_finalization_result/v1',
  'finalization returns one explicit combined result'
);
select is(
  (select count(*) from public.accepted_target_cycle
    where decision_id = (select decision_id from public.arena_round_entry
      where round_id = 'd5000000-0000-4000-8000-000000000001')),
  1::bigint,
  'one full accepted-target cycle is durably published'
);
select ok((
  select valuation.stage = 'S2_CLOSE'
     and valuation.snapshot_id = 'f1300000-0000-4000-8000-000000000001'
     and valuation.liquidation_nav = 18142.028
    from public.arena_valuation as valuation
   where valuation.round_id = 'd5000000-0000-4000-8000-000000000001'
     and valuation.stage = 'S2_CLOSE'
), 'the final cycle publishes its exact shared-close ranking valuation');
select is(
  (public.get_arena_leaderboard(
    'd1000000-0000-4000-8000-000000000001'
  )->0->>'stage'),
  'S2_CLOSE',
  'leaderboard advances to the completed S2 close'
);
set local role service_role;
select is(
  (public.finalize_arena_accepted_target_cycle(
    'arena-round-contract:finalize', input_.round_entry_id,
    identity_.cycle_id, identity_.canonical_json, identity_.cycle_sha256,
    '2026-09-01T20:20:06.000Z', identity_.event_id,
    valuation_.canonical_json, 'arena-round-contract'
  )#>>'{cycle,cycleId}'),
  (select value#>>'{cycle,cycleId}' from arena_finalization_result),
  'an exact finalization retry returns the same cycle identity'
)
from arena_s1_freeze_input as input_
cross join arena_final_cycle_identity as identity_
cross join arena_final_valuation_payload as valuation_;
select throws_ok(
  $$select public.finalize_arena_accepted_target_cycle(
    'arena-round-contract:finalize', input_.round_entry_id,
    identity_.cycle_id, identity_.canonical_json, identity_.cycle_sha256,
    '2026-09-01T20:20:06.000Z', identity_.event_id,
    valuation_.canonical_json, 'different-recorder'
  )
  from arena_s1_freeze_input as input_
  cross join arena_final_cycle_identity as identity_
  cross join arena_final_valuation_payload as valuation_$$,
  '23505', 'accepted target cycle identity was reused with different content',
  'a finalization retry cannot hide changed recorder identity'
);
reset role;
select ok(
  not public.jsonb_contains_number(
    (select value from arena_finalization_result)
  ),
  'finalization result contains no JSON numeric tokens'
);
set local role anon;
select throws_ok(
  $$select public.finalize_arena_accepted_target_cycle(
    'anon', null, null, '{}', repeat('0', 64), now(), null, '{}', 'anon'
  )$$,
  '42501', null,
  'anonymous callers cannot finalize a private Arena cycle'
);
reset role;

select has_function(
  'public', 'get_private_arena_overview',
  array['uuid', 'timestamp with time zone'],
  'the private Arena dashboard has one authoritative read boundary'
);
set local role service_role;
create temporary table private_arena_overview_result on commit drop as
select public.get_private_arena_overview(
  'd1000000-0000-4000-8000-000000000001',
  '2026-09-01T20:20:06.000Z'
) as value;
reset role;
select is(
  (select value->>'schema' from private_arena_overview_result),
  'twofold.private_arena_overview/v2',
  'the private Arena overview schema is explicit'
);
select is(
  (select value#>>'{entrants,0,schema}' from private_arena_overview_result),
  'twofold.private_arena_entrant_overview/v2',
  'the entrant overview versions its explicit no-trade field'
);
select is(
  (select value#>'{entrants,0,noTrade}' from private_arena_overview_result),
  'null'::jsonb,
  'a normally completed entrant has no no-trade recovery marker'
);
select is(
  (select value#>>'{season,seasonId}' from private_arena_overview_result),
  'd1000000-0000-4000-8000-000000000001',
  'the overview is bound to the requested Season'
);
select is(
  (select value#>>'{season,openingHolding}'
     from private_arena_overview_result),
  '150 LULU',
  'the overview preserves the frozen opening holding'
);
select is(
  (select value#>>'{currentRound,stage}' from private_arena_overview_result),
  'COMPLETE',
  'a Round with every final valuation is complete'
);
select is(
  (select jsonb_array_length(value->'entrants')
     from private_arena_overview_result),
  1,
  'the overview returns every Season entrant exactly once'
);
select is(
  (select value#>>'{entrants,0,valuation,stage}'
     from private_arena_overview_result),
  'S2_CLOSE',
  'the entrant score uses the authoritative latest valuation'
);
select is(
  (select jsonb_array_length(value#>'{entrants,0,work}')
     from private_arena_overview_result),
  8,
  'the entrant exposes the complete real-time work DAG'
);
select ok(
  not public.jsonb_contains_number(
    (select value from private_arena_overview_result)
  ),
  'the private Arena overview contains no JSON numeric tokens'
);
set local role anon;
select throws_ok(
  $$select public.get_private_arena_overview(
    'd1000000-0000-4000-8000-000000000001',
    '2026-09-01T20:20:06.000Z'
  )$$,
  '42501', null,
  'anonymous callers cannot read the private Arena overview'
);
reset role;

select has_table(
  'public', 'arena_round_provisioning',
  'completed cycles create durable next-Round provisioning work'
);
select has_function(
  'public', 'claim_arena_round_provisioning',
  array['text', 'integer', 'timestamp with time zone'],
  'a scheduler leases one next-Round request'
);
select has_function(
  'public', 'commit_arena_round_provisioning',
  array['uuid', 'uuid', 'uuid', 'text', 'jsonb', 'timestamp with time zone'],
  'one atomic boundary registers the Round, seats, and work DAG'
);
select has_function(
  'public', 'fail_arena_round_provisioning',
  array['uuid', 'uuid', 'timestamp with time zone', 'text', 'text', 'boolean'],
  'provisioning failures use a lease-safe retry boundary'
);
select is(
  (select count(*) from public.arena_round_provisioning
    where source_round_id = 'd5000000-0000-4000-8000-000000000001'),
  0::bigint,
  'a final valuation alone cannot start a later Round'
);

select set_config('twofold.arena_round_provisioning_mutation', 'on', true);
select set_config('twofold.arena_work_item_mutation', 'on', true);
update public.arena_work_item
   set status = 'SUCCEEDED', completed_at = '2026-09-01T20:20:07.000Z',
       result = '{"outcome":"CONTRACT_PREREQUISITE"}', retryable = false,
       claimed_by = null, lease_token = null, claimed_at = null,
       lease_expires_at = null, completion_fingerprint_sha256 = null
 where round_id = 'd5000000-0000-4000-8000-000000000001'
   and phase <> 'FINALIZE_ACCEPTED_TARGET_CYCLE';
update public.arena_work_item
   set status = 'SUCCEEDED', completed_at = '2026-09-01T20:20:08.000Z',
       result = '{"outcome":"CONTRACT_FINALIZED"}', retryable = false,
       claimed_by = null, lease_token = null, claimed_at = null,
       lease_expires_at = null, completion_fingerprint_sha256 = null
 where round_id = 'd5000000-0000-4000-8000-000000000001'
   and phase = 'FINALIZE_ACCEPTED_TARGET_CYCLE';
select set_config('twofold.arena_work_item_mutation', 'off', true);
select set_config('twofold.arena_round_provisioning_mutation', 'off', true);

select is(
  (select count(*) from public.arena_round_provisioning
    where source_round_id = 'd5000000-0000-4000-8000-000000000001'),
  1::bigint,
  'the last successful entrant finalization enqueues exactly one next Round'
);
select ok((
  select next_round_index = 2
     and decision_snapshot_id = 'f1300000-0000-4000-8000-000000000001'
     and decision_session_date = '2026-09-01'
    from public.arena_round_provisioning
   where source_round_id = 'd5000000-0000-4000-8000-000000000001'
), 'the next decision is causally based on the completed shared S2 close');

set local role service_role;
create temporary table arena_provisioning_claim on commit drop as
select public.claim_arena_round_provisioning(
  'arena-round-scheduler', 60, '2026-09-01T20:20:09.000Z'
) as value;
reset role;
select is(
  (select value->>'schema' from arena_provisioning_claim),
  'twofold.arena_round_provisioning/v1',
  'the provisioning lease schema is explicit'
);
select is(
  (select value->>'status' from arena_provisioning_claim),
  'CLAIMED',
  'the due next Round is leased exactly once'
);
select ok(
  not public.jsonb_contains_number(
    (select value from arena_provisioning_claim)
  ),
  'the provisioning lease contains no JSON numeric tokens'
);
set local role anon;
select throws_ok(
  $$select public.claim_arena_round_provisioning(
    'anon', 60, '2026-09-01T20:20:09.000Z'
  )$$,
  '42501', null,
  'anonymous callers cannot claim private Round provisioning'
);
reset role;

insert into public.artifact_metadata (
  artifact_id, idempotency_key, season_id, artifact_kind, storage_bucket,
  object_path, content_type, byte_size, sha256, created_by, metadata
) values (
  'aa000000-0000-4000-8000-000000000036',
  'arena-round-contract:round:2:calendar',
  'd1000000-0000-4000-8000-000000000001',
  'exchange_calendar_schedule', 'twofold-private-artifacts',
  'arena/calendar/round-2-contract.json', 'application/json', 1,
  repeat('6', 64), 'arena-round-contract', '{"provider":"alpaca"}'
);
create temporary table arena_round_2_schedule on commit drop as
select '{
  "schema":"twofold.two_stage_cycle_calendar/v1",
  "decisionSessionDate":"2026-09-01",
  "s1SessionDate":"2026-09-02",
  "s1OpenAt":"2026-09-02T13:30:00.000Z",
  "s1ReferenceAvailableAt":"2026-09-02T13:32:00.000Z",
  "s1CloseAt":"2026-09-02T20:00:00.000Z",
  "s1CloseAvailableAt":"2026-09-02T20:20:00.000Z",
  "s2SessionDate":"2026-09-03",
  "s2OpenAt":"2026-09-03T13:30:00.000Z",
  "s2ReferenceAvailableAt":"2026-09-03T13:32:00.000Z",
  "s2CloseAt":"2026-09-03T20:00:00.000Z",
  "cycleReadyAt":"2026-09-03T20:20:00.000Z"
}'::jsonb as value;
grant select on arena_round_2_schedule to service_role;

set local role service_role;
create temporary table arena_provisioning_commit on commit drop as
select public.commit_arena_round_provisioning(
  (select (value->>'provisioningId')::uuid from arena_provisioning_claim),
  (select (value->>'leaseToken')::uuid from arena_provisioning_claim),
  'aa000000-0000-4000-8000-000000000036', repeat('6', 64),
  (select value from arena_round_2_schedule),
  '2026-09-01T20:20:10.000Z'
) as value;
reset role;
select is(
  (select value->>'outcome' from arena_provisioning_commit),
  'ROUND_PROVISIONED',
  'the completed cycle atomically provisions its next Round'
);
select ok((
  select round_index = 2
     and decision_snapshot_id = 'f1300000-0000-4000-8000-000000000001'
     and decision_window_opens_at = '2026-09-01T20:20:10.000Z'
     and decision_window_closes_at = '2026-09-02T13:15:00.000Z'
    from public.arena_round
   where season_id = 'd1000000-0000-4000-8000-000000000001'
     and round_index = 2
), 'Round 2 starts only after Round 1 final state and closes before S1 open');
select is(
  (select count(*) from public.arena_round_entry
    where round_id = (select (value->>'roundId')::uuid
      from arena_provisioning_commit)),
  1::bigint,
  'every stable Season entrant receives one Round 2 seat'
);
select is(
  (select count(*) from public.arena_work_item
    where round_id = (select (value->>'roundId')::uuid
      from arena_provisioning_commit)),
  8::bigint,
  'the next Round receives the complete real-cadence work DAG'
);
set local role service_role;
select is(
  (public.commit_arena_round_provisioning(
    (select (value->>'provisioningId')::uuid from arena_provisioning_claim),
    (select (value->>'leaseToken')::uuid from arena_provisioning_claim),
    'aa000000-0000-4000-8000-000000000036', repeat('6', 64),
    (select value from arena_round_2_schedule),
    '2026-09-01T20:20:10.000Z'
  )->>'roundId'),
  (select value->>'roundId' from arena_provisioning_commit),
  'an exact lost-response retry returns the same provisioned Round'
);
select throws_ok(
  $$select public.commit_arena_round_provisioning(
    (select (value->>'provisioningId')::uuid from arena_provisioning_claim),
    (select (value->>'leaseToken')::uuid from arena_provisioning_claim),
    'aa000000-0000-4000-8000-000000000036', repeat('6', 64),
    (select value from arena_round_2_schedule),
    '2026-09-01T20:20:11.000Z'
  )$$,
  '23505',
  'Arena Round provisioning identity was reused with different content',
  'a provisioning retry cannot change its completion identity'
);
reset role;
select ok(
  not public.jsonb_contains_number(
    (select value from arena_provisioning_commit)
  ),
  'the Round provisioning commit contains no JSON numeric tokens'
);
select throws_ok(
  $$update public.arena_round_provisioning set next_round_index = 3
     where source_round_id = 'd5000000-0000-4000-8000-000000000001'$$,
  '55000',
  'Arena Round provisioning may change only through queue RPCs',
  'provisioning identity cannot be edited directly'
);
set local role anon;
select throws_ok(
  $$select public.commit_arena_round_provisioning(
    null, null, null, repeat('0', 64), '{}', now()
  )$$,
  '42501', null,
  'anonymous callers cannot provision a private Round'
);
reset role;

select has_table(
  'public', 'arena_no_trade_recovery',
  'a contestant-local terminal failure has durable carry-forward work'
);
select has_function(
  'public', 'claim_arena_no_trade_recovery',
  array['text', 'integer', 'timestamp with time zone'],
  'no-trade recovery is leased only after the shared S2 evidence boundary'
);
select has_function(
  'public', 'commit_arena_no_trade_recovery',
  array['uuid', 'uuid', 'text', 'timestamp with time zone'],
  'unchanged-ledger valuation and recovery completion share one boundary'
);
select has_function(
  'public', 'fail_arena_no_trade_recovery',
  array['uuid', 'uuid', 'timestamp with time zone', 'text', 'text', 'boolean'],
  'recovery failures use a lease-safe retry boundary'
);

create temporary table arena_round_2_fixture on commit drop as
select round.round_id, entry.round_entry_id, entry.decision_id, entry.run_id
  from public.arena_round as round
  join public.arena_round_entry as entry on entry.round_id = round.round_id
 where round.season_id = 'd1000000-0000-4000-8000-000000000001'
   and round.round_index = 2;
grant select on arena_round_2_fixture to service_role;
create temporary table arena_no_trade_head_before on commit drop as
select head.head_sequence, head.head_sha256, head.updated_at
  from arena_round_2_fixture as fixture
  join public.strategy_account as account on account.run_id = fixture.run_id
  join public.strategy_ledger_head as head
    on head.strategy_account_id = account.strategy_account_id;

select set_config('twofold.arena_work_item_mutation', 'on', true);
update public.arena_work_item
   set status = 'CANCELED', completed_at = '2026-09-02T13:15:00.000Z',
       result = '{"outcome":"DEADLINE_EXPIRED"}',
       error_code = 'DEADLINE_EXPIRED',
       error_message = 'Decision was not completed before its deadline',
       retryable = false
 where round_entry_id = (select round_entry_id from arena_round_2_fixture)
   and phase = 'RUN_AGENT_DECISION';
select set_config('twofold.arena_work_item_mutation', 'off', true);

select is(
  (select count(*) from public.arena_no_trade_recovery
    where round_entry_id = (select round_entry_id from arena_round_2_fixture)),
  1::bigint,
  'one local terminal failure creates exactly one recovery request'
);
select ok((
  select reason_code = 'DECISION_UNAVAILABLE'
     and scheduled_at = '2026-09-03T20:20:00.000Z'
     and next_attempt_at = scheduled_at
    from public.arena_no_trade_recovery
   where round_entry_id = (select round_entry_id from arena_round_2_fixture)
), 'the recovery reason and shared S2 availability time are frozen');

-- The remote contract runs against a live database whose global recovery
-- queue may contain unrelated rows. Make those rows unavailable only inside
-- this rollback-only transaction so both claims below are fixture-local.
select set_config('twofold.arena_no_trade_recovery_mutation', 'on', true);
update public.arena_no_trade_recovery
   set next_attempt_at = 'infinity'::timestamptz
 where status = 'REQUESTED'
   and round_entry_id <> (select round_entry_id from arena_round_2_fixture);
select set_config('twofold.arena_no_trade_recovery_mutation', 'off', true);

set local role service_role;
create temporary table arena_no_trade_early_claim on commit drop as
select public.claim_arena_no_trade_recovery(
  'arena-no-trade-worker', 60, '2026-09-03T20:19:59.999Z'
) as value;
reset role;
select is(
  (select value from arena_no_trade_early_claim), null::jsonb,
  'no-trade recovery cannot run before the real S2-close boundary'
);

insert into public.raw_artifact (
  raw_artifact_id, storage_bucket, object_path, content_type,
  byte_size, response_sha256, first_stored_at
) values (
  'fa000000-0000-4000-8000-000000000001',
  'twofold-private-artifacts',
  'raw/alpaca/aa/' || repeat('a', 64) || '.json',
  'application/json', 2, repeat('a', 64),
  '2026-09-03T20:20:05.000Z'
);
insert into public.source_delivery (
  delivery_id, idempotency_key, source_version_id, raw_artifact_id,
  request_fingerprint, http_status, retrieved_at, first_observed_at,
  available_at, normalized_manifest_sha256, recorded_at
) values (
  'fa100000-0000-4000-8000-000000000001',
  'arena-round-contract:round:2:s2-close-delivery',
  'd2000000-0000-4000-8000-000000000001',
  'fa000000-0000-4000-8000-000000000001',
  repeat('b', 64), 200,
  '2026-09-03T20:20:05.000Z', '2026-09-03T20:20:05.000Z',
  '2026-09-03T20:20:05.000Z', repeat('c', 64),
  '2026-09-03T20:20:05.000Z'
);
insert into public.market_bar_fact (
  fact_id, source_version_id, symbol, timeframe, bar_start, bar_date,
  currency, open_price, high_price, low_price, close_price, volume,
  trade_count, vwap, normalizer_version, fact_sha256, recorded_at
) values (
  'fa200000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000001',
  'LULU', '1Day', '2026-09-03T04:00:00.000Z', '2026-09-03',
  'USD', '119', '122', '118', '121', '100', '10', '120.5',
  'arena-round-contract', repeat('d', 64),
  '2026-09-03T20:20:05.000Z'
);
insert into public.delivery_fact (delivery_id, fact_id, fact_index) values (
  'fa100000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001', 0
);
insert into public.market_snapshot (
  snapshot_id, idempotency_key, source_version_id, snapshot_kind,
  cutoff_at, target_session_date, symbols, selection_policy,
  manifest_schema, manifest_sha256, sealed_at
) values (
  'fa300000-0000-4000-8000-000000000001',
  'arena-round-contract:round:2:s2-close-snapshot',
  'd2000000-0000-4000-8000-000000000001', 'market_close',
  '2026-09-03T20:20:05.000Z', '2026-09-03', array['LULU'],
  'arena-round-contract', 'twofold.market_snapshot/v2', repeat('e', 64),
  '2026-09-03T20:20:06.000Z'
);
insert into public.market_snapshot_member (
  snapshot_id, symbol, delivery_id, fact_id, member_index
) values (
  'fa300000-0000-4000-8000-000000000001', 'LULU',
  'fa100000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001', 0
);
set local role service_role;
select public.register_arena_round_close_snapshot(
  'arena-round-contract:round:2:s2-close',
  (select round_id from arena_round_2_fixture), 'S2_CLOSE',
  'fa300000-0000-4000-8000-000000000001',
  'arena-round-contract'
);
create temporary table arena_no_trade_claim on commit drop as
select public.claim_arena_no_trade_recovery(
  'arena-no-trade-worker', 60, '2026-09-03T20:20:07.000Z'
) as value;
reset role;

select is(
  (select value->>'schema' from arena_no_trade_claim),
  'twofold.arena_no_trade_recovery/v1',
  'the no-trade recovery lease schema is explicit'
);
select ok((
  select value->>'status' = 'CLAIMED'
     and value->>'reasonCode' = 'DECISION_UNAVAILABLE'
     and value->>'attemptCount' = '1'
    from arena_no_trade_claim
), 'the due recovery is leased exactly once with its causal reason');
select ok(
  not public.jsonb_contains_number((select value from arena_no_trade_claim)),
  'the no-trade recovery lease contains no JSON numeric tokens'
);
set local role anon;
select throws_ok(
  $$select public.claim_arena_no_trade_recovery(
    'anon', 60, '2026-09-03T20:20:07.000Z'
  )$$,
  '42501', null,
  'anonymous callers cannot claim private no-trade recovery'
);
reset role;

create temporary table arena_no_trade_valuation_payload on commit drop as
select jsonb_build_object(
  'brokerNav', '18150',
  'estimatedCloseFees', '2.84',
  'estimatedUnrealizedLiquidationTax', '5.132',
  'feeScheduleIds', jsonb_build_array(
    'futu_hk_us_equity_fixed_2026-08-23'
  ),
  'ledgerSequence', head.head_sequence::text,
  'ledgerSha256', head.head_sha256,
  'liquidationNav', '18142.028',
  'portfolioAsOf', to_char(head.updated_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'positionMarketValue', '18150',
  'reportingCurrency', 'USD',
  'schema', 'twofold.arena_valuation/v1',
  'scoreBaseLiquidationNav', '18118.66',
  'settledCash', '0',
  'taxReserve', '0',
  'taxReservedNav', '18150',
  'valuationAt', '2026-09-03T20:20:06.000Z',
  'valuationDate', '2026-09-03'
)::text as canonical_json
from arena_no_trade_head_before as head;
grant select on arena_no_trade_valuation_payload to service_role;

set local role service_role;
select throws_ok(
  $$select public.commit_arena_no_trade_recovery(
    (select (value->>'recoveryId')::uuid from arena_no_trade_claim),
    (select (value->>'leaseToken')::uuid from arena_no_trade_claim),
    jsonb_set(canonical_json::jsonb, '{ledgerSha256}',
      to_jsonb(repeat('0', 64)))::text,
    '2026-09-03T20:20:08.000Z'
  ) from arena_no_trade_valuation_payload$$,
  '22023',
  'Arena no-trade valuation diverges from unchanged ledger or S2 evidence',
  'a recovery cannot fabricate a different ledger head'
);
reset role;
select is(
  (select status from public.arena_no_trade_recovery
    where round_entry_id = (select round_entry_id from arena_round_2_fixture)),
  'CLAIMED',
  'a rejected valuation leaves the valid recovery lease intact'
);

set local role service_role;
create temporary table arena_no_trade_commit on commit drop as
select public.commit_arena_no_trade_recovery(
  (select (value->>'recoveryId')::uuid from arena_no_trade_claim),
  (select (value->>'leaseToken')::uuid from arena_no_trade_claim),
  (select canonical_json from arena_no_trade_valuation_payload),
  '2026-09-03T20:20:08.000Z'
) as value;
reset role;

select is(
  (select value#>>'{result,outcome}' from arena_no_trade_commit),
  'NO_TRADE_CARRY_FORWARD',
  'a local failure becomes an explicit no-trade economic outcome'
);
select ok((
  select status = 'SUCCEEDED' and valuation_id is not null
     and completed_at = '2026-09-03T20:20:08.000Z'
    from public.arena_no_trade_recovery
   where round_entry_id = (select round_entry_id from arena_round_2_fixture)
), 'the recovery and its S2 valuation commit together');
select is(
  (select status from public.arena_work_item
    where work_item_id = (
      select source_work_item_id from public.arena_no_trade_recovery
       where round_entry_id = (select round_entry_id from arena_round_2_fixture)
    )),
  'CANCELED',
  'the source failure is never rewritten as successful work'
);
select is(
  (select count(*) from public.arena_work_item
    where round_entry_id = (select round_entry_id from arena_round_2_fixture)
      and phase in (
        'RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS',
        'SETTLE_S1_AND_PREPARE_S2', 'FINALIZE_ACCEPTED_TARGET_CYCLE'
      ) and status = 'CANCELED'),
  4::bigint,
  'all remaining contestant-local phases are canceled without fake success'
);
select is(
  (select count(*) from public.arena_work_item
    where round_entry_id = (select round_entry_id from arena_round_2_fixture)
      and phase in (
        'CAPTURE_S1_OPEN_REFERENCE', 'CAPTURE_S1_CLOSE',
        'CAPTURE_S2_OPEN_REFERENCE', 'CAPTURE_S2_CLOSE'
      ) and status <> 'CANCELED'),
  4::bigint,
  'no-trade recovery does not cancel Round-shared market evidence work'
);
select is(
  (select count(*) from public.accepted_target_cycle
    where decision_id = (select decision_id from arena_round_2_fixture)),
  0::bigint,
  'no accepted target or synthetic trade cycle is fabricated'
);
select ok((
  select head.head_sequence = before_.head_sequence
     and head.head_sha256 = before_.head_sha256
     and head.updated_at = before_.updated_at
    from arena_round_2_fixture as fixture
    join public.strategy_account as account on account.run_id = fixture.run_id
    join public.strategy_ledger_head as head
      on head.strategy_account_id = account.strategy_account_id
    cross join arena_no_trade_head_before as before_
), 'the Strategy Account ledger head is preserved byte-for-byte');
select ok((
  select valuation.stage = 'S2_CLOSE'
     and valuation.snapshot_id = 'fa300000-0000-4000-8000-000000000001'
     and valuation.position_market_value = 18150
     and valuation.liquidation_nav = 18142.028
     and valuation.ledger_sequence = before_.head_sequence
     and valuation.ledger_sha256 = before_.head_sha256
    from public.arena_valuation as valuation
    cross join arena_no_trade_head_before as before_
   where valuation.round_entry_id = (
     select round_entry_id from arena_round_2_fixture
   ) and valuation.stage = 'S2_CLOSE'
), 'the unchanged portfolio is ranked against the shared Round 2 S2 close');
select ok((
  select value->>'roundIndex' = '2' and value->>'stage' = 'S2_CLOSE'
     and value->>'liquidationNav' = '18142.028'
    from jsonb_array_elements(public.get_arena_leaderboard(
      'd1000000-0000-4000-8000-000000000001'
    )) as leaderboard(value)
), 'the authoritative leaderboard advances after no-trade recovery');
select is(
  (select count(*) from public.arena_round_provisioning
    where source_round_id = (select round_id from arena_round_2_fixture)),
  1::bigint,
  'a recovered entrant can advance to the next non-overlapping Round'
);
set local role service_role;
create temporary table private_arena_no_trade_overview on commit drop as
select public.get_private_arena_overview(
  'd1000000-0000-4000-8000-000000000001',
  '2026-09-03T20:20:08.000Z'
) as value;
reset role;
select ok((
  select value#>>'{entrants,0,noTrade,schema}'
         = 'twofold.private_arena_no_trade_overview/v1'
     and value#>>'{entrants,0,noTrade,status}' = 'SUCCEEDED'
     and value#>>'{entrants,0,noTrade,reasonCode}' = 'DECISION_UNAVAILABLE'
     and value#>>'{entrants,0,noTrade,sourcePhase}' = 'RUN_AGENT_DECISION'
     and value#>>'{entrants,0,noTrade,outcome}' = 'NO_TRADE_CARRY_FORWARD'
     and value#>>'{entrants,0,valuation,roundIndex}' = '2'
    from private_arena_no_trade_overview
), 'the dashboard explains a ranked no-trade carry-forward explicitly');
select ok(
  not public.jsonb_contains_number(
    (select value from private_arena_no_trade_overview)
  ),
  'the no-trade dashboard overview contains no JSON numeric tokens'
);

set local role service_role;
select is(
  (public.commit_arena_no_trade_recovery(
    (select (value->>'recoveryId')::uuid from arena_no_trade_claim),
    (select (value->>'leaseToken')::uuid from arena_no_trade_claim),
    (select canonical_json from arena_no_trade_valuation_payload),
    '2026-09-03T20:20:08.000Z'
  )->>'recoveryId'),
  (select value->>'recoveryId' from arena_no_trade_commit),
  'an exact lost-response retry returns the same no-trade recovery'
);
select throws_ok(
  $$select public.commit_arena_no_trade_recovery(
    (select (value->>'recoveryId')::uuid from arena_no_trade_claim),
    (select (value->>'leaseToken')::uuid from arena_no_trade_claim),
    (select canonical_json from arena_no_trade_valuation_payload),
    '2026-09-03T20:20:09.000Z'
  )$$,
  '23505',
  'Arena no-trade recovery identity was reused with different content',
  'a no-trade retry cannot change its completion identity'
);
reset role;
select ok(
  not public.jsonb_contains_number((select value from arena_no_trade_commit)),
  'the no-trade recovery commit contains no JSON numeric tokens'
);
select throws_ok(
  $$update public.arena_no_trade_recovery
       set reason_code = 'FINALIZATION_UNAVAILABLE'
     where round_entry_id = (select round_entry_id from arena_round_2_fixture)$$,
  '55000',
  'Arena no-trade recovery may change only through queue RPCs',
  'no-trade recovery identity cannot be edited directly'
);
set local role anon;
select throws_ok(
  $$select public.commit_arena_no_trade_recovery(
    null, null, '{}', now()
  )$$,
  '42501', null,
  'anonymous callers cannot commit private no-trade recovery'
);
reset role;

-- Unadjusted market bars require an independent, revision-aware company-action
-- source. A known split must block the affected date until a per-account
-- application is committed; it must not be guessed inside NAV.
select has_table(
  'public', 'corporate_action_scan',
  'corporate-action provider scans are durable'
);
select has_table(
  'public', 'corporate_action_revision',
  'corporate-action revisions are content-addressed separately from scans'
);
select has_function(
  'public', 'register_corporate_action_scan',
  array[
    'text', 'uuid', 'text', 'date', 'date', 'timestamp with time zone',
    'text', 'text', 'jsonb', 'jsonb', 'text'
  ],
  'the service role can admit one exact paginated corporate-action scan'
);

select ok((
  select (value).dataset = 'us_corporate_actions'
     and (value).feed = 'none'
     and (value).timeframe = 'Event'
    from corporate_action_source
), 'corporate actions use an explicit event source rather than pretending to be bars');

create temporary table corporate_action_fixture on commit drop as
select
  jsonb_build_array(jsonb_build_object(
    'pageIndex', '0',
    'providerRequestId', null,
    'storageBucket', 'twofold-private-artifacts',
    'objectPath', 'raw/alpaca/01/'
      || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      || '.json',
    'byteSize', '2',
    'responseSha256',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  )) as pages,
  jsonb_build_array(jsonb_build_object(
    'schema', 'twofold.alpaca_corporate_action_revision/v1',
    'source', 'ALPACA_CORPORATE_ACTIONS_V1',
    'sourceActionId', 'fb000000-0000-4000-8000-000000000001',
    'revisionSha256', encode(extensions.digest(convert_to(
      '{"ex_date":"2026-09-01","id":"fb000000-0000-4000-8000-000000000001","new_rate":"2","old_rate":"1","process_date":"2026-08-29","symbol":"LULU"}',
      'UTF8'
    ), 'sha256'), 'hex'),
    'type', 'FORWARD_SPLIT',
    'symbol', 'LULU',
    'status', 'COMPLETE',
    'interpretation', 'SPLIT',
    'processDate', '2026-08-29',
    'exDate', '2026-09-01',
    'recordDate', null,
    'payableDate', null,
    'rawCanonicalJson',
      '{"ex_date":"2026-09-01","id":"fb000000-0000-4000-8000-000000000001","new_rate":"2","old_rate":"1","process_date":"2026-08-29","symbol":"LULU"}',
    'oldRate', '1',
    'newRate', '2'
  )) as actions;

create temporary table corporate_action_manifest on commit drop as
select
  jsonb_build_object(
    'schema', 'twofold.alpaca_corporate_action_scan/v1',
    'source', jsonb_build_object(
      'provider', 'alpaca',
      'dataset', 'us_corporate_actions',
      'versionKey', 'arena-contract-corporate-actions-v1',
      'endpointBaseUrl', 'https://data.alpaca.markets',
      'feed', 'none',
      'adjustment', 'raw',
      'timeframe', 'Event',
      'normalizerVersion', 'alpaca-corporate-actions-v1',
      'licenseScope', 'private-research',
      'configSha256', repeat('4', 64),
      'effectiveFrom', '2026-08-01T00:00:00.000Z'
    ),
    'processDateStart', '2026-08-01',
    'processDateEnd', '2026-09-30',
    'observedAt', '2026-08-29T12:00:00.000Z',
    'requestFingerprint', repeat('5', 64),
    'pageResponseSha256', jsonb_build_array(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    ),
    'actions', fixture.actions
  )::text as canonical_json,
  fixture.pages,
  fixture.actions
from corporate_action_fixture as fixture;
grant select on corporate_action_fixture, corporate_action_manifest
  to service_role;

set local role service_role;
create temporary table corporate_action_commit on commit drop as
select public.register_corporate_action_scan(
  'arena-round-contract:corporate-action-scan:1',
  (select (value).source_version_id from corporate_action_source),
  repeat('5', 64), '2026-08-01', '2026-09-30',
  '2026-08-29T12:00:00.000Z', manifest.canonical_json,
  encode(extensions.digest(convert_to(manifest.canonical_json, 'UTF8'),
    'sha256'), 'hex'), manifest.pages, manifest.actions,
  'arena-round-contract'
) as value
from corporate_action_manifest as manifest;
reset role;

select ok((
  select value->>'schema'
           = 'twofold.corporate_action_scan_commit_result/v1'
     and value->>'pageCount' = '1'
     and value->>'actionCount' = '1'
     and value->>'observedAt' = '2026-08-29T12:00:00.000Z'
    from corporate_action_commit
), 'one exact scan commits every raw page and normalized action revision');
select is(
  (select count(*) from public.corporate_action_scan_page
    where scan_id = (
      select (value->>'scanId')::uuid from corporate_action_commit
    )),
  1::bigint,
  'the scan binds its content-addressed raw page'
);
select ok((
  select action_type = 'FORWARD_SPLIT'
     and symbol = 'LULU'
     and evidence_status = 'COMPLETE'
     and ex_date = '2026-09-01'
     and normalized_action->>'oldRate' = '1'
     and normalized_action->>'newRate' = '2'
     and revision_sha256 = encode(extensions.digest(
       convert_to(raw_canonical_json, 'UTF8'), 'sha256'
     ), 'hex')
    from public.corporate_action_revision
   where source_action_id = 'fb000000-0000-4000-8000-000000000001'
), 'the normalized split binds the exact raw provider revision');
select is(
  (select count(*) from public.corporate_action_scan_revision
    where scan_id = (
      select (value->>'scanId')::uuid from corporate_action_commit
    )),
  1::bigint,
  'the observation history links the scan to its immutable revision'
);

set local role service_role;
select is(
  (public.register_corporate_action_scan(
    'arena-round-contract:corporate-action-scan:1',
    (select (value).source_version_id from corporate_action_source),
    repeat('5', 64), '2026-08-01', '2026-09-30',
    '2026-08-29T12:00:00.000Z', manifest.canonical_json,
    encode(extensions.digest(convert_to(manifest.canonical_json, 'UTF8'),
      'sha256'), 'hex'), manifest.pages, manifest.actions,
    'arena-round-contract'
  )->>'scanId'),
  (select value->>'scanId' from corporate_action_commit),
  'an exact lost-response retry returns the same corporate-action scan'
)
from corporate_action_manifest as manifest;
reset role;

set local role service_role;
create temporary table corporate_action_gate_before on commit drop as
select public.get_corporate_action_gate(
  array['LULU'], '2026-08-28', '2026-08-31',
  '2026-08-29T12:00:01.000Z'
) as value;
create temporary table corporate_action_gate_effective on commit drop as
select public.get_corporate_action_gate(
  array['LULU'], '2026-08-28', '2026-09-01',
  '2026-08-29T12:00:01.000Z'
) as value;
create temporary table corporate_action_gate_after on commit drop as
select public.get_corporate_action_gate(
  array['LULU'], '2026-09-02', '2026-09-03',
  '2026-08-29T12:00:01.000Z'
) as value;
reset role;
select is(
  (select value->>'status' from corporate_action_gate_before),
  'CLEAR',
  'a known future split does not block an earlier market date'
);
select ok((
  select value->>'status' = 'BLOCKED'
     and value->>'reason' = 'CORPORATE_ACTION_APPLICATION_REQUIRED'
     and value#>>'{actions,0,type}' = 'FORWARD_SPLIT'
     and value#>>'{actions,0,revisionSha256}' = (
       select revision_sha256 from public.corporate_action_revision
        where source_action_id = 'fb000000-0000-4000-8000-000000000001'
     )
    from corporate_action_gate_effective
), 'the effective date blocks trading until the exact revision is applied');
select is(
  (select value->>'status' from corporate_action_gate_after),
  'CLEAR',
  'an action already absorbed before the economic window does not block it'
);
select ok(
  not public.jsonb_contains_number(
    (select value from corporate_action_gate_effective)
  ),
  'the corporate-action gate contains no JSON numeric tokens'
);
select is(
  public.arena_corporate_action_phase_is_clear(
    'd5000000-0000-4000-8000-000000000001',
    'FINALIZE_ACCEPTED_TARGET_CYCLE',
    '2026-08-29T12:00:01.000Z'
  ),
  false,
  'contestant-local finalization cannot be claimed across an unapplied action'
);
select throws_ok(
  $$update public.corporate_action_revision
       set evidence_status = 'INCOMPLETE'
     where source_action_id = 'fb000000-0000-4000-8000-000000000001'$$,
  '55000',
  'corporate_action_revision is append-only; append a compensating or superseding record instead',
  'a provider revision cannot be edited in place'
);

set local role service_role;
select throws_ok(
  $$select public.register_corporate_action_scan(
    'arena-round-contract:corporate-action-scan:numeric',
    (select (value).source_version_id from corporate_action_source),
    repeat('5', 64), '2026-08-01', '2026-09-30',
    '2026-08-29T12:00:00.000Z', manifest.canonical_json,
    encode(extensions.digest(convert_to(manifest.canonical_json, 'UTF8'),
      'sha256'), 'hex'), manifest.pages,
    jsonb_set(manifest.actions, '{0,newRate}', '2'::jsonb),
    'arena-round-contract'
  ) from corporate_action_manifest as manifest$$,
  '22023',
  'invalid corporate-action scan request',
  'numeric financial tokens are rejected before persistence'
);
reset role;

set local role anon;
select throws_ok(
  $$select public.register_corporate_action_scan(
    null, null, null, null, null, null, null, null, null, null, null
  )$$,
  '42501', null,
  'anonymous callers cannot register private corporate-action evidence'
);
select throws_ok(
  $$select public.get_corporate_action_gate(
    array['LULU'], '2026-08-28', '2026-09-01', now()
  )$$,
  '42501', null,
  'anonymous callers cannot inspect the private corporate-action gate'
);
reset role;

select has_table(
  'public', 'corporate_action_account_preparation',
  'each account freezes split or dividend entitlement before ex-date open'
);
select has_table(
  'public', 'corporate_action_account_application',
  'each due corporate action has one immutable account application'
);
select has_column(
  'public', 'strategy_ledger_head', 'corporate_action_mutation_count',
  'the ledger distinguishes corporate-action mutations from settlements'
);
select has_function(
  'public', 'register_corporate_action_account_preparation',
  array[
    'text','uuid','uuid','uuid','uuid','text','text','text',
    'timestamp with time zone','bigint','uuid','text'
  ],
  'pre-open corporate-action preparation has one exact service boundary'
);
select has_function(
  'public', 'commit_corporate_action_account_application',
  array[
    'text','uuid','uuid','uuid','uuid','text','text','text',
    'timestamp with time zone','bigint','uuid','text'
  ],
  'due corporate-action application has one atomic ledger-CAS boundary'
);
select has_function(
  'public', 'get_corporate_action_account_work',
  array['timestamp with time zone'],
  'the worker discovers every account preparation and due application centrally'
);
set local role service_role;
select ok(exists (
  select 1 from jsonb_array_elements(
    public.get_corporate_action_account_work(
      '2026-09-01T13:00:00.000Z'
    )->'items'
  ) as item(value)
   where item.value->>'sourceActionId'
           = 'fb000000-0000-4000-8000-000000000001'
     and item.value->>'symbol' = 'LULU'
     and item.value->>'instrumentId'
           = item.value#>>'{replayMaterial,portfolio,positions,0,instrumentId}'
     and item.value->>'phase' = 'PREPARE'
     and item.value#>>'{replayMaterial,portfolio,ledgerHead,sha256}'
           = item.value#>>'{replayMaterial,portfolio,ledgerHead,sha256}'
), 'a visible split becomes account-scoped work only in the pre-open window');
reset role;

select * from finish();
rollback;
