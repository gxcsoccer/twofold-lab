-- Atomic S2 BUY settlement contract. Every fixture rolls back.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(105);

create or replace function pg_temp.settlement_sha256(p_value text)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select encode(digest(convert_to(p_value, 'UTF8'), 'sha256'), 'hex')
$$;

create or replace function pg_temp.settlement_fee_terms()
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  -- Exact JSON.stringify output of canonicalFutuFeeScheduleTerms(
  -- FUTU_HK_US_EQUITY_FIXED_2026_08_23), including trailing-zero rate text.
  select '{"feeScheduleId":"futu_hk_us_equity_fixed_2026-08-23","brokerLegalEntity":"FUTU_HK","accountRegion":"HK","market":"US","product":"US_EQUITY_ETF","accountTier":"FIXED_PLATFORM_FEE","effectiveFrom":"2026-08-23","effectiveTo":null,"currency":"USD","roundingPolicy":"ROUND_HALF_UP_TO_CENT","aggregationPolicy":"PER_ORDER","rates":{"commissionPerShare":"0.0049","commissionMinimumPerOrder":"0.99","platformPerShare":"0.005","platformMinimumPerOrder":"1.00","settlementPerShare":"0.003","secRateOfGrossNotional":"0.0000206","secMinimumPerOrder":"0.01","finraTafPerShare":"0.000195","finraTafMinimumPerOrder":"0.01","finraTafMaximumPerOrder":"9.79","catPerShare":"0"}}'::text
$$;

create temporary table settlement_clock (
  decision_at timestamptz not null,
  opened_at timestamptz not null,
  accepted_at timestamptz not null,
  planned_at timestamptz not null,
  trade_date date not null,
  executed_at timestamptz not null,
  evidence_available_at timestamptz not null
) on commit drop;

insert into settlement_clock
with base as (
  select date_trunc('millisecond', clock_timestamp()) as executed_at
)
select
  executed_at - interval '1 day 4 minutes',
  executed_at - interval '1 day 3 minutes',
  executed_at - interval '1 day 2 minutes',
  executed_at - interval '1 day 1 minute',
  (executed_at at time zone 'UTC')::date,
  executed_at,
  executed_at
from base;

