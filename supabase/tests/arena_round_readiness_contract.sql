begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(12);

select ok(
  to_regprocedure(
    'public.get_arena_round_readiness(uuid,timestamp with time zone)'
  ) is not null,
  'operators have one static Round readiness boundary'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.get_arena_round_readiness(uuid,timestamp with time zone)',
    'EXECUTE'
  ),
  'the private Worker can inspect Round readiness'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.get_arena_round_readiness(uuid,timestamp with time zone)',
    'EXECUTE'
  ),
  'anonymous callers cannot inspect private competition readiness'
);

set local role service_role;
create temporary table missing_round_readiness on commit drop as
select public.get_arena_round_readiness(
  'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid,
  '2026-08-29T10:00:00.000Z'::timestamptz
) as value;
reset role;

select is(
  (select value->>'status' from missing_round_readiness),
  'BLOCKED',
  'an unknown Round fails closed'
);
select is(
  (select value#>>'{blockers,0,code}' from missing_round_readiness),
  'ROUND_MISSING',
  'the readiness result exposes one causal missing-Round blocker'
);
select ok(
  not public.jsonb_contains_number(
    (select value from missing_round_readiness)
  ),
  'Round readiness contains no JSON numeric tokens'
);

select ok(
  to_regprocedure(
    'public.arena_tick_capacity_fits(bigint,bigint,bigint,bigint)'
  ) is not null,
  'readiness has one generic minute-tick capacity policy'
);
select ok(
  to_regprocedure(
    'public.get_arena_round_structural_readiness_base(uuid,timestamp with time zone)'
  ) is not null,
  'the original structural proof remains an internal exact boundary'
);
select ok(
  position(
    'arena_tick_capacity_fits' in pg_get_functiondef(
      'public.get_arena_round_readiness(uuid,timestamp with time zone)'::regprocedure
    )
  ) > 0,
  'the public Round gate composes structural and capacity proofs'
);
select ok(
  public.arena_tick_capacity_fits(2, 388, 0, 5),
  'two entrants fit the current 388-minute shared-open window with retry reserve'
);
select ok(
  public.arena_tick_capacity_fits(2, 1030, 1, 5),
  'dependent settlement adds one tick and fits the current S1-close window'
);
select ok(
  not public.arena_tick_capacity_fits(383, 388, 0, 5),
  'a nominally saturated Round is blocked before the market boundary'
);

select * from finish();
rollback;
