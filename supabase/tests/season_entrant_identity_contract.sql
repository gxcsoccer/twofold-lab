-- Durable Season/entrant/Run identity contract. Every fixture rolls back.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(19);

select has_table('public', 'arena_season', 'Arena Season identity is durable');
select has_table('public', 'season_entrant', 'Season entrant identity is durable');
select has_column(
  'public', 'season_entrant', 'run_id',
  'an entrant retains one stable Strategy Run'
);
select has_function(
  'public', 'register_arena_season',
  array[
    'text', 'uuid', 'text', 'text', 'timestamp with time zone',
    'timestamp with time zone', 'text', 'text', 'jsonb', 'text'
  ],
  'Season registration has one audited service boundary'
);
select has_function(
  'public', 'register_season_entrant',
  array[
    'text', 'uuid', 'uuid', 'text', 'uuid', 'text', 'text', 'text',
    'text', 'text', 'text', 'jsonb', 'text'
  ],
  'entrant registration has one audited service boundary'
);

select public.register_run_manifest(
  'season-identity-contract:run:one',
  'a1000000-0000-4000-8000-000000000001',
  'twofold.run_manifest/v1',
  '{"engine_version":"season-identity-v1","lot_method":"FIFO"}',
  'season-identity-contract', repeat('1', 64)
);
select public.register_run_manifest(
  'season-identity-contract:run:two',
  'a1000000-0000-4000-8000-000000000002',
  'twofold.run_manifest/v1',
  '{"engine_version":"season-identity-v1","lot_method":"FIFO"}',
  'season-identity-contract', repeat('2', 64)
);

set local role service_role;
select public.register_arena_season(
  'season-identity-contract:season',
  'a2000000-0000-4000-8000-000000000001',
  'contract-controlled-lab-s1',
  'Contract Controlled Lab S1',
  '2026-08-28T21:00:00.000Z',
  '2026-09-26T00:00:00.000Z',
  'US_EQUITY_DAILY_AFTER_CLOSE',
  'America/New_York',
  '{"initialHolding":"150 LULU","openingCash":"0"}',
  'season-identity-contract'
);
select public.register_season_entrant(
  'season-identity-contract:entrant:twofold',
  'a3000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001',
  'twofold',
  'a1000000-0000-4000-8000-000000000001',
  'twofold@0.1.0', repeat('a', 64), 'twofold',
  'deepseek-official', 'deepseek-v4-pro', 'ROOT_ONLY',
  '{"track":"MAIN_ARENA"}', 'season-identity-contract'
);
select public.register_season_entrant(
  'season-identity-contract:entrant:orchestrator',
  'a3000000-0000-4000-8000-000000000002',
  'a2000000-0000-4000-8000-000000000001',
  'twofold-orchestrator',
  'a1000000-0000-4000-8000-000000000002',
  'twofold-orchestrator@0.1.0', repeat('b', 64),
  'twofold-orchestrator', 'deepseek-official', 'deepseek-v4-pro',
  'ORCHESTRATED', '{"track":"MAIN_ARENA"}',
  'season-identity-contract'
);
reset role;

