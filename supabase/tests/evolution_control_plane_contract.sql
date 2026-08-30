begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(19);

select ok(to_regclass('public.evolution_cycle') is not null,
  'scheduled evolution cycles are durable');
select ok(to_regclass('public.evolution_experience') is not null,
  'learned experience is an explicit immutable ledger');
select ok(to_regclass('public.evolution_experiment') is not null,
  'experiments have an audited registry');
select ok(to_regclass('public.evolution_trial') is not null,
  'local and online trials have an isolated lane');
select ok(not exists (
  select 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'evolution_trial'
     and column_name in ('entrant_id','round_entry_id')
), 'shadow trials cannot acquire an official entrant or Round-entry identity');
select ok(exists (
  select 1 from pg_trigger where tgrelid = 'public.evolution_experience'::regclass
    and tgname = 'evolution_experience_is_immutable' and not tgisinternal
), 'experience rows are immutable');
select ok(has_function_privilege('service_role',
  'public.collect_evolution_metrics(timestamptz,timestamptz)', 'EXECUTE'),
  'the private worker can harvest metrics');
select ok(not has_function_privilege('anon',
  'public.collect_evolution_metrics(timestamptz,timestamptz)', 'EXECUTE'),
  'anonymous users cannot harvest private operations data');

set local role service_role;

select is(
  public.request_evolution_cycle(
    'pgtap:evolution:2026-08-29', '2026-08-29T00:00:00Z', '2026-08-30T00:00:00Z',
    '{"schema":"twofold.evolution_policy/v1","analyzerVersion":"pgtap"}', 'pgtap'
  )->>'status', 'REQUESTED', 'a scheduled cycle can be requested');
select is(
  public.request_evolution_cycle(
    'pgtap:evolution:2026-08-29', '2026-08-29T00:00:00Z', '2026-08-30T00:00:00Z',
    '{"schema":"twofold.evolution_policy/v1","analyzerVersion":"pgtap"}', 'pgtap'
  )->>'status', 'REQUESTED', 'exact cycle retries are idempotent');
select is(
  public.request_evolution_cycle(
    'pgtap:evolution:2026-08-29', '2026-08-29T00:00:00Z', '2026-08-30T00:00:00Z',
    '{"schema":"twofold.evolution_policy/v1","analyzerVersion":"pgtap"}', 'pgtap:second-worker'
  )->>'status', 'REQUESTED', 'a second worker may request the same global window');
select ok(not public.jsonb_contains_number(public.request_evolution_cycle(
    'pgtap:evolution:2026-08-29', '2026-08-29T00:00:00Z', '2026-08-30T00:00:00Z',
    '{"schema":"twofold.evolution_policy/v1","analyzerVersion":"pgtap"}', 'pgtap'
  )), 'cycle boundaries never emit JSON numbers');
select throws_ok(
  $$select public.request_evolution_cycle(
    'pgtap:evolution:bad', '2026-08-30T00:00:00Z', '2026-08-29T00:00:00Z',
    '{}'::jsonb, 'pgtap')$$,
  '22023', null, 'invalid analysis windows fail closed');

create temporary table pgtap_online as
select jsonb_build_object(
  'schema','twofold.evolution_experiment_spec/v1',
  'experimentId','73e9716e-fe49-5ef2-bc18-b7bf5980c123',
  'experimentCode','pgtap-online-shadow',
  'mode','ONLINE_SHADOW',
  'hypothesis','A bounded shadow treatment improves reliability.',
  'sourceFindingSha256s',jsonb_build_array(repeat('a',64)),
  'changeSurface','RUNTIME_BUDGET',
  'baselineRef','bundle:baseline', 'treatmentRef','bundle:treatment',
  'primaryMetric',jsonb_build_object('metricKey','agent.decision.terminal_failure_rate','direction','LOWER_IS_BETTER','minimumAbsoluteImprovement','0.1'),
  'guardrails',jsonb_build_array(),
  'onlineShadow',jsonb_build_object('seasonId','1486ba8e-47ae-5774-ba44-5c26f9359eeb','startsAtRoundIndex','2','maximumRounds','1','rankingScope','SHADOW'),
  'expiresAt','2026-09-30T00:00:00.000Z'
) as spec;

select is((public.propose_evolution_experiment(
  (select spec from pgtap_online), repeat('b',64), 'model', 'pgtap:model',
  '2026-08-30T01:00:00Z', 'pgtap:online:propose')->>'status'),
  'PROPOSED', 'a model may propose an online shadow hypothesis');
select throws_ok(
  $$select public.transition_evolution_experiment(
    '73e9716e-fe49-5ef2-bc18-b7bf5980c123','SCHEDULE','worker','pgtap:worker',
    '2026-08-30T01:01:00Z','pgtap:online:schedule-too-soon',null)$$,
  '55000', null, 'online scheduling cannot bypass human approval');
select is((public.transition_evolution_experiment(
    '73e9716e-fe49-5ef2-bc18-b7bf5980c123','APPROVE','human','pgtap:operator',
    '2026-08-30T01:02:00Z','pgtap:online:approve',null)->>'status'),
  'APPROVED', 'a human can explicitly approve the online experiment');
select is((public.transition_evolution_experiment(
    '73e9716e-fe49-5ef2-bc18-b7bf5980c123','SCHEDULE','worker','pgtap:worker',
    '2026-08-30T01:03:00Z','pgtap:online:schedule',null)->>'rankingScope'),
  'SHADOW', 'approved online work is always shadow-ranked');
select throws_ok(
  $$select public.transition_evolution_experiment(
    '73e9716e-fe49-5ef2-bc18-b7bf5980c123','PROMOTE','model','pgtap:model',
    '2026-08-30T01:04:00Z','pgtap:online:promote',null)$$,
  '55000', null, 'a model can never promote itself');
select ok(not public.jsonb_contains_number(public.collect_evolution_metrics(
    '2026-08-29T00:00:00Z','2026-08-30T00:00:00Z')),
  'harvested observations use exact string values');

reset role;
select * from finish();
rollback;
