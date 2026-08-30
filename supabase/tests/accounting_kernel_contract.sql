-- Keyless pgTAP contract tests for the immutable paper-accounting boundary.
-- The enclosing transaction leaves no durable fixtures.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(92);

create or replace function pg_temp.contract_buy_postings()
returns jsonb
language sql
immutable
as $$
  select '[
    {
      "account_code":"securities.inventory",
      "side":"debit",
      "amount":"1000",
      "currency":"USD",
      "instrument_id":"71000000-0000-4000-8000-000000000001"
    },
    {
      "account_code":"expense.broker_fee",
      "side":"debit",
      "amount":"2.29",
      "currency":"USD"
    },
    {
      "account_code":"asset.cash",
      "side":"credit",
      "amount":"1002.29",
      "currency":"USD"
    }
  ]'::jsonb;
$$;

select has_table('public', 'run_manifest', 'run_manifest exists');
select has_table('public', 'instrument', 'instrument exists');
select has_table(
  'public',
  'instrument_symbol_version',
  'instrument_symbol_version exists'
);
select has_table(
  'public',
  'strategy_account',
  'strategy_account exists'
);
select has_table(
  'public',
  'position_lot_origin',
  'position_lot_origin exists'
);
select has_table(
  'public',
  'accounting_transaction',
  'accounting_transaction exists'
);
select has_table(
  'public',
  'accounting_posting',
  'accounting_posting exists'
);
select has_table(
  'public',
  'frozen_order_plan',
  'frozen_order_plan exists'
);

select has_column(
  'public',
  'run_manifest',
  'manifest_sha256',
  'run manifests retain a content hash'
);
select has_column(
  'public',
  'position_lot_origin',
  'tax_basis',
  'original lots expose generated tax basis'
);
select has_column(
  'public',
  'accounting_transaction',
  'posting_manifest',
  'journal headers retain the exact RPC request'
);
select has_column(
  'public',
  'accounting_posting',
  'amount',
  'journal postings store exact decimal amounts'
);
select has_column(
  'public',
  'frozen_order_plan',
  'engine_plan_fingerprint',
  'frozen plans retain the exact Core engine fingerprint bytes'
);
select has_column(
  'public',
  'frozen_order_plan',
  'engine_plan_fingerprint_sha256',
  'frozen plans retain the exact Core engine fingerprint digest'
);

select is(
  (
    public.register_run_manifest(
      'accounting-contract:manifest',
      '70000000-0000-4000-8000-000000000001',
      'twofold.run_manifest/v1',
      '{
        "engine_version":"accounting-kernel-v1",
        "git_commit":"contract-fixture",
        "lot_method":"FIFO"
      }'::jsonb,
      'accounting-contract',
      repeat('a', 64)
    )
  ).run_id,
  '70000000-0000-4000-8000-000000000001'::uuid,
  'register_run_manifest freezes one reproducible run identity'
);

select ok(
  (
    select manifest_sha256 ~ '^[0-9a-f]{64}$'
       and source_sha256 = repeat('a', 64)
      from public.run_manifest
     where idempotency_key = 'accounting-contract:manifest'
  ),
  'the run manifest is content hashed and bound to its immutable source hash'
);

select is(
  (
    public.register_run_manifest(
      'accounting-contract:manifest',
      '70000000-0000-4000-8000-000000000001',
      'twofold.run_manifest/v1',
      '{
        "engine_version":"accounting-kernel-v1",
        "git_commit":"contract-fixture",
        "lot_method":"FIFO"
      }'::jsonb,
      'accounting-contract',
      repeat('a', 64)
    )
  ).run_manifest_id,
  (
    select run_manifest_id
      from public.run_manifest
     where idempotency_key = 'accounting-contract:manifest'
  ),
  'an exact run-manifest retry returns the original immutable row'
);

select is(
  (
    select count(*)
      from public.run_manifest
     where run_id = '70000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'an exact run-manifest retry does not duplicate the run'
);

select throws_ok(
  $$
    select public.register_run_manifest(
      'accounting-contract:manifest',
      '70000000-0000-4000-8000-000000000001',
      'twofold.run_manifest/v1',
      '{
        "engine_version":"different",
        "git_commit":"contract-fixture",
        "lot_method":"FIFO"
      }'::jsonb,
      'accounting-contract',
      repeat('a', 64)
    )
  $$,
  '23505',
  'run manifest identity was reused with different content',
  'a run-manifest identity cannot be retried with different content'
);

select throws_ok(
  $$
    select public.register_run_manifest(
      'accounting-contract:manifest:number',
      '70000000-0000-4000-8000-000000000002',
      'twofold.run_manifest/v1',
      '{"starting_cash":1000}'::jsonb,
      'accounting-contract',
      repeat('c', 64)
    )
  $$,
  '22023',
  'run manifest requires an idempotency key, run ID, v1 object payload without JSON numbers, and recorder',
  'run-manifest JSON rejects number tokens instead of accepting float-like payloads'
);

select is(
  (
    public.register_instrument(
      'accounting-contract:instrument:lulu',
      '71000000-0000-4000-8000-000000000001',
      'common_stock',
      'NASDAQ',
      'USD',
      'US',
      '{"issuer":"lululemon athletica inc."}'::jsonb,
      'accounting-contract'
    )
  ).instrument_id,
  '71000000-0000-4000-8000-000000000001'::uuid,
  'register_instrument establishes a stable contract-only identity'
);

select is(
  (
    public.register_instrument_symbol_version(
      'accounting-contract:symbol:lulu',
      '71000000-0000-4000-8000-000000000001',
      'TFLULU',
      'NASDAQ',
      '2026-01-01',
      null,
      '{"source":"contract-fixture"}'::jsonb,
      'accounting-contract'
    )
  ).symbol,
  'TFLULU',
  'a ticker is stored as an effective-dated alias of the stable instrument'
);

