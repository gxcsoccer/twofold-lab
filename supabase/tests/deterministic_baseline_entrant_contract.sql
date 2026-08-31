-- Deterministic baseline entrant contract. A model-free contestant may rank,
-- but it may never claim a provider route and never bill a token.
-- Every fixture rolls back.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(16);

-- Structural boundaries -------------------------------------------------------

select has_column(
  'public', 'decision_invocation', 'decision_kind',
  'a decision records whether an Agent or a baseline policy produced it'
);
select has_function(
  'public', 'derive_decision_kind', array[]::text[],
  'decision kind is derived from immutable entrant identity, not the caller'
);
select has_function(
  'public', 'reject_baseline_model_usage', array[]::text[],
  'baseline model usage has a fail-closed guard'
);
select has_trigger(
  'public', 'decision_invocation', 'decision_invocation_derives_kind',
  'every decision insert derives its kind'
);
select has_trigger(
  'public', 'model_usage_record', 'model_usage_record_rejects_baseline_usage',
  'every usage insert is checked against baseline decisions'
);
select col_default_is(
  'public', 'decision_invocation', 'decision_kind', 'AGENT',
  'existing Agent decisions keep their meaning'
);

-- Fixtures --------------------------------------------------------------------

select public.register_run_manifest(
  'baseline-contract:run:agent',
  'b1000000-0000-4000-8000-000000000001',
  'twofold.run_manifest/v1',
  '{"engine_version":"baseline-v1","lot_method":"FIFO"}',
  'baseline-contract', repeat('1', 64)
);
select public.register_run_manifest(
  'baseline-contract:run:baseline',
  'b1000000-0000-4000-8000-000000000002',
  'twofold.run_manifest/v1',
  '{"engine_version":"baseline-v1","lot_method":"FIFO"}',
  'baseline-contract', repeat('2', 64)
);

select public.register_arena_season(
  'baseline-contract:season',
  'b2000000-0000-4000-8000-000000000001',
  'baseline-contract-season',
  'Baseline Contract Season',
  '2026-08-29T21:28:55.699Z'::timestamptz,
  '2026-09-27T00:00:00.000Z'::timestamptz,
  'US_EQUITY_DAILY_AFTER_CLOSE',
  'America/New_York',
  '{"purpose":"baseline-contract"}'::jsonb,
  'baseline-contract'
);

-- Entrant identity ------------------------------------------------------------

select is(
  (public.register_season_entrant(
    'baseline-contract:entrant:baseline',
    'b3000000-0000-4000-8000-000000000002',
    'b2000000-0000-4000-8000-000000000001',
    'baseline-hold-lulu',
    'b1000000-0000-4000-8000-000000000002',
    'twofold-baseline-hold-genesis@1.0.0',
    repeat('a', 64),
    'none', 'none', 'none',
    'DETERMINISTIC_BASELINE',
    '{"track":"MAIN_ARENA"}'::jsonb,
    'baseline-contract'
  )).execution_class,
  'DETERMINISTIC_BASELINE',
  'a model-free baseline may hold a ranked Season seat'
);

select is(
  (select provider from public.season_entrant
    where entrant_id = 'b3000000-0000-4000-8000-000000000002'),
  'none',
  'the baseline records an explicit no-route sentinel rather than a real provider'
);

select throws_ok(
  $$select public.register_season_entrant(
    'baseline-contract:entrant:forged-route',
    'b3000000-0000-4000-8000-000000000003',
    'b2000000-0000-4000-8000-000000000001',
    'baseline-forged',
    'b1000000-0000-4000-8000-000000000001',
    'twofold-baseline-hold-genesis@1.0.0',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'none', 'deepseek-official', 'deepseek-v4-pro',
    'DETERMINISTIC_BASELINE',
    '{}'::jsonb,
    'baseline-contract'
  )$$,
  '22023',
  'invalid immutable Season entrant',
  'a baseline cannot claim a real provider route'
);

select throws_ok(
  $$select public.register_season_entrant(
    'baseline-contract:entrant:agent-sentinel',
    'b3000000-0000-4000-8000-000000000004',
    'b2000000-0000-4000-8000-000000000001',
    'agent-sentinel',
    'b1000000-0000-4000-8000-000000000001',
    'twofold@0.1.0',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'twofold', 'none', 'none',
    'ROOT_ONLY',
    '{}'::jsonb,
    'baseline-contract'
  )$$,
  '22023',
  'invalid immutable Season entrant',
  'an Agent entrant cannot hide behind the baseline sentinel'
);

select throws_ok(
  $$select public.register_season_entrant(
    'baseline-contract:entrant:unknown-class',
    'b3000000-0000-4000-8000-000000000005',
    'b2000000-0000-4000-8000-000000000001',
    'unknown-class',
    'b1000000-0000-4000-8000-000000000001',
    'twofold@0.1.0',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'twofold', 'deepseek-official', 'deepseek-v4-pro',
    'DETERMINISTIC_HOLD',
    '{}'::jsonb,
    'baseline-contract'
  )$$,
  '22023',
  'invalid immutable Season entrant',
  'only the three registered execution classes exist'
);

select throws_ok(
  $$update public.season_entrant
       set execution_class = 'ROOT_ONLY'
     where entrant_id = 'b3000000-0000-4000-8000-000000000002'$$,
  '55000',
  'season_entrant is append-only; append a compensating or superseding record instead',
  'a recorded baseline entrant cannot be relabelled into an Agent'
);

select is(
  (select count(*)::text from public.season_entrant
    where season_id = 'b2000000-0000-4000-8000-000000000001'),
  '1',
  'no rejected entrant was partially recorded'
);

select matches(
  pg_get_functiondef('public.derive_decision_kind()'::regprocedure),
  'cannot record model usage',
  'the deployed guard text is present; arena_decision_contract covers the behaviour'
);

-- Deployment assertions for the replaced RPC. Behavioural coverage of the
-- kind-aware branch belongs in arena_decision_contract.sql, which already owns
-- the market-fact/snapshot/artifact fixture chain the invocation needs.
select matches(
  pg_get_functiondef('public.open_decision_invocation(text,uuid,uuid,uuid,bigint,text,text,uuid,uuid,uuid,timestamptz,timestamptz,timestamptz,text[],timestamptz,text)'::regprocedure),
  'baseline_decision_packet',
  'the invocation boundary accepts a baseline packet kind'
);
select matches(
  pg_get_functiondef('public.open_decision_invocation(text,uuid,uuid,uuid,bigint,text,text,uuid,uuid,uuid,timestamptz,timestamptz,timestamptz,text[],timestamptz,text)'::regprocedure),
  'deterministic_baseline_policy',
  'a baseline presents its own policy artifact, never a dsh_agent_bundle_manifest'
);

select * from finish();
rollback;