select has_table(
  'public', 'official_execution_price_evidence',
  'trusted official execution evidence exists'
);
select has_table(
  'public', 'tax_fx_rate_evidence',
  'trusted acquisition tax FX evidence exists'
);
select has_table(
  'public', 'position_lot_acquisition_fx',
  'lots retain acquisition FX bindings'
);
select has_table(
  'public', 'strategy_ledger_head',
  'per-strategy-account ledger head exists'
);
select has_table(
  'public', 'paper_fill_settlement',
  'atomic paper settlement outcome exists'
);
select has_table(
  'public', 'paper_fill_fee_component',
  'derived fee components exist'
);
select has_column(
  'public', 'strategy_ledger_head', 'head_sha256',
  'ledger head retains its hash-chain pointer'
);
select has_column(
  'public', 'paper_fill_settlement', 'request_sha256',
  'settlement retains its exact scalar request digest'
);
select is(
  public.deterministic_uuid_from_sha256(
    'twofold.contract.uuid/v1',
    'same-stable-business-key'
  ),
  public.deterministic_uuid_from_sha256(
    'twofold.contract.uuid/v1',
    'same-stable-business-key'
  ),
  'SHA256 UUIDv8 derivation is stable for identical namespace and key bytes'
);
select isnt(
  public.deterministic_uuid_from_sha256(
    'twofold.contract.uuid/v1',
    'same-stable-business-key'
  ),
  public.deterministic_uuid_from_sha256(
    'twofold.contract.other/v1',
    'same-stable-business-key'
  ),
  'UUID namespace version prevents cross-entity deterministic collisions'
);
select ok(
  public.deterministic_uuid_from_sha256(
    'twofold.contract.uuid/v1',
    'same-stable-business-key'
  )::text ~ (
    '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-'
    || '[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  'deterministic helper emits RFC-variant UUIDv8 identifiers'
);

select public.register_run_manifest(
  'settlement-contract:run',
  '81000000-0000-4000-8000-000000000001',
  'twofold.run_manifest/v1',
  '{"engine_version":"settlement-contract-v1","lot_method":"FIFO"}'::jsonb,
  'settlement-contract',
  repeat('1', 64)
);

select public.register_run_manifest(
  'settlement-contract:empty-run',
  '81000000-0000-4000-8000-000000000002',
  'twofold.run_manifest/v1',
  '{"engine_version":"settlement-contract-empty","lot_method":"FIFO"}'::jsonb,
  'settlement-contract',
  repeat('2', 64)
);

select public.register_instrument(
  'settlement-contract:instrument:lulu',
  '82000000-0000-4000-8000-000000000001',
  'common_stock',
  'NASDAQ',
  'USD',
  'US',
  '{"issuer":"lululemon athletica inc."}'::jsonb,
  'settlement-contract'
);

select public.register_strategy_account(
  'settlement-contract:account',
  '81000000-0000-4000-8000-000000000001',
  'paper-main',
  'futu-simulation',
  'HK',
  'USD',
  false,
  '{"purpose":"atomic-settlement-contract"}'::jsonb,
  'settlement-contract'
);

select public.register_strategy_account(
  'settlement-contract:empty-account',
  '81000000-0000-4000-8000-000000000002',
  'paper-unconfigured',
  'futu-simulation',
  'HK',
  'USD',
  false,
  '{"portfolioState":"not_configured"}'::jsonb,
  'settlement-contract'
);

insert into public.data_source_version (
  source_version_id,
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
  '83000000-0000-4000-8000-000000000001',
  'alpaca',
  'us_stock_daily_bars',
  'settlement-contract-v1',
  'https://data.alpaca.markets',
  'iex',
  'raw',
  '1Day',
  'settlement-contract-normalizer-v1',
  'private-research',
  repeat('3', 64),
  (select decision_at from settlement_clock)
);

insert into public.market_snapshot (
  snapshot_id,
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
  '83000000-0000-4000-8000-000000000002',
  'settlement-contract:snapshot',
  '83000000-0000-4000-8000-000000000001',
  'market_close',
  (select decision_at from settlement_clock),
  ((select decision_at from settlement_clock) at time zone 'UTC')::date,
  array['LULU'],
  'settlement-contract-selection-v1',
  'twofold.market_snapshot/v2',
  repeat('4', 64)
);

insert into public.market_bar_fact (
  fact_id,
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
  normalizer_version,
  fact_sha256
) values (
  '83000000-0000-4000-8000-000000000003',
  '83000000-0000-4000-8000-000000000001',
  'LULU',
  '1Day',
  ((select trade_date from settlement_clock)::text || 'T00:00:00Z')::timestamptz,
  (select trade_date from settlement_clock),
  'USD',
  '10',
  '11',
  '9',
  '10',
  '1000',
  '10',
  'settlement-contract-normalizer-v1',
  repeat('5', 64)
);

insert into public.event_stream (
  event_id,
  stream_id,
  stream_type,
  stream_seq,
  event_type,
  schema_version,
  idempotency_key,
  actor_kind,
  actor_id,
  event_time,
  payload,
  metadata
) values
  (
    '84000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    'run', 1, 'decision.opened', '1',
    'settlement-contract:decision-event',
    'worker', 'settlement-contract',
    (select opened_at from settlement_clock),
    '{"fixture":"atomic-settlement"}'::jsonb,
    '{}'::jsonb
  ),
  (
    '84000000-0000-4000-8000-000000000002',
    '81000000-0000-4000-8000-000000000001',
    'run', 2, 'decision.targets_accepted', '1',
    'settlement-contract:submission-event',
    'worker', 'settlement-contract',
    (select accepted_at from settlement_clock),
    '{"fixture":"atomic-settlement"}'::jsonb,
    '{}'::jsonb
  );

insert into public.artifact_metadata (
  artifact_id,
  idempotency_key,
  run_id,
  source_event_id,
  artifact_kind,
  storage_bucket,
  object_path,
  content_type,
  byte_size,
  sha256,
  created_by,
  metadata
) values
  (
    '85000000-0000-4000-8000-000000000001',
    'settlement-contract:packet',
    '81000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000001',
    'decision_packet', 'twofold-private-artifacts',
    'contract/settlement/packet.json', 'application/json', 1,
    repeat('6', 64), 'settlement-contract', '{}'::jsonb
  ),
  (
    '85000000-0000-4000-8000-000000000002',
    'settlement-contract:bundle',
    '81000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000001',
    'agent_bundle_manifest', 'twofold-private-artifacts',
    'contract/settlement/bundle.json', 'application/json', 1,
    repeat('7', 64), 'settlement-contract', '{}'::jsonb
  ),
  (
    '85000000-0000-4000-8000-000000000003',
    'settlement-contract:opening-state',
    '81000000-0000-4000-8000-000000000001',
    null,
    'paper_account_opening_state', 'twofold-private-artifacts',
    'contract/settlement/opening-state.json', 'application/json', 1,
    repeat('8', 64), 'trusted-ingestion', '{}'::jsonb
  ),
  (
    '85000000-0000-4000-8000-000000000004',
    'settlement-contract:official-open',
    '81000000-0000-4000-8000-000000000001',
    null,
    'official_exchange_auction_print', 'twofold-private-artifacts',
    'contract/settlement/official-open.json', 'application/json', 1,
    repeat('9', 64), 'trusted-ingestion', '{}'::jsonb
  ),
  (
    '85000000-0000-4000-8000-000000000005',
    'settlement-contract:tax-fx',
    '81000000-0000-4000-8000-000000000001',
    null,
    'official_tax_fx_rate', 'twofold-private-artifacts',
    'contract/settlement/tax-fx.json', 'application/json', 1,
    repeat('a', 64), 'trusted-ingestion', '{}'::jsonb
  ),
  (
    '85000000-0000-4000-8000-000000000006',
    'settlement-contract:regulated-broker-execution',
    '81000000-0000-4000-8000-000000000001',
    null,
    'regulated_broker_auction_execution', 'twofold-private-artifacts',
    'contract/settlement/regulated-broker-execution.json',
    'application/json', 1,
    repeat('c', 64), 'trusted-ingestion', '{}'::jsonb
  );

set constraints all deferred;

insert into public.decision_invocation (
  decision_id,
  idempotency_key,
  run_id,
  season_id,
  root_harness_session_id,
  packet_artifact_id,
  agent_bundle_artifact_id,
  market_snapshot_id,
  decision_at,
  data_cutoff_at,
  submission_deadline_at,
  trigger_reasons,
  source_event_id,
  source_stream_seq,
  opened_at
) values (
  '86000000-0000-4000-8000-000000000001',
  'settlement-contract:decision',
  '81000000-0000-4000-8000-000000000001',
  '86000000-0000-4000-8000-000000000002',
  'settlement-contract-root',
  '85000000-0000-4000-8000-000000000001',
  '85000000-0000-4000-8000-000000000002',
  '83000000-0000-4000-8000-000000000002',
  (select decision_at from settlement_clock),
  (select decision_at from settlement_clock),
  clock_timestamp() + interval '1 day',
  array['contract_fixture'],
  '84000000-0000-4000-8000-000000000001',
  1,
  (select opened_at from settlement_clock)
);

insert into public.agent_session_lineage (
  harness_session_id,
  idempotency_key,
  decision_id,
  root_harness_session_id,
  parent_harness_session_id,
  session_kind,
  agent_identity,
  agent_path,
  depth,
  started_at,
  source_event_id,
  source_stream_seq
) values (
  'settlement-contract-root',
  'settlement-contract:root-lineage',
  '86000000-0000-4000-8000-000000000001',
  'settlement-contract-root',
  null,
  'root',
  'settlement-contract-agent',
  'root',
  0,
  (select opened_at from settlement_clock),
  '84000000-0000-4000-8000-000000000001',
  1
);

set constraints all immediate;

insert into public.accepted_target_submission (
  submission_id,
  idempotency_key,
  decision_id,
  root_harness_session_id,
  packet_artifact_id,
  packet_sha256,
  targets,
  cash_weight_bps,
  decision_summary,
  submission_sha256,
  accepted_at,
  source_event_id,
  source_stream_seq,
  recorded_by
) values (
  '86000000-0000-4000-8000-000000000003',
  'settlement-contract:submission',
  '86000000-0000-4000-8000-000000000001',
  'settlement-contract-root',
  '85000000-0000-4000-8000-000000000001',
  repeat('6', 64),
  '[{"symbol":"LULU","target_weight_bps":"10000"}]'::jsonb,
  '0',
  'Atomic settlement fixture',
  repeat('b', 64),
  (select accepted_at from settlement_clock),
  '84000000-0000-4000-8000-000000000002',
  2,
  'settlement-contract'
);

create or replace function pg_temp.settlement_plan(
  p_stage text,
  p_late_s1_evidence boolean default false,
  p_bad_s2_priority boolean default false,
  p_bad_fill_scale boolean default false,
  p_bad_buying_power_scale boolean default false
)
returns jsonb
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_order_one jsonb;
  v_order_two jsonb;
  v_order_three jsonb;
  v_order_four jsonb;
  v_plan jsonb;
begin
  v_order_one := jsonb_build_object(
    'orderId', case when p_stage = 'S2' then 'buy-lulu-1' else 'sell-lulu-1' end,
    'instrumentId', '82000000-0000-4000-8000-000000000001',
    'side', case when p_stage = 'S2' then 'BUY' else 'SELL' end,
    'quantity', case when p_stage = 'S2' then '101' else '100' end,
    'executionModel', 'SIMULATED_SLIPPAGE',
    'feeCurrency', 'USD',
    'feeScheduleId', 'futu_hk_us_equity_fixed_2026-08-23',
    'feeScheduleTerms', pg_temp.settlement_fee_terms(),
    'priority', '1'
  );
  if p_stage = 'S1' then
    v_order_one := v_order_one || jsonb_build_object(
      'referencePriceEvidence', jsonb_build_object(
        'visibleAt', to_char(
          (
            select decision_at + case
              when p_late_s1_evidence then interval '30 seconds'
              else interval '0 seconds'
            end
            from settlement_clock
          ) at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      )
    );
  end if;
  v_order_two := jsonb_build_object(
    'orderId', 'buy-lulu-2',
    'instrumentId', '82000000-0000-4000-8000-000000000001',
    'side', 'BUY',
    'quantity', '1',
    'executionModel', 'SIMULATED_SLIPPAGE',
    'feeCurrency', 'USD',
    'feeScheduleId', 'futu_hk_us_equity_fixed_2026-08-23',
    'feeScheduleTerms', pg_temp.settlement_fee_terms(),
    'priority', case when p_bad_s2_priority then '1' else '2' end
  );
  v_order_three := jsonb_build_object(
    'orderId', 'buy-lulu-cancel-with-requested-fx',
    'instrumentId', '82000000-0000-4000-8000-000000000001',
    'side', 'BUY',
    'quantity', '1',
    'executionModel', 'SIMULATED_SLIPPAGE',
    'feeCurrency', 'USD',
    'feeScheduleId', 'futu_hk_us_equity_fixed_2026-08-23',
    'feeScheduleTerms', pg_temp.settlement_fee_terms(),
    'priority', '3'
  );
  v_order_four := jsonb_build_object(
    'orderId', 'buy-lulu-expired-fees',
    'instrumentId', '82000000-0000-4000-8000-000000000001',
    'side', 'BUY',
    'quantity', '1',
    'executionModel', 'SIMULATED_SLIPPAGE',
    'feeCurrency', 'USD',
    'feeScheduleId', 'futu_hk_us_equity_fixed_2026-08-23',
    'feeScheduleTerms', jsonb_set(
      pg_temp.settlement_fee_terms()::jsonb,
      '{effectiveTo}',
      to_jsonb((select trade_date::text from settlement_clock))
    )::text,
    'priority', '4'
  );
  v_plan := jsonb_build_object(
    'manifestSchema', 'twofold.frozen_order_plan/v1',
    'stage', p_stage,
    'fillPriceScale', case when p_bad_fill_scale then '13' else '8' end,
    'slippageBps', '5',
    'initialBuyingPower', case
      when p_bad_buying_power_scale then '1002.1234567890123'
      else '1002.8'
    end,
    'reservedBuyingPower', case
      when p_bad_buying_power_scale then '1002.1234567890123'
      else '1002.8'
    end,
    'remainingUnreservedBuyingPower', '0',
    'orders', case
      when p_stage = 'S2' then jsonb_build_array(
        v_order_one,
        v_order_two,
        v_order_three,
        v_order_four
      )
      else jsonb_build_array(v_order_one)
    end
  );
  return v_plan;
end;
$$;

create or replace function pg_temp.insert_settlement_plan(
  p_stage text,
  p_late_s1_evidence boolean default false,
  p_bad_s2_priority boolean default false,
  p_bad_fill_scale boolean default false,
  p_bad_buying_power_scale boolean default false
)
returns uuid
language plpgsql
volatile
set search_path = public, extensions, pg_temp
as $$
declare
  v_plan_id uuid := case
    when p_stage = 'S2' then '87000000-0000-4000-8000-000000000001'::uuid
    else '87000000-0000-4000-8000-000000000002'::uuid
  end;
  v_payload jsonb := pg_temp.settlement_plan(
    p_stage,
    p_late_s1_evidence,
    p_bad_s2_priority,
    p_bad_fill_scale,
    p_bad_buying_power_scale
  );
begin
  insert into public.frozen_order_plan (
    frozen_order_plan_id,
    idempotency_key,
    strategy_account_id,
    run_id,
    decision_id,
    accepted_submission_id,
    stage,
    planned_at,
    planned_trade_date,
    manifest_schema,
    plan_canonical_json,
    plan,
    plan_sha256,
    engine_plan_fingerprint,
    engine_plan_fingerprint_sha256,
    recorded_by
  ) values (
    v_plan_id,
    'settlement-contract:plan:' || lower(p_stage),
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:account'),
    '81000000-0000-4000-8000-000000000001',
    '86000000-0000-4000-8000-000000000001',
    '86000000-0000-4000-8000-000000000003',
    p_stage,
    (select planned_at from settlement_clock),
    (select trade_date from settlement_clock),
    'twofold.frozen_order_plan/v1',
    v_payload::text,
    v_payload,
    pg_temp.settlement_sha256(v_payload::text),
    v_payload::text,
    pg_temp.settlement_sha256(v_payload::text),
    'settlement-contract'
  );
  return v_plan_id;
end;
$$;

select throws_ok(
  $$select pg_temp.insert_settlement_plan('S2', false, true)$$,
  '22023',
  'S2 order priorities must be unique and strictly increase with array order',
  'S2 admission cannot let array order diverge from Core priority order'
);

select throws_ok(
  $$select pg_temp.insert_settlement_plan('S2', false, false, true)$$,
  '22023',
  'S2 settlement v1 requires fillPriceScale between 0 and 12',
  'S2 admission rejects fillPriceScale 13 before an un-settleable plan is frozen'
);

select throws_ok(
  $$select pg_temp.insert_settlement_plan(
    'S2', false, false, false, true
  )$$,
  '22023',
  'S2 plan amounts exceed exact numeric(38,12) settlement precision',
  'S2 admission rejects a thirteenth buying-power fractional digit'
);

select pg_temp.insert_settlement_plan('S2');

select throws_ok(
  $$select pg_temp.insert_settlement_plan('S1', true)$$,
  '22023',
  'S1 close-price evidence was not visible by the trusted decision cutoff',
  'S1 rejects close evidence visible after decision_at even before planned_at'
);

select pg_temp.insert_settlement_plan('S1');

select public.append_accounting_transaction(
  'settlement-contract:opening-journal',
  (select strategy_account_id from public.strategy_account
    where idempotency_key = 'settlement-contract:account'),
  'opening_balance',
  'paper-opening:settlement-contract',
  (select planned_at from settlement_clock),
  (select trade_date from settlement_clock),
  (select trade_date from settlement_clock),
  'Artifact-bound opening all-cash paper balance',
  '[
    {"account_code":"asset.cash","side":"debit","amount":"1002.79","currency":"USD"},
    {"account_code":"equity.opening_balance","side":"credit","amount":"1002.79","currency":"USD"}
  ]'::jsonb,
  jsonb_build_object(
    'openingStateSchema', 'twofold.paper_opening_state/v1',
    'openingStateArtifactId', '85000000-0000-4000-8000-000000000003',
    'openingStateSha256', repeat('8', 64)
  ),
  'settlement-contract'
);

with payload as (
  select jsonb_build_object(
    'kind', 'OFFICIAL_AUCTION_OPEN',
    'instrumentId', '82000000-0000-4000-8000-000000000001',
    'sessionDate', (select trade_date::text from settlement_clock),
    'officialOpenPrice', '10',
    'currency', 'USD',
    'authority', 'PRIMARY_EXCHANGE_OFFICIAL'
  )::text as body
)
insert into public.official_execution_price_evidence (
  execution_price_evidence_id,
  idempotency_key,
  run_id,
  instrument_id,
  evidence_kind,
  session_date,
  currency,
  official_open_price,
  authority,
  observed_at,
  available_at,
  source_artifact_id,
  source_sha256,
  evidence_canonical_json,
  evidence,
  evidence_sha256,
  recorded_by
)
select
  '88000000-0000-4000-8000-000000000001',
  'settlement-contract:official-open-evidence',
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  'OFFICIAL_AUCTION_OPEN',
  (select trade_date from settlement_clock),
  'USD',
  '10',
  'PRIMARY_EXCHANGE_OFFICIAL',
  (select evidence_available_at from settlement_clock),
  (select evidence_available_at from settlement_clock),
  '85000000-0000-4000-8000-000000000004',
  repeat('9', 64),
  payload.body,
  payload.body::jsonb,
  pg_temp.settlement_sha256(payload.body),
  'trusted-ingestion'
from payload;

with payload as (
  select jsonb_build_object(
    'kind', 'ACQUISITION_TAX_BASIS_USD_CNY',
    'effectiveDate', (select trade_date::text from settlement_clock),
    'baseCurrency', 'USD',
    'quoteCurrency', 'CNY',
    'cnyPerUsd', '7.2',
    'authority', 'OFFICIAL_TAX_FX_FIXTURE'
  )::text as body
)
insert into public.tax_fx_rate_evidence (
  tax_fx_rate_evidence_id,
  idempotency_key,
  run_id,
  rate_kind,
  effective_date,
  base_currency,
  quote_currency,
  cny_per_usd,
  authority,
  observed_at,
  available_at,
  source_artifact_id,
  source_sha256,
  evidence_canonical_json,
  evidence,
  evidence_sha256,
  recorded_by
)
select
  '88000000-0000-4000-8000-000000000002',
  'settlement-contract:tax-fx-evidence',
  '81000000-0000-4000-8000-000000000001',
  'ACQUISITION_TAX_BASIS_USD_CNY',
  (select trade_date from settlement_clock),
  'USD',
  'CNY',
  '7.2',
  'OFFICIAL_TAX_FX_FIXTURE',
  (select evidence_available_at from settlement_clock),
  (select evidence_available_at from settlement_clock),
  '85000000-0000-4000-8000-000000000005',
  repeat('a', 64),
  payload.body,
  payload.body::jsonb,
  pg_temp.settlement_sha256(payload.body),
  'trusted-ingestion'
from payload;

select throws_ok(
  $$with payload as (
      select jsonb_build_object(
        'kind', 'OFFICIAL_AUCTION_OPEN',
        'instrumentId', '82000000-0000-4000-8000-000000000001',
        'sessionDate', ((select trade_date from settlement_clock) + 1)::text,
        'officialOpenPrice', '10',
        'currency', 'USD',
        'authority', 'PRIMARY_EXCHANGE_OFFICIAL'
      )::text as body
    )
    insert into public.official_execution_price_evidence (
      idempotency_key, run_id, instrument_id, evidence_kind, session_date,
      currency, official_open_price, authority, observed_at, available_at,
      source_artifact_id, source_sha256, evidence_canonical_json, evidence,
      evidence_sha256, recorded_by
    ) select
      'primary-authority-with-broker-artifact',
      '81000000-0000-4000-8000-000000000001',
      '82000000-0000-4000-8000-000000000001',
      'OFFICIAL_AUCTION_OPEN',
      (select trade_date + 1 from settlement_clock),
      'USD', '10', 'PRIMARY_EXCHANGE_OFFICIAL',
      (((select trade_date + 1 from settlement_clock))::text
        || 'T14:30:00Z')::timestamptz,
      (((select trade_date + 1 from settlement_clock))::text
        || 'T14:30:00Z')::timestamptz,
      '85000000-0000-4000-8000-000000000006', repeat('c',64),
      body, body::jsonb, pg_temp.settlement_sha256(body),
      'trusted-ingestion'
    from payload$$,
  '22023',
  'execution evidence authority does not match its source artifact kind',
  'primary-exchange authority cannot bind a broker execution artifact'
);

select throws_ok(
  $$with payload as (
      select jsonb_build_object(
        'kind', 'OFFICIAL_AUCTION_OPEN',
        'instrumentId', '82000000-0000-4000-8000-000000000001',
        'sessionDate', ((select trade_date from settlement_clock) + 2)::text,
        'officialOpenPrice', '10',
        'currency', 'USD',
        'authority', 'REGULATED_BROKER_EXECUTION'
      )::text as body
    )
    insert into public.official_execution_price_evidence (
      idempotency_key, run_id, instrument_id, evidence_kind, session_date,
      currency, official_open_price, authority, observed_at, available_at,
      source_artifact_id, source_sha256, evidence_canonical_json, evidence,
      evidence_sha256, recorded_by
    ) select
      'broker-authority-with-primary-artifact',
      '81000000-0000-4000-8000-000000000001',
      '82000000-0000-4000-8000-000000000001',
      'OFFICIAL_AUCTION_OPEN',
      (select trade_date + 2 from settlement_clock),
      'USD', '10', 'REGULATED_BROKER_EXECUTION',
      (((select trade_date + 2 from settlement_clock))::text
        || 'T14:30:00Z')::timestamptz,
      (((select trade_date + 2 from settlement_clock))::text
        || 'T14:30:00Z')::timestamptz,
      '85000000-0000-4000-8000-000000000004', repeat('9',64),
      body, body::jsonb, pg_temp.settlement_sha256(body),
      'trusted-ingestion'
    from payload$$,
  '22023',
  'execution evidence authority does not match its source artifact kind',
  'broker authority cannot bind a primary-exchange auction artifact'
);

select throws_ok(
  $$with payload as (
      select jsonb_build_object(
        'kind', 'OFFICIAL_AUCTION_OPEN',
        'instrumentId', '82000000-0000-4000-8000-000000000001',
        'sessionDate', ((select trade_date from settlement_clock) + 3)::text,
        'officialOpenPrice', '10',
        'currency', 'USD',
        'authority', 'PRIMARY_EXCHANGE_OFFICIAL'
      )::text as body
    )
    insert into public.official_execution_price_evidence (
      idempotency_key, run_id, instrument_id, evidence_kind, session_date,
      currency, official_open_price, authority, observed_at, available_at,
      source_artifact_id, source_sha256, evidence_canonical_json, evidence,
      evidence_sha256, recorded_by
    ) select
      'wrong-session-observation-date',
      '81000000-0000-4000-8000-000000000001',
      '82000000-0000-4000-8000-000000000001',
      'OFFICIAL_AUCTION_OPEN',
      (select trade_date + 3 from settlement_clock),
      'USD', '10', 'PRIMARY_EXCHANGE_OFFICIAL',
      (select evidence_available_at from settlement_clock),
      (select evidence_available_at from settlement_clock),
      '85000000-0000-4000-8000-000000000004', repeat('9',64),
      body, body::jsonb, pg_temp.settlement_sha256(body),
      'trusted-ingestion'
    from payload$$,
  '23514', null,
  'official-open observed/available UTC dates must equal the claimed session'
);

select throws_ok(
  $$select public.initialize_strategy_ledger_head(
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:empty-account'),
    'settlement-contract'
  )$$,
  '55000',
  'ledger genesis requires exactly one opening transaction',
  'an empty/unconfigured account cannot become accounting-ready'
);

create temporary table settlement_head_zero as
select public.initialize_strategy_ledger_head(
  (select strategy_account_id from public.strategy_account
    where idempotency_key = 'settlement-contract:account'),
  'settlement-contract'
) as result;

select is(
  (select result->>'schema' from settlement_head_zero),
  'twofold.strategy_ledger_head_result/v1',
  'head init returns the frozen string-safe v1 schema'
);
select is(
  (select result->>'headSequence' from settlement_head_zero),
  '0',
  'genesis starts at sequence zero'
);
select is(
  (select result->>'initializedBy' from settlement_head_zero),
  'settlement-contract',
  'head result exposes the immutable initialization recorder as a string'
);
select ok(
  not public.jsonb_contains_number((select result from settlement_head_zero)),
  'head init response contains no JSON number token'
);
select is(
  (public.initialize_strategy_ledger_head(
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:account'),
    'settlement-contract'
  )->>'headSha256'),
  (select result->>'headSha256' from settlement_head_zero),
  'head initialization is idempotent after durable creation'
);
select throws_ok(
  $$select public.initialize_strategy_ledger_head(
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:account'),
    'different-recorder'
  )$$,
  '23505',
  'ledger head identity was reused with a different recorder',
  'head initialization retry rejects a different recorded_by identity'
);
select ok(
  (
    select
      head.genesis_manifest = jsonb_build_object(
        'schema', 'twofold.strategy_ledger_genesis/v1',
        'strategyAccountIdempotencyKey', 'settlement-contract:account',
        'runManifestIdempotencyKey', 'settlement-contract:run',
        'runManifestSha256', run.manifest_sha256,
        'openingTransactionIdempotencyKey',
          'settlement-contract:opening-journal',
        'openingSourceEventKey', 'paper-opening:settlement-contract',
        'openingPostingManifestSha256', journal.posting_manifest_sha256,
        'openingCash', '1002.79',
        'openingStateArtifactIdempotencyKey',
          'settlement-contract:opening-state',
        'openingStateSha256', repeat('8', 64),
        'initializedBy', 'settlement-contract',
        'accountingTransactionCount', '1',
        'lotOriginCount', '0',
        'acquisitionFxBindingCount', '0',
        'settlementCount', '0'
      )
      and not (head.genesis_manifest ? 'strategyAccountId')
      and not (head.genesis_manifest ? 'runId')
      and not (head.genesis_manifest ? 'openingAccountingTransactionId')
      and not (head.genesis_manifest ? 'openingStateArtifactId')
      and head.genesis_manifest_sha256 =
        pg_temp.settlement_sha256(head.genesis_manifest::text)
      and head.head_sha256 = pg_temp.settlement_sha256(
        'twofold.strategy_ledger_head/v1' || chr(10)
          || head.genesis_manifest_sha256
      )
    from public.strategy_ledger_head as head
    join public.strategy_account as account
      on account.strategy_account_id = head.strategy_account_id
    join public.run_manifest as run
      on run.run_id = account.run_id
    join public.accounting_transaction as journal
      on journal.strategy_account_id = head.strategy_account_id
  ),
  'genesis manifest and hash use only stable business/source keys, never random row UUIDs'
);
select ok(
  not public.jsonb_contains_number(public.get_strategy_ledger_head(
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:account')
  )),
  'head read response is also string-safe'
);

set local role anon;
select throws_ok(
  $$select public.initialize_strategy_ledger_head(
    '00000000-0000-4000-8000-000000000001', 'anon'
  )$$,
  '42501', null,
  'anonymous cannot initialize a ledger head'
);
select throws_ok(
  $$select public.get_strategy_ledger_head(
    '00000000-0000-4000-8000-000000000001'
  )$$,
  '42501', null,
  'anonymous cannot read a ledger head RPC'
);
select throws_ok(
  $$select public.settle_paper_fill(
    'anon', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002', 'order',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',
    clock_timestamp(), current_date, 0, repeat('0', 64), 'anon'
  )$$,
  '42501', null,
  'anonymous cannot invoke settlement'
);
select throws_ok(
  $$insert into public.official_execution_price_evidence (
    idempotency_key, run_id, instrument_id, evidence_kind, session_date,
    currency, official_open_price, authority, observed_at, available_at,
    source_artifact_id, source_sha256, evidence_canonical_json, evidence,
    evidence_sha256, recorded_by
  ) values (
    'anon', '81000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001', 'OFFICIAL_AUCTION_OPEN',
    current_date, 'USD', '1', 'PRIMARY_EXCHANGE_OFFICIAL', now(), now(),
    '85000000-0000-4000-8000-000000000004', repeat('9',64), '{}', '{}',
    repeat('0',64), 'anon'
  )$$,
  '42501', null,
  'anonymous cannot self-report execution evidence'
);
reset role;

set local role service_role;
select throws_ok(
  $$insert into public.tax_fx_rate_evidence (
    idempotency_key, run_id, rate_kind, effective_date, base_currency,
    quote_currency, cny_per_usd, authority, observed_at, available_at,
    source_artifact_id, source_sha256, evidence_canonical_json, evidence,
    evidence_sha256, recorded_by
  ) values (
    'service-forgery', '81000000-0000-4000-8000-000000000001',
    'ACQUISITION_TAX_BASIS_USD_CNY', current_date, 'USD', 'CNY', '7',
    'forged', now(), now(), '85000000-0000-4000-8000-000000000005',
    repeat('a',64), '{}', '{}', repeat('0',64), 'service'
  )$$,
  '42501', null,
  'service role cannot self-report acquisition tax FX'
);
select throws_ok(
  $$update public.strategy_ledger_head set head_sequence = 99$$,
  '42501', null,
  'service role cannot directly mutate the ledger head'
);
reset role;

select throws_ok(
  $$with payload as (
      select jsonb_build_object(
        'kind', 'OFFICIAL_AUCTION_OPEN',
        'instrumentId', '82000000-0000-4000-8000-000000000001',
        'sessionDate', (current_date + 1)::text,
        'officialOpenPrice', '10',
        'currency', 'USD',
        'authority', 'PRIMARY_EXCHANGE_OFFICIAL'
      )::text as body
    )
    insert into public.official_execution_price_evidence (
      idempotency_key, run_id, instrument_id, evidence_kind, session_date,
      currency, official_open_price, authority, observed_at, available_at,
      source_artifact_id, source_sha256, evidence_canonical_json, evidence,
      evidence_sha256, recorded_by
    ) select
      'bad-hash', '81000000-0000-4000-8000-000000000001',
      '82000000-0000-4000-8000-000000000001', 'OFFICIAL_AUCTION_OPEN',
      current_date + 1, 'USD', '10', 'PRIMARY_EXCHANGE_OFFICIAL',
      ((current_date + 1)::text || 'T14:30:00Z')::timestamptz,
      ((current_date + 1)::text || 'T14:30:00Z')::timestamptz,
      '85000000-0000-4000-8000-000000000004', repeat('9',64), body,
      body::jsonb, repeat('0',64), 'trusted-ingestion'
    from payload$$,
  '23514', null,
  'trusted evidence exact UTF8 hash is enforced'
);

select throws_ok(
  $$with payload as (
      select jsonb_build_object(
        'kind', 'OFFICIAL_AUCTION_OPEN',
        'instrumentId', '82000000-0000-4000-8000-000000000001',
        'sessionDate', (current_date + 1)::text,
        'officialOpenPrice', '11',
        'currency', 'USD',
        'authority', 'PRIMARY_EXCHANGE_OFFICIAL'
      )::text as body
    )
    insert into public.official_execution_price_evidence (
      idempotency_key, run_id, instrument_id, evidence_kind, session_date,
      currency, official_open_price, authority, observed_at, available_at,
      source_artifact_id, source_sha256, evidence_canonical_json, evidence,
      evidence_sha256, recorded_by
    ) select
      'mismatched-price-payload',
      '81000000-0000-4000-8000-000000000001',
      '82000000-0000-4000-8000-000000000001',
      'OFFICIAL_AUCTION_OPEN', current_date + 1, 'USD', '10',
      'PRIMARY_EXCHANGE_OFFICIAL',
      ((current_date + 1)::text || 'T14:30:00Z')::timestamptz,
      ((current_date + 1)::text || 'T14:30:00Z')::timestamptz,
      '85000000-0000-4000-8000-000000000004', repeat('9',64), body,
      body::jsonb, pg_temp.settlement_sha256(body), 'trusted-ingestion'
    from payload$$,
  '23514', null,
  'hashed official-price payload must equal every structured evidence column'
);

select throws_ok(
  $$with payload as (
      select jsonb_build_object(
        'kind', 'ACQUISITION_TAX_BASIS_USD_CNY',
        'effectiveDate', (current_date + 1)::text,
        'baseCurrency', 'USD',
        'quoteCurrency', 'CNY',
        'cnyPerUsd', '7.3',
        'authority', 'OFFICIAL_TAX_FX_FIXTURE'
      )::text as body
    )
    insert into public.tax_fx_rate_evidence (
      idempotency_key, run_id, rate_kind, effective_date, base_currency,
      quote_currency, cny_per_usd, authority, observed_at, available_at,
      source_artifact_id, source_sha256, evidence_canonical_json, evidence,
      evidence_sha256, recorded_by
    ) select
      'mismatched-fx-payload',
      '81000000-0000-4000-8000-000000000001',
      'ACQUISITION_TAX_BASIS_USD_CNY', current_date + 1, 'USD', 'CNY',
      '7.2', 'OFFICIAL_TAX_FX_FIXTURE', now(), now(),
      '85000000-0000-4000-8000-000000000005', repeat('a',64), body,
      body::jsonb, pg_temp.settlement_sha256(body), 'trusted-ingestion'
    from payload$$,
  '23514', null,
  'hashed acquisition-FX payload must equal every structured evidence column'
);

select throws_ok(
  $$with payload as (
      select jsonb_build_object(
        'kind', 'OFFICIAL_AUCTION_OPEN',
        'instrumentId', '82000000-0000-4000-8000-000000000001',
        'sessionDate', (current_date + 2)::text,
        'officialOpenPrice', '10.1234567890123',
        'currency', 'USD',
        'authority', 'PRIMARY_EXCHANGE_OFFICIAL'
      )::text as body
    )
    insert into public.official_execution_price_evidence (
      idempotency_key, run_id, instrument_id, evidence_kind, session_date,
      currency, official_open_price, authority, observed_at, available_at,
      source_artifact_id, source_sha256, evidence_canonical_json, evidence,
      evidence_sha256, recorded_by
    ) select
      'overprecision-price', '81000000-0000-4000-8000-000000000001',
      '82000000-0000-4000-8000-000000000001',
      'OFFICIAL_AUCTION_OPEN', current_date + 2, 'USD',
      '10.1234567890123', 'PRIMARY_EXCHANGE_OFFICIAL',
      ((current_date + 2)::text || 'T14:30:00Z')::timestamptz,
      ((current_date + 2)::text || 'T14:30:00Z')::timestamptz,
      '85000000-0000-4000-8000-000000000004', repeat('9',64), body,
      body::jsonb, pg_temp.settlement_sha256(body), 'trusted-ingestion'
    from payload$$,
  '23514', null,
  'official execution price rejects a thirteenth fractional digit'
);

select throws_ok(
  $$with payload as (
      select jsonb_build_object(
        'kind', 'ACQUISITION_TAX_BASIS_USD_CNY',
        'effectiveDate', (current_date + 2)::text,
        'baseCurrency', 'USD',
        'quoteCurrency', 'CNY',
        'cnyPerUsd', '7.1234567890123',
        'authority', 'OFFICIAL_TAX_FX_FIXTURE'
      )::text as body
    )
    insert into public.tax_fx_rate_evidence (
      idempotency_key, run_id, rate_kind, effective_date, base_currency,
      quote_currency, cny_per_usd, authority, observed_at, available_at,
      source_artifact_id, source_sha256, evidence_canonical_json, evidence,
      evidence_sha256, recorded_by
    ) select
      'overprecision-fx', '81000000-0000-4000-8000-000000000001',
      'ACQUISITION_TAX_BASIS_USD_CNY', current_date + 2, 'USD', 'CNY',
      '7.1234567890123', 'OFFICIAL_TAX_FX_FIXTURE', now(), now(),
      '85000000-0000-4000-8000-000000000005', repeat('a',64), body,
      body::jsonb, pg_temp.settlement_sha256(body), 'trusted-ingestion'
    from payload$$,
  '23514', null,
  'acquisition tax FX rejects a thirteenth fractional digit'
);

select throws_ok(
  $$select public.settle_paper_fill(
    'settlement-contract:missing-fx',
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:account'),
    '87000000-0000-4000-8000-000000000001', 'buy-lulu-1',
    '88000000-0000-4000-8000-000000000001', null,
    (select executed_at from settlement_clock),
    (select trade_date from settlement_clock),
    0, (select result->>'headSha256' from settlement_head_zero),
    'settlement-contract'
  )$$,
  '22023',
  'a positive BUY fill requires acquisition USD/CNY tax FX evidence',
  'BUY cannot create a future-unusable lot without acquisition tax FX'
);

select throws_ok(
  $$select public.settle_paper_fill(
    'settlement-contract:microsecond-executed-at',
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:account'),
    '87000000-0000-4000-8000-000000000001', 'buy-lulu-1',
    '88000000-0000-4000-8000-000000000001',
    '88000000-0000-4000-8000-000000000002',
    (select executed_at + interval '0.000001 seconds' from settlement_clock),
    (select trade_date from settlement_clock),
    0, (select result->>'headSha256' from settlement_head_zero),
    'settlement-contract'
  )$$,
  '22023',
  'settlement executed_at must be exact to milliseconds',
  'direct RPC cannot persist microseconds hidden by the millisecond response'
);

select throws_ok(
  $$select public.settle_paper_fill(
    'settlement-contract:alpaca-is-not-auction',
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:account'),
    '87000000-0000-4000-8000-000000000001', 'buy-lulu-1',
    '83000000-0000-4000-8000-000000000003',
    '88000000-0000-4000-8000-000000000002',
    (select executed_at from settlement_clock),
    (select trade_date from settlement_clock),
    0, (select result->>'headSha256' from settlement_head_zero),
    'settlement-contract'
  )$$,
  '22023',
  'official auction execution evidence is missing, late, or mismatched',
  'an actual Alpaca daily-bar fact UUID is not execution evidence'
);

select throws_ok(
  $$select public.settle_paper_fill(
    'settlement-contract:s1-blocked',
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:account'),
    '87000000-0000-4000-8000-000000000002', 'sell-lulu-1',
    '88000000-0000-4000-8000-000000000001',
    '88000000-0000-4000-8000-000000000002',
    (select executed_at from settlement_clock),
    (select trade_date from settlement_clock),
    0, (select result->>'headSha256' from settlement_head_zero),
    'settlement-contract'
  )$$,
  '0A000',
  'S1 settlement is fail closed until trusted CNY FX/FIFO tax settlement exists',
  'S1 cannot pretend strict China-resident tax is already resolved'
);

create temporary table settlement_first as
select public.settle_paper_fill(
  'settlement-contract:buy-lulu-1',
  (select strategy_account_id from public.strategy_account
    where idempotency_key = 'settlement-contract:account'),
  '87000000-0000-4000-8000-000000000001',
  'buy-lulu-1',
  '88000000-0000-4000-8000-000000000001',
  '88000000-0000-4000-8000-000000000002',
  (select executed_at from settlement_clock),
  (select trade_date from settlement_clock),
  0,
  (select result->>'headSha256' from settlement_head_zero),
  'settlement-contract'
) as result;

select is(
  (select result->>'outcome' from settlement_first),
  'PARTIALLY_FILLED_CASH_LIMIT',
  'current ledger cash, not the slightly higher frozen limit, forces partial BUY'
);
select is(
  (select result->>'fill_quantity' from settlement_first),
  '100',
  'settlement derives the largest affordable integer quantity'
);
select is(
  (select result->>'canceled_quantity' from settlement_first),
  '1',
  'the unfilled order remainder is deterministically canceled'
);
select is(
  (select result->>'fill_price' from settlement_first),
  '10.005',
  'BUY simulated fill applies the frozen five-basis-point slippage'
);
select is(
  (select result->>'total_fees' from settlement_first),
  '2.29',
  'the legal 12-key Futu schedule derives per-order minima and rounding'
);
select is(
  (select result->>'cash_effect' from settlement_first),
  '1002.79',
  'positive cash_effect is gross plus derived fees'
);
select is(
  (select result->>'effective_buying_power_limit' from settlement_first),
  '1002.79',
  'effective BUY limit is min(current ledger BP, frozen remaining BP)'
);
select is(
  (select result->>'buying_power_after' from settlement_first),
  '0',
  'post-fill buying power is reconciled from immutable cash postings'
);
select ok(
  (select result->>'accounting_transaction_id' is not null
          and result->>'created_lot_origin_id' is not null
     from settlement_first),
  'a positive fill atomically creates its journal and lot'
);
select ok(
  (
    select
      (result->>'settlement_id')::uuid =
        public.deterministic_uuid_from_sha256(
          'twofold.paper_fill_settlement/v1',
          result->>'request_sha256'
        )
      and (result->>'accounting_transaction_id')::uuid =
        public.deterministic_uuid_from_sha256(
          'twofold.accounting_transaction.paper_fill/v1',
          result->>'settlement_id'
        )
      and (result->>'created_lot_origin_id')::uuid =
        public.deterministic_uuid_from_sha256(
          'twofold.position_lot_origin.paper_fill/v1',
          result->>'settlement_id'
        )
    from settlement_first
  ),
  'settlement, journal, and lot IDs derive only from stable request/hash keys'
);
select ok(
  (
    select
      settlement.request_manifest = jsonb_build_object(
        'schema', 'twofold.settle_paper_fill_request/v1',
        'idempotencyKey', settlement.idempotency_key,
        'strategyAccountIdempotencyKey', account.idempotency_key,
        'frozenOrderPlanIdempotencyKey', plan.idempotency_key,
        'frozenOrderPlanSha256', plan.plan_sha256,
        'orderId', settlement.order_id,
        'executionPriceEvidenceIdempotencyKey', evidence.idempotency_key,
        'executionPriceEvidenceSha256', evidence.evidence_sha256,
        'taxFxEvidenceIdempotencyKey', tax_fx.idempotency_key,
        'taxFxEvidenceSha256', tax_fx.evidence_sha256,
        'executedAt', to_char(
          settlement.executed_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'settlementDate', settlement.settlement_date::text,
        'expectedHeadSequence',
          settlement.requested_expected_head_sequence::text,
        'expectedHeadSha256', settlement.requested_expected_head_sha256,
        'recordedBy', settlement.recorded_by
      )
      and not (settlement.request_manifest ?| array[
        'strategyAccountId',
        'frozenOrderPlanId',
        'executionPriceEvidenceId',
        'taxFxRateEvidenceId'
      ]::text[])
      and strpos(
        settlement.request_manifest::text,
        settlement.strategy_account_id::text
      ) = 0
      and strpos(
        settlement.request_manifest::text,
        settlement.frozen_order_plan_id::text
      ) = 0
      and strpos(
        settlement.request_manifest::text,
        settlement.execution_price_evidence_id::text
      ) = 0
      and strpos(
        settlement.request_manifest::text,
        settlement.requested_tax_fx_rate_evidence_id::text
      ) = 0
      and settlement.request_sha256 =
        pg_temp.settlement_sha256(settlement.request_manifest::text)
    from public.paper_fill_settlement as settlement
    join public.strategy_account as account
      on account.strategy_account_id = settlement.strategy_account_id
    join public.frozen_order_plan as plan
      on plan.frozen_order_plan_id = settlement.frozen_order_plan_id
    join public.official_execution_price_evidence as evidence
      on evidence.execution_price_evidence_id =
        settlement.execution_price_evidence_id
    join public.tax_fx_rate_evidence as tax_fx
      on tax_fx.tax_fx_rate_evidence_id =
        settlement.requested_tax_fx_rate_evidence_id
    where settlement.settlement_id = (
      select (result->>'settlement_id')::uuid from settlement_first
    )
  ),
  'request hash binds stable logical identities and excludes random upstream UUIDs'
);
select ok(
  (
    select
      settlement.settlement_manifest->>'strategyAccountIdempotencyKey'
        = account.idempotency_key
      and settlement.settlement_manifest
        ->>'frozenOrderPlanIdempotencyKey' = plan.idempotency_key
      and settlement.settlement_manifest->>'frozenOrderPlanSha256'
        = plan.plan_sha256
      and settlement.settlement_manifest
        ->>'executionPriceEvidenceIdempotencyKey' = evidence.idempotency_key
      and settlement.settlement_manifest->>'executionPriceEvidenceSha256'
        = evidence.evidence_sha256
      and settlement.settlement_manifest->>'taxFxEvidenceIdempotencyKey'
        = tax_fx.idempotency_key
      and settlement.settlement_manifest->>'taxFxEvidenceSha256'
        = tax_fx.evidence_sha256
      and not (settlement.settlement_manifest ?| array[
        'strategyAccountId',
        'frozenOrderPlanId',
        'executionPriceEvidenceId',
        'taxFxRateEvidenceId'
      ]::text[])
      and strpos(
        settlement.settlement_manifest::text,
        settlement.strategy_account_id::text
      ) = 0
      and strpos(
        settlement.settlement_manifest::text,
        settlement.frozen_order_plan_id::text
      ) = 0
      and strpos(
        settlement.settlement_manifest::text,
        settlement.execution_price_evidence_id::text
      ) = 0
      and strpos(
        settlement.settlement_manifest::text,
        settlement.requested_tax_fx_rate_evidence_id::text
      ) = 0
      and settlement.settlement_sha256 =
        pg_temp.settlement_sha256(settlement.settlement_manifest::text)
      and settlement.post_head_sha256 = pg_temp.settlement_sha256(
        settlement.pre_head_sha256 || chr(10)
          || settlement.settlement_sha256
      )
    from public.paper_fill_settlement as settlement
    join public.strategy_account as account
      on account.strategy_account_id = settlement.strategy_account_id
    join public.frozen_order_plan as plan
      on plan.frozen_order_plan_id = settlement.frozen_order_plan_id
    join public.official_execution_price_evidence as evidence
      on evidence.execution_price_evidence_id =
        settlement.execution_price_evidence_id
    join public.tax_fx_rate_evidence as tax_fx
      on tax_fx.tax_fx_rate_evidence_id =
        settlement.requested_tax_fx_rate_evidence_id
    where settlement.settlement_id = (
      select (result->>'settlement_id')::uuid from settlement_first
    )
  ),
  'same stable logical fixture reproduces settlement and chained-head hashes across physical UUID changes'
);
select is(
  (select result->>'tax_fx_rate_evidence_id' from settlement_first),
  '88000000-0000-4000-8000-000000000002',
  'response binds the acquisition tax FX evidence ID'
);
select is(
  (select count(*) from public.position_lot_acquisition_fx),
  1::bigint,
  'the new BUY lot atomically receives one acquisition FX binding'
);
select is(
  (select public.accounting_decimal_text(acquisition_tax_basis_cny)
     from public.position_lot_acquisition_fx),
  '7220.088',
  'future FIFO tax basis freezes gross plus fees translated to CNY'
);
select is(
  (select count(*) from public.paper_fill_fee_component
    where settlement_id = (
      select (result->>'settlement_id')::uuid from settlement_first
    )),
  6::bigint,
  'all six fee components are frozen once per order'
);
select is(
  (
    select sum(case side when 'debit' then amount else -amount end)
      from public.accounting_posting
     where accounting_transaction_id = (
       select (result->>'accounting_transaction_id')::uuid
         from settlement_first
     )
  ),
  0::numeric,
  'atomic BUY journal is balanced in USD'
);
select ok(
  (
    select
      not public.jsonb_contains_number(settlement.settlement_manifest)
      and settlement.settlement_manifest->>'postingManifestSha256'
        = journal.posting_manifest_sha256
      and settlement.settlement_manifest->>'acquisitionTaxBasisCny'
        = public.accounting_decimal_text(binding.acquisition_tax_basis_cny)
    from public.paper_fill_settlement as settlement
    join public.accounting_transaction as journal
      on journal.accounting_transaction_id =
        settlement.accounting_transaction_id
    join public.position_lot_acquisition_fx as binding
      on binding.lot_origin_id = settlement.created_lot_origin_id
    where settlement.settlement_id = (
      select (result->>'settlement_id')::uuid from settlement_first
    )
  ),
  'head-chained settlement manifest binds journal digest and CNY tax basis without numbers'
);
select ok(
  (
    select settlement.settlement_manifest->'feeComponents' = (
      select jsonb_object_agg(
        case component
          when 'sec_regulatory' then 'secRegulatory'
          when 'finra_taf' then 'finraTaf'
          else component
        end,
        public.accounting_decimal_text(amount)
      )
      from public.paper_fill_fee_component as component
      where component.settlement_id = settlement.settlement_id
    )
    from public.paper_fill_settlement as settlement
    where settlement.settlement_id = (
      select (result->>'settlement_id')::uuid from settlement_first
    )
  ),
  'head-chained settlement manifest binds all six persisted fee components'
);
select is(
  (select result->>'post_head_sequence' from settlement_first),
  '1',
  'positive fill advances the account head exactly once'
);
select ok(
  not public.jsonb_contains_number((select result from settlement_first)),
  'settlement RPC response contains no JSON number token'
);

create temporary table settlement_first_retry as
select public.settle_paper_fill(
  'settlement-contract:buy-lulu-1',
  (select strategy_account_id from public.strategy_account
    where idempotency_key = 'settlement-contract:account'),
  '87000000-0000-4000-8000-000000000001', 'buy-lulu-1',
  '88000000-0000-4000-8000-000000000001',
  '88000000-0000-4000-8000-000000000002',
  (select executed_at from settlement_clock),
  (select trade_date from settlement_clock),
  0, (select result->>'headSha256' from settlement_head_zero),
  'settlement-contract'
) as result;

select is(
  (select result->>'settlement_id' from settlement_first_retry),
  (select result->>'settlement_id' from settlement_first),
  'exact retry recovers the original row after the head already advanced'
);
select is(
  (select count(*) from public.paper_fill_settlement
    where order_id = 'buy-lulu-1'),
  1::bigint,
  'exact retry does not duplicate fill, fee, lot, or journal state'
);
select throws_ok(
  $$select public.settle_paper_fill(
    'settlement-contract:buy-lulu-1',
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:account'),
    '87000000-0000-4000-8000-000000000001', 'buy-lulu-1',
    '88000000-0000-4000-8000-000000000001',
    '88000000-0000-4000-8000-000000000002',
    (select executed_at + interval '1 second' from settlement_clock),
    (select trade_date from settlement_clock),
    0, (select result->>'headSha256' from settlement_head_zero),
    'settlement-contract'
  )$$,
  '23505',
  'settlement idempotency or plan/order conflict',
  'same idempotency key with different execution content conflicts'
);

select throws_ok(
  $$select public.settle_paper_fill(
    'settlement-contract:stale-second-order',
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:account'),
    '87000000-0000-4000-8000-000000000001', 'buy-lulu-2',
    '88000000-0000-4000-8000-000000000001',
    '88000000-0000-4000-8000-000000000002',
    (select executed_at from settlement_clock),
    (select trade_date from settlement_clock),
    0, (select result->>'headSha256' from settlement_head_zero),
    'settlement-contract'
  )$$,
  '40001',
  'strategy ledger head compare-and-swap failed',
  'a stale Worker cannot settle against an old head'
);

create temporary table settlement_second as
select public.settle_paper_fill(
  'settlement-contract:buy-lulu-2',
  (select strategy_account_id from public.strategy_account
    where idempotency_key = 'settlement-contract:account'),
  '87000000-0000-4000-8000-000000000001', 'buy-lulu-2',
  '88000000-0000-4000-8000-000000000001',
  null,
  (select executed_at from settlement_clock),
  (select trade_date from settlement_clock),
  1, (select result->>'post_head_sha256' from settlement_first),
  'settlement-contract'
) as result;

select is(
  (select result->>'outcome' from settlement_second),
  'CANCELED_CASH_LIMIT',
  'zero-affordable second order becomes a deterministic cancellation'
);
select ok(
  (select result->>'official_open_price' = '10'
          and result->>'fill_price' = '10.005'
          and result->>'fill_quantity' = '0'
          and result->>'canceled_quantity' = '1'
          and result->>'gross_notional' = '0'
          and result->>'total_fees' = '0'
          and result->>'cash_effect' = '0'
          and result->'tax_fx_rate_evidence_id' = 'null'::jsonb
          and result->'accounting_transaction_id' = 'null'::jsonb
          and result->'created_lot_origin_id' = 'null'::jsonb
     from settlement_second),
  'cancellation preserves verified prices but fabricates no fill or journal'
);
select is(
  (select result->>'post_head_sequence' from settlement_second),
  '2',
  'zero-fill outcome still advances head and permanently consumes the order'
);
select is(
  (select count(*) from public.accounting_transaction
    where strategy_account_id = (
      select strategy_account_id from public.strategy_account
       where idempotency_key = 'settlement-contract:account'
    )),
  2::bigint,
  'cancellation creates no extra accounting transaction'
);

create temporary table settlement_third as
select public.settle_paper_fill(
  'settlement-contract:cancel-with-requested-fx',
  (select strategy_account_id from public.strategy_account
    where idempotency_key = 'settlement-contract:account'),
  '87000000-0000-4000-8000-000000000001',
  'buy-lulu-cancel-with-requested-fx',
  '88000000-0000-4000-8000-000000000001',
  '88000000-0000-4000-8000-000000000002',
  (select executed_at from settlement_clock),
  (select trade_date from settlement_clock),
  2, (select result->>'post_head_sha256' from settlement_second),
  'settlement-contract'
) as result;

select ok(
  (
    select result->>'outcome' = 'CANCELED_CASH_LIMIT'
      and result->'tax_fx_rate_evidence_id' = 'null'::jsonb
      and settlement.request_manifest->'taxFxEvidenceIdempotencyKey'
        = 'null'::jsonb
      and settlement.request_manifest->'taxFxEvidenceSha256'
        = 'null'::jsonb
      and settlement.settlement_manifest->'taxFxEvidenceIdempotencyKey'
        = 'null'::jsonb
      and settlement.settlement_manifest->'acquisitionCnyPerUsd'
        = 'null'::jsonb
      and settlement.settlement_manifest->'taxFxEvidenceSha256'
        = 'null'::jsonb
      and settlement.requested_tax_fx_rate_evidence_id =
        '88000000-0000-4000-8000-000000000002'::uuid
    from settlement_third
    join public.paper_fill_settlement as settlement
      on settlement.settlement_id =
        (settlement_third.result->>'settlement_id')::uuid
  ),
  'cancel may retain requested FX for retry but never exposes it as used evidence'
);

select throws_ok(
  $$select public.settle_paper_fill(
    'settlement-contract:expired-fee-terms',
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:account'),
    '87000000-0000-4000-8000-000000000001',
    'buy-lulu-expired-fees',
    '88000000-0000-4000-8000-000000000001',
    null,
    (select executed_at from settlement_clock),
    (select trade_date from settlement_clock),
    3, (select result->>'post_head_sha256' from settlement_third),
    'settlement-contract'
  )$$,
  '22023',
  'frozen fee schedule is not an admissible per-order USD schedule',
  'fee effectiveTo is exclusive on the planned trade date'
);

select is(
  (public.settle_paper_fill(
    'settlement-contract:buy-lulu-2',
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:account'),
    '87000000-0000-4000-8000-000000000001', 'buy-lulu-2',
    '88000000-0000-4000-8000-000000000001',
    null,
    (select executed_at from settlement_clock),
    (select trade_date from settlement_clock),
    1, (select result->>'post_head_sha256' from settlement_first),
    'settlement-contract'
  )->>'settlement_id'),
  (select result->>'settlement_id' from settlement_second),
  'canceled outcome has the same cross-head exact-retry guarantee'
);

select ok(
  (select head_sequence = 3
          and settlement_count = 3
          and accounting_transaction_count = 2
          and lot_origin_count = 1
          and acquisition_fx_binding_count = 1
     from public.strategy_ledger_head),
  'head counters fully reconcile journal, lot, FX binding, and outcomes'
);

select throws_ok(
  $$update public.paper_fill_settlement set outcome = 'FILLED'$$,
  '55000',
  'paper_fill_settlement is append-only; append a compensating or superseding record instead',
  'settlement outcomes are immutable even for the owner'
);
select throws_ok(
  $$truncate table public.paper_fill_fee_component$$,
  '55000',
  'paper_fill_fee_component is append-only; append a compensating or superseding record instead',
  'append-only settlement children also reject owner TRUNCATE'
);

set local role service_role;
select throws_ok(
  $$select public.append_accounting_transaction(
    'settlement-contract:orphan-fill',
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:account'),
    'buy_fill', 'orphan', now(), current_date, current_date,
    'orphan', '[
      {"account_code":"asset.cash","side":"debit","amount":"1","currency":"USD"},
      {"account_code":"asset.cash","side":"credit","amount":"1","currency":"USD"}
    ]'::jsonb, '{}'::jsonb, 'service'
  )$$,
  '42501', null,
  'service role still cannot bypass settlement through generic journal append'
);
select throws_ok(
  $$select public.register_position_lot_origin(
    'settlement-contract:orphan-lot',
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'settlement-contract:account'),
    '82000000-0000-4000-8000-000000000001',
    'initial_import', 'orphan-lot', now(), current_date,
    1, 1, 0, 'USD', 'FIFO', '{}', 'service', repeat('0',64), null
  )$$,
  '42501', null,
  'service role cannot poison an initialized head with a standalone lot'
);
reset role;

