-- The S1 settlement phase must be reachable on the evening it is scheduled.
-- A cash dividend whose ex-date falls on the S2 session date cannot hold it:
-- account preparation for that ex-date is exposed only from thirty minutes
-- before the S2 open, while the S2 plan must be written before the S2
-- calendar date, so the two windows never overlap. Finalization keeps the
-- wider horizon, so the entitlement guarantee is unchanged.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(9);

select public.register_arena_season(
  'settlement-window-contract:season',
  'e9100000-0000-4000-8000-000000000001',
  'settlement-window-contract', 'Settlement Window Contract',
  '2026-08-28T21:00:00.000Z', '2026-09-26T00:00:00.000Z',
  'US_EQUITY_DAILY_AFTER_CLOSE', 'America/New_York',
  '{"fixture":"settlement-window"}',
  'settlement-window-contract'
);
select public.register_run_manifest(
  'settlement-window-contract:run',
  'e9110000-0000-4000-8000-000000000001',
  'twofold.run_manifest/v1',
  '{"engine_version":"settlement-window-contract","lot_method":"FIFO"}',
  'settlement-window-contract', repeat('a', 64)
);
select public.register_season_entrant(
  'settlement-window-contract:entrant',
  'e9120000-0000-4000-8000-000000000001',
  'e9100000-0000-4000-8000-000000000001',
  'settlement-window-entrant',
  'e9110000-0000-4000-8000-000000000001',
  'twofold@contract', repeat('b', 64), 'twofold',
  'deepseek-official', 'deepseek-v4-pro', 'ROOT_ONLY',
  '{"track":"MAIN_ARENA"}', 'settlement-window-contract'
);

insert into public.data_source_version (
  source_version_id, provider, dataset, version_key, endpoint_base_url,
  feed, adjustment, timeframe, normalizer_version, license_scope,
  config_sha256, effective_from
) values (
  'e9200000-0000-4000-8000-000000000001', 'alpaca',
  'us_stock_daily_bars', 'settlement-window-contract',
  'https://data.alpaca.markets', 'sip', 'raw', '1Day',
  'settlement-window-contract', 'private-research', repeat('1', 64),
  '2026-08-28T00:00:00.000Z'
);
insert into public.market_snapshot (
  snapshot_id, idempotency_key, source_version_id, snapshot_kind,
  cutoff_at, target_session_date, symbols, selection_policy,
  manifest_schema, manifest_sha256, sealed_at
) values (
  'e9300000-0000-4000-8000-000000000001',
  'settlement-window-contract:snapshot',
  'e9200000-0000-4000-8000-000000000001', 'market_close',
  '2026-08-28T21:00:00.000Z', '2026-08-28', array['LULU'],
  'settlement-window-contract', 'twofold.market_snapshot/v2', repeat('2', 64),
  '2026-08-28T22:00:00.000Z'
);
insert into public.artifact_metadata (
  artifact_id, idempotency_key, season_id, artifact_kind, storage_bucket,
  object_path, content_type, byte_size, sha256, created_by, metadata
) values (
  'e9400000-0000-4000-8000-000000000001',
  'settlement-window-contract:calendar',
  'e9100000-0000-4000-8000-000000000001',
  'exchange_calendar_schedule', 'twofold-private-artifacts',
  'arena/calendar/settlement-window.json', 'application/json', 1,
  repeat('3', 64), 'settlement-window-contract', '{"provider":"alpaca"}'
);
insert into public.strategy_account (
  strategy_account_id, idempotency_key, run_id, account_code, broker,
  broker_region, base_currency, live_trading, metadata, recorded_by
) values (
  'e9600000-0000-4000-8000-000000000001',
  'settlement-window-contract:account',
  'e9110000-0000-4000-8000-000000000001',
  'SETTLEMENT-WINDOW', 'FUTU_HK', 'HK', 'USD', false,
  '{"fixture":"settlement-window"}', 'settlement-window-contract'
);

set local role service_role;
select public.register_arena_round(
  'settlement-window-contract:round',
  'e9500000-0000-4000-8000-000000000001',
  'e9100000-0000-4000-8000-000000000001', 1,
  'e9300000-0000-4000-8000-000000000001',
  '2026-08-28T22:23:53.027Z', '2026-08-31T13:15:00.000Z',
  'e9400000-0000-4000-8000-000000000001', repeat('3', 64),
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
  'settlement-window-contract'
);
select public.register_arena_round_entry(
  'settlement-window-contract:round:entrant',
  'e9500000-0000-4000-8000-000000000001',
  'e9120000-0000-4000-8000-000000000001',
  'settlement-window-contract'
);
select public.seed_arena_round_work(
  'e9500000-0000-4000-8000-000000000001',
  'settlement-window-contract'
);

