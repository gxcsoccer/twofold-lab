-- Behavioral phase-aware recovery fixture; every write rolls back. No economic commits.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(10);

select public.register_arena_season(
  'recovery-behavior-contract:season',
  'd1000000-0000-4000-8000-000000000001',
  'recovery-behavior-contract', 'Arena Round Contract',
  '2099-08-28T21:00:00.000Z', '2099-09-26T00:00:00.000Z',
  'US_EQUITY_DAILY_AFTER_CLOSE', 'America/New_York',
  '{"fixture":"arena-round","openingHolding":"150 LULU","openingCash":"0"}',
  'recovery-behavior-contract'
);
select public.register_run_manifest(
  'recovery-behavior-contract:run',
  'd1100000-0000-4000-8000-000000000001',
  'twofold.run_manifest/v1',
  '{"engine_version":"recovery-behavior-contract","lot_method":"FIFO"}',
  'recovery-behavior-contract', repeat('a', 64)
);
select public.register_season_entrant(
  'recovery-behavior-contract:entrant',
  'd1200000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001',
  'recovery-behavior-contract-entrant',
  'd1100000-0000-4000-8000-000000000001',
  'twofold@contract', repeat('b', 64), 'twofold',
  'deepseek-official', 'deepseek-v4-pro', 'ROOT_ONLY',
  '{"track":"MAIN_ARENA"}', 'recovery-behavior-contract'
);
insert into public.data_source_version (
  source_version_id, provider, dataset, version_key, endpoint_base_url,
  feed, adjustment, timeframe, normalizer_version, license_scope,
  config_sha256, effective_from
) values (
  'd2000000-0000-4000-8000-000000000001', 'alpaca',
  'us_stock_daily_bars', 'recovery-behavior-contract',
  'https://data.alpaca.markets', 'sip', 'raw', '1Day',
  'recovery-behavior-contract', 'private-research', repeat('1', 64),
  '2099-08-28T00:00:00.000Z'
);
insert into public.market_snapshot (
  snapshot_id, idempotency_key, source_version_id, snapshot_kind,
  cutoff_at, target_session_date, symbols, selection_policy,
  manifest_schema, manifest_sha256, sealed_at
) values (
  'd3000000-0000-4000-8000-000000000001',
  'recovery-behavior-contract:snapshot',
  'd2000000-0000-4000-8000-000000000001', 'market_close',
  '2099-08-28T21:00:00.000Z', '2099-08-28', array['LULU'],
  'recovery-behavior-contract', 'twofold.market_snapshot/v2', repeat('2', 64),
  '2099-08-28T22:00:00.000Z'
);

insert into public.artifact_metadata (
  artifact_id, idempotency_key, season_id, artifact_kind, storage_bucket,
  object_path, content_type, byte_size, sha256, created_by, metadata
) values (
  'd4000000-0000-4000-8000-000000000001',
  'recovery-behavior-contract:calendar',
  'd1000000-0000-4000-8000-000000000001',
  'exchange_calendar_schedule', 'twofold-private-artifacts',
  'arena/calendar/contract.json', 'application/json', 1,
  repeat('3', 64), 'recovery-behavior-contract', '{"provider":"alpaca"}'
);

set local role service_role;
create temporary table arena_round_result on commit drop as
select public.register_arena_round(
  'recovery-behavior-contract:round:1',
  'd5000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001', 1,
  'd3000000-0000-4000-8000-000000000001',
  '2099-08-28T22:23:53.027Z', '2099-08-31T13:15:00.000Z',
  'd4000000-0000-4000-8000-000000000001', repeat('3', 64),
  '{
    "schema":"twofold.two_stage_cycle_calendar/v1",
    "decisionSessionDate":"2099-08-28",
    "s1SessionDate":"2099-08-31",
    "s1OpenAt":"2099-08-31T13:30:00.000Z",
    "s1ReferenceAvailableAt":"2099-08-31T13:32:00.000Z",
    "s1CloseAt":"2099-08-31T20:00:00.000Z",
    "s1CloseAvailableAt":"2099-08-31T20:20:00.000Z",
    "s2SessionDate":"2099-09-01",
    "s2OpenAt":"2099-09-01T13:30:00.000Z",
    "s2ReferenceAvailableAt":"2099-09-01T13:32:00.000Z",
    "s2CloseAt":"2099-09-01T20:00:00.000Z",
    "cycleReadyAt":"2099-09-01T20:20:00.000Z"
  }',
  'recovery-behavior-contract'
) as value;
reset role;

