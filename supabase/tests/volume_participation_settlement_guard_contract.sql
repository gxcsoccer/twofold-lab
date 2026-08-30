begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(11);

select ok(
  to_regprocedure('public.arena_maximum_minute_fill(text,text)') is not null,
  'the database owns the minute participation capacity formula'
);
select ok(
  to_regprocedure(
    'public.assert_arena_minute_participation_settlements(jsonb,jsonb,uuid,date,text)'
  ) is not null,
  'the database independently validates settlement evidence and quantities'
);
select ok(exists (
  select 1 from pg_trigger
   where tgrelid = 'public.arena_cycle_stage_result'::regclass
     and tgname = 'arena_cycle_stage_volume_participation_guard'
     and not tgisinternal
), 'the S1 checkpoint cannot bypass the volume cap');
select ok(exists (
  select 1 from pg_trigger
   where tgrelid = 'public.accepted_target_cycle'::regclass
     and tgname = 'accepted_target_cycle_volume_participation_guard'
     and not tgisinternal
), 'the final S2 commit cannot bypass the volume cap');
select is(
  public.arena_maximum_minute_fill('12345', '100'),
  '123',
  'one percent participation floors to whole shares'
);
select is(
  public.arena_maximum_minute_fill('99', '100'),
  '0',
  'the database never invents a minimum one-share fill'
);
select is(
  public.arena_maximum_minute_fill('12345', '10000'),
  '12345',
  'full participation cannot exceed observed volume'
);
select throws_ok(
  $$select public.arena_maximum_minute_fill('12345', '0')$$,
  '22023', null,
  'zero participation is not a valid execution policy'
);
select throws_ok(
  $$select public.arena_maximum_minute_fill('12.5', '100')$$,
  '22023', null,
  'fractional provider volume is rejected'
);
select ok(
  has_function_privilege('service_role',
    'public.assert_arena_minute_participation_settlements(jsonb,jsonb,uuid,date,text)',
    'EXECUTE'),
  'the private commit boundary can invoke the independent guard'
);
select ok(
  not has_function_privilege('anon',
    'public.assert_arena_minute_participation_settlements(jsonb,jsonb,uuid,date,text)',
    'EXECUTE'),
  'anonymous callers cannot probe private settlement evidence'
);

select * from finish();
rollback;