create temporary table settlement_window_source on commit drop as
select public.register_data_source_version(
  'alpaca', 'us_corporate_actions', 'settlement-window-corporate-actions-v1',
  'https://data.alpaca.markets', 'none', 'raw', 'Event',
  'alpaca-corporate-actions-v1', 'private-research', repeat('4', 64),
  '2026-08-01T00:00:00.000Z'
) as value;
reset role;

-- One completed cash dividend whose ex-date is the Round's S2 session date,
-- with no account preparation. This is the shape that deadlocked Round 1 of
-- private-us-liquid-100-s4 on 2026-09-01.
create temporary table settlement_window_dividend on commit drop as
select
  '{"ex_date":"2026-09-01","foreign":false,'
    || '"id":"e9700000-0000-4000-8000-000000000001",'
    || '"payable_date":"2026-09-14","process_date":"2026-09-14",'
    || '"rate":"0.25","record_date":"2026-09-01","special":false,'
    || '"symbol":"LULU"}' as raw_s2,
  '{"ex_date":"2026-08-31","foreign":false,'
    || '"id":"e9700000-0000-4000-8000-000000000002",'
    || '"payable_date":"2026-09-14","process_date":"2026-09-14",'
    || '"rate":"0.25","record_date":"2026-08-31","special":false,'
    || '"symbol":"LULU"}' as raw_s1,
  jsonb_build_array(jsonb_build_object(
    'pageIndex', '0', 'providerRequestId', null,
    'storageBucket', 'twofold-private-artifacts',
    'objectPath', 'raw/alpaca/ab/'
      || 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
      || '.json',
    'byteSize', '2',
    'responseSha256',
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
  )) as pages;
grant select on settlement_window_source, settlement_window_dividend
  to service_role;

create temporary table settlement_window_s2_action on commit drop as
select jsonb_build_array(jsonb_build_object(
  'schema', 'twofold.alpaca_corporate_action_revision/v1',
  'source', 'ALPACA_CORPORATE_ACTIONS_V1',
  'sourceActionId', 'e9700000-0000-4000-8000-000000000001',
  'revisionSha256', encode(extensions.digest(
    convert_to(dividend.raw_s2, 'UTF8'), 'sha256'), 'hex'),
  'type', 'CASH_DIVIDEND',
  'symbol', 'LULU',
  'status', 'COMPLETE',
  'interpretation', 'CASH_DIVIDEND',
  'processDate', '2026-09-14',
  'exDate', '2026-09-01',
  'recordDate', '2026-09-01',
  'payableDate', '2026-09-14',
  'rawCanonicalJson', dividend.raw_s2,
  'rate', '0.25',
  'foreign', false,
  'special', false
)) as actions
from settlement_window_dividend as dividend;
create temporary table settlement_window_s2_manifest on commit drop as
select jsonb_build_object(
  'schema', 'twofold.alpaca_corporate_action_scan/v1',
  'source', jsonb_build_object(
    'provider', 'alpaca', 'dataset', 'us_corporate_actions',
    'versionKey', 'settlement-window-corporate-actions-v1',
    'endpointBaseUrl', 'https://data.alpaca.markets',
    'feed', 'none', 'adjustment', 'raw', 'timeframe', 'Event',
    'normalizerVersion', 'alpaca-corporate-actions-v1',
    'licenseScope', 'private-research',
    'configSha256', repeat('4', 64),
    'effectiveFrom', '2026-08-01T00:00:00.000Z'
  ),
  'processDateStart', '2026-08-01',
  'processDateEnd', '2026-09-30',
  'observedAt', '2026-08-29T12:00:00.000Z',
  'requestFingerprint', repeat('7', 64),
  'pageResponseSha256', jsonb_build_array(
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
  ),
  'actions', action.actions
)::text as canonical_json
from settlement_window_s2_action as action;
grant select on settlement_window_s2_action, settlement_window_s2_manifest
  to service_role;