select is(
  (
    select count(*)
      from public.instrument_symbol_version
     where instrument_id = '71000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'the first symbol version is singular before retry'
);

select throws_ok(
  $$
    select public.register_instrument_symbol_version(
      'accounting-contract:symbol:lulu:overlap',
      '71000000-0000-4000-8000-000000000001',
      'TFLULU2',
      'NASDAQ',
      '2026-08-24',
      null,
      '{}'::jsonb,
      'accounting-contract'
    )
  $$,
  '23P01',
  'instrument symbol effective window overlaps an existing version',
  'overlapping ticker history fails closed'
);

select is(
  (
    public.register_strategy_account(
      'accounting-contract:account',
      '70000000-0000-4000-8000-000000000001',
      'main-paper',
      'futu-simulation',
      'HK',
      'USD',
      false,
      '{"purpose":"accounting-contract"}'::jsonb,
      'accounting-contract'
    )
  ).live_trading,
  false,
  'strategy_account is structurally paper-only'
);

select throws_ok(
  $$
    select public.register_strategy_account(
      'accounting-contract:account:live',
      '70000000-0000-4000-8000-000000000001',
      'main-live',
      'futu',
      'HK',
      'USD',
      true,
      '{}'::jsonb,
      'accounting-contract'
    )
  $$,
  '22023',
  'strategy account must be a valid paper-only account',
  'live trading cannot be enabled through the service RPC'
);

create temporary table accounting_order_plan_context (
  decision_at timestamptz not null,
  opened_at timestamptz not null,
  accepted_at timestamptz not null,
  planned_at timestamptz not null,
  planned_trade_date date not null,
  submission_deadline_at timestamptz not null
) on commit drop;

insert into accounting_order_plan_context (
  decision_at,
  opened_at,
  accepted_at,
  planned_at,
  planned_trade_date,
  submission_deadline_at
)
select
  base_time - interval '3 minutes',
  base_time - interval '2 minutes',
  base_time - interval '1 minute',
  base_time,
  ((base_time at time zone 'UTC')::date + 1),
  base_time + interval '1 day'
from (
  select date_trunc('second', clock_timestamp()) as base_time
) as clock;

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
  '73000000-0000-4000-8000-000000000001',
  'alpaca',
  'us_stock_daily_bars',
  'accounting-order-plan-contract-v1',
  'https://data.alpaca.markets',
  'iex',
  'raw',
  '1Day',
  'accounting-order-plan-normalizer-v1',
  'private-research',
  repeat('7', 64),
  (select decision_at from accounting_order_plan_context)
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
  '73000000-0000-4000-8000-000000000002',
  'accounting-contract:order-plan:snapshot',
  '73000000-0000-4000-8000-000000000001',
  'market_close',
  (select decision_at from accounting_order_plan_context),
  ((select decision_at from accounting_order_plan_context)
    at time zone 'UTC')::date,
  array['TFLULU'],
  'accounting-order-plan-contract-v1',
  'twofold.market_snapshot/v2',
  repeat('8', 64)
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
    '72000000-0000-4000-8000-000000000010',
    '72000000-0000-4000-8000-000000000020',
    'run',
    1,
    'decision.opened',
    '1',
    'accounting-contract:order-plan:decision-event',
    'worker',
    'accounting-contract',
    (select opened_at from accounting_order_plan_context),
    '{"fixture":"order-plan"}'::jsonb,
    '{}'::jsonb
  ),
  (
    '72000000-0000-4000-8000-000000000011',
    '72000000-0000-4000-8000-000000000020',
    'run',
    2,
    'decision.targets_accepted',
    '1',
    'accounting-contract:order-plan:submission-event',
    'worker',
    'accounting-contract',
    (select accepted_at from accounting_order_plan_context),
    '{"fixture":"order-plan"}'::jsonb,
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
    '72000000-0000-4000-8000-000000000012',
    'accounting-contract:order-plan:packet',
    '70000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000010',
    'decision_packet',
    'twofold-private-artifacts',
    'contract/accounting/order-plan-packet.json',
    'application/json',
    1,
    repeat('9', 64),
    'accounting-contract',
    '{}'::jsonb
  ),
  (
    '72000000-0000-4000-8000-000000000013',
    'accounting-contract:order-plan:bundle',
    '70000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000010',
    'agent_bundle_manifest',
    'twofold-private-artifacts',
    'contract/accounting/order-plan-bundle.json',
    'application/json',
    1,
    repeat('a', 64),
    'accounting-contract',
    '{}'::jsonb
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
  '72000000-0000-4000-8000-000000000001',
  'accounting-contract:order-plan:decision',
  '70000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000003',
  'accounting-contract-order-plan-root',
  '72000000-0000-4000-8000-000000000012',
  '72000000-0000-4000-8000-000000000013',
  '73000000-0000-4000-8000-000000000002',
  (select decision_at from accounting_order_plan_context),
  (select decision_at from accounting_order_plan_context),
  (select submission_deadline_at from accounting_order_plan_context),
  array['contract_fixture'],
  '72000000-0000-4000-8000-000000000010',
  1,
  (select opened_at from accounting_order_plan_context)
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
  'accounting-contract-order-plan-root',
  'accounting-contract:order-plan:root',
  '72000000-0000-4000-8000-000000000001',
  'accounting-contract-order-plan-root',
  null,
  'root',
  'accounting-contract-agent',
  'root',
  0,
  (select opened_at from accounting_order_plan_context),
  '72000000-0000-4000-8000-000000000010',
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
  '72000000-0000-4000-8000-000000000002',
  'accounting-contract:order-plan:submission',
  '72000000-0000-4000-8000-000000000001',
  'accounting-contract-order-plan-root',
  '72000000-0000-4000-8000-000000000012',
  repeat('9', 64),
  '[{"symbol":"TFLULU","target_weight_bps":"10000"}]'::jsonb,
  '0',
  'Accounting order plan fixture',
  repeat('b', 64),
  (select accepted_at from accounting_order_plan_context),
  '72000000-0000-4000-8000-000000000011',
  2,
  'accounting-contract'
);

create or replace function pg_temp.contract_sha256(p_value text)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select encode(digest(convert_to(p_value, 'UTF8'), 'sha256'), 'hex')
$$;

create or replace function pg_temp.contract_fee_schedule_terms(
  p_commission_per_share text default '0.0049'
)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'feeScheduleId', 'futu-us-fixed-v1',
    'brokerLegalEntity', 'Futu Securities International (Hong Kong) Limited',
    'accountRegion', 'HK',
    'market', 'US',
    'product', 'US_EQUITY_ETF',
    'accountTier', 'fixed',
    'effectiveFrom', '2026-08-23',
    'effectiveTo', null,
    'currency', 'USD',
    'roundingPolicy', 'ROUND_HALF_UP_TO_CENT',
    'aggregationPolicy', 'PER_ORDER',
    'rates', jsonb_build_object(
      'commissionPerShare', p_commission_per_share,
      'commissionMinimumPerOrder', '0.99',
      'platformPerShare', '0.005',
      'platformMinimumPerOrder', '1',
      'settlementPerShare', '0.003',
      'secRateOfGrossNotional', '0',
      'secMinimumPerOrder', '0',
      'finraTafPerShare', '0',
      'finraTafMinimumPerOrder', '0',
      'finraTafMaximumPerOrder', '0',
      'catPerShare', '0'
    )
  )::text
$$;

create or replace function pg_temp.contract_order_plan_text(
  p_stage text,
  p_order_id text,
  p_side text,
  p_quantity text,
  p_fee_schedule_terms text,
  p_noop boolean default false,
  p_duplicate boolean default false,
  p_planned_at timestamptz default null,
  p_planned_trade_date date default null,
  p_buying_power_visible_at timestamptz default null,
  p_run_id text default '70000000-0000-4000-8000-000000000001',
  p_decision_id text default '72000000-0000-4000-8000-000000000001',
  p_accepted_submission_id text
    default '72000000-0000-4000-8000-000000000002'
)
returns text
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_planned_at timestamptz;
  v_decision_at timestamptz;
  v_planned_at_text text;
  v_planned_trade_date date;
  v_reference_session_date date;
  v_reference_evidence jsonb;
  v_engine_order jsonb;
  v_wrapper_order jsonb;
  v_engine_orders jsonb;
  v_wrapper_orders jsonb;
  v_buying_power_evidence jsonb;
  v_engine_plan jsonb;
  v_engine_plan_text text;
  v_wrapper jsonb;
