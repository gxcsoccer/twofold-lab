begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(8);

select has_table('public', 'arena_work_recovery',
  'failed work recovery has an immutable audit table');
select ok(to_regprocedure(
  'public.recover_failed_arena_work_item(uuid,bigint,text,text)'
) is not null,
  'operators have one narrow failed-work recovery boundary');
select ok(has_table_privilege('service_role', 'public.arena_work_recovery', 'SELECT'),
  'the private Worker can inspect recovery evidence');
select ok(not has_table_privilege('anon', 'public.arena_work_recovery', 'SELECT'),
  'anonymous callers cannot inspect recovery evidence');
select ok(has_function_privilege('service_role',
  'public.recover_failed_arena_work_item(uuid,bigint,text,text)', 'EXECUTE'),
  'the private Worker can execute recovery');
select ok(not has_function_privilege('anon',
  'public.recover_failed_arena_work_item(uuid,bigint,text,text)', 'EXECUTE'),
  'anonymous callers cannot execute recovery');
select ok(exists (
  select 1 from pg_trigger
   where tgrelid = 'public.arena_work_recovery'::regclass
     and tgname = 'arena_work_recovery_is_immutable'
     and not tgisinternal
),
  'recovery evidence is immutable');
select ok(exists (
  select 1 from pg_constraint
   where conrelid = 'public.arena_work_recovery'::regclass
     and conname = 'arena_work_recovery_attempt_unique'
     and contype = 'u'
),
  'one failed attempt count can be recovered only once');

select * from finish();
rollback;