set local role service_role;
select public.register_corporate_action_scan(
  'settlement-window-contract:scan:s2-dividend',
  (select (value).source_version_id from settlement_window_source),
  repeat('7', 64), '2026-08-01', '2026-09-30',
  '2026-08-29T12:00:00.000Z', manifest.canonical_json,
  encode(extensions.digest(convert_to(manifest.canonical_json, 'UTF8'),
    'sha256'), 'hex'),
  (select pages from settlement_window_dividend),
  (select actions from settlement_window_s2_action),
  'settlement-window-contract'
)
from settlement_window_s2_manifest as manifest;
reset role;

select is(
  public.arena_corporate_action_phase_is_clear(
    'e9500000-0000-4000-8000-000000000001',
    'SETTLE_S1_AND_PREPARE_S2',
    '2026-08-31T20:20:00.000Z'
  ),
  true,
  'a cash dividend on the S2 session date does not hold S1 settlement'
);
select is(
  public.arena_corporate_action_phase_is_clear(
    'e9500000-0000-4000-8000-000000000001',
    'FINALIZE_ACCEPTED_TARGET_CYCLE',
    '2026-08-31T20:20:00.000Z'
  ),
  false,
  'the same dividend still holds finalization until the account prepares it'
);
-- Neither deadline moves. Legality is decided by the sealed evidence instant,
-- not by queue completion: both phases persist or reuse shared evidence, and
-- an item completing after midnight over evidence sealed before it is still
-- legal. Cancelling either at midnight would destroy that overnight recovery,
-- and a cancelled prerequisite can never be claimed again. The evidence
-- boundary is enforced in the close handler instead.
select is(
  (select deadline_at from public.arena_work_item
    where round_id = 'e9500000-0000-4000-8000-000000000001'
      and phase = 'CAPTURE_S1_CLOSE'),
  '2026-09-01T13:30:00.000Z'::timestamptz,
  'the S1 close keeps the completion and reuse window it already had'
);
select is(
  (select deadline_at from public.arena_work_item
    where round_id = 'e9500000-0000-4000-8000-000000000001'
      and phase = 'SETTLE_S1_AND_PREPARE_S2'),
  '2026-09-01T13:30:00.000Z'::timestamptz,
  'S1 settlement keeps the overnight window its arrival guard allows'
);

-- A dividend whose ex-date is the S1 session date is still in scope: the
-- narrowed horizon guards the session the phase actually settles.
create temporary table settlement_window_s1_action on commit drop as
select jsonb_build_array(jsonb_build_object(
  'schema', 'twofold.alpaca_corporate_action_revision/v1',
  'source', 'ALPACA_CORPORATE_ACTIONS_V1',
  'sourceActionId', 'e9700000-0000-4000-8000-000000000002',
  'revisionSha256', encode(extensions.digest(
    convert_to(dividend.raw_s1, 'UTF8'), 'sha256'), 'hex'),
  'type', 'CASH_DIVIDEND',
  'symbol', 'LULU',
  'status', 'COMPLETE',
  'interpretation', 'CASH_DIVIDEND',
  'processDate', '2026-09-14',
  'exDate', '2026-08-31',
  'recordDate', '2026-08-31',
  'payableDate', '2026-09-14',
  'rawCanonicalJson', dividend.raw_s1,
  'rate', '0.25',
  'foreign', false,
  'special', false
)) as actions
from settlement_window_dividend as dividend;
create temporary table settlement_window_s1_manifest on commit drop as
select jsonb_build_object(
  'schema', 'twofold.alpaca_corporate_action_scan/v1',
  'source', jsonb_build_object(
    'provider', 'alpaca', 'dataset', 'us_corporate_actions',
    'versionKey', 'settlement-window-corporate-actions-v1',
    'endpointBaseUrl', 'https://data.alpaca.markets',
    'feed', 'none', 'adjustment', 'raw', 'timeframe', 'Event',
    'normalizerVersion', 'alpaca-corporate-actions-v1',
    'licenseScope', 'private-research',
    'configSha256', repeat('4', 64),
    'effectiveFrom', '2026-08-01T00:00:00.000Z'
  ),
  'processDateStart', '2026-08-01',
  'processDateEnd', '2026-09-30',
  'observedAt', '2026-08-29T12:30:00.000Z',
  'requestFingerprint', repeat('8', 64),
  'pageResponseSha256', jsonb_build_array(
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
  ),
  'actions', action.actions
)::text as canonical_json
from settlement_window_s1_action as action;
grant select on settlement_window_s1_action, settlement_window_s1_manifest
  to service_role;

