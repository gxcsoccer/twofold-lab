-- Keyless Arena decision thin-slice contract tests. Provider-shaped values are
-- fixtures only; the enclosing transaction leaves no durable rows.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
set local timezone = 'UTC';

create or replace function pg_temp.arena_fact(
  p_symbol text,
  p_open text,
  p_high text,
  p_low text,
  p_close text
)
returns jsonb
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'symbol', p_symbol,
    'timeframe', '1Day',
    'barStart', '2026-08-21T04:00:00.000Z',
    'barDate', '2026-08-21',
    'currency', 'USD',
    'openPrice', p_open,
    'highPrice', p_high,
    'lowPrice', p_low,
    'closePrice', p_close,
    'volume', '1000000',
    'tradeCount', '20000',
    'vwap', p_close,
    'factSha256', encode(
      digest(
        p_symbol || chr(31)
        || '1Day' || chr(31)
        || '2026-08-21T04:00:00.000Z' || chr(31)
        || '2026-08-21' || chr(31)
        || 'USD' || chr(31)
        || p_open || chr(31)
        || p_high || chr(31)
        || p_low || chr(31)
        || p_close || chr(31)
        || '1000000' || chr(31)
        || '20000' || chr(31)
        || p_close || chr(31)
        || 'arena-contract-normalizer-v1',
        'sha256'
      ),
      'hex'
    )
  )
$$;

create or replace function pg_temp.arena_facts()
returns jsonb
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_array(
    pg_temp.arena_fact('LULU', '191.1', '196.2', '190.5', '195.3'),
    pg_temp.arena_fact('SPY', '640.1', '644.2', '639.5', '643.3')
  )
$$;

create or replace function pg_temp.arena_fact_manifest(p_facts jsonb)
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

create temporary table arena_contract_context (
  opened_at timestamptz not null,
  decision_at timestamptz not null,
  deadline_at timestamptz not null
) on commit drop;

insert into arena_contract_context (opened_at, decision_at, deadline_at)
select
  base_time + interval '1 minute',
  base_time,
  base_time + interval '11 minutes'
from (
  select greatest(
    clock_timestamp(),
    '2026-08-23T00:11:00Z'::timestamptz
  ) as base_time
) as clock_fence;

create or replace function pg_temp.open_arena_contract_invocation(
  p_idempotency_key text,
  p_decision_id uuid,
  p_root_session_id text,
  p_packet_key text,
  p_expected_stream_seq bigint
)
returns public.decision_invocation
language sql
volatile
set search_path = public, extensions, pg_temp
as $$
  select public.open_decision_invocation(
    p_idempotency_key,
    p_decision_id,
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002',
    p_expected_stream_seq,
    p_root_session_id,
    'twofold-root',
    (
      select artifact_id
        from public.artifact_metadata
       where idempotency_key = p_packet_key
    ),
    (
      select artifact_id
        from public.artifact_metadata
       where idempotency_key = 'arena:bundle'
    ),
    (
      select snapshot_id
        from public.market_snapshot
       where idempotency_key = 'arena:snapshot'
    ),
    (select decision_at from arena_contract_context),
    '2026-08-23T00:10:00Z',
    (select deadline_at from arena_contract_context),
    array['weekly'],
    (select opened_at from arena_contract_context),
    'arena-contract'
  )
$$;

create or replace function pg_temp.accept_arena_contract_targets(
  p_idempotency_key text,
  p_submission_id uuid,
  p_root_session_id text,
  p_targets jsonb,
  p_cash_weight_bps text,
  p_packet_sha256 text,
  p_expected_stream_seq bigint
)
returns public.accepted_target_submission
language sql
volatile
set search_path = public, extensions, pg_temp
as $$
  select public.accept_portfolio_targets(
    p_idempotency_key,
    p_submission_id,
    p_root_session_id,
    (
      select artifact_id
        from public.artifact_metadata
       where idempotency_key = 'arena:packet'
    ),
    p_packet_sha256,
    p_targets,
    p_cash_weight_bps,
    'Contract target',
    (select opened_at + interval '2 minutes' from arena_contract_context),
    p_expected_stream_seq,
    'arena-contract'
  )
$$;

select plan(46);

select has_table('public', 'decision_invocation', 'decision_invocation exists');
select has_table('public', 'agent_session_lineage', 'agent_session_lineage exists');
select has_table(
  'public',
  'accepted_target_submission',
  'accepted_target_submission exists'
);
select ok(
  to_regclass('public.model_usage_root_attribution') is not null,
  'model usage root-attribution view exists'
);

