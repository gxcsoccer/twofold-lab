begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(4);

select has_function(
  'public', 'get_latest_corporate_action_scan_observed_at', array[]::text[],
  'stateless Workers read one durable corporate-action cadence fence'
);

create temporary table corporate_action_cadence_expected on commit drop as
select max(observed_at) as observed_at from public.corporate_action_scan;
grant select on corporate_action_cadence_expected to service_role;

set local role service_role;
select ok(
  public.get_latest_corporate_action_scan_observed_at()
    is not distinct from (
      select observed_at from corporate_action_cadence_expected
    ),
  'the service boundary returns the latest persisted observation'
);
reset role;

select ok(
  has_function_privilege(
    'service_role',
    'public.get_latest_corporate_action_scan_observed_at()',
    'EXECUTE'
  ),
  'the Worker service role can read the cadence fence'
);

set local role anon;
select throws_ok(
  $$select public.get_latest_corporate_action_scan_observed_at()$$,
  '42501', null,
  'anonymous callers cannot inspect private provider cadence'
);
reset role;

select * from finish();
rollback;