begin
  select
    coalesce(p_planned_at, context.planned_at),
    coalesce(p_planned_trade_date, context.planned_trade_date),
    context.decision_at
    into v_planned_at, v_planned_trade_date, v_decision_at
    from accounting_order_plan_context as context;

  v_planned_at_text := to_char(
    v_planned_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_reference_session_date :=
    (v_planned_at at time zone 'UTC')::date - 1;
  v_reference_evidence := jsonb_build_object(
    'value', '100',
    'kind', 'OFFICIAL_CLOSE',
    'sessionDate', v_reference_session_date::text,
    'visibleAt', to_char(
      least(v_decision_at, v_planned_at) at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'snapshotId', 'accounting-contract-close-snapshot',
    'factId', 'accounting-contract-close-fact'
  );

  v_engine_order := jsonb_build_object(
    'orderId', p_order_id,
    'decisionId', p_decision_id,
    'stage', p_stage,
    'side', p_side,
    'instrumentId', '71000000-0000-4000-8000-000000000001',
    'symbol', 'TFLULU',
    'quantity', p_quantity,
    'referencePrice', '100',
    'referencePriceEvidence', v_reference_evidence,
    'plannedAt', v_planned_at_text,
    'plannedTradeDate', v_planned_trade_date::text,
    'feeScheduleId', 'futu-us-fixed-v1',
    'feeCurrency', 'USD',
    'feeScheduleTerms', p_fee_schedule_terms,
    'targetWeightBps', '10000'
  );

  if p_stage = 'S2' then
    v_engine_order := v_engine_order || jsonb_build_object(
      'targetAmount', '1000',
      'currentMarketValue', '0',
      'targetGap', '1000',
      'priority', '1',
      'estimatedGrossNotional', '1000',
      'estimatedFees', jsonb_build_object(
        'commission', '0.99',
        'platform', '1',
        'settlement', '0.3',
        'secRegulatory', '0',
        'finraTaf', '0',
        'cat', '0'
      ),
      'estimatedTotalFees', '2.02',
      'reservedBuyingPower', '1002.29'
    );
  end if;

  v_wrapper_order := v_engine_order || jsonb_build_object(
    'executionModel', 'SIMULATED_SLIPPAGE',
    'slippageBps', '5',
    'feeTermsSha256', pg_temp.contract_sha256(p_fee_schedule_terms)
  );

  if p_noop then
    v_engine_orders := '[]'::jsonb;
    v_wrapper_orders := '[]'::jsonb;
  elsif p_duplicate then
    v_engine_orders := jsonb_build_array(v_engine_order, v_engine_order);
    v_wrapper_orders := jsonb_build_array(v_wrapper_order, v_wrapper_order);
  else
    v_engine_orders := jsonb_build_array(v_engine_order);
    v_wrapper_orders := jsonb_build_array(v_wrapper_order);
  end if;

  v_engine_plan := jsonb_build_object(
    'schema', 'twofold.frozen_order_plan/v1',
    'decisionId', p_decision_id,
    'stage', p_stage,
    'executionModel', 'SIMULATED_SLIPPAGE',
    'slippageBps', '5',
    'fillPriceScale', '8',
    'orders', v_engine_orders
  );

  if p_stage = 'S1' then
    v_engine_plan := v_engine_plan || jsonb_build_object(
      'taxRulesetId',
        'cn_resident_direct_foreign_securities_strict_v1',
      'taxAllocationScale', '12'
    );
  else
    v_buying_power_evidence := jsonb_build_object(
      'value', '1002.29',
      'snapshotId', 'accounting-contract-buying-power-snapshot',
      'visibleAt', to_char(
        coalesce(p_buying_power_visible_at, v_planned_at)
          at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    );
    v_engine_plan := v_engine_plan || jsonb_build_object(
      'initialBuyingPower', '1002.29',
      'reservedBuyingPower', '1002.29',
      'remainingUnreservedBuyingPower', '0',
      'buyingPowerEvidence', v_buying_power_evidence
    );
  end if;

  v_engine_plan_text := v_engine_plan::text;
  v_wrapper := jsonb_build_object(
    'manifestSchema', 'twofold.frozen_order_plan/v1',
    'runId', p_run_id,
    'decisionId', p_decision_id,
    'acceptedSubmissionId', p_accepted_submission_id,
    'stage', p_stage,
    'plannedAt', v_planned_at_text,
    'plannedTradeDate', v_planned_trade_date::text,
    'executionModel', 'SIMULATED_SLIPPAGE',
    'slippageBps', '5',
    'fillPriceScale', '8',
    'enginePlanFingerprint', v_engine_plan_text,
    'enginePlanFingerprintSha256',
      pg_temp.contract_sha256(v_engine_plan_text),
    'orders', v_wrapper_orders
  );

  if p_stage = 'S1' then
    v_wrapper := v_wrapper || jsonb_build_object(
      'taxRulesetId',
        'cn_resident_direct_foreign_securities_strict_v1',
      'taxAllocationScale', '12'
    );
  else
    v_wrapper := v_wrapper || jsonb_build_object(
      'initialBuyingPower', '1002.29',
      'reservedBuyingPower', '1002.29',
      'remainingUnreservedBuyingPower', '0',
      'buyingPowerEvidence', v_buying_power_evidence
    );
  end if;

  return v_wrapper::text;
end;
$$;

create or replace function pg_temp.register_contract_order_plan(
  p_idempotency_key text,
  p_stage text,
  p_plan_canonical_json text,
  p_planned_at timestamptz default null,
  p_planned_trade_date date default null,
  p_run_id uuid default '70000000-0000-4000-8000-000000000001',
  p_decision_id uuid default '72000000-0000-4000-8000-000000000001',
  p_accepted_submission_id uuid
    default '72000000-0000-4000-8000-000000000002'
)
returns public.frozen_order_plan
language sql
volatile
set search_path = public, extensions, pg_temp
as $$
  select public.register_frozen_order_plan(
    p_idempotency_key,
    (
      select strategy_account_id
        from public.strategy_account
       where idempotency_key = 'accounting-contract:account'
    ),
    p_run_id,
    p_decision_id,
    p_accepted_submission_id,
    p_stage,
    coalesce(
      p_planned_at,
      (select planned_at from accounting_order_plan_context)
    ),
    coalesce(
      p_planned_trade_date,
      (select planned_trade_date from accounting_order_plan_context)
    ),
    'twofold.frozen_order_plan/v1',
    p_plan_canonical_json,
    pg_temp.contract_sha256(p_plan_canonical_json),
    'accounting-contract'
  )
$$;

select is(
  (
    pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:s2',
      'S2',
      pg_temp.contract_order_plan_text(
        'S2',
        'order-buy-1',
        'BUY',
        '10',
        pg_temp.contract_fee_schedule_terms()
      )
    )
  ).stage,
  'S2',
  'register_frozen_order_plan admits a canonical next-day S2 plan'
);

select ok(
  (
    select plan_sha256 = pg_temp.contract_sha256(plan_canonical_json)
      from public.frozen_order_plan
     where idempotency_key = 'accounting-contract:order-plan:s2'
  ),
  'the frozen plan hash is computed over the exact stored UTF-8 bytes'
);

select ok(
  (
    select engine_plan_fingerprint_sha256 =
      pg_temp.contract_sha256(engine_plan_fingerprint)
      from public.frozen_order_plan
     where idempotency_key = 'accounting-contract:order-plan:s2'
  ),
  'the Core engine fingerprint hash covers its exact stored UTF-8 bytes'
);

select is(
  (
    pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:s2',
      'S2',
      pg_temp.contract_order_plan_text(
        'S2',
        'order-buy-1',
        'BUY',
        '10',
        pg_temp.contract_fee_schedule_terms()
      )
    )
  ).frozen_order_plan_id,
  (
    select frozen_order_plan_id
      from public.frozen_order_plan
     where idempotency_key = 'accounting-contract:order-plan:s2'
  ),
  'an exact canonical plan retry returns the original immutable plan'
);

select is(
  (
    select count(*)
      from public.frozen_order_plan
     where decision_id = '72000000-0000-4000-8000-000000000001'
       and stage = 'S2'
  ),
  1::bigint,
  'one decision stage cannot acquire a second frozen plan'
);

select is(
  (
    pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:s2:transport-retry',
      'S2',
      pg_temp.contract_order_plan_text(
        'S2',
        'order-buy-1',
        'BUY',
        '10',
        pg_temp.contract_fee_schedule_terms()
      )
    )
  ).frozen_order_plan_id,
  (
    select frozen_order_plan_id
      from public.frozen_order_plan
     where idempotency_key = 'accounting-contract:order-plan:s2'
  ),
  'the same decision-stage plan is deduplicated across a changed transport key'
);

select throws_ok(
  $$
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:s2',
      'S2',
      pg_temp.contract_order_plan_text(
        'S2',
        'order-buy-1',
        'BUY',
        '10',
        pg_temp.contract_fee_schedule_terms('0.005')
      )
    )
  $$,
  '23505',
  'frozen order plan identity was reused with different content',
  'the same plan identity cannot be retried with different frozen fee terms'
);

