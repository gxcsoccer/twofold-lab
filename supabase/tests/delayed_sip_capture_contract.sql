-- Focused queue fixture: no wall-clock-dependent economic commits. All data rolls back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(13);

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
set local role service_role;
select public.seed_arena_round_work('d5000000-0000-4000-8000-000000000001', 'queue-contract');

select is(public.claim_arena_work_item('sip-worker',60,'2026-08-31T13:32:00.000Z','d5000000-0000-4000-8000-000000000001',array['CAPTURE_S1_OPEN_REFERENCE']), null::jsonb, 'S1 waits beyond frozen availability');
select is(public.claim_arena_work_item('sip-worker',60,'2026-08-31T13:46:59.000Z','d5000000-0000-4000-8000-000000000001',array['CAPTURE_S1_OPEN_REFERENCE']), null::jsonb, 'S1 waits until query end plus sixteen minutes');
select is((select attempt_count from arena_work_item where round_id='d5000000-0000-4000-8000-000000000001' and phase='CAPTURE_S1_OPEN_REFERENCE'),0,'S1 waiting consumes no attempts');
create temporary table claim_S1 on commit drop as select coalesce(public.claim_arena_work_item('sip-worker',60,'2026-08-31T13:47:00.000Z','d5000000-0000-4000-8000-000000000001',array['CAPTURE_S1_OPEN_REFERENCE']),
  (select public.arena_work_item_result(item) from public.arena_work_item item where round_id='d5000000-0000-4000-8000-000000000001' and phase='CAPTURE_S1_OPEN_REFERENCE' and status='CLAIMED')) as value;
select is((select value->>'attemptCount' from claim_S1),'1','S1 claims once at the entitlement-safe boundary');
select is((select value->>'scheduledAt' from claim_S1),'2026-08-31T13:32:00.000Z','S1 retains its immutable schedule');

select is(public.claim_arena_work_item('sip-worker',60,'2026-09-01T13:32:00.000Z','d5000000-0000-4000-8000-000000000001',array['CAPTURE_S2_OPEN_REFERENCE']), null::jsonb, 'S2 waits beyond frozen availability');
select is(public.claim_arena_work_item('sip-worker',60,'2026-09-01T13:46:59.000Z','d5000000-0000-4000-8000-000000000001',array['CAPTURE_S2_OPEN_REFERENCE']), null::jsonb, 'S2 waits until query end plus sixteen minutes');
select is((select attempt_count from arena_work_item where round_id='d5000000-0000-4000-8000-000000000001' and phase='CAPTURE_S2_OPEN_REFERENCE'),0,'S2 waiting consumes no attempts');
create temporary table claim_S2 on commit drop as select coalesce(public.claim_arena_work_item('sip-worker',60,'2026-09-01T13:47:00.000Z','d5000000-0000-4000-8000-000000000001',array['CAPTURE_S2_OPEN_REFERENCE']),
  (select public.arena_work_item_result(item) from public.arena_work_item item where round_id='d5000000-0000-4000-8000-000000000001' and phase='CAPTURE_S2_OPEN_REFERENCE' and status='CLAIMED')) as value;
select is((select value->>'attemptCount' from claim_S2),'1','S2 claims once at the entitlement-safe boundary');
select is((select value->>'scheduledAt' from claim_S2),'2026-09-01T13:32:00.000Z','S2 retains its immutable schedule');

create temporary table fail_s2_one on commit drop as
select public.complete_arena_work_item((select (value->>'workItemId')::uuid from claim_S2),
(select (value->>'leaseToken')::uuid from claim_S2),'2026-09-01T13:47:01.000Z',false,
'{"outcome":"FAILED"}','ALPACA_TRANSIENT_FAILURE','HTTP 503',true) as value;
select is((select value->>'nextAttemptAt' from fail_s2_one),'2026-09-01T13:48:01.000Z','first transient failure backs off one minute');
create temporary table retry_s2 on commit drop as
select public.claim_arena_work_item('sip-worker',60,'2026-09-01T13:48:01.000Z',
'd5000000-0000-4000-8000-000000000001',array['CAPTURE_S2_OPEN_REFERENCE']) as value;
create temporary table fail_s2_two on commit drop as
select public.complete_arena_work_item((select (value->>'workItemId')::uuid from retry_s2),
(select (value->>'leaseToken')::uuid from retry_s2),'2026-09-01T13:48:02.000Z',false,
'{"outcome":"FAILED"}','ALPACA_TRANSIENT_FAILURE','HTTP 503',true) as value;
select is((select value->>'nextAttemptAt' from fail_s2_two),'2026-09-01T13:50:02.000Z','second transient failure backs off two minutes');
select is(public.claim_arena_work_item('sip-worker',60,'2026-09-01T13:49:02.000Z',
'd5000000-0000-4000-8000-000000000001',array['CAPTURE_S2_OPEN_REFERENCE']),null::jsonb,'transient backoff is enforced before another claim');
reset role;
select * from finish();
rollback;