select is(
  (select count(*) from public.paper_fill_settlement where stage = 'S1'),
  0::bigint,
  'fail-closed S1 attempts leave no misleading tax settlement state'
);

select has_table(
  'public', 'accepted_target_cycle',
  'one immutable accepted-target cycle artifact closes the Core replay boundary'
);
select has_column(
  'public', 'accepted_target_cycle', 'cycle_sha256',
  'cycle stores the exact content hash used for replay identity'
);
select is(
  public.get_accepted_target_cycle_readiness(
    '86000000-0000-4000-8000-000000000001'
  )->>'status',
  'READY_FOR_INPUT_BUILD',
  'a fully bound accepted target exposes the input-build handoff before execution'
);
select is(
  public.get_accepted_target_cycle_readiness(
    '86000000-0000-4000-8000-000000000001'
  )->'blockers',
  '[]'::jsonb,
  'the input-build handoff has no synthetic downstream blockers'
);

-- One READY intent per frozen order, each observing the head the previous
-- settlement produced. The database fences the opening head against the durable
-- row and the final head against the settlement count; the intermediate hash
-- chain is a Core invariant covered by the Core suite, so entries after the
-- first carry deterministic synthetic hashes.
create or replace function pg_temp.cycle_settlements(
  p_stage text,
  p_side text,
  p_orders jsonb,
  p_base_sequence bigint,
  p_base_hash text,
  p_strategy_account_id uuid,
  p_run_id uuid
)
returns jsonb
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'status', 'READY',
      'intent', jsonb_build_object(
        'stage', p_stage,
        'side', p_side,
        'ledgerHead', jsonb_build_object(
          'strategyAccountId', p_strategy_account_id::text,
          'runId', p_run_id::text,
          'headSequence', (p_base_sequence + entry.ordinality - 1)::text,
          'headHash', case
            when entry.ordinality = 1 then p_base_hash
            else pg_temp.settlement_sha256(
              'cycle-head:' || (p_base_sequence + entry.ordinality - 1)::text
            )
          end
        )
      )
    ) order by entry.ordinality),
    '[]'::jsonb
  )
  from jsonb_array_elements(p_orders)
    with ordinality as entry(value, ordinality)
