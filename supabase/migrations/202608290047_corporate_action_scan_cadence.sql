begin;

create or replace function public.get_latest_corporate_action_scan_observed_at()
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select max(scan.observed_at)
  from public.corporate_action_scan as scan
$$;

revoke all on function public.get_latest_corporate_action_scan_observed_at()
  from public, anon, authenticated;
grant execute on function public.get_latest_corporate_action_scan_observed_at()
  to service_role;

comment on function public.get_latest_corporate_action_scan_observed_at() is
  'Returns the durable corporate-action polling fence for stateless Workers.';

commit;