select is(
  (
    public.register_data_source_version(
      'alpaca',
      'us_stock_daily_bars',
      'arena-contract-sip-v1',
      'https://data.alpaca.markets',
      'sip',
      'raw',
      '1Day',
      'arena-contract-normalizer-v1',
      'private-research',
      repeat('a', 64),
      '2026-08-23T00:00:00Z'
    )
  ).provider,
  'alpaca',
  'the Arena contract registers a frozen real-provider shape'
);

select is(
  (
    public.register_market_delivery(
      'arena:delivery',
      (
        select source_version_id
          from public.data_source_version
         where version_key = 'arena-contract-sip-v1'
      ),
      repeat('b', 64),
      'arena-provider-request',
      200,
      '2026-08-23T00:09:59Z',
      '2026-08-23T00:09:58Z',
      '2026-08-23T00:10:00Z',
      'twofold-private-artifacts',
      'raw/alpaca/cc/' || repeat('c', 64) || '.json',
      'application/json',
      512,
      repeat('c', 64),
      pg_temp.arena_fact_manifest(pg_temp.arena_facts()),
      null,
      null,
      pg_temp.arena_facts()
    )
  ).http_status,
  200,
  'the Arena contract registers one immutable market observation'
);

select is(
  (
    public.seal_market_snapshot(
      'arena:snapshot',
      (
        select source_version_id
          from public.data_source_version
         where version_key = 'arena-contract-sip-v1'
      ),
      'market_close',
      '2026-08-23T00:10:00Z',
      '2026-08-21',
      array['LULU', 'SPY'],
      'arena-contract-selection-v1'
    )
  ).snapshot_kind,
  'market_close',
  'the decision fixture uses a sealed point-in-time market snapshot'
);

select is(
  (
    public.register_artifact(
      'arena:packet',
      '50000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000002',
      null,
      'decision_packet',
      'twofold-private-artifacts',
      'packets/' || repeat('e', 64) || '.json',
      'application/json',
      512,
      repeat('e', 64),
      'arena-contract',
      jsonb_build_object(
        'schema', 'twofold.decision_packet/v1',
        'decisionId', '50000000-0000-4000-8000-000000000003',
        'marketSnapshotId', (
          select snapshot_id::text
            from public.market_snapshot
           where idempotency_key = 'arena:snapshot'
        ),
        'marketManifestSha256', (
          select manifest_sha256
            from public.market_snapshot
           where idempotency_key = 'arena:snapshot'
        )
      )
    )
  ).artifact_kind,
  'decision_packet',
  'the packet reuses immutable artifact_metadata'
);

select is(
  (
    public.register_artifact(
      'arena:bundle',
      null,
      '50000000-0000-4000-8000-000000000002',
      null,
      'dsh_agent_bundle_manifest',
      'twofold-private-artifacts',
      'bundles/' || repeat('f', 64) || '.json',
      'application/json',
      512,
      repeat('f', 64),
      'arena-contract',
      jsonb_build_object(
        'schema', 'twofold.dsh_agent_bundle/v1',
        'preset', 'twofold-orchestrator'
      )
    )
  ).artifact_kind,
  'dsh_agent_bundle_manifest',
  'the invocation binds an immutable full-Agent Bundle manifest'
);

select is(
  (
    public.register_artifact(
      'arena:bad-packet',
      '50000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000002',
      null,
      'decision_packet',
      'twofold-private-artifacts',
      'packets/' || repeat('1', 64) || '.json',
      'application/json',
      512,
      repeat('1', 64),
      'arena-contract',
      jsonb_build_object(
        'schema', 'twofold.decision_packet/v1',
        'decisionId', '50000000-0000-4000-8000-000000000006',
        'marketSnapshotId', (
          select snapshot_id::text
            from public.market_snapshot
           where idempotency_key = 'arena:snapshot'
        ),
        'marketManifestSha256', repeat('0', 64)
      )
    )
  ).artifact_kind,
  'decision_packet',
  'a mismatched packet fixture is available for the fail-closed contract'
);

select is(
  (
    pg_temp.open_arena_contract_invocation(
      'arena:invocation',
      '50000000-0000-4000-8000-000000000003',
      'arena-root-1',
      'arena:packet',
      0
    )
  ).source_stream_seq,
  1::bigint,
  'opening an invocation appends and returns run stream sequence one'
);