$$;

create temporary table accepted_cycle_request as
with plan_rows as (
  select
    max(engine_plan_fingerprint) filter (where stage = 'S1') as s1_fingerprint,
    max(engine_plan_fingerprint) filter (where stage = 'S2') as s2_fingerprint,
    (array_agg(frozen_order_plan_id) filter (where stage = 'S1'))[1] as s1_plan_id,
    (array_agg(frozen_order_plan_id) filter (where stage = 'S2'))[1] as s2_plan_id
  from public.frozen_order_plan
  where decision_id = '86000000-0000-4000-8000-000000000001'
), core_plans as (
  select
    (s1_fingerprint::jsonb || jsonb_build_object(
      'planFingerprint', s1_fingerprint
    )) as s1_plan,
    (s2_fingerprint::jsonb || jsonb_build_object(
      'planFingerprint', s2_fingerprint
    )) as s2_plan,
    s1_plan_id,
    s2_plan_id
  from plan_rows
), cycle_body as (
  select jsonb_build_object(
    'schema', 'twofold.accepted_target_cycle/v1',
    'submissionId', '86000000-0000-4000-8000-000000000003',
    'decisionId', '86000000-0000-4000-8000-000000000001',
    's1', jsonb_build_object(
      'plan', s1_plan,
      'settlements', pg_temp.cycle_settlements(
        'S1', 'SELL', s1_plan->'orders',
        head_sequence, head_sha256,
        strategy_account_id, '81000000-0000-4000-8000-000000000001'
      ),
      'nav', jsonb_build_object(
        'currency', 'USD',
        'positionMarketValue', '0',
        'brokerNav', '1000',
        'taxReserveDeductions', '0',
        'taxReservedNav', '1000',
        'liquidationDeductions', '0',
        'liquidationNav', '1000'
      )
    ),
    's2', jsonb_build_object(
      'plan', s2_plan,
      'settlements', pg_temp.cycle_settlements(
        'S2', 'BUY', s2_plan->'orders',
        head_sequence + jsonb_array_length(s1_plan->'orders'),
        pg_temp.settlement_sha256(
          'cycle-head:' || (
            head_sequence + jsonb_array_length(s1_plan->'orders')
          )::text
        ),
        strategy_account_id, '81000000-0000-4000-8000-000000000001'
      )
    ),
    'positions', '[]'::jsonb,
    'ledger', jsonb_build_object(
      'transactionCount', (
        select count(*)::text from public.accounting_transaction
         where strategy_account_id = (
           select strategy_account_id from public.strategy_account
            where idempotency_key = 'settlement-contract:account'
         )
      ),
      'balances', '[]'::jsonb,
      'positions', '[]'::jsonb
    ),
    'nav', jsonb_build_object(
      'currency', 'USD',
      'positionMarketValue', '0',
      'brokerNav', '1000',
      'taxReserveDeductions', '0',
      'taxReservedNav', '1000',
      'liquidationDeductions', '0',
      'liquidationNav', '1000'
    ),
    -- The head advances exactly once per settlement across both stages.
    'finalLedgerHead', jsonb_build_object(
      'sequence', (
        head_sequence
          + jsonb_array_length(s1_plan->'orders')
          + jsonb_array_length(s2_plan->'orders')
      )::text,
      'sha256', pg_temp.settlement_sha256(
        'cycle-head:' || (
          head_sequence
            + jsonb_array_length(s1_plan->'orders')
            + jsonb_array_length(s2_plan->'orders')
        )::text
      )
    )
  ) as body, s1_plan_id, s2_plan_id
  from core_plans
  cross join public.strategy_ledger_head
  where strategy_account_id = (
    select strategy_account_id from public.strategy_account
     where idempotency_key = 'settlement-contract:account'
  )
), exact_bytes as (
  select body::text as canonical_json,
         pg_temp.settlement_sha256(body::text) as cycle_sha256,
         s1_plan_id,
         s2_plan_id
  from cycle_body
)
select
  'accepted-cycle-contract:commit'::text as idempotency_key,
  public.deterministic_uuid_from_sha256(
    'twofold.accepted_target_cycle/v1', cycle_sha256
  ) as cycle_id,
  (select strategy_account_id from public.strategy_account
    where idempotency_key = 'settlement-contract:account') as strategy_account_id,
  '81000000-0000-4000-8000-000000000001'::uuid as run_id,
  '86000000-0000-4000-8000-000000000001'::uuid as decision_id,
  '86000000-0000-4000-8000-000000000003'::uuid as accepted_submission_id,
  s1_plan_id,
  s2_plan_id,
  canonical_json,
  cycle_sha256,
  (select executed_at from settlement_clock) as completed_at,
  (select max(stream_seq) from public.event_stream
    where stream_id = '81000000-0000-4000-8000-000000000001') as expected_run_seq,
  0::bigint as expected_projection_seq,
  public.deterministic_uuid_from_sha256(
    'twofold.event.accepted_target_cycle/v1',
    public.deterministic_uuid_from_sha256(
      'twofold.accepted_target_cycle/v1', cycle_sha256
    )::text
  ) as event_id,
  'settlement-contract'::text as recorded_by
