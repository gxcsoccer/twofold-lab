-- Two gaps in the baseline boundary.
--
-- 1. open_decision_invocation checked the policy artifact only by kind and
--    scope. The immutable seat freezes an exact bundle_sha256, but nothing
--    required the presented artifact to be that policy, so a service-role
--    caller could open a baseline decision under any registered policy row in
--    the same Season. The Worker already checks this, but Postgres is supposed
--    to verify independently rather than trust the executor.
--
-- 2. The zero-token invariant was enforced by two BEFORE triggers that each
--    read the opposite table. Two concurrent transactions could both see no
--    row and both commit, so the invariant did not hold under concurrency.
--    Both paths now serialize on the same decision-scoped advisory lock first.

begin;

do $migration$
declare
  v_function_oid oid;
  v_definition text;
  v_original constant text := $original$         then 'deterministic_baseline_policy' else 'dsh_agent_bundle_manifest' end)$original$;
  v_replacement constant text := $replacement$         then 'deterministic_baseline_policy' else 'dsh_agent_bundle_manifest' end)
    or (
      v_execution_class = 'DETERMINISTIC_BASELINE'
      and not exists (
        select 1 from public.season_entrant as entrant
         where entrant.run_id = p_run_id
           and entrant.bundle_sha256 = v_bundle.sha256
      )
    )$replacement$;
begin
  select procedure.oid into strict v_function_oid
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
   where namespace.nspname = 'public'
     and procedure.proname = 'open_decision_invocation';
  select pg_get_functiondef(v_function_oid) into v_definition;
  if strpos(v_definition, v_original) = 0 then
    raise exception 'open_decision_invocation baseline artifact guard changed unexpectedly'
      using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_original, v_replacement);
  execute v_definition;
end;
$migration$;

create or replace function public.derive_decision_kind()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_execution_class text;
begin
  select entrant.execution_class into v_execution_class
    from public.season_entrant as entrant
   where entrant.run_id = new.run_id;

  new.decision_kind := case
    when v_execution_class = 'DETERMINISTIC_BASELINE'
      then 'DETERMINISTIC_BASELINE'
    else 'AGENT'
  end;

  if new.decision_kind = 'DETERMINISTIC_BASELINE' then
    -- Serialize against a concurrent model_usage_record insert for the same
    -- decision. Without this both transactions read before either commits and
    -- the invariant silently does not hold.
    perform pg_advisory_xact_lock(
      hashtextextended('twofold.baseline_usage:' || new.decision_id::text, 0)
    );
    if exists (
      select 1 from public.model_usage_record as usage
       where usage.decision_id = new.decision_id
    ) then
      raise exception
        'a deterministic baseline decision cannot record model usage'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.reject_baseline_model_usage()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('twofold.baseline_usage:' || new.decision_id::text, 0)
  );
  if exists (
    select 1 from public.decision_invocation as invocation
     where invocation.decision_id = new.decision_id
       and invocation.decision_kind = 'DETERMINISTIC_BASELINE'
  ) then
    raise exception
      'a deterministic baseline decision cannot record model usage'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.derive_decision_kind()
  from public, anon, authenticated, service_role;
revoke all on function public.reject_baseline_model_usage()
  from public, anon, authenticated, service_role;

commit;