set local role service_role;
create temporary table arena_round_entry_result on commit drop as
select public.register_arena_round_entry(
  'recovery-behavior-contract:round:1:entrant',
  'd5000000-0000-4000-8000-000000000001',
  'd1200000-0000-4000-8000-000000000001',
  'recovery-behavior-contract'
) as value;
reset role;
set local role service_role;
select public.seed_arena_round_work('d5000000-0000-4000-8000-000000000001', 'queue-contract');

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
  '2099-08-28T20:01:00.000Z'
);
insert into public.source_delivery (
  delivery_id, idempotency_key, source_version_id, raw_artifact_id,
  request_fingerprint, http_status, retrieved_at, first_observed_at,
  available_at, normalized_manifest_sha256, recorded_at
) values (
  'd7210000-0000-4000-8000-000000000001',
  'recovery-behavior-contract:decision-close-delivery',
  'd2000000-0000-4000-8000-000000000001',
  'd7200000-0000-4000-8000-000000000001',
  repeat('d', 64), 200,
  '2099-08-28T20:01:00.000Z', '2099-08-28T20:01:00.000Z',
  '2099-08-28T20:01:00.000Z', repeat('e', 64),
  '2099-08-28T20:01:00.000Z'
);
insert into public.market_bar_fact (
  fact_id, source_version_id, symbol, timeframe, bar_start, bar_date,
  currency, open_price, high_price, low_price, close_price, volume,
  trade_count, vwap, normalizer_version, fact_sha256, recorded_at
) values (
  'd7220000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000001',
  'LULU', '1Day', '2099-08-28T04:00:00.000Z', '2099-08-28',
  'USD', '119', '122', '118', '120.81', '100', '10', '120.5',
  'recovery-behavior-contract', repeat('f', 64),
  '2099-08-28T20:01:00.000Z'
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
  'recovery-behavior-contract:decision-packet',
  entry.run_id, entry.season_id, 'decision_packet',
  'twofold-private-artifacts', 'arena/contract/decision-packet.json',
  'application/json', 1, repeat('a', 64), 'recovery-behavior-contract',
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
  'recovery-behavior-contract:agent-bundle',
  'd1100000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001',
  'dsh_agent_bundle_manifest', 'twofold-private-artifacts',
  'arena/contract/agent-bundle.json', 'application/json', 1,
  repeat('b', 64), 'recovery-behavior-contract', '{}'
);

set local role service_role;
select public.open_decision_invocation(
  'recovery-behavior-contract:decision-invocation',
  (select decision_id from public.arena_round_entry
    where round_id = 'd5000000-0000-4000-8000-000000000001'),
  'd1100000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001', 0,
  'recovery-behavior-contract-root', 'twofold@contract',
  'd7000000-0000-4000-8000-000000000001',
  'd7100000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000001',
  '2099-08-28T22:23:53.027Z', '2099-08-28T21:00:00.000Z',
  '2099-08-31T13:15:00.000Z', array['ROUND_SCHEDULED'],
  '2099-08-28T22:23:53.027Z', 'recovery-behavior-contract'
);
reset role;

-- Isolate the global queue only within this transaction, including expired leases.
-- No economic commits, public-function replacement, or disabled guards are needed.
select set_config('twofold.arena_no_trade_recovery_mutation', 'on', true);
update public.arena_no_trade_recovery
   set next_attempt_at = 'infinity'
 where status = 'REQUESTED';
update public.arena_no_trade_recovery
   set lease_expires_at = 'infinity'
 where status = 'CLAIMED';
select set_config('twofold.arena_no_trade_recovery_mutation', 'off', true);

-- Each probe executes the real enqueue trigger and claim RPC, then rolls its
-- changes back via a subtransaction. TAP assertions remain outside that rollback.
create function pg_temp.probe_recovery(p_phase text, p_status text)
returns jsonb language plpgsql as $probe$
declare
  v_claim jsonb;
  v_attempts integer;
begin
  begin
    perform set_config('twofold.arena_work_item_mutation', 'on', true);
    update public.arena_work_item
       set status = p_status, completed_at = '2099-09-01T20:20:00Z',
           result = '{"outcome":"FAILED"}', error_code = 'FIXTURE_FAILURE',
           error_message = 'fixture terminal source', retryable = false
     where round_id = 'd5000000-0000-4000-8000-000000000001'
       and phase = p_phase;
    perform set_config('twofold.arena_work_item_mutation', 'off', true);
    v_claim := public.claim_arena_no_trade_recovery('recovery-behavior-worker', 60, '2099-09-01T20:21:00Z');
    select attempt_count into strict v_attempts
      from public.arena_no_trade_recovery
     where round_id = 'd5000000-0000-4000-8000-000000000001';
    raise exception using errcode = 'ZX001', message = 'rollback probe';
  exception when sqlstate 'ZX001' then null;
  end;
  return jsonb_build_object('claim', v_claim, 'attempts', v_attempts);