select throws_ok(
  $$
    select public.register_frozen_order_plan(
      'accounting-contract:order-plan:bad-hash',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      '70000000-0000-4000-8000-000000000001',
      '72000000-0000-4000-8000-000000000001',
      '72000000-0000-4000-8000-000000000002',
      'S1',
      (select planned_at from accounting_order_plan_context),
      (select planned_trade_date from accounting_order_plan_context),
      'twofold.frozen_order_plan/v1',
      pg_temp.contract_order_plan_text(
        'S1',
        'order-sell-bad-hash',
        'SELL',
        '10',
        pg_temp.contract_fee_schedule_terms()
      ),
      repeat('0', 64),
      'accounting-contract'
    )
  $$,
  '22023',
  'frozen order plan SHA256 does not match canonical bytes',
  'a caller cannot substitute a hash that does not cover exact plan bytes'
);

select throws_ok(
  $$
    with mismatched as (
      select jsonb_set(
        pg_temp.contract_order_plan_text(
          'S1',
          'order-sell-engine-hash',
          'SELL',
          '10',
          pg_temp.contract_fee_schedule_terms()
        )::jsonb,
        '{enginePlanFingerprintSha256}',
        to_jsonb(repeat('0', 64))
      )::text as plan_text
    )
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:engine-hash',
      'S1',
      mismatched.plan_text
    )
    from mismatched
  $$,
  '22023',
  'engine plan fingerprint SHA256 does not match its exact UTF-8 bytes',
  'the engine fingerprint digest cannot be detached from its exact bytes'
);

select throws_ok(
  $$
    with base as (
      select pg_temp.contract_order_plan_text(
        'S1',
        'order-sell-engine-number',
        'SELL',
        '10',
        pg_temp.contract_fee_schedule_terms()
      )::jsonb as wrapper
    ), numbered as (
      select
        wrapper,
        jsonb_set(
          (wrapper->>'enginePlanFingerprint')::jsonb,
          '{fillPriceScale}',
          '8'::jsonb
        )::text as engine_text
      from base
    ), rebound as (
      select jsonb_set(
        jsonb_set(
          wrapper,
          '{enginePlanFingerprint}',
          to_jsonb(engine_text)
        ),
        '{enginePlanFingerprintSha256}',
        to_jsonb(pg_temp.contract_sha256(engine_text))
      )::text as plan_text
      from numbered
    )
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:engine-number',
      'S1',
      rebound.plan_text
    )
    from rebound
  $$,
  '22023',
  'engine plan fingerprint must be the complete number-free Core payload without planFingerprint',
  'a JSON number hidden inside the engine fingerprint is rejected'
);

select throws_ok(
  $$
    with mismatched as (
      select jsonb_set(
        pg_temp.contract_order_plan_text(
          'S1',
          'order-sell-wrapper-scale',
          'SELL',
          '10',
          pg_temp.contract_fee_schedule_terms()
        )::jsonb,
        '{fillPriceScale}',
        '"9"'::jsonb
      )::text as plan_text
    )
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:wrapper-scale',
      'S1',
      mismatched.plan_text
    )
    from mismatched
  $$,
  '22023',
  'frozen wrapper identity or execution settings diverge from the Core engine fingerprint',
  'wrapper execution scales must exactly match the Core fingerprint'
);

select throws_ok(
  $$
    with mismatched as (
      select jsonb_set(
        pg_temp.contract_order_plan_text(
          'S1',
          'order-sell-wrapper-quantity',
          'SELL',
          '10',
          pg_temp.contract_fee_schedule_terms()
        )::jsonb,
        '{orders,0,quantity}',
        '"11"'::jsonb
      )::text as plan_text
    )
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:wrapper-quantity',
      'S1',
      mismatched.plan_text
    )
    from mismatched
  $$,
  '22023',
  'wrapper orders diverge from the ordered Core engine payload',
  'wrapper order fields cannot diverge from the corresponding Core order'
);

select throws_ok(
  $$
    with mismatched as (
      select jsonb_set(
        pg_temp.contract_order_plan_text(
          'S1',
          'order-sell-fee-hash',
          'SELL',
          '10',
          pg_temp.contract_fee_schedule_terms()
        )::jsonb,
        '{orders,0,feeTermsSha256}',
        to_jsonb(repeat('0', 64))
      )::text as plan_text
    )
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:fee-hash',
      'S1',
      mismatched.plan_text
    )
    from mismatched
  $$,
  '22023',
  'frozen order plan contains an invalid order or order inconsistent with its stage/date',
  'feeTermsSha256 must cover the exact frozen feeScheduleTerms bytes'
);

select throws_ok(
  $$
    with mismatched as (
      select jsonb_set(
        pg_temp.contract_order_plan_text(
          'S1',
          'order-sell-tax-rules',
          'SELL',
          '10',
          pg_temp.contract_fee_schedule_terms()
        )::jsonb,
        '{taxRulesetId}',
        '"wrong-tax-ruleset"'::jsonb
      )::text as plan_text
    )
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:tax-rules',
      'S1',
      mismatched.plan_text
    )
    from mismatched
  $$,
  '22023',
  'S1 wrapper and Core engine fingerprint have invalid or divergent tax rules',
  'S1 freezes the exact strict China-resident tax ruleset'
);

select throws_ok(
  $$
    with mismatched as (
      select jsonb_set(
        pg_temp.contract_order_plan_text(
          'S2',
          'order-buy-power',
          'BUY',
          '10',
          pg_temp.contract_fee_schedule_terms()
        )::jsonb,
        '{initialBuyingPower}',
        '"1002.3"'::jsonb
      )::text as plan_text
    )
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:buying-power',
      'S2',
      mismatched.plan_text
    )
    from mismatched
  $$,
  '22023',
  'S2 wrapper and Core engine fingerprint have invalid or divergent buying power',
  'S2 buying-power totals must exactly match the Core fingerprint'
);

select throws_ok(
  $$
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:late-buying-power-evidence',
      'S2',
      pg_temp.contract_order_plan_text(
        'S2',
        'order-buy-late-evidence',
        'BUY',
        '10',
        pg_temp.contract_fee_schedule_terms(),
        p_buying_power_visible_at => (
          select planned_at + interval '1 minute'
            from accounting_order_plan_context
        )
      )
    )
  $$,
  '22023',
  'S2 buying power evidence must be visible by planning and its totals must reconcile',
  'S2 cannot freeze buying power evidence that was not yet visible'
);

select throws_ok(
  $$
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:duplicate-order',
      'S1',
      pg_temp.contract_order_plan_text(
        'S1',
        'order-sell-duplicate',
        'SELL',
        '10',
        pg_temp.contract_fee_schedule_terms(),
        p_duplicate => true
      )
    )
  $$,
  '22023',
  'frozen order plan contains duplicate order IDs',
  'the wrapper and engine payload cannot repeat an order ID'
);

select throws_ok(
  $$
    with future_window as (
      select
        date_trunc(
          'second',
          clock_timestamp() + interval '1 hour'
        ) as planned_at,
        (clock_timestamp() at time zone 'UTC')::date + 2
          as planned_trade_date
    ), manifest as (
      select
        future_window.*,
        pg_temp.contract_order_plan_text(
          'S1',
          'order-sell-future-planned-at',
          'SELL',
          '10',
          pg_temp.contract_fee_schedule_terms(),
          p_planned_at => future_window.planned_at,
          p_planned_trade_date => future_window.planned_trade_date
        ) as plan_text
      from future_window
    )
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:future-planned-at',
      'S1',
      manifest.plan_text,
      manifest.planned_at,
      manifest.planned_trade_date
    )
    from manifest
  $$,
  '22023',
  'frozen order plan planned_at cannot be later than the database arrival time',
  'caller time cannot claim that a plan was frozen after its DB arrival'
);

select throws_ok(
  $$
    with entered_window as (
      select
        context.planned_at,
        (clock_timestamp() at time zone 'UTC')::date as planned_trade_date
      from accounting_order_plan_context as context
    ), manifest as (
      select
        entered_window.*,
        pg_temp.contract_order_plan_text(
          'S1',
          'order-sell-late-admission',
          'SELL',
          '10',
          pg_temp.contract_fee_schedule_terms(),
          p_planned_at => entered_window.planned_at,
          p_planned_trade_date => entered_window.planned_trade_date
        ) as plan_text
      from entered_window
    )
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:late-admission',
      'S1',
      manifest.plan_text,
      manifest.planned_at,
      manifest.planned_trade_date
    )
    from manifest
  $$,
  '22023',
  'frozen order plan admission has already entered its UTC trade date',
  'the trusted DB clock rejects a plan admitted on or after its UTC trade date'
);

