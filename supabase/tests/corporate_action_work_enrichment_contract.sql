-- Retirement filtering composes with the complete corporate-action work
-- envelope and its bounded pre-open preparation window.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(5);

select ok(
  pg_get_functiondef(
    'public.get_corporate_action_account_work(timestamptz)'::regprocedure
  ) like '%''instrumentId''%',
  'corporate-action work retains stable instrument identity'
);
select ok(
  pg_get_functiondef(
    'public.get_corporate_action_account_work(timestamptz)'::regprocedure
  ) like '%WAITING_PREPARATION%',
  'corporate-action work retains its bounded preparation phase'
);
select ok(
  pg_get_functiondef(
    'public.get_corporate_action_account_work(timestamptz)'::regprocedure
  ) like '%arena_season_retirement%',
  'corporate-action work still excludes retired Seasons'
);

set local role service_role;
with work as (
  select public.get_corporate_action_account_work(clock_timestamp()) as value
)
select ok(not exists (
  select 1 from work,
    jsonb_array_elements(work.value->'items') as item(value)
   where item.value->>'instrumentId' is null
      or item.value->>'instrumentId'
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
), 'every exposed account action has a stable instrument identity');
with work as (
  select public.get_corporate_action_account_work(clock_timestamp()) as value
)
select ok(not exists (
  select 1 from work,
    jsonb_array_elements(work.value->'items') as item(value)
   where item.value->>'phase' = 'PREPARE'
     and (item.value->>'exDateOpenAt')::timestamptz
       > (work.value->>'asOf')::timestamptz + interval '30 minutes'
), 'preparation is never exposed more than thirty minutes before ex-date open');
reset role;

select * from finish();
rollback;