end;
$probe$;

select is(pg_temp.probe_recovery('RUN_AGENT_DECISION', 'FAILED'),
  '{"claim":null,"attempts":0}'::jsonb,
  'a terminal decision waits for S2 evidence without consuming attempts');

insert into public.raw_artifact (
  raw_artifact_id, storage_bucket, object_path, content_type,
  byte_size, response_sha256, first_stored_at
) values (
  'fa000000-0000-4000-8000-000000000001',
  'twofold-private-artifacts',
  'raw/alpaca/aa/' || repeat('a', 64) || '.json',
  'application/json', 2, repeat('a', 64),
  '2099-09-01T20:20:05.000Z'
);
insert into public.source_delivery (
  delivery_id, idempotency_key, source_version_id, raw_artifact_id,
  request_fingerprint, http_status, retrieved_at, first_observed_at,
  available_at, normalized_manifest_sha256, recorded_at
) values (
  'fa100000-0000-4000-8000-000000000001',
  'recovery-behavior-contract:round:1:s2-close-delivery',
  'd2000000-0000-4000-8000-000000000001',
  'fa000000-0000-4000-8000-000000000001',
  repeat('b', 64), 200,
  '2099-09-01T20:20:05.000Z', '2099-09-01T20:20:05.000Z',
  '2099-09-01T20:20:05.000Z', repeat('c', 64),
  '2099-09-01T20:20:05.000Z'
);
insert into public.market_bar_fact (
  fact_id, source_version_id, symbol, timeframe, bar_start, bar_date,
  currency, open_price, high_price, low_price, close_price, volume,
  trade_count, vwap, normalizer_version, fact_sha256, recorded_at
) values (
  'fa200000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000001',
  'LULU', '1Day', '2099-09-01T04:00:00.000Z', '2099-09-01',
  'USD', '119', '122', '118', '121', '100', '10', '120.5',
  'recovery-behavior-contract', repeat('d', 64),
  '2099-09-01T20:20:05.000Z'
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
  'recovery-behavior-contract:round:1:s2-close-snapshot',
  'd2000000-0000-4000-8000-000000000001', 'market_close',
  '2099-09-01T20:20:05.000Z', '2099-09-01', array['LULU'],
  'recovery-behavior-contract', 'twofold.market_snapshot/v2', repeat('e', 64),
  '2099-09-01T20:20:06.000Z'
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
  'recovery-behavior-contract:round:1:s2-close',
  'd5000000-0000-4000-8000-000000000001', 'S2_CLOSE',
  'fa300000-0000-4000-8000-000000000001',
  'recovery-behavior-contract'
);

reset role;
select is(pg_temp.probe_recovery('RUN_AGENT_DECISION', 'FAILED')->'claim'->>'status',
  'CLAIMED', 'without accepted targets a terminal decision can recover after S2 evidence');

-- Use future frozen dates so the database deadline guard remains enabled.
-- Admission itself is covered elsewhere; this owner-only fixture seeds the target.
select public.accept_portfolio_targets(
  'recovery-behavior-contract:accepted-target',
  'd7300000-0000-4000-8000-000000000001',
  'recovery-behavior-contract-root',
  'd7000000-0000-4000-8000-000000000001', repeat('a', 64),
  '[{"symbol":"LULU","target_weight_bps":"10000"}]',
  '0', 'Keep the portfolio in LULU.',
  '2099-08-28T22:30:00.000Z', 1, 'recovery-behavior-contract'
);

select is(pg_temp.probe_recovery('RUN_AGENT_DECISION', status),
  '{"claim":null,"attempts":0}'::jsonb,
  'accepted targets block a ' || status || ' decision source without consuming attempts')
from unnest(array['FAILED','CANCELED']) as status;

select is(pg_temp.probe_recovery(phase, status)->'claim'->>'sourceWorkItemId',
  (select work_item_id::text from public.arena_work_item
    where round_id = 'd5000000-0000-4000-8000-000000000001'
      and arena_work_item.phase = phases.phase),
  'accepted targets allow the exact ' || status || ' ' || phase || ' source to be claimed')
from unnest(array['PREPARE_S1_ORDERS','SETTLE_S1_AND_PREPARE_S2','FINALIZE_ACCEPTED_TARGET_CYCLE']) as phases(phase)
cross join unnest(array['FAILED','CANCELED']) as statuses(status);

select * from finish();
rollback;