select is(
  (select count(*) from public.arena_season
    where season_id = 'a2000000-0000-4000-8000-000000000001'),
  1::bigint,
  'both entrants share exactly one Season'
);
select is(
  (select count(*) from public.season_entrant
    where season_id = 'a2000000-0000-4000-8000-000000000001'),
  2::bigint,
  'the Season has two immutable entrants'
);
select is(
  (select count(distinct season_id) from public.season_entrant
    where entrant_id in (
      'a3000000-0000-4000-8000-000000000001',
      'a3000000-0000-4000-8000-000000000002'
    )),
  1::bigint,
  'different Bundles never derive different Season identities'
);
select is(
  (select count(distinct run_id) from public.season_entrant
    where season_id = 'a2000000-0000-4000-8000-000000000001'),
  2::bigint,
  'each entrant owns an isolated stable Run'
);
select is(
  (
    public.register_arena_season(
      'season-identity-contract:season',
      'a2000000-0000-4000-8000-000000000001',
      'contract-controlled-lab-s1', 'Contract Controlled Lab S1',
      '2026-08-28T21:00:00.000Z', '2026-09-26T00:00:00.000Z',
      'US_EQUITY_DAILY_AFTER_CLOSE', 'America/New_York',
      '{"initialHolding":"150 LULU","openingCash":"0"}',
      'season-identity-contract'
    )
  ).season_id,
  'a2000000-0000-4000-8000-000000000001'::uuid,
  'an exact Season retry returns the original identity'
);
select throws_ok(
  $$select public.register_arena_season(
    'season-identity-contract:season',
    'a2000000-0000-4000-8000-000000000001',
    'contract-controlled-lab-s1', 'Changed name',
    '2026-08-28T21:00:00.000Z', '2026-09-26T00:00:00.000Z',
    'US_EQUITY_DAILY_AFTER_CLOSE', 'America/New_York', '{}',
    'season-identity-contract'
  )$$,
  '23505',
  'Arena Season identity was reused with different content',
  'a Season identity cannot drift after registration'
);
select throws_ok(
  $$select public.register_season_entrant(
    'season-identity-contract:entrant:duplicate-run',
    'a3000000-0000-4000-8000-000000000003',
    'a2000000-0000-4000-8000-000000000001', 'other-code',
    'a1000000-0000-4000-8000-000000000001',
    'other@0.1.0', repeat('c',64), 'other', 'provider', 'model',
    'ROOT_ONLY', '{}', 'season-identity-contract'
  )$$,
  '23505',
  'Season entrant identity was reused with different content',
  'one Strategy Run cannot be assigned to a second entrant'
);
select throws_ok(
  $$select public.register_arena_season(
    'season-identity-contract:numeric',
    'a2000000-0000-4000-8000-000000000002', 'numeric-season',
    'Numeric Season', now(), now() + interval '1 day',
    'US_EQUITY_DAILY_AFTER_CLOSE', 'America/New_York', '{"cash":0}',
    'season-identity-contract'
  )$$,
  '22023', 'invalid immutable Arena Season',
  'Season configuration rejects JSON number tokens'
);
select throws_ok(
  $$select public.register_season_entrant(
    'season-identity-contract:bad-class',
    'a3000000-0000-4000-8000-000000000004',
    'a2000000-0000-4000-8000-000000000001', 'bad-class',
    'a1000000-0000-4000-8000-000000000002',
    'bad@0.1.0', repeat('d',64), 'bad', 'provider', 'model',
    'UNBOUNDED', '{}', 'season-identity-contract'
  )$$,
  '22023', 'invalid immutable Season entrant',
  'execution class is explicit rather than inferred from Bundle name'
);
select throws_ok(
  $$update public.season_entrant set entrant_code = 'mutated'$$,
  '55000',
  'season_entrant is append-only; append a compensating or superseding record instead',
  'entrant identity is immutable even for the owner'
);

set local role anon;
select throws_ok(
  $$select * from public.arena_season$$,
  '42501', null,
  'anonymous callers cannot read the private Season'
);
select throws_ok(
  $$select public.register_arena_season(
    'anon', 'a2000000-0000-4000-8000-000000000009', 'anon-season',
    'Anon', now(), now() + interval '1 day',
    'US_EQUITY_DAILY_AFTER_CLOSE', 'America/New_York', '{}', 'anon'
  )$$,
  '42501', null,
  'anonymous callers cannot register a Season'
);
reset role;

set local role service_role;
select is(
  (select count(*) from public.season_entrant
    where season_id = 'a2000000-0000-4000-8000-000000000001'),
  2::bigint,
  'service role can read the private roster for scheduling'
);
reset role;

select is(
  (select decision_cadence from public.arena_season
    where season_id = 'a2000000-0000-4000-8000-000000000001'),
  'US_EQUITY_DAILY_AFTER_CLOSE',
  'the Season freezes one realistic market-session cadence'
);

select * from finish();
rollback;
