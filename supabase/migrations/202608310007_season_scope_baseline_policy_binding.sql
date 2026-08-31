-- Season-scope the baseline policy binding.
--
-- The binding added in 202608310006 matched the seat by run_id and SHA only.
-- season_entrant.run_id is globally unique and the SHA is a content address, so
-- a foreign policy could not actually be substituted. What the omission did
-- allow is opening an invocation whose recorded season_id is not the season the
-- run's seat belongs to, since nothing else in the function ties p_season_id to
-- the entrant. Binding the seat to the exact Season closes that independently
-- of the policy question.

begin;

do $migration$
declare
  v_function_oid oid;
  v_definition text;
  v_original constant text := $original$        select 1 from public.season_entrant as entrant
         where entrant.run_id = p_run_id
           and entrant.bundle_sha256 = v_bundle.sha256$original$;
  v_replacement constant text := $replacement$        select 1 from public.season_entrant as entrant
         where entrant.run_id = p_run_id
           and entrant.season_id = p_season_id
           and entrant.bundle_sha256 = v_bundle.sha256$replacement$;
begin
  select procedure.oid into strict v_function_oid
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
   where namespace.nspname = 'public'
     and procedure.proname = 'open_decision_invocation';
  select pg_get_functiondef(v_function_oid) into v_definition;
  -- Two occurrences: the cross-Season Agent Bundle exception from 056 and the
  -- baseline policy binding from 006. Only the baseline binding is Season
  -- scoped here; the Agent exception exists precisely to permit a differing
  -- Season and already carries its own season_id predicate.
  if strpos(v_definition, v_original) = 0 then
    raise exception 'open_decision_invocation baseline policy binding changed unexpectedly'
      using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_original, v_replacement);
  execute v_definition;
end;
$migration$;

commit;