select throws_ok(
  $$
    with numbered as (
      select jsonb_set(
        pg_temp.contract_order_plan_text(
          'S1',
          'order-sell-number',
          'SELL',
          '10',
          pg_temp.contract_fee_schedule_terms()
        )::jsonb,
        '{orders,0,quantity}',
        '10'::jsonb
      )::text as plan_text
    )
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:number',
      'S1',
      numbered.plan_text
    )
    from numbered
  $$,
  '22023',
  'frozen order plan must contain the complete string-safe wrapper envelope and no JSON numbers',
  'frozen order plans reject JSON number tokens at every depth'
);

select throws_ok(
  $$
    with mismatched as (
      select jsonb_set(
        pg_temp.contract_order_plan_text(
          'S1',
          'order-sell-date',
          'SELL',
          '10',
          pg_temp.contract_fee_schedule_terms()
        )::jsonb,
        '{plannedTradeDate}',
        to_jsonb(
          ((select planned_trade_date from accounting_order_plan_context) + 1)::text
        )
      )::text as plan_text
    )
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:date-mismatch',
      'S1',
      mismatched.plan_text
    )
    from mismatched
  $$,
  '22023',
  'frozen order plan manifest identity, stage, or dates do not match RPC arguments',
  'manifest plannedTradeDate cannot diverge from the frozen RPC date'
);

select throws_ok(
  $$
    with reversed as (
      select
        context.planned_trade_date,
        (
          context.planned_trade_date::text || 'T00:00:00.000Z'
        )::timestamptz as planned_at
      from accounting_order_plan_context as context
    ), manifest as (
      select
        reversed.*,
        pg_temp.contract_order_plan_text(
          'S1',
          'order-sell-time',
          'SELL',
          '10',
          pg_temp.contract_fee_schedule_terms(),
          p_planned_at => reversed.planned_at,
          p_planned_trade_date => reversed.planned_trade_date
        ) as plan_text
      from reversed
    )
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:time-reversal',
      'S1',
      manifest.plan_text,
      manifest.planned_at,
      manifest.planned_trade_date
    )
    from manifest
  $$,
  '22023',
  'frozen order plan must be recorded before its planned trade date in UTC',
  'a same-day or time-reversed plan cannot bypass the core next-session rule'
);

select throws_ok(
  $$
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:zero-quantity',
      'S1',
      pg_temp.contract_order_plan_text(
        'S1',
        'order-sell-zero',
        'SELL',
        '0',
        pg_temp.contract_fee_schedule_terms()
      )
    )
  $$,
  '22023',
  'frozen order plan contains an invalid order or order inconsistent with its stage/date',
  'a planned order cannot freeze a zero quantity'
);

select throws_ok(
  $$
    with unsupported as (
      select jsonb_set(
        pg_temp.contract_order_plan_text(
          'S1',
          'order-sell-model',
          'SELL',
          '10',
          pg_temp.contract_fee_schedule_terms()
        )::jsonb,
        '{executionModel}',
        '"BROKER_ACTUAL"'::jsonb
      )::text as plan_text
    )
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:unsupported-execution',
      'S1',
      unsupported.plan_text
    )
    from unsupported
  $$,
  '22023',
  'frozen order plan manifest identity, stage, or dates do not match RPC arguments',
  'this milestone fails closed on unsupported broker-actual execution'
);

select is(
  (
    pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:s1-noop',
      'S1',
      pg_temp.contract_order_plan_text(
        'S1',
        'unused-noop-order',
        'SELL',
        '1',
        pg_temp.contract_fee_schedule_terms(),
        true
      )
    )
  ).stage,
  'S1',
  'a complete canonical S1 no-op envelope may freeze orders=[]'
);

select is(
  (
    pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:s1-noop',
      'S1',
      pg_temp.contract_order_plan_text(
        'S1',
        'unused-noop-order',
        'SELL',
        '1',
        pg_temp.contract_fee_schedule_terms(),
        true
      )
    )
  ).frozen_order_plan_id,
  (
    select frozen_order_plan_id
      from public.frozen_order_plan
     where idempotency_key = 'accounting-contract:order-plan:s1-noop'
  ),
  'an empty no-op plan has the same exact-retry guarantee as a trading plan'
);

-- Simulate a plan that was durably admitted before its trade date but whose
-- successful response was lost. The direct fixture uses recorded_at from the
-- original pre-cutoff admission; the production table remains RPC-only.
create temporary table accounting_past_retry_context (
  decision_at timestamptz not null,
  opened_at timestamptz not null,
  accepted_at timestamptz not null,
  planned_at timestamptz not null,
  planned_trade_date date not null,
  submission_deadline_at timestamptz not null
) on commit drop;

insert into accounting_past_retry_context (
  decision_at,
  opened_at,
  accepted_at,
  planned_at,
  planned_trade_date,
  submission_deadline_at
)
select
  planned_at - interval '3 minutes',
  planned_at - interval '2 minutes',
  planned_at - interval '1 minute',
  planned_at,
  current_utc_date,
  clock_timestamp() + interval '1 hour'
from (
  select
    (clock_timestamp() at time zone 'UTC')::date as current_utc_date,
    (
      (
        (clock_timestamp() at time zone 'UTC')::date - 1
      )::text || 'T20:00:00.000Z'
    )::timestamptz as planned_at
) as past;

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
    '72000000-0000-4000-8000-000000000110',
    '72000000-0000-4000-8000-000000000120',
    'run',
    1,
    'decision.opened',
    '1',
    'accounting-contract:past-retry:decision-event',
    'worker',
    'accounting-contract',
    (select opened_at from accounting_past_retry_context),
    '{"fixture":"past-cutoff-exact-retry"}'::jsonb,
    '{}'::jsonb
  ),
  (
    '72000000-0000-4000-8000-000000000111',
    '72000000-0000-4000-8000-000000000120',
    'run',
    2,
    'decision.targets_accepted',
    '1',
    'accounting-contract:past-retry:submission-event',
    'worker',
    'accounting-contract',
    (select accepted_at from accounting_past_retry_context),
    '{"fixture":"past-cutoff-exact-retry"}'::jsonb,
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
) values (
  '72000000-0000-4000-8000-000000000112',
  'accounting-contract:past-retry:packet',
  '70000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000110',
  'decision_packet',
  'twofold-private-artifacts',
  'contract/accounting/past-retry-packet.json',
  'application/json',
  1,
  repeat('c', 64),
  'accounting-contract',
  '{}'::jsonb
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
  '72000000-0000-4000-8000-000000000101',
  'accounting-contract:past-retry:decision',
  '70000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000003',
  'accounting-contract-past-retry-root',
  '72000000-0000-4000-8000-000000000112',
  '72000000-0000-4000-8000-000000000013',
  '73000000-0000-4000-8000-000000000002',
  (select decision_at from accounting_past_retry_context),
  (select decision_at from accounting_past_retry_context),
  (select submission_deadline_at from accounting_past_retry_context),
  array['contract_fixture'],
  '72000000-0000-4000-8000-000000000110',
  1,
  (select opened_at from accounting_past_retry_context)
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
  'accounting-contract-past-retry-root',
  'accounting-contract:past-retry:root',
  '72000000-0000-4000-8000-000000000101',
  'accounting-contract-past-retry-root',
  null,
  'root',
  'accounting-contract-agent',
  'root',
  0,
  (select opened_at from accounting_past_retry_context),
  '72000000-0000-4000-8000-000000000110',
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
  '72000000-0000-4000-8000-000000000102',
  'accounting-contract:past-retry:submission',
  '72000000-0000-4000-8000-000000000101',
  'accounting-contract-past-retry-root',
  '72000000-0000-4000-8000-000000000112',
  repeat('c', 64),
  '[{"symbol":"TFLULU","target_weight_bps":"10000"}]'::jsonb,
  '0',
  'Past-cutoff exact retry fixture',
  repeat('d', 64),
  (select accepted_at from accounting_past_retry_context),
  '72000000-0000-4000-8000-000000000111',
  2,
  'accounting-contract'
);