set local role service_role;
select public.register_corporate_action_scan(
  'settlement-window-contract:scan:s1-dividend',
  (select (value).source_version_id from settlement_window_source),
  repeat('8', 64), '2026-08-01', '2026-09-30',
  '2026-08-29T12:30:00.000Z', manifest.canonical_json,
  encode(extensions.digest(convert_to(manifest.canonical_json, 'UTF8'),
    'sha256'), 'hex'),
  (select pages from settlement_window_dividend),
  (select actions from settlement_window_s1_action),
  'settlement-window-contract'
)
from settlement_window_s1_manifest as manifest;
reset role;

select is(
  public.arena_corporate_action_phase_is_clear(
    'e9500000-0000-4000-8000-000000000001',
    'SETTLE_S1_AND_PREPARE_S2',
    '2026-08-31T20:20:00.000Z'
  ),
  false,
  'a dividend on the S1 session date still holds S1 settlement'
);

-- A second Season isolates the split case: relevance is Season-scoped through
-- the universe, so a SPY split cannot interact with the LULU dividends above.
-- A split changes the share counts a frozen plan is written in, so it keeps
-- the wider horizon and still holds settlement on the S2 session date.
select public.register_arena_season(
  'settlement-window-contract:season:split',
  'e9800000-0000-4000-8000-000000000001',
  'settlement-window-split', 'Settlement Window Split Contract',
  '2026-08-28T21:00:00.000Z', '2026-09-26T00:00:00.000Z',
  'US_EQUITY_DAILY_AFTER_CLOSE', 'America/New_York',
  '{"fixture":"settlement-window-split"}',
  'settlement-window-contract'
);
select public.register_run_manifest(
  'settlement-window-contract:run:split',
  'e9810000-0000-4000-8000-000000000001',
  'twofold.run_manifest/v1',
  '{"engine_version":"settlement-window-contract","lot_method":"FIFO"}',
  'settlement-window-contract', repeat('c', 64)
);
select public.register_season_entrant(
  'settlement-window-contract:entrant:split',
  'e9820000-0000-4000-8000-000000000001',
  'e9800000-0000-4000-8000-000000000001',
  'settlement-window-split-entrant',
  'e9810000-0000-4000-8000-000000000001',
  'twofold@contract', repeat('d', 64), 'twofold',
  'deepseek-official', 'deepseek-v4-pro', 'ROOT_ONLY',
  '{"track":"MAIN_ARENA"}', 'settlement-window-contract'
);
insert into public.market_snapshot (
  snapshot_id, idempotency_key, source_version_id, snapshot_kind,
  cutoff_at, target_session_date, symbols, selection_policy,
  manifest_schema, manifest_sha256, sealed_at
) values (
  'e9830000-0000-4000-8000-000000000001',
  'settlement-window-contract:snapshot:split',
  'e9200000-0000-4000-8000-000000000001', 'market_close',
  '2026-08-28T21:00:00.000Z', '2026-08-28', array['SPY'],
  'settlement-window-contract', 'twofold.market_snapshot/v2', repeat('5', 64),
  '2026-08-28T22:00:00.000Z'
);
insert into public.artifact_metadata (
  artifact_id, idempotency_key, season_id, artifact_kind, storage_bucket,
  object_path, content_type, byte_size, sha256, created_by, metadata
) values (
  'e9840000-0000-4000-8000-000000000001',
  'settlement-window-contract:calendar:split',
  'e9800000-0000-4000-8000-000000000001',
  'exchange_calendar_schedule', 'twofold-private-artifacts',
  'arena/calendar/settlement-window-split.json', 'application/json', 1,
  repeat('6', 64), 'settlement-window-contract', '{"provider":"alpaca"}'
);
insert into public.strategy_account (
  strategy_account_id, idempotency_key, run_id, account_code, broker,
  broker_region, base_currency, live_trading, metadata, recorded_by
) values (
  'e9860000-0000-4000-8000-000000000001',
  'settlement-window-contract:account:split',
  'e9810000-0000-4000-8000-000000000001',
  'SETTLEMENT-WINDOW-SPLIT', 'FUTU_HK', 'HK', 'USD', false,
  '{"fixture":"settlement-window-split"}', 'settlement-window-contract'
);

