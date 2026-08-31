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

create or replace function pg_temp.accept_arena_contract_targets_evidenced(
  p_idempotency_key text,
  p_submission_id uuid,
  p_root_session_id text,
  p_targets jsonb,
  p_cash_weight_bps text,
  p_packet_sha256 text,
  p_expected_stream_seq bigint
)
returns public.accepted_target_submission
language plpgsql
volatile
set search_path = public, extensions, pg_temp
as $$
declare
  v_invocation public.decision_invocation%rowtype;
  v_snapshot public.market_snapshot%rowtype;
  v_accepted_at timestamptz := (
    select opened_at + interval '2 minutes' from arena_contract_context
  );
  v_targets jsonb;
  v_decision jsonb;
  v_decision_sha text;
  v_input_age text;
  v_stable_window text;
  v_evidence_payload jsonb;
  v_evidence jsonb;
  v_evidence_sha text;
  v_canonical text;
  v_artifact_sha text;
begin
  select * into strict v_invocation from public.decision_invocation
   where root_harness_session_id = p_root_session_id;
  select * into strict v_snapshot from public.market_snapshot
   where snapshot_id = v_invocation.market_snapshot_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'symbol', item->>'symbol',
    'targetWeightBps', item->>'target_weight_bps'
  ) order by (item->>'symbol') collate "C"), '[]'::jsonb)
    into v_targets
    from jsonb_array_elements(p_targets) as target(item);
  v_decision := jsonb_build_object(
    'schema', 'twofold.portfolio_decision_evidence/v1',
    'decisionRef', v_invocation.decision_id::text,
    'policyRef', 'agent-bundle:arena-contract',
    'evidenceSnapshotId', v_invocation.market_snapshot_id::text,
    'targets', v_targets,
    'cashWeightBps', p_cash_weight_bps
  );
  v_decision_sha := encode(
    digest(convert_to(v_decision::text, 'UTF8'), 'sha256'), 'hex'
  );
  v_decision := v_decision || jsonb_build_object(
    'decisionSha256', v_decision_sha
  );
  v_input_age := (
    extract(epoch from (v_accepted_at - v_invocation.data_cutoff_at)) * 1000
  )::bigint::text;
  v_stable_window := (
    extract(epoch from (v_accepted_at - v_snapshot.sealed_at)) * 1000
  )::bigint::text;
  v_evidence_payload := jsonb_build_object(
    'schema', 'twofold.decision_admission_evidence/v1',
    'decision', v_decision,
    'evidenceSnapshotId', v_invocation.market_snapshot_id::text,
    'observedAt', to_char(v_accepted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'dataCutoffAt', to_char(v_invocation.data_cutoff_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evidenceSealedAt', to_char(v_snapshot.sealed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'policy', jsonb_build_object(
      'policyRef', 'twofold.arena_submission_admission/v1',
      'maxInputAgeMs', v_input_age,
      'maxMarketJumpBps', '10000',
      'minimumStableWindowMs', '0',
      'maxTargetDeltaBps', '10000',
      'maxCooldownRemainingMs', '0'
    ),
    'metrics', jsonb_build_object(
      'inputAgeMs', v_input_age,
      'marketJumpBps', '220',
      'stableWindowMs', v_stable_window,
      'maxTargetDeltaBps', '10000',
      'cooldownRemainingMs', '0'
    ),
    'guardAction', 'ALLOW',
    'reasons', jsonb_build_array('ALL_GUARDS_PASSED')
  );
  v_evidence_sha := encode(
    digest(convert_to(v_evidence_payload::text, 'UTF8'), 'sha256'), 'hex'
  );
  v_evidence := v_evidence_payload || jsonb_build_object(
    'evidenceSha256', v_evidence_sha
  );
  v_canonical := v_evidence::text;
  v_artifact_sha := encode(
    digest(convert_to(v_canonical, 'UTF8'), 'sha256'), 'hex'
  );
  return public.accept_portfolio_targets_with_evidence(
    p_idempotency_key,
    p_submission_id,
    p_root_session_id,
    (select artifact_id from public.artifact_metadata
      where idempotency_key = 'arena:packet'),
    p_packet_sha256,
    p_targets,
    p_cash_weight_bps,
    'Contract target',
    v_accepted_at,
    v_evidence,
    v_canonical,
    v_evidence_sha,
    v_artifact_sha,
    p_expected_stream_seq,
    'arena-contract'
  );
end;
$$;

select plan(76);

select has_table('public', 'decision_invocation', 'decision_invocation exists');
select has_table('public', 'agent_session_lineage', 'agent_session_lineage exists');
select has_table(
  'public',
  'accepted_target_submission',
  'accepted_target_submission exists'
);
select has_table(
  'public',
  'decision_admission_evidence',
  'decision admission evidence exists'
);
select has_table(
  'public',
  'decision_comparison_artifact',
  'same-snapshot decision comparison artifacts exist'
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
    pg_temp.accept_arena_contract_targets_evidenced(
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

select ok(
  exists (
    select 1
      from public.decision_admission_evidence
     where submission_id = '50000000-0000-4000-8000-000000000004'
       and guard_action = 'ALLOW'
       and evidence->'metrics' ?& array[
         'inputAgeMs',
         'marketJumpBps',
         'stableWindowMs',
         'maxTargetDeltaBps',
         'cooldownRemainingMs'
       ]
  ),
  'accepted targets carry every immutable admission observation'
);

select is(
  (
    with identity as (
      select snapshot_id::text as snapshot_id
        from public.market_snapshot
       where idempotency_key = 'arena:snapshot'
    ), document as (
      select jsonb_build_object(
        'schema', 'twofold.portfolio_decision_comparison/v1',
        'evidenceSnapshotId', snapshot_id,
        'official', jsonb_build_object(
          'schema', 'twofold.portfolio_decision_evidence/v1',
          'decisionRef', 'official:contract',
          'policyRef', 'official-v1',
          'evidenceSnapshotId', snapshot_id,
          'targets', jsonb_build_array(),
          'cashWeightBps', '10000',
          'decisionSha256', repeat('e', 64)
        ),
        'candidate', jsonb_build_object(
          'schema', 'twofold.portfolio_decision_evidence/v1',
          'decisionRef', 'candidate:contract',
          'policyRef', 'candidate-v1',
          'evidenceSnapshotId', snapshot_id,
          'targets', jsonb_build_array(),
          'cashWeightBps', '10000',
          'decisionSha256', repeat('f', 64)
        ),
        'deltas', jsonb_build_array(),
        'cashDeltaBps', '0',
        'maxAbsoluteDeltaBps', '0',
        'turnoverBps', '0',
        'identical', true,
        'comparisonSha256', repeat('d', 64)
      ) as value
      from identity
    ), material as (
      select value, value::text as canonical_json,
             encode(digest(convert_to(value::text, 'UTF8'), 'sha256'), 'hex')
               as artifact_sha256
        from document
    )
    select public.register_decision_comparison_artifact(
      repeat('d', 64),
      material.artifact_sha256,
      (material.value->>'evidenceSnapshotId')::uuid,
      repeat('e', 64),
      repeat('f', 64),
      null,
      null,
      material.value,
      material.canonical_json,
      'arena-contract'
    )->>'comparisonSha256'
    from material
  ),
  repeat('d', 64),
  'same-snapshot decision diff is stored under its content identity'
);

select is(
  (
    select count(*)::integer
      from public.decision_comparison_artifact
     where comparison_sha256 = repeat('d', 64)
       and comparison->'official'->>'evidenceSnapshotId'
         = comparison->'candidate'->>'evidenceSnapshotId'
  ),
  1,
  'decision comparison persistence keeps exactly one same-snapshot artifact'
);

select throws_ok(
  $$
    with identity as (
      select snapshot_id::text as snapshot_id
        from public.market_snapshot
       where idempotency_key = 'arena:snapshot'
    ), document as (
      select jsonb_build_object(
        'schema', 'twofold.portfolio_decision_comparison/v1',
        'evidenceSnapshotId', snapshot_id,
        'official', jsonb_build_object(
          'evidenceSnapshotId', snapshot_id,
          'decisionSha256', repeat('a', 64)
        ),
        'candidate', jsonb_build_object(
          'evidenceSnapshotId', '60000000-0000-4000-8000-000000000099',
          'decisionSha256', repeat('b', 64)
        ),
        'deltas', jsonb_build_array(),
        'cashDeltaBps', '0',
        'maxAbsoluteDeltaBps', '0',
        'turnoverBps', '0',
        'identical', true,
        'comparisonSha256', repeat('c', 64)
      ) as value
      from identity
    ), material as (
      select value, value::text as canonical_json,
             encode(digest(convert_to(value::text, 'UTF8'), 'sha256'), 'hex')
               as artifact_sha256
        from document
    )
    select public.register_decision_comparison_artifact(
      repeat('c', 64),
      material.artifact_sha256,
      (material.value->>'evidenceSnapshotId')::uuid,
      repeat('a', 64),
      repeat('b', 64),
      null,
      null,
      material.value,
      material.canonical_json,
      'arena-contract'
    )
    from material
  $$,
  '22023',
  'decision comparison crossed its same-snapshot identity',
  'Postgres rejects a candidate decision from another snapshot'
);

select ok(
  to_regclass('public.decision_evolution_evaluation') is not null,
  'decision evolution evaluations are durable'
);

create temporary table p1_evolution_clock as
select
  clock_timestamp() as proposed_at,
  clock_timestamp() + interval '1 second' as scheduled_at,
  clock_timestamp() + interval '2 seconds' as started_at,
  clock_timestamp() + interval '1 day' as expires_at;

create temporary table p1_evolution_spec as
select jsonb_build_object(
  'schema','twofold.evolution_experiment_spec/v1',
  'experimentId','93000000-0000-5000-8000-000000000001',
  'experimentCode','pgtap-portfolio-policy-replay-v1',
  'mode','LOCAL_REPLAY',
  'hypothesis','Candidate improves terminal NAV without weakening portfolio constraints.',
  'sourceFindingSha256s',jsonb_build_array(repeat('a',64)),
  'changeSurface','PORTFOLIO_POLICY',
  'baselineRef','policy:official-v1',
  'treatmentRef','policy:candidate-v2',
  'primaryMetric',jsonb_build_object(
    'metricKey','portfolio.terminal_nav','direction','HIGHER_IS_BETTER',
    'minimumAbsoluteImprovement','10'
  ),
  'guardrails',jsonb_build_array(
    jsonb_build_object('metricKey','portfolio.constraint_violation_count','direction','LOWER_IS_BETTER','maximumRegression','0','candidateMaximum','0'),
    jsonb_build_object('metricKey','portfolio.turnover_bps','direction','LOWER_IS_BETTER','maximumRegression','100'),
    jsonb_build_object('metricKey','portfolio.simulated_slippage_nav_cost','direction','LOWER_IS_BETTER','maximumRegression','2'),
    jsonb_build_object('metricKey','portfolio.simulated_fee_nav_cost','direction','LOWER_IS_BETTER','maximumRegression','2'),
    jsonb_build_object('metricKey','portfolio.simulated_tax_nav_cost','direction','LOWER_IS_BETTER','maximumRegression','2'),
    jsonb_build_object('metricKey','portfolio.max_drawdown_bps','direction','LOWER_IS_BETTER','maximumRegression','25'),
    jsonb_build_object('metricKey','portfolio.terminal_failure_count','direction','LOWER_IS_BETTER','maximumRegression','0','candidateMaximum','0')
  ),
  'onlineShadow',null,
  'expiresAt',to_char(clock.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
) as value
from p1_evolution_clock clock;

select is(
  public.propose_evolution_experiment(
    (select value from p1_evolution_spec), repeat('8',64),
    'model','pgtap:p1-model',(select proposed_at from p1_evolution_clock),
    'pgtap:p1:propose'
  )->>'status',
  'PROPOSED',
  'P1 portfolio evaluation is preregistered before replay'
);

select is(
  public.transition_evolution_experiment(
    '93000000-0000-5000-8000-000000000001','SCHEDULE','worker',
    'pgtap:p1-worker',(select scheduled_at from p1_evolution_clock),
    'pgtap:p1:schedule',null
  )->>'status',
  'SCHEDULED',
  'P1 local replay can be scheduled without promotion authority'
);

create temporary table p1_evolution_trial as
select (
  public.register_evolution_trial(
    'pgtap-portfolio-policy-replay-v1:trial-1',
    '93000000-0000-5000-8000-000000000001',null,null,
    '{"schema":"twofold.evolution_trial_evidence/v1","design":"SAME_SNAPSHOT_PORTFOLIO_REPLAY"}',
    (select scheduled_at from p1_evolution_clock),
    (select expires_at from p1_evolution_clock),
    'pgtap:p1-worker'
  )->>'trialId'
)::uuid as trial_id;

create temporary table p1_decision_comparison as
with identity as (
  select snapshot_id::text as snapshot_id
    from public.market_snapshot where idempotency_key = 'arena:snapshot'
), document as (
  select jsonb_build_object(
    'schema','twofold.portfolio_decision_comparison/v1',
    'evidenceSnapshotId',snapshot_id,
    'official',jsonb_build_object(
      'schema','twofold.portfolio_decision_evidence/v1','decisionRef','official:p1',
      'policyRef','official-v1','evidenceSnapshotId',snapshot_id,
      'targets',jsonb_build_array(),'cashWeightBps','10000','decisionSha256',repeat('1',64)
    ),
    'candidate',jsonb_build_object(
      'schema','twofold.portfolio_decision_evidence/v1','decisionRef','candidate:p1',
      'policyRef','candidate-v2','evidenceSnapshotId',snapshot_id,
      'targets',jsonb_build_array(),'cashWeightBps','10000','decisionSha256',repeat('2',64)
    ),
    'deltas',jsonb_build_array(),'cashDeltaBps','0','maxAbsoluteDeltaBps','0',
    'turnoverBps','500','identical',false,'comparisonSha256',repeat('3',64)
  ) as value from identity
)
select value, value::text as canonical_json,
       encode(digest(convert_to(value::text,'UTF8'),'sha256'),'hex') as artifact_sha256
from document;

select is(
  public.register_decision_comparison_artifact(
    repeat('3',64),(select artifact_sha256 from p1_decision_comparison),
    ((select value from p1_decision_comparison)->>'evidenceSnapshotId')::uuid,
    repeat('1',64),repeat('2',64),'93000000-0000-5000-8000-000000000001',
    (select trial_id from p1_evolution_trial),(select value from p1_decision_comparison),
    (select canonical_json from p1_decision_comparison),'pgtap:p1-worker'
  )->>'comparisonSha256',
  repeat('3',64),
  'same-snapshot decision diff is attached to the preregistered trial'
);

select is(
  public.transition_evolution_experiment(
    '93000000-0000-5000-8000-000000000001','START','worker',
    'pgtap:p1-worker',(select started_at from p1_evolution_clock),
    'pgtap:p1:start',null
  )->>'status',
  'RUNNING',
  'P1 evaluation starts only after its comparison is durable'
);

create temporary table p1_decision_evaluation as
with identity as (
  select (value->>'evidenceSnapshotId') as snapshot_id
    from p1_decision_comparison
), outcomes as (
  select
    jsonb_build_object(
      'schema','twofold.portfolio_replay_outcome/v1','evidenceSnapshotId',snapshot_id,
      'decisionSha256',repeat('1',64),'replayPolicyRef','arena-replay/v1',
      'replayInputSha256',repeat('b',64),
      'navCurrency','USD','metrics',jsonb_build_object(
        'constraintViolationCount','0','turnoverBps','600',
        'simulatedSlippageNavCost','5','simulatedFeeNavCost','3',
        'simulatedTaxNavCost','2','terminalNav','1000','maxDrawdownBps','200',
        'terminalFailureCount','0'
      ),'outcomeSha256',repeat('4',64)
    ) as official,
    jsonb_build_object(
      'schema','twofold.portfolio_replay_outcome/v1','evidenceSnapshotId',snapshot_id,
      'decisionSha256',repeat('2',64),'replayPolicyRef','arena-replay/v1',
      'replayInputSha256',repeat('b',64),
      'navCurrency','USD','metrics',jsonb_build_object(
        'constraintViolationCount','0','turnoverBps','650',
        'simulatedSlippageNavCost','5.5','simulatedFeeNavCost','3.5',
        'simulatedTaxNavCost','2.5','terminalNav','1020','maxDrawdownBps','210',
        'terminalFailureCount','0'
      ),'outcomeSha256',repeat('5',64)
    ) as candidate
  from identity
), result as (
  select jsonb_build_object(
    'schema','twofold.evolution_experiment_result/v1','recommendation','PROMOTE_CANDIDATE',
    'baselineValue','1000','treatmentValue','1020','primaryImprovement','20',
    'minimumAbsoluteImprovement','10','guardrails',jsonb_build_array(
      jsonb_build_object('metricKey','portfolio.constraint_violation_count','baselineValue','0','treatmentValue','0','regression','0','maximumRegression','0','candidateMaximum','0','candidateMaximumPassed',true,'passed',true),
      jsonb_build_object('metricKey','portfolio.turnover_bps','baselineValue','600','treatmentValue','650','regression','50','maximumRegression','100','passed',true),
      jsonb_build_object('metricKey','portfolio.simulated_slippage_nav_cost','baselineValue','5','treatmentValue','5.5','regression','0.5','maximumRegression','2','passed',true),
      jsonb_build_object('metricKey','portfolio.simulated_fee_nav_cost','baselineValue','3','treatmentValue','3.5','regression','0.5','maximumRegression','2','passed',true),
      jsonb_build_object('metricKey','portfolio.simulated_tax_nav_cost','baselineValue','2','treatmentValue','2.5','regression','0.5','maximumRegression','2','passed',true),
      jsonb_build_object('metricKey','portfolio.max_drawdown_bps','baselineValue','200','treatmentValue','210','regression','10','maximumRegression','25','passed',true),
      jsonb_build_object('metricKey','portfolio.terminal_failure_count','baselineValue','0','treatmentValue','0','regression','0','maximumRegression','0','candidateMaximum','0','candidateMaximumPassed',true,'passed',true)
    ),'resultSha256',repeat('7',64)
  ) as value
), document as (
  select jsonb_build_object(
    'schema','twofold.portfolio_decision_evolution_evaluation/v1',
    'experimentId','93000000-0000-5000-8000-000000000001',
    'evidenceSnapshotId',official->>'evidenceSnapshotId',
    'comparisonSha256',repeat('3',64),'decisionDeltaTurnoverBps','500',
    'officialOutcome',official,'candidateOutcome',candidate,
    'result',(select value from result),'evaluationSha256',repeat('6',64)
  ) as value from outcomes
)
select value, value::text as canonical_json,
       encode(digest(convert_to(value::text,'UTF8'),'sha256'),'hex') as artifact_sha256
from document;

select is(
  public.register_decision_evolution_evaluation(
    repeat('6',64),(select artifact_sha256 from p1_decision_evaluation),repeat('3',64),
    '93000000-0000-5000-8000-000000000001',(select trial_id from p1_evolution_trial),
    ((select value from p1_decision_evaluation)->>'evidenceSnapshotId')::uuid,
    repeat('4',64),repeat('5',64),repeat('7',64),
    (select value from p1_decision_evaluation),(select canonical_json from p1_decision_evaluation),
    'pgtap:p1-worker'
  )->>'evaluationSha256',
  repeat('6',64),
  'P1 evaluation persists every replay metric under one content identity'
);

select ok(
  exists (
    select 1 from public.decision_evolution_evaluation
     where evaluation_sha256 = repeat('6',64)
       and evaluation->'officialOutcome'->'metrics' ?& array[
         'constraintViolationCount','turnoverBps','simulatedSlippageNavCost',
         'simulatedFeeNavCost','simulatedTaxNavCost','terminalNav',
         'maxDrawdownBps','terminalFailureCount'
       ]
  ),
  'P1 evidence covers constraints, turnover, costs, tax, NAV, drawdown, and failure'
);

select is(
  (select status from public.evolution_experiment
    where experiment_id = '93000000-0000-5000-8000-000000000001'),
  'RUNNING',
  'PROMOTE_CANDIDATE evidence does not auto-promote or complete an experiment'
);

select throws_ok(
  $$
    with tampered as (
      select jsonb_set(
        jsonb_set(
          value,
          '{candidateOutcome,metrics,constraintViolationCount}',
          '"1"'::jsonb
        ),
        '{evaluationSha256}',
        to_jsonb(repeat('9',64))
      ) as value
      from p1_decision_evaluation
    ), material as (
      select value, value::text as canonical_json,
             encode(digest(convert_to(value::text,'UTF8'),'sha256'),'hex')
               as artifact_sha256
      from tampered
    )
    select public.register_decision_evolution_evaluation(
      repeat('9',64),material.artifact_sha256,repeat('3',64),
      '93000000-0000-5000-8000-000000000001',
      (select trial_id from p1_evolution_trial),
      (material.value->>'evidenceSnapshotId')::uuid,
      repeat('4',64),repeat('5',64),repeat('7',64),
      material.value,material.canonical_json,'pgtap:p1-worker'
    )
    from material
  $$,
  '22023',
  'decision evolution guardrails are not bound to replay metrics',
  'Postgres rejects a fabricated promotion recommendation after a hard violation'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.register_decision_evolution_evaluation(text,text,text,uuid,uuid,uuid,text,text,text,jsonb,text,text)',
    'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'public.register_decision_evolution_evaluation(text,text,text,uuid,uuid,uuid,text,text,text,jsonb,text,text)',
    'EXECUTE'
  ),
  'only the private worker can register P1 evaluation evidence'
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
    pg_temp.accept_arena_contract_targets_evidenced(
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
  not has_function_privilege(
    'service_role',
    'public.accept_portfolio_targets(text,uuid,text,uuid,text,jsonb,text,text,timestamp with time zone,bigint,text)',
    'EXECUTE'
  ),
  'service_role cannot bypass decision admission evidence'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.accept_portfolio_targets_with_evidence(text,uuid,text,uuid,text,jsonb,text,text,timestamp with time zone,jsonb,text,text,text,bigint,text)',
    'EXECUTE'
  ),
  'service_role can accept targets only with evidence'
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


-- Deterministic baseline: the invocation boundary must accept a model-free
-- entrant's own artifact kinds, derive its decision kind from immutable entrant
-- identity, and refuse to bill it a token.

select public.register_run_manifest(
  'arena:baseline:run',
  '51000000-0000-4000-8000-000000000001',
  'twofold.run_manifest/v1',
  '{"engine_version":"arena-contract-v1","lot_method":"FIFO"}',
  'arena-contract', repeat('9', 64)
);

select public.register_arena_season(
  'arena:baseline:season',
  '51000000-0000-4000-8000-000000000002',
  'arena-contract-baseline-season',
  'Arena Contract Baseline Season',
  '2026-08-22T00:00:00Z'::timestamptz,
  '2026-09-30T00:00:00Z'::timestamptz,
  'US_EQUITY_DAILY_AFTER_CLOSE',
  'America/New_York',
  '{"purpose":"arena-contract-baseline"}'::jsonb,
  'arena-contract'
);

select is(
  (public.register_season_entrant(
    'arena:baseline:entrant',
    '51000000-0000-4000-8000-000000000004',
    '51000000-0000-4000-8000-000000000002',
    'baseline-hold-lulu',
    '51000000-0000-4000-8000-000000000001',
    'twofold-baseline-hold-genesis@1.0.0',
    -- Must equal the policy artifact SHA registered below: the invocation
    -- boundary now binds the presented policy to the frozen seat identity.
    repeat('bb', 32),
    'none', 'none', 'none',
    'DETERMINISTIC_BASELINE',
    '{"track":"MAIN_ARENA"}'::jsonb,
    'arena-contract'
  )).execution_class,
  'DETERMINISTIC_BASELINE',
  'a model-free baseline holds a ranked seat in the decision fixture Season'
);

select is(
  (public.register_artifact(
    'arena:baseline:packet',
    '51000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000002',
    null,
    'baseline_decision_packet',
    'twofold-private-artifacts',
    'packets/' || repeat('ba', 32) || '.json',
    'application/json', 512, repeat('ba', 32),
    'arena-contract',
    jsonb_build_object(
      'schema', 'twofold.baseline_decision_packet/v1',
      'decisionId', '51000000-0000-4000-8000-000000000003',
      'marketSnapshotId', (
        select snapshot_id::text from public.market_snapshot
         where idempotency_key = 'arena:snapshot'
      ),
      'marketManifestSha256', (
        select manifest_sha256 from public.market_snapshot
         where idempotency_key = 'arena:snapshot'
      )
    )
  )).artifact_kind,
  'baseline_decision_packet',
  'a baseline registers its own packet kind rather than an Agent packet'
);

select is(
  (public.register_artifact(
    'arena:baseline:policy',
    null,
    '51000000-0000-4000-8000-000000000002',
    null,
    'deterministic_baseline_policy',
    'twofold-private-artifacts',
    'policies/' || repeat('bb', 32) || '.json',
    'application/json', 256, repeat('bb', 32),
    'arena-contract',
    jsonb_build_object(
      'schema', 'twofold.deterministic_baseline_policy/v1',
      'policyId', 'hold-genesis'
    )
  )).artifact_kind,
  'deterministic_baseline_policy',
  'the frozen policy stands in for the Agent Bundle manifest, under its own kind'
);

create or replace function pg_temp.open_baseline_invocation(
  p_idempotency_key text,
  p_decision_id uuid,
  p_root_session_id text,
  p_packet_key text,
  p_policy_key text default 'arena:baseline:policy'
)
returns public.decision_invocation
language sql
volatile
set search_path = public, extensions, pg_temp
as $$
  select public.open_decision_invocation(
    p_idempotency_key,
    p_decision_id,
    '51000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000002',
    (select coalesce(max(stream_seq), 0) from public.event_stream
      where stream_id = '51000000-0000-4000-8000-000000000001'),
    p_root_session_id,
    'hold-genesis',
    (select artifact_id from public.artifact_metadata
      where idempotency_key = p_packet_key),
    (select artifact_id from public.artifact_metadata
      where idempotency_key = p_policy_key),
    (select snapshot_id from public.market_snapshot
      where idempotency_key = 'arena:snapshot'),
    (select decision_at from arena_contract_context),
    '2026-08-23T00:10:00Z',
    (select deadline_at from arena_contract_context),
    array['deterministic_baseline'],
    (select opened_at from arena_contract_context),
    'arena-contract'
  )
$$;

select is(
  (pg_temp.open_baseline_invocation(
    'arena:baseline:open',
    '51000000-0000-4000-8000-000000000003',
    'baseline:hold-genesis:51000000-0000-4000-8000-000000000004',
    'arena:baseline:packet'
  )).decision_kind,
  'DETERMINISTIC_BASELINE',
  'the decision kind is derived from immutable entrant identity, not the caller'
);

-- Same run and Season as the baseline, differing only in artifact kind and
-- packet schema, so the rejection isolates the kind branch rather than the
-- run/Season scope checks that surround it.
select is(
  (public.register_artifact(
    'arena:baseline:agent-kind-packet',
    '51000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000002',
    null,
    'decision_packet',
    'twofold-private-artifacts',
    'packets/' || repeat('bc', 32) || '.json',
    'application/json', 512, repeat('bc', 32),
    'arena-contract',
    jsonb_build_object(
      'schema', 'twofold.decision_packet/v1',
      'decisionId', '51000000-0000-4000-8000-000000000005',
      'marketSnapshotId', (
        select snapshot_id::text from public.market_snapshot
         where idempotency_key = 'arena:snapshot'
      ),
      'marketManifestSha256', (
        select manifest_sha256 from public.market_snapshot
         where idempotency_key = 'arena:snapshot'
      )
    )
  )).artifact_kind,
  'decision_packet',
  'an Agent-kind packet exists inside the baseline run and Season scope'
);

select throws_ok(
  $q$select pg_temp.open_baseline_invocation(
    'arena:baseline:open-agent-packet',
    '51000000-0000-4000-8000-000000000005',
    'baseline:hold-genesis:51000000-0000-4000-8000-000000000006',
    'arena:baseline:agent-kind-packet'
  )$q$,
  '22023',
  'decision packet artifact does not match invocation scope or market snapshot',
  'a baseline run cannot open a decision on an Agent decision packet'
);

select is(
  (public.register_artifact(
    'arena:baseline:packet-seven',
    '51000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000002',
    null,
    'baseline_decision_packet',
    'twofold-private-artifacts',
    'packets/' || repeat('be', 32) || '.json',
    'application/json', 512, repeat('be', 32),
    'arena-contract',
    jsonb_build_object(
      'schema', 'twofold.baseline_decision_packet/v1',
      'decisionId', '51000000-0000-4000-8000-000000000007',
      'marketSnapshotId', (
        select snapshot_id::text from public.market_snapshot
         where idempotency_key = 'arena:snapshot'
      ),
      'marketManifestSha256', (
        select manifest_sha256 from public.market_snapshot
         where idempotency_key = 'arena:snapshot'
      )
    )
  )).artifact_kind,
  'baseline_decision_packet',
  'a packet exists for the foreign-policy attempt'
);

select is(
  (public.register_artifact(
    'arena:baseline:foreign-policy',
    null,
    '51000000-0000-4000-8000-000000000002',
    null,
    'deterministic_baseline_policy',
    'twofold-private-artifacts',
    'policies/' || repeat('bd', 32) || '.json',
    'application/json', 256, repeat('bd', 32),
    'arena-contract',
    jsonb_build_object(
      'schema', 'twofold.deterministic_baseline_policy/v1',
      'policyId', 'all-in-nvda'
    )
  )).artifact_kind,
  'deterministic_baseline_policy',
  'a second baseline policy exists that this seat did not freeze'
);

select throws_ok(
  $q$select pg_temp.open_baseline_invocation(
    'arena:baseline:open-foreign-policy',
    '51000000-0000-4000-8000-000000000007',
    'baseline:hold-genesis:51000000-0000-4000-8000-000000000008',
    'arena:baseline:packet-seven',
    'arena:baseline:foreign-policy'
  )$q$,
  '22023',
  'Agent Bundle artifact does not match invocation scope',
  'a baseline cannot open a decision under a policy the seat did not freeze'
);

select throws_ok(
  $q$insert into public.model_usage_record (
    idempotency_key, run_id, season_id, decision_id, harness_session_id,
    turn_index, step_index, attempt_index, provider, model,
    request_started_at, completed_at, usage_status, usage_source,
    cost_status, recorded_by
  ) values (
    'arena:baseline:usage',
    '51000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000002',
    '51000000-0000-4000-8000-000000000003',
    'baseline:hold-genesis:51000000-0000-4000-8000-000000000004',
    0, 0, 0, 'deepseek-official', 'deepseek-v4-pro',
    '2026-08-23T00:11:00Z', '2026-08-23T00:11:05Z',
    'provider_unreported', 'provider_unreported', 'unavailable', 'arena-contract'
  )$q$,
  '23514',
  'a deterministic baseline decision cannot record model usage',
  'a model-free entrant can never be billed a provider request'
);

-- Behavioural cover for the usage-before-invocation ordering. Recording usage
-- for a decision that has no invocation yet is legal, and opening a baseline
-- invocation over it must then be refused.
insert into public.model_usage_record (
  idempotency_key, run_id, season_id, decision_id, harness_session_id,
  turn_index, step_index, attempt_index, provider, model,
  request_started_at, completed_at, usage_status, usage_source,
  cost_status, recorded_by
) values (
  'arena:baseline:usage-first',
  '51000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000002',
  '51000000-0000-4000-8000-000000000009',
  'some-agent-session',
  0, 0, 0, 'deepseek-official', 'deepseek-v4-pro',
  '2026-08-23T00:11:00Z', '2026-08-23T00:11:05Z',
  'provider_unreported', 'provider_unreported', 'unavailable', 'arena-contract'
);

select is(
  (select count(*)::text from public.model_usage_record
    where decision_id = '51000000-0000-4000-8000-000000000009'),
  '1',
  'usage may be recorded for a decision that has not been opened yet'
);

select is(
  (public.register_artifact(
    'arena:baseline:packet-nine',
    '51000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000002',
    null,
    'baseline_decision_packet',
    'twofold-private-artifacts',
    'packets/' || repeat('bf', 32) || '.json',
    'application/json', 512, repeat('bf', 32),
    'arena-contract',
    jsonb_build_object(
      'schema', 'twofold.baseline_decision_packet/v1',
      'decisionId', '51000000-0000-4000-8000-000000000009',
      'marketSnapshotId', (
        select snapshot_id::text from public.market_snapshot
         where idempotency_key = 'arena:snapshot'
      ),
      'marketManifestSha256', (
        select manifest_sha256 from public.market_snapshot
         where idempotency_key = 'arena:snapshot'
      )
    )
  )).artifact_kind,
  'baseline_decision_packet',
  'a packet exists for the usage-first attempt'
);

select throws_ok(
  $q$select pg_temp.open_baseline_invocation(
    'arena:baseline:open-over-usage',
    '51000000-0000-4000-8000-000000000009',
    'baseline:hold-genesis:51000000-0000-4000-8000-00000000000a',
    'arena:baseline:packet-nine'
  )$q$,
  '23514',
  'a deterministic baseline decision cannot record model usage',
  'a baseline decision cannot be opened over pre-existing provider usage'
);

select * from finish();
rollback;