with manifest as (
  select pg_temp.contract_order_plan_text(
    'S1',
    'unused-past-retry-order',
    'SELL',
    '1',
    pg_temp.contract_fee_schedule_terms(),
    p_noop => true,
    p_planned_at => context.planned_at,
    p_planned_trade_date => context.planned_trade_date,
    p_decision_id => '72000000-0000-4000-8000-000000000101',
    p_accepted_submission_id => '72000000-0000-4000-8000-000000000102'
  ) as plan_text
  from accounting_past_retry_context as context
)
insert into public.frozen_order_plan (
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
  recorded_by,
  recorded_at
)
select
  'accounting-contract:order-plan:past-cutoff-exact',
  account.strategy_account_id,
  '70000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000101',
  '72000000-0000-4000-8000-000000000102',
  'S1',
  context.planned_at,
  context.planned_trade_date,
  'twofold.frozen_order_plan/v1',
  manifest.plan_text,
  manifest.plan_text::jsonb,
  pg_temp.contract_sha256(manifest.plan_text),
  manifest.plan_text::jsonb->>'enginePlanFingerprint',
  manifest.plan_text::jsonb->>'enginePlanFingerprintSha256',
  'accounting-contract',
  context.planned_at
from manifest
cross join accounting_past_retry_context as context
cross join public.strategy_account as account
where account.idempotency_key = 'accounting-contract:account';

select is(
  (
    pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:past-cutoff-exact',
      'S1',
      pg_temp.contract_order_plan_text(
        'S1',
        'unused-past-retry-order',
        'SELL',
        '1',
        pg_temp.contract_fee_schedule_terms(),
        p_noop => true,
        p_planned_at => (
          select planned_at from accounting_past_retry_context
        ),
        p_planned_trade_date => (
          select planned_trade_date from accounting_past_retry_context
        ),
        p_decision_id => '72000000-0000-4000-8000-000000000101',
        p_accepted_submission_id =>
          '72000000-0000-4000-8000-000000000102'
      ),
      p_planned_at => (
        select planned_at from accounting_past_retry_context
      ),
      p_planned_trade_date => (
        select planned_trade_date from accounting_past_retry_context
      ),
      p_decision_id => '72000000-0000-4000-8000-000000000101',
      p_accepted_submission_id =>
        '72000000-0000-4000-8000-000000000102'
    )
  ).frozen_order_plan_id,
  (
    select frozen_order_plan_id
      from public.frozen_order_plan
     where idempotency_key =
       'accounting-contract:order-plan:past-cutoff-exact'
  ),
  'an exact retry remains recoverable after the trusted trade-date cutoff'
);

select throws_ok(
  $$
    select pg_temp.register_contract_order_plan(
      'accounting-contract:order-plan:past-cutoff-new',
      'S2',
      pg_temp.contract_order_plan_text(
        'S2',
        'order-buy-past-cutoff-new',
        'BUY',
        '10',
        pg_temp.contract_fee_schedule_terms(),
        p_planned_at => (
          select planned_at from accounting_past_retry_context
        ),
        p_planned_trade_date => (
          select planned_trade_date from accounting_past_retry_context
        ),
        p_decision_id => '72000000-0000-4000-8000-000000000101',
        p_accepted_submission_id =>
          '72000000-0000-4000-8000-000000000102'
      ),
      p_planned_at => (
        select planned_at from accounting_past_retry_context
      ),
      p_planned_trade_date => (
        select planned_trade_date from accounting_past_retry_context
      ),
      p_decision_id => '72000000-0000-4000-8000-000000000101',
      p_accepted_submission_id =>
        '72000000-0000-4000-8000-000000000102'
    )
  $$,
  '22023',
  'frozen order plan admission has already entered its UTC trade date',
  'a new plan remains fail-closed after the trusted trade-date cutoff'
);

select throws_ok(
  $$
    select public.register_position_lot_origin(
      'accounting-contract:lot:standalone-buy-fill',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      '71000000-0000-4000-8000-000000000001',
      'buy_fill',
      'orphan-order',
      '2026-08-21T14:30:00Z',
      '2026-08-21',
      1,
      100,
      0,
      'USD',
      'FIFO',
      '{}'::jsonb,
      'accounting-contract',
      repeat('e', 64)
    )
  $$,
  '0A000',
  'buy_fill lot origins require the future atomic settle_paper_fill boundary',
  'standalone RPC cannot create a buy_fill lot before atomic settlement exists'
);

select throws_ok(
  $$
    select public.append_accounting_transaction(
      'accounting-contract:journal:standalone-buy-fill',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      'buy_fill',
      'paper-fill:orphan-order',
      '2026-08-21T14:30:00Z',
      '2026-08-21',
      '2026-08-22',
      'Forbidden standalone fill journal',
      pg_temp.contract_buy_postings(),
      '{}'::jsonb,
      'accounting-contract'
    )
  $$,
  '0A000',
  'fill accounting requires the future atomic settle_paper_fill boundary',
  'standalone RPC cannot create buy/sell fill accounting before atomic settlement exists'
);

select throws_ok(
  $$
    select public.append_accounting_transaction(
      'accounting-contract:journal:standalone-sell-fill',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      'sell_fill',
      'paper-fill:orphan-sell-order',
      '2026-08-21T14:30:00Z',
      '2026-08-21',
      '2026-08-22',
      'Forbidden standalone sell fill journal',
      pg_temp.contract_buy_postings(),
      '{}'::jsonb,
      'accounting-contract'
    )
  $$,
  '0A000',
  'fill accounting requires the future atomic settle_paper_fill boundary',
  'standalone RPC also reserves sell_fill accounting for atomic settlement'
);

select ok(
  to_regclass('public.paper_fill') is null
  and not exists (
    select 1
      from pg_proc as procedure
      join pg_namespace as namespace
        on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.proname = 'register_paper_fill'
  )
  and exists (
    select 1
      from pg_proc as procedure
      join pg_namespace as namespace
        on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.proname = 'settle_paper_fill'
  ),
  'standalone paper fills stay absent while the later atomic settlement boundary exists'
);

select is(
  (
    public.register_position_lot_origin(
      'accounting-contract:lot:initial-lulu',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      '71000000-0000-4000-8000-000000000001',
      'initial_import',
      'broker-lot-lulu-1',
      '2026-08-21T14:30:00Z',
      '2026-08-21',
      10,
      100,
      2.29,
      'USD',
      'FIFO',
      '{"source":"verified-broker-import"}'::jsonb,
      'accounting-contract',
      repeat('b', 64)
    )
  ).tax_basis,
  1002.29::numeric,
  'the database generates 1002.29 tax basis from 1000 purchase price plus 2.29 buy fees'
);

select is(
  (
    select purchase_price_total
      from public.position_lot_origin
     where idempotency_key = 'accounting-contract:lot:initial-lulu'
  ),
  1000::numeric,
  'the original lot separately preserves its 1000 gross purchase price'
);

select is(
  (
    select lot_method
      from public.position_lot_origin
     where idempotency_key = 'accounting-contract:lot:initial-lulu'
  ),
  'FIFO',
  'the original lot freezes FIFO as the v1 cost method'
);