from exact_bytes;

create or replace function pg_temp.commit_cycle(p_completed_at timestamptz)
returns jsonb
language sql
volatile
set search_path = public, extensions, pg_temp
as $$
  select public.commit_accepted_target_cycle(
    idempotency_key, cycle_id, strategy_account_id, run_id, decision_id,
    accepted_submission_id, s1_plan_id, s2_plan_id, canonical_json,
    cycle_sha256, p_completed_at, expected_run_seq,
    expected_projection_seq, event_id, recorded_by
  )
  from accepted_cycle_request
$$;

-- Every rejection branch of the cycle admission boundary, exercised before the
-- one accepted commit so the idempotency lookup cannot short-circuit them.
create or replace function pg_temp.commit_mutated_cycle(p_cycle jsonb)
returns jsonb
language sql
volatile
set search_path = public, extensions, pg_temp
as $$
  select public.commit_accepted_target_cycle(
    'accepted-cycle-contract:rejected',
    public.deterministic_uuid_from_sha256(
      'twofold.accepted_target_cycle/v1',
      pg_temp.settlement_sha256(p_cycle::text)
    ),
    strategy_account_id, run_id, decision_id, accepted_submission_id,
    s1_plan_id, s2_plan_id, p_cycle::text,
    pg_temp.settlement_sha256(p_cycle::text), completed_at,
    expected_run_seq, expected_projection_seq,
    public.deterministic_uuid_from_sha256(
      'twofold.event.accepted_target_cycle/v1',
      public.deterministic_uuid_from_sha256(
        'twofold.accepted_target_cycle/v1',
        pg_temp.settlement_sha256(p_cycle::text)
      )::text
    ),
    recorded_by
  )
  from accepted_cycle_request