select ok(
  exists (
    select 1
      from public.decision_invocation as invocation
      join public.event_stream as event
        on event.event_id = invocation.source_event_id
       and event.stream_seq = invocation.source_stream_seq
     where invocation.decision_id = '50000000-0000-4000-8000-000000000003'
       and event.event_type = 'decision.invocation_opened'
  ),
  'the invocation returns an event ID that resolves to its authoritative event'
);

select is(
  (
    pg_temp.open_arena_contract_invocation(
      'arena:invocation',
      '50000000-0000-4000-8000-000000000003',
      'arena-root-1',
      'arena:packet',
      0
    )
  ).decision_id,
  '50000000-0000-4000-8000-000000000003'::uuid,
  'an exact invocation retry returns the original row before stream-head checking'
);

select throws_ok(
  $$
    select pg_temp.open_arena_contract_invocation(
      'arena:bad-invocation',
      '50000000-0000-4000-8000-000000000006',
      'arena-root-bad',
      'arena:bad-packet',
      1
    )
  $$,
  '22023',
  'decision packet artifact does not match invocation scope or market snapshot',
  'a packet whose manifest hash does not match the bound snapshot is rejected'
);

select is(
  (
    select decision_id
      from public.agent_session_lineage
     where harness_session_id = 'arena-root-1'
  ),
  '50000000-0000-4000-8000-000000000003'::uuid,
  'opening the invocation atomically binds its root Harness Session'
);

select is(
  (
    select session.source_event_id
      from public.agent_session_lineage as session
     where session.harness_session_id = 'arena-root-1'
  ),
  (
    select invocation.source_event_id
      from public.decision_invocation as invocation
     where invocation.decision_id = '50000000-0000-4000-8000-000000000003'
  ),
  'the root binding and invocation share one authoritative event'
);

select throws_ok(
  $$
    select public.register_descendant_session(
      'arena:child:stale',
      'arena-root-1',
      'arena-root-1',
      'arena-child-stale',
      'researcher',
      'root/research-stale',
      (select opened_at + interval '1 minute' from arena_contract_context),
      0,
      'arena-contract'
    )
  $$,
  '40001',
  'stream head conflict for 50000000-0000-4000-8000-000000000001',
  'descendant registration fails closed on stale optimistic stream sequence'
);

select is(
  (
    public.register_descendant_session(
      'arena:child:1',
      'arena-root-1',
      'arena-root-1',
      'arena-child-1',
      'researcher',
      'root/research-1',
      (select opened_at + interval '1 minute' from arena_contract_context),
      1,
      'arena-contract'
    )
  ).source_stream_seq,
  2::bigint,
  'a valid descendant append returns the new run stream sequence'
);

select is(
  (
    select root_harness_session_id
      from public.agent_session_lineage
     where harness_session_id = 'arena-child-1'
  ),
  'arena-root-1',
  'the descendant is durably attributed to the invocation root'
);

select is(
  (
    public.register_model_usage(
      'arena:model-usage:child',
      '50000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000003',
      'arena-child-1',
      0,
      0,
      0,
      'deepseek-official',
      'deepseek-v4-pro',
      (select opened_at + interval '1 minute' from arena_contract_context),
      (select opened_at + interval '1 minute 1 second' from arena_contract_context),
      'provider_unreported',
      'provider_unreported',
      null,
      null,
      null,
      null,
      null,
      'arena-contract'
    )
  ).harness_session_id,
  'arena-child-1',
  'existing model usage registration remains backward-compatible'
);

select is(
  (
    select root_harness_session_id
      from public.model_usage_root_attribution
     where idempotency_key = 'arena:model-usage:child'
  ),
  'arena-root-1',
  'the lineage view attributes descendant usage to the root without a usage FK'
);

select throws_ok(
  $$
    select pg_temp.accept_arena_contract_targets(
      'arena:submission:child',
      '50000000-0000-4000-8000-000000000004',
      'arena-child-1',
      '[{"symbol":"LULU","target_weight_bps":"5000"}]'::jsonb,
      '5000',
      repeat('e', 64),
      2
    )
  $$,
  'P0002',
  'only the bound root Harness Session may submit portfolio targets',
  'a descendant cannot submit a final target portfolio'
);

select throws_ok(
  $$
    select pg_temp.accept_arena_contract_targets(
      'arena:submission:bad-total',
      '50000000-0000-4000-8000-000000000004',
      'arena-root-1',
      '[{"symbol":"LULU","target_weight_bps":"5000"}]'::jsonb,
      '4999',
      repeat('e', 64),
      2
    )
  $$,
  '22023',
  'target weights plus cash weight must total exactly 10000 basis points',
  'target and cash weights must satisfy the exact 10000 bps fence'
);