select is(
  (
    public.register_position_lot_origin(
      'accounting-contract:lot:initial-lulu',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      '71000000-0000-4000-8000-000000000001',
      'initial_import',
      'broker-lot-lulu-1',
      '2026-08-21T14:30:00Z',
      '2026-08-21',
      10,
      100,
      2.29,
      'USD',
      'FIFO',
      '{"source":"verified-broker-import"}'::jsonb,
      'accounting-contract',
      repeat('b', 64)
    )
  ).lot_origin_id,
  (
    select lot_origin_id
      from public.position_lot_origin
     where idempotency_key = 'accounting-contract:lot:initial-lulu'
  ),
  'an exact initial-lot retry returns the original lot'
);

select is(
  (
    select count(*)
      from public.position_lot_origin
     where strategy_account_id = (
       select strategy_account_id
         from public.strategy_account
        where idempotency_key = 'accounting-contract:account'
     )
       and origin_reference = 'broker-lot-lulu-1'
  ),
  1::bigint,
  'an exact initial-lot retry never creates a second lot'
);

select throws_ok(
  $$
    select public.register_position_lot_origin(
      'accounting-contract:lot:initial-lulu',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      '71000000-0000-4000-8000-000000000001',
      'initial_import',
      'broker-lot-lulu-1',
      '2026-08-21T14:30:00Z',
      '2026-08-21',
      10,
      101,
      2.29,
      'USD',
      'FIFO',
      '{"source":"verified-broker-import"}'::jsonb,
      'accounting-contract',
      repeat('b', 64)
    )
  $$,
  '23505',
  'position lot origin identity was reused with different content',
  'an existing lot cannot be retried with another purchase price'
);

select throws_ok(
  $$
    select public.register_position_lot_origin(
      'accounting-contract:lot:number-json',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      '71000000-0000-4000-8000-000000000001',
      'initial_import',
      'broker-lot-lulu-number-json',
      '2026-08-21T14:30:00Z',
      '2026-08-21',
      1,
      100,
      0,
      'USD',
      'FIFO',
      '{"source_row":1}'::jsonb,
      'accounting-contract',
      repeat('b', 64)
    )
  $$,
  '22023',
  'invalid FIFO position lot origin',
  'lot metadata also rejects JSON number tokens'
);

select is(
  (
    public.register_position_lot_origin(
      'accounting-contract:lot:full-product-scale',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      '71000000-0000-4000-8000-000000000001',
      'initial_import',
      'broker-lot-lulu-full-product-scale',
      '2026-08-21T14:30:01Z',
      '2026-08-21',
      1.000000000001,
      1.000000000001,
      0,
      'USD',
      'FIFO',
      '{"source":"precision-contract"}'::jsonb,
      'accounting-contract',
      repeat('d', 64)
    )
  ).tax_basis,
  1.000000000002000000000001::numeric,
  'generated tax basis preserves the full product scale of two 12-decimal inputs'
);

select is(
  (
    public.append_accounting_transaction(
      'accounting-contract:fill:lulu-1',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      'opening_balance',
      'provider-fill:lulu-1',
      '2026-08-21T14:30:00Z',
      '2026-08-21',
      '2026-08-22',
      'Buy TFLULU and recognize its broker fee',
      pg_temp.contract_buy_postings(),
      '{"provider":"contract-fixture"}'::jsonb,
      'accounting-contract'
    )
  ).transaction_type,
  'opening_balance',
  'append_accounting_transaction accepts the balanced 1000 plus 2.29 journal'
);

select is(
  (
    select count(*)
      from public.accounting_posting
     where accounting_transaction_id = (
       select accounting_transaction_id
         from public.accounting_transaction
        where idempotency_key = 'accounting-contract:fill:lulu-1'
     )
  ),
  3::bigint,
  'the balanced buy journal materializes all three postings atomically'
);

select is(
  (
    select sum(amount)
      from public.accounting_posting
     where accounting_transaction_id = (
       select accounting_transaction_id
         from public.accounting_transaction
        where idempotency_key = 'accounting-contract:fill:lulu-1'
     )
       and side = 'debit'
       and currency = 'USD'
  ),
  1002.29::numeric,
  'USD debits equal 1000 securities plus 2.29 fees'
);

select is(
  (
    select sum(amount)
      from public.accounting_posting
     where accounting_transaction_id = (
       select accounting_transaction_id
         from public.accounting_transaction
        where idempotency_key = 'accounting-contract:fill:lulu-1'
     )
       and side = 'credit'
       and currency = 'USD'
  ),
  1002.29::numeric,
  'USD credits equal the same 1002.29 cash reduction'
);

select ok(
  (
    select posting_manifest_sha256 ~ '^[0-9a-f]{64}$'
      from public.accounting_transaction
     where idempotency_key = 'accounting-contract:fill:lulu-1'
  ),
  'the admitted posting request has a durable content hash'
);

select is(
  (
    public.append_accounting_transaction(
      'accounting-contract:fill:lulu-1',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      'opening_balance',
      'provider-fill:lulu-1',
      '2026-08-21T14:30:00Z',
      '2026-08-21',
      '2026-08-22',
      'Buy TFLULU and recognize its broker fee',
      pg_temp.contract_buy_postings(),
      '{"provider":"contract-fixture"}'::jsonb,
      'accounting-contract'
    )
  ).accounting_transaction_id,
  (
    select accounting_transaction_id
      from public.accounting_transaction
     where idempotency_key = 'accounting-contract:fill:lulu-1'
  ),
  'an exact journal retry returns the original transaction'
);

select is(
  (
    public.append_accounting_transaction(
      'accounting-contract:fill:lulu-1:transport-retry',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      'opening_balance',
      'provider-fill:lulu-1',
      '2026-08-21T14:30:00Z',
      '2026-08-21',
      '2026-08-22',
      'Buy TFLULU and recognize its broker fee',
      pg_temp.contract_buy_postings(),
      '{"provider":"contract-fixture"}'::jsonb,
      'accounting-contract'
    )
  ).accounting_transaction_id,
  (
    select accounting_transaction_id
      from public.accounting_transaction
     where idempotency_key = 'accounting-contract:fill:lulu-1'
  ),
  'the same provider fill is deduplicated even after a transport key changes'
);

select is(
  (
    select count(*)
      from public.accounting_transaction
     where strategy_account_id = (
       select strategy_account_id
         from public.strategy_account
        where idempotency_key = 'accounting-contract:account'
     )
       and source_event_key = 'provider-fill:lulu-1'
  ),
  1::bigint,
  'repeated fill ingestion cannot create another journal transaction'
);

select throws_ok(
  $$
    select public.append_accounting_transaction(
      'accounting-contract:fill:lulu-1:conflict',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      'opening_balance',
      'provider-fill:lulu-1',
      '2026-08-21T14:30:00Z',
      '2026-08-21',
      '2026-08-22',
      'Changed fill content',
      '[
        {"account_code":"securities.inventory","side":"debit","amount":"1001","currency":"USD"},
        {"account_code":"expense.broker_fee","side":"debit","amount":"2.29","currency":"USD"},
        {"account_code":"asset.cash","side":"credit","amount":"1003.29","currency":"USD"}
      ]'::jsonb,
      '{"provider":"contract-fixture"}'::jsonb,
      'accounting-contract'
    )
  $$,
  '23505',
  'accounting transaction identity was reused with different content',
  'the same fill identity cannot be reused with changed balanced content'
);

select throws_ok(
  $$
    select public.append_accounting_transaction(
      'accounting-contract:fill:unbalanced',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      'opening_balance',
      'provider-fill:unbalanced',
      '2026-08-21T14:31:00Z',
      '2026-08-21',
      '2026-08-22',
      'Unbalanced fixture',
      '[
        {"account_code":"securities.inventory","side":"debit","amount":"1000","currency":"USD"},
        {"account_code":"asset.cash","side":"credit","amount":"999","currency":"USD"}
      ]'::jsonb,
      '{}'::jsonb,
      'accounting-contract'
    )
  $$,
  '22023',
  'postings are not balanced for currency USD',
  'an unbalanced journal is rejected before any durable write'
);

select is(
  (
    select count(*)
      from public.accounting_transaction
     where source_event_key = 'provider-fill:unbalanced'
  ),
  0::bigint,
  'a rejected unbalanced journal leaves no header behind'
);