$$;

create or replace function pg_temp.rejected_cycle(p_path text[], p_value jsonb)
returns jsonb
language sql
volatile
set search_path = public, extensions, pg_temp
as $$
  select pg_temp.commit_mutated_cycle(
    case
      when p_value is null then (canonical_json::jsonb) #- p_path
      else jsonb_set(canonical_json::jsonb, p_path, p_value)
    end
  )
  from accepted_cycle_request
$$;

select throws_ok(
  $$select pg_temp.rejected_cycle('{s1,plan,orders}', null)$$,
  '22023',
  'cycle stage payload must carry both order arrays and settlements',
  'a plan without an orders array is rejected instead of collapsing the conservation check to NULL'
);
select throws_ok(
  $$select pg_temp.rejected_cycle('{s1,plan,orders,0,quantity}', '"999"'::jsonb)$$,
  '22023',
  'cycle plan content diverges from the admitted frozen plan bytes',
  'a correct planFingerprint cannot smuggle tampered plan orders'
);
select throws_ok(
  $$select pg_temp.commit_mutated_cycle(jsonb_set(
      canonical_json::jsonb,
      '{s2,settlements}',
      (canonical_json::jsonb#>'{s2,settlements}') - 0
    )) from accepted_cycle_request$$,
  '22023',
  'cycle orders and READY settlement intents do not conserve',
  'dropping one settlement breaks stage conservation'
);
select throws_ok(
  $$select pg_temp.rejected_cycle(
      '{s1,settlements,0,intent,ledgerHead,strategyAccountId}',
      '"82000000-0000-4000-8000-000000000001"'::jsonb
    )$$,
  '22023',
  'cycle settlement intents are not bound to this account and run',
  'a settlement derived against another account cannot be filed under this one'
);
select throws_ok(
  $$select pg_temp.rejected_cycle('{nav,liquidationNav}', '"1"'::jsonb)$$,
  '22023',
  'cycle ledger, final head, or NAV invariants are invalid',
  'a broken NAV subtraction identity is rejected'
);
select throws_ok(
  $$select pg_temp.rejected_cycle(
      '{s1,settlements,0,intent,ledgerHead,headSequence}', '"2"'::jsonb
    )$$,
  '40001',
  'cycle opening ledger head does not match the durable head',
  'a cycle derived from a stale ledger head is a CAS conflict, not an admission'
);
select throws_ok(
  $$select pg_temp.rejected_cycle('{finalLedgerHead,sequence}', '"99"'::jsonb)$$,
  '22023',
  'cycle final ledger head must advance exactly once per settlement',
  'the final head cannot skip or invent settlements'
);

create temporary table accepted_cycle_commit as
select pg_temp.commit_cycle(completed_at) as result
from accepted_cycle_request;

select is(
  (select head_sequence::text || ':' || head_sha256
     from public.strategy_ledger_head
    where strategy_account_id = (
      select strategy_account_id from public.strategy_account
       where idempotency_key = 'settlement-contract:account'
    )),
  (select (canonical_json::jsonb#>>'{finalLedgerHead,sequence}')
            || ':' || (canonical_json::jsonb#>>'{finalLedgerHead,sha256}')
     from accepted_cycle_request),
  'the durable ledger head is advanced to the artifact final head in the same transaction'
);
select isnt(
  (select head_sha256 from public.strategy_ledger_head
    where strategy_account_id = (
      select strategy_account_id from public.strategy_account
       where idempotency_key = 'settlement-contract:account'
    )),
  (select canonical_json::jsonb#>>'{s1,settlements,0,intent,ledgerHead,headHash}'
     from accepted_cycle_request),
  'the consumed opening head is no longer durable, so no second cycle can spend the same balances'
);

select is(
  (select result->>'schema' from accepted_cycle_commit),
  'twofold.accepted_target_cycle_commit_result/v1',
  'complete cycle commit returns a string-only versioned response'
);
select is(
  (select result->>'sourceStreamSeq' from accepted_cycle_commit),
  (select (expected_run_seq + 1)::text from accepted_cycle_request),
  'cycle commit advances the authoritative run stream exactly once'
);
select is(
  public.get_accepted_target_cycle_readiness(
    '86000000-0000-4000-8000-000000000001'
  )->>'status',
  'COMPLETED',
  'the same readiness boundary becomes completed after atomic cycle commit'
);
select is(
  public.get_accepted_target_cycle_readiness(
    '86000000-0000-4000-8000-000000000001'
  )->>'cycleId',
  (select cycle_id::text from accepted_cycle_request),
  'completed readiness identifies the exact immutable cycle'
);
select ok(
  (select cycle_canonical_json::jsonb = cycle
          and cycle_sha256 = pg_temp.settlement_sha256(cycle_canonical_json)
     from public.accepted_target_cycle),
  'persisted cycle retains the exact bytes, parsed payload, and content hash'
);
select is(
  (select event_type from public.event_stream
    where event_id = (select event_id from accepted_cycle_request)),
  'decision.accepted_target_cycle_completed',
  'cycle publication appends one causally linked run event'
);
select ok(
  (select state->>'status' = 'COMPLETED'
          and state#>>'{s1,status}' = 'COMPLETED'
          and state#>>'{s2,status}' = 'COMPLETED'
          and state#>>'{ledger,headSequence}' = '8'
     from public.projection
    where projection_name = 'dashboard.accepted_target_cycle'
      and entity_id = '86000000-0000-4000-8000-000000000001'),
  'decision projection exposes both stages and the replayed ledger head'
);
select is(
  (select state#>>'{nav,taxReservedNav}' from public.projection
    where projection_name = 'dashboard.accepted_target_cycle'
      and entity_id = '86000000-0000-4000-8000-000000000001'),
  '1000',
  'decision projection exposes the exact tax-reserved NAV string'
);
select is(
  (select pg_temp.commit_cycle(completed_at)->>'cycleId'
     from accepted_cycle_request),
  (select result->>'cycleId' from accepted_cycle_commit),
  'an exact retry returns the original cycle without a second event'
);
select throws_ok(
  $$select pg_temp.commit_cycle(completed_at + interval '1 millisecond')
      from accepted_cycle_request$$,
  '23505',
  'accepted target cycle identity was reused with different content',
  'a changed retry cannot overwrite the immutable cycle'
);
select throws_ok(
  $$update public.accepted_target_cycle set completed_at = completed_at + interval '1 second'$$,
  '55000',
  'accepted_target_cycle is append-only; append a compensating or superseding record instead',
  'cycle artifacts reject owner mutation'
);
set local role service_role;
select throws_ok(
  $$select count(*) from public.accepted_target_cycle$$,
  '42501', null,
  'service role may commit through the RPC but cannot read the private artifact table directly'
);
reset role;

select * from finish();
rollback;