select throws_ok(
  $$
    select pg_temp.accept_arena_contract_targets(
      'arena:submission:ineligible',
      '50000000-0000-4000-8000-000000000004',
      'arena-root-1',
      '[{"symbol":"MU","target_weight_bps":"5000"}]'::jsonb,
      '5000',
      repeat('e', 64),
      2
    )
  $$,
  '22023',
  'targets contain a symbol outside the bound market snapshot',
  'a symbol absent from the bound eligible snapshot is rejected'
);

select throws_ok(
  $$
    select pg_temp.accept_arena_contract_targets(
      'arena:submission:stale-hash',
      '50000000-0000-4000-8000-000000000004',
      'arena-root-1',
      '[{"symbol":"LULU","target_weight_bps":"5000"}]'::jsonb,
      '5000',
      repeat('0', 64),
      2
    )
  $$,
  '22023',
  'packet artifact id or SHA-256 fence does not match the root invocation',
  'a stale packet SHA-256 cannot be submitted'
);

select is(
  (
    pg_temp.accept_arena_contract_targets(
      'arena:submission:accepted',
      '50000000-0000-4000-8000-000000000004',
      'arena-root-1',
      '[{"symbol":"SPY","target_weight_bps":"2500"},{"symbol":"LULU","target_weight_bps":"5000"}]'::jsonb,
      '2500',
      repeat('e', 64),
      2
    )
  ).source_stream_seq,
  3::bigint,
  'the accepted root submission appends and returns stream sequence three'
);

select ok(
  exists (
    select 1
      from public.accepted_target_submission as submission
      join public.event_stream as event
        on event.event_id = submission.source_event_id
       and event.stream_seq = submission.source_stream_seq
     where submission.submission_id = '50000000-0000-4000-8000-000000000004'
       and event.event_type = 'decision.targets_accepted'
  ),
  'the accepted submission returns its authoritative event ID'
);

select is(
  (
    select targets->0->>'symbol'
      from public.accepted_target_submission
     where submission_id = '50000000-0000-4000-8000-000000000004'
  ),
  'LULU',
  'accepted targets are canonicalized into stable symbol order'
);

select is(
  (
    pg_temp.accept_arena_contract_targets(
      'arena:submission:accepted',
      '50000000-0000-4000-8000-000000000004',
      'arena-root-1',
      '[{"symbol":"SPY","target_weight_bps":"2500"},{"symbol":"LULU","target_weight_bps":"5000"}]'::jsonb,
      '2500',
      repeat('e', 64),
      2
    )
  ).submission_id,
  '50000000-0000-4000-8000-000000000004'::uuid,
  'an exact accepted-submission retry returns the original row'
);

select throws_ok(
  $$
    select pg_temp.accept_arena_contract_targets(
      'arena:submission:second-key',
      '50000000-0000-4000-8000-000000000005',
      'arena-root-1',
      '[{"symbol":"LULU","target_weight_bps":"5000"},{"symbol":"SPY","target_weight_bps":"2500"}]'::jsonb,
      '2500',
      repeat('e', 64),
      3
    )
  $$,
  '23505',
  'decision invocation already has an accepted target submission',
  'a decision invocation accepts exactly one submission across idempotency keys'
);

select is(
  (
    select max(stream_seq)
      from public.event_stream
     where stream_id = '50000000-0000-4000-8000-000000000001'
  ),
  3::bigint,
  'rejected attempts and exact retries do not append business events'
);

create temporary table late_arena_context (
  opened_at timestamptz not null,
  deadline_at timestamptz not null
) on commit drop;

insert into late_arena_context (opened_at, deadline_at)
select arrived_at, arrived_at + interval '1 second'
from (select clock_timestamp() as arrived_at) as clock_fence;

select is(
  (
    public.register_artifact(
      'arena:late-packet',
      '50000000-0000-4000-8000-000000000009',
      '50000000-0000-4000-8000-000000000002',
      null,
      'decision_packet',
      'twofold-private-artifacts',
      'packets/' || repeat('d', 64) || '.json',
      'application/json',
      512,
      repeat('d', 64),
      'arena-contract',
      jsonb_build_object(
        'schema', 'twofold.decision_packet/v1',
        'decisionId', '50000000-0000-4000-8000-000000000008',
        'marketSnapshotId', (
          select snapshot_id::text
            from public.market_snapshot
           where idempotency_key = 'arena:snapshot'
        ),
        'marketManifestSha256', (
          select manifest_sha256
            from public.market_snapshot
           where idempotency_key = 'arena:snapshot'
        )
      )
    )
  ).artifact_kind,
  'decision_packet',
  'a separate packet fixture is available for database-arrival deadline testing'
);