set local role service_role;
select public.register_arena_round(
  'settlement-window-contract:round:split',
  'e9850000-0000-4000-8000-000000000001',
  'e9800000-0000-4000-8000-000000000001', 1,
  'e9830000-0000-4000-8000-000000000001',
  '2026-08-28T22:23:53.027Z', '2026-08-31T13:15:00.000Z',
  'e9840000-0000-4000-8000-000000000001', repeat('6', 64),
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
  'settlement-window-contract'
);
reset role;

create temporary table settlement_window_split on commit drop as
select '{"ex_date":"2026-09-01","id":"e9700000-0000-4000-8000-000000000003",'
  || '"new_rate":"2","old_rate":"1","process_date":"2026-08-29",'
  || '"symbol":"SPY"}' as raw_split;
create temporary table settlement_window_split_action on commit drop as
select jsonb_build_array(jsonb_build_object(
  'schema', 'twofold.alpaca_corporate_action_revision/v1',
  'source', 'ALPACA_CORPORATE_ACTIONS_V1',
  'sourceActionId', 'e9700000-0000-4000-8000-000000000003',
  'revisionSha256', encode(extensions.digest(
    convert_to(split.raw_split, 'UTF8'), 'sha256'), 'hex'),
  'type', 'FORWARD_SPLIT',
  'symbol', 'SPY',
  'status', 'COMPLETE',
  'interpretation', 'SPLIT',
  'processDate', '2026-08-29',
  'exDate', '2026-09-01',
  'recordDate', null,
  'payableDate', null,
  'rawCanonicalJson', split.raw_split,
  'oldRate', '1',
  'newRate', '2'
)) as actions
from settlement_window_split as split;
create temporary table settlement_window_split_manifest on commit drop as
select jsonb_build_object(
  'schema', 'twofold.alpaca_corporate_action_scan/v1',
  'source', jsonb_build_object(
    'provider', 'alpaca', 'dataset', 'us_corporate_actions',
    'versionKey', 'settlement-window-corporate-actions-v1',
    'endpointBaseUrl', 'https://data.alpaca.markets',
    'feed', 'none', 'adjustment', 'raw', 'timeframe', 'Event',
    'normalizerVersion', 'alpaca-corporate-actions-v1',
    'licenseScope', 'private-research',
    'configSha256', repeat('4', 64),
    'effectiveFrom', '2026-08-01T00:00:00.000Z'
  ),
  'processDateStart', '2026-08-01',
  'processDateEnd', '2026-09-30',
  'observedAt', '2026-08-29T13:00:00.000Z',
  'requestFingerprint', repeat('9', 64),
  'pageResponseSha256', jsonb_build_array(
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
  ),
  'actions', action.actions
)::text as canonical_json
from settlement_window_split_action as action;
grant select on settlement_window_split, settlement_window_split_action,
  settlement_window_split_manifest to service_role;

set local role service_role;
select public.register_corporate_action_scan(
  'settlement-window-contract:scan:split',
  (select (value).source_version_id from settlement_window_source),
  repeat('9', 64), '2026-08-01', '2026-09-30',
  '2026-08-29T13:00:00.000Z', manifest.canonical_json,
  encode(extensions.digest(convert_to(manifest.canonical_json, 'UTF8'),
    'sha256'), 'hex'),
  (select pages from settlement_window_dividend),
  (select actions from settlement_window_split_action),
  'settlement-window-contract'
)
from settlement_window_split_manifest as manifest;
reset role;

select is(
  public.arena_corporate_action_phase_is_clear(
    'e9850000-0000-4000-8000-000000000001',
    'SETTLE_S1_AND_PREPARE_S2',
    '2026-08-31T20:20:00.000Z'
  ),
  false,
  'a split on the S2 session date holds S1 settlement, unlike a dividend'
);

-- Evidence that could never carry a legal S2 plan is refused where it is
-- created. `sealed_at` is assigned by the database after the provider request,
-- so a capture that starts before midnight and finishes after it can only be
-- caught here.
insert into public.market_snapshot (
  snapshot_id, idempotency_key, source_version_id, snapshot_kind,
  cutoff_at, target_session_date, symbols, selection_policy,
  manifest_schema, manifest_sha256, sealed_at
) values (
  'e9900000-0000-4000-8000-000000000001',
  'settlement-window-contract:late-close',
  'e9200000-0000-4000-8000-000000000001', 'market_close',
  '2026-08-31T20:35:00.000Z', '2026-08-31', array['LULU'],
  'settlement-window-contract', 'twofold.market_snapshot/v2', repeat('7', 64),
  '2026-09-01T12:03:11.000Z'
);
set local role service_role;
select throws_ok(
  $$select public.register_arena_round_close_snapshot(
    'settlement-window-contract:late-close',
    'e9500000-0000-4000-8000-000000000001', 'S1_CLOSE',
    'e9900000-0000-4000-8000-000000000001', 'settlement-window-contract'
  )$$,
  '22023',
  'S1 close sealed on or after the S2 session date cannot carry an S2 plan',
  'a close sealed on the S2 session date is refused where it is bound'
);
reset role;