select throws_ok(
  $$
    select public.append_accounting_transaction(
      'accounting-contract:fill:cross-currency',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      'adjustment',
      'provider-fill:cross-currency',
      '2026-08-21T14:32:00Z',
      '2026-08-21',
      null,
      'Cross-currency imbalance fixture',
      '[
        {"account_code":"asset.cash","side":"debit","amount":"100","currency":"USD"},
        {"account_code":"asset.cash","side":"credit","amount":"100","currency":"CNY"}
      ]'::jsonb,
      '{}'::jsonb,
      'accounting-contract'
    )
  $$,
  '22023',
  'postings are not balanced for currency CNY',
  'equal totals in different currencies do not bypass per-currency balancing'
);

select throws_ok(
  $$
    select public.append_accounting_transaction(
      'accounting-contract:fill:json-number',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      'adjustment',
      'provider-fill:json-number',
      '2026-08-21T14:33:00Z',
      '2026-08-21',
      null,
      'JSON number fixture',
      '[
        {"account_code":"asset.cash","side":"debit","amount":100,"currency":"USD"},
        {"account_code":"equity.opening","side":"credit","amount":100,"currency":"USD"}
      ]'::jsonb,
      '{}'::jsonb,
      'accounting-contract'
    )
  $$,
  '22023',
  'postings must be an array of at least two entries without JSON number tokens',
  'posting JSON forbids numeric tokens even when the journal would balance'
);

select throws_ok(
  $$
    select public.append_accounting_transaction(
      'accounting-contract:fill:noncanonical-decimal',
      (
        select strategy_account_id
          from public.strategy_account
         where idempotency_key = 'accounting-contract:account'
      ),
      'adjustment',
      'provider-fill:noncanonical-decimal',
      '2026-08-21T14:34:00Z',
      '2026-08-21',
      null,
      'Noncanonical decimal fixture',
      '[
        {"account_code":"asset.cash","side":"debit","amount":"1.00","currency":"USD"},
        {"account_code":"equity.opening","side":"credit","amount":"1.00","currency":"USD"}
      ]'::jsonb,
      '{}'::jsonb,
      'accounting-contract'
    )
  $$,
  '22023',
  'posting entries do not match the canonical posting schema',
  'workers must normalize 1.00 to canonical 1 before append and exact retry'
);

select throws_ok(
  $$update public.run_manifest set recorded_by = 'tampered'$$,
  '55000',
  'run_manifest is append-only; append a compensating or superseding record instead',
  'run manifests are immutable'
);

select throws_ok(
  $$update public.position_lot_origin set allocated_buy_fees = 0$$,
  '55000',
  'position_lot_origin is append-only; append a compensating or superseding record instead',
  'original FIFO lots are immutable'
);

select throws_ok(
  $$update public.accounting_transaction set description = 'tampered'$$,
  '55000',
  'accounting_transaction is append-only; append a compensating or superseding record instead',
  'journal headers are immutable'
);

select throws_ok(
  $$update public.accounting_posting set memo = 'tampered'$$,
  '55000',
  'accounting_posting is append-only; append a compensating or superseding record instead',
  'journal postings are immutable'
);

select throws_ok(
  $$update public.frozen_order_plan set stage = 'S2'$$,
  '55000',
  'frozen_order_plan is append-only; append a compensating or superseding record instead',
  'frozen order plans are immutable'
);

select is(
  (
    select count(*)
      from pg_proc as procedure
      join pg_namespace as namespace
        on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.proname in (
         'register_run_manifest',
         'register_instrument',
         'register_instrument_symbol_version',
         'register_strategy_account',
         'register_position_lot_origin',
         'append_accounting_transaction',
         'register_frozen_order_plan'
       )
       and has_function_privilege(
         'anon',
         procedure.oid,
         'EXECUTE'
       )
  ),
  0::bigint,
  'anon cannot execute any accounting-kernel write RPC'
);

select is(
  (
    select count(*)
      from pg_proc as procedure
      join pg_namespace as namespace
        on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.proname in (
         'register_run_manifest',
         'register_instrument',
         'register_instrument_symbol_version',
         'register_strategy_account',
         'register_position_lot_origin',
         'append_accounting_transaction',
         'register_frozen_order_plan'
       )
       and has_function_privilege(
         'authenticated',
         procedure.oid,
         'EXECUTE'
       )
  ),
  0::bigint,
  'authenticated clients cannot execute any accounting-kernel write RPC'
);

set local role service_role;

select throws_ok(
  $$
    select public.append_accounting_transaction(
      'accounting-contract:journal:forbidden-negative-cash',
      '00000000-0000-4000-8000-000000000001',
      'opening_balance',
      'opening:forbidden-negative-cash',
      '2026-08-21T14:30:00Z',
      '2026-08-21',
      null,
      'Would create negative cash if the generic primitive were exposed',
      '[
        {
          "account_code":"equity.opening",
          "side":"debit",
          "amount":"100",
          "currency":"USD"
        },
        {
          "account_code":"asset.cash",
          "side":"credit",
          "amount":"100",
          "currency":"USD"
        }
      ]'::jsonb,
      '{}'::jsonb,
      'accounting-contract'
    )
  $$,
  '42501',
  'permission denied for function append_accounting_transaction',
  'service_role cannot use the generic journal primitive to create negative cash'
);

reset role;

select is(
  (
    select count(*)
      from pg_proc as procedure
      join pg_namespace as namespace
        on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.proname in (
         'register_run_manifest',
         'register_instrument',
         'register_instrument_symbol_version',
         'register_strategy_account',
         'register_position_lot_origin',
         'append_accounting_transaction',
         'register_frozen_order_plan'
       )
       and has_function_privilege(
         'service_role',
         procedure.oid,
         'EXECUTE'
       )
  ),
  5::bigint,
  '009 removes standalone lot admission, leaving five safe accounting RPCs'
);

select is(
  (
    select count(*)
      from pg_class as relation
      join pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      cross join (
        values
          ('SELECT'),
          ('INSERT'),
          ('UPDATE'),
          ('DELETE'),
          ('TRUNCATE'),
          ('REFERENCES'),
          ('TRIGGER')
      ) as privilege(name)
     where namespace.nspname = 'public'
       and relation.relname in (
         'run_manifest',
         'instrument',
         'instrument_symbol_version',
         'strategy_account',
         'position_lot_origin',
         'accounting_transaction',
         'accounting_posting',
         'frozen_order_plan'
       )
       and has_table_privilege(
         'authenticated',
         relation.oid,
         privilege.name
       )
  ),
  0::bigint,
  'authenticated has no direct privilege on accounting-kernel tables'
);

select is(
  (
    select count(*)
      from pg_class as relation
      join pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      cross join (
        values
          ('INSERT'),
          ('UPDATE'),
          ('DELETE'),
          ('TRUNCATE'),
          ('REFERENCES'),
          ('TRIGGER')
      ) as privilege(name)
     where namespace.nspname = 'public'
       and relation.relname in (
         'run_manifest',
         'instrument',
         'instrument_symbol_version',
         'strategy_account',
         'position_lot_origin',
         'accounting_transaction',
         'accounting_posting',
         'frozen_order_plan'
       )
       and has_table_privilege(
         'service_role',
         relation.oid,
         privilege.name
       )
  ),
  0::bigint,
  'service_role cannot bypass RPCs with direct table mutation'
);

select is(
  (
    select count(*)
      from pg_class as relation
      join pg_namespace as namespace
        on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relname in (
         'run_manifest',
         'instrument',
         'instrument_symbol_version',
         'strategy_account',
         'position_lot_origin',
         'accounting_transaction',
         'accounting_posting',
         'frozen_order_plan'
       )
       and has_table_privilege('service_role', relation.oid, 'SELECT')
  ),
  8::bigint,
  'service_role can read all eight immutable accounting tables'
);

select * from finish();
rollback;