select is(
  (
    public.open_decision_invocation(
      'arena:late-invocation',
      '50000000-0000-4000-8000-000000000008',
      '50000000-0000-4000-8000-000000000009',
      '50000000-0000-4000-8000-000000000002',
      0,
      'arena-root-late',
      'twofold-root',
      (
        select artifact_id
          from public.artifact_metadata
         where idempotency_key = 'arena:late-packet'
      ),
      (
        select artifact_id
          from public.artifact_metadata
         where idempotency_key = 'arena:bundle'
      ),
      (
        select snapshot_id
          from public.market_snapshot
         where idempotency_key = 'arena:snapshot'
      ),
      (select opened_at from late_arena_context),
      '2026-08-23T00:10:00Z',
      (select deadline_at from late_arena_context),
      array['deadline-test'],
      (select opened_at from late_arena_context),
      'arena-contract'
    )
  ).source_stream_seq,
  1::bigint,
  'the deadline fixture opens a separate one-event invocation'
);

do $$
begin
  perform pg_sleep(1.1);
end;
$$;

select throws_ok(
  $test$
    select public.accept_portfolio_targets(
      'arena:late-submission',
      '50000000-0000-4000-8000-000000000010',
      'arena-root-late',
      (
        select artifact_id
          from public.artifact_metadata
         where idempotency_key = 'arena:late-packet'
      ),
      repeat('d', 64),
      '[{"symbol":"SPY","target_weight_bps":"5000"}]'::jsonb,
      '5000',
      'Late contract target',
      (select opened_at + interval '500 milliseconds' from late_arena_context),
      1,
      'arena-contract'
    )
  $test$,
  '22023',
  'target submission reached the database after the invocation deadline',
  'a client timestamp inside the window cannot bypass the database arrival deadline'
);

select is(
  (
    select max(stream_seq)
      from public.event_stream
     where stream_id = '50000000-0000-4000-8000-000000000009'
  ),
  1::bigint,
  'a database-late submission rolls back its business event atomically'
);

select throws_ok(
  $$update public.decision_invocation set opened_at = opened_at + interval '1 second'$$,
  '55000',
  'decision_invocation is append-only; append a compensating or superseding record instead',
  'decision invocations are immutable'
);

select throws_ok(
  $$update public.agent_session_lineage set agent_identity = 'changed'$$,
  '55000',
  'agent_session_lineage is append-only; append a compensating or superseding record instead',
  'Session lineage is immutable'
);

select throws_ok(
  $$update public.accepted_target_submission set cash_weight_bps = '10000'$$,
  '55000',
  'accepted_target_submission is append-only; append a compensating or superseding record instead',
  'accepted target submissions are immutable'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.open_decision_invocation(text,uuid,uuid,uuid,bigint,text,text,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,text[],timestamp with time zone,text)',
    'EXECUTE'
  ),
  'anon cannot open a decision invocation'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.open_decision_invocation(text,uuid,uuid,uuid,bigint,text,text,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,text[],timestamp with time zone,text)',
    'EXECUTE'
  ),
  'authenticated clients cannot open a decision invocation'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.accept_portfolio_targets(text,uuid,text,uuid,text,jsonb,text,text,timestamp with time zone,bigint,text)',
    'EXECUTE'
  ),
  'authenticated clients cannot accept portfolio targets'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.open_decision_invocation(text,uuid,uuid,uuid,bigint,text,text,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,text[],timestamp with time zone,text)',
    'EXECUTE'
  ),
  'service_role can open a decision invocation'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.register_descendant_session(text,text,text,text,text,text,timestamp with time zone,bigint,text)',
    'EXECUTE'
  ),
  'service_role can register descendant lineage'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.accept_portfolio_targets(text,uuid,text,uuid,text,jsonb,text,text,timestamp with time zone,bigint,text)',
    'EXECUTE'
  ),
  'service_role can accept the single root submission'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'public.decision_invocation',
    'SELECT'
  ),
  'new Arena evidence tables do not add another authenticated global read'
);

select ok(
  has_table_privilege(
    'service_role',
    'public.model_usage_root_attribution',
    'SELECT'
  ),
  'service_role can read the root-attribution view'
);

select * from finish();
rollback;
