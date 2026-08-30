begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(12);

select ok(
  to_regclass('public.arena_tick_observation') is not null,
  'serverless Arena passes leave durable observations'
);
select ok(
  to_regprocedure(
    'public.register_arena_tick_observation(text,timestamptz,timestamptz,text,jsonb,jsonb)'
  ) is not null,
  'the Worker can register one exact rolling-deploy-compatible phase result'
);
select ok(
  to_regprocedure(
    'public.get_arena_operational_health(text,timestamptz)'
  ) is not null,
  'private operations can derive health from durable evidence'
);
select ok(exists (
  select 1 from pg_trigger
   where tgrelid = 'public.arena_tick_observation'::regclass
     and tgname = 'arena_tick_observation_is_immutable'
     and not tgisinternal
  ),
  'tick observations are immutable'
);
select ok(
  has_function_privilege('service_role',
    'public.register_arena_tick_observation(text,timestamptz,timestamptz,text,jsonb,jsonb)',
    'EXECUTE'),
  'the private Worker can register tick evidence'
);
select ok(
  not has_function_privilege('anon',
    'public.get_arena_operational_health(text,timestamptz)', 'EXECUTE'),
  'anonymous callers cannot inspect private operational health'
);

set local role service_role;

select is(
  (public.register_arena_tick_observation(
    'pgtap:arena-observer',
    '2026-08-29T09:00:00.000Z'::timestamptz,
    '2026-08-29T09:00:01.250Z'::timestamptz,
    'completed',
    '["CAPTURE_S1_OPEN_REFERENCE","PROVISION_NEXT_ROUND"]'::jsonb,
    '{"agent":"idle","cycle":"completed","market":"idle","corporateActionScan":"idle","corporateActionAccount":"idle","recovery":"idle","season":"idle"}'::jsonb
  )->>'schema'),
  'twofold.arena_tick_observation/v1',
  'registration returns the versioned observation contract'
);
select is(
  (public.register_arena_tick_observation(
    'pgtap:arena-observer',
    '2026-08-29T09:00:00.000Z'::timestamptz,
    '2026-08-29T09:00:01.250Z'::timestamptz,
    'completed',
    '["CAPTURE_S1_OPEN_REFERENCE","PROVISION_NEXT_ROUND"]'::jsonb,
    '{"agent":"idle","cycle":"completed","market":"idle","corporateActionScan":"idle","corporateActionAccount":"idle","recovery":"idle","season":"idle"}'::jsonb
  )->>'workerId'),
  'pgtap:arena-observer',
  'an exact retry is idempotent'
);
select ok(
  not public.jsonb_contains_number(public.register_arena_tick_observation(
    'pgtap:arena-observer',
    '2026-08-29T09:00:00.000Z'::timestamptz,
    '2026-08-29T09:00:01.250Z'::timestamptz,
    'completed',
    '["CAPTURE_S1_OPEN_REFERENCE","PROVISION_NEXT_ROUND"]'::jsonb,
    '{"agent":"idle","cycle":"completed","market":"idle","corporateActionScan":"idle","corporateActionAccount":"idle","recovery":"idle","season":"idle"}'::jsonb
  )),
  'tick evidence never introduces JSON numbers'
);
select throws_ok(
  $$select public.register_arena_tick_observation(
    'pgtap:arena-observer:bad',
    '2026-08-29T09:01:00.000Z'::timestamptz,
    '2026-08-29T09:01:01.000Z'::timestamptz,
    'idle',
    '["PROVISION_NEXT_ROUND"]'::jsonb,
    '{"agent":"idle","cycle":"completed","market":"idle","corporateActionScan":"idle","corporateActionAccount":"idle","recovery":"idle","season":"idle"}'::jsonb
  )$$,
  '22023', null,
  'the aggregate result cannot hide a completed or failed phase'
);
select is(
  (public.get_arena_operational_health(
    'pgtap:arena-observer',
    '2026-08-29T09:02:00.000Z'::timestamptz
  )->>'schema'),
  'twofold.arena_operational_health/v1',
  'health uses one versioned private contract'
);
select ok(
  not public.jsonb_contains_number(public.get_arena_operational_health(
    'pgtap:arena-observer',
    '2026-08-29T09:02:00.000Z'::timestamptz
  )),
  'health evidence is number-free across the API boundary'
);

reset role;
select * from finish();
rollback;