-- The disposition FX is the other half of the same instant: plannedAt is the
-- maximum of the close seal and the FX visibility, so a reused close does not
-- rescue FX first observed on the S2 session date. The two cases use different
-- Rounds because a Round holds one FX reference per stage: without the fix the
-- refused one registers instead, and one Round could not show both outcomes.
create temporary table settlement_window_fx on commit drop as
select
  '{"authority":"ECB_REFERENCE_CROSS","availableAt":"' || instant
    || '","cnyPerUsd":"6.719730941704",'
    || '"derivation":"EUR_CNY_DIV_EUR_USD_HALF_UP_12",'
    || '"effectiveDate":"2026-08-31","eurToCny":"7.7922",'
    || '"eurToUsd":"1.1596","observedAt":"' || instant
    || '","schema":"twofold.ecb_usd_cny_reference_cross/v1",'
    || '"status":"ESTIMATED"}' as canonical_json,
  instant,
  artifact_sha
from (values
  ('2026-09-01T12:03:08.464Z', repeat('7', 64)),
  ('2026-08-31T20:25:00.000Z', repeat('a', 64))
) as fixture(instant, artifact_sha);
grant select on settlement_window_fx to service_role;

insert into public.artifact_metadata (
  artifact_id, idempotency_key, season_id, artifact_kind, storage_bucket,
  object_path, content_type, byte_size, sha256, created_by, metadata
)
select
  case when fx.instant like '2026-09-01%'
    then 'e9a00000-0000-4000-8000-000000000001'::uuid
    else 'e9a00000-0000-4000-8000-000000000002'::uuid end,
  'settlement-window-contract:ecb:' || fx.instant,
  case when fx.instant like '2026-09-01%'
    then 'e9800000-0000-4000-8000-000000000001'::uuid
    else 'e9100000-0000-4000-8000-000000000001'::uuid end,
  'official_tax_fx_rate', 'twofold-private-artifacts',
  'competition-sources/ecb/' || fx.artifact_sha || '.json',
  'application/json', 1, fx.artifact_sha, 'settlement-window-contract',
  jsonb_build_object(
    'schema', 'twofold.ecb_reference_source/v1',
    'sourceUrl',
      'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml',
    'effectiveDate', '2026-08-31',
    'observedAt', fx.instant,
    'rawBodySha256', repeat('b', 64)
  )
from settlement_window_fx as fx;

set local role service_role;
select throws_ok(
  format(
    $$select public.register_arena_round_tax_fx_reference(
      'settlement-window-contract:fx:late',
      'e9850000-0000-4000-8000-000000000001', 'S1_DISPOSITION',
      'e9a00000-0000-4000-8000-000000000001', %L, %L, %L, %L,
      'settlement-window-contract'
    )$$,
    repeat('7', 64), repeat('b', 64), fx.canonical_json,
    encode(extensions.digest(convert_to(fx.canonical_json, 'UTF8'), 'sha256'),
      'hex')
  ),
  '22023',
  'S1 disposition FX first visible on or after the S2 session date cannot carry an S2 plan',
  'disposition FX first visible on the S2 session date is refused too'
)
from settlement_window_fx as fx where fx.instant like '2026-09-01%';
select is(
  (public.register_arena_round_tax_fx_reference(
    'settlement-window-contract:fx:intime',
    'e9500000-0000-4000-8000-000000000001', 'S1_DISPOSITION',
    'e9a00000-0000-4000-8000-000000000002', repeat('a', 64), repeat('b', 64),
    fx.canonical_json,
    encode(extensions.digest(convert_to(fx.canonical_json, 'UTF8'), 'sha256'),
      'hex'),
    'settlement-window-contract'
  )->>'stage'),
  'S1_DISPOSITION',
  'disposition FX observed before the S2 session date is still accepted'
)
from settlement_window_fx as fx where fx.instant like '2026-08-31%';
reset role;

select * from finish();
rollback;
