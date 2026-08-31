-- Restore cross-Season Agent Bundle reuse.
--
-- Migration 056 applied its exception by text substitution on the deployed
-- open_decision_invocation body. Migration 202608310003 replaced that whole
-- function from the original 005 definition to add the baseline artifact-kind
-- branch, and silently reverted 056 with it: an Agent seat whose Bundle bytes
-- were first registered under an earlier Season would fail the invocation
-- fence again. This re-applies 056 on top of the baseline-aware body.
--
-- The substitution self-verifies with strpos, so a future body that no longer
-- contains the guard fails loudly instead of leaving the exception dropped.
-- That check is exactly what did not exist when 202608310003 overwrote it.

begin;

do $migration$
declare
  v_function_oid oid;
  v_definition text;
  v_original constant text := $original$    or v_bundle.season_id is distinct from p_season_id
    or (v_bundle.run_id is not null and v_bundle.run_id is distinct from p_run_id)$original$;
  v_replacement constant text := $replacement$    or (
      v_bundle.season_id is distinct from p_season_id
      and not exists (
        select 1 from public.season_entrant as entrant
         where entrant.season_id = p_season_id
           and entrant.run_id = p_run_id
           and entrant.bundle_sha256 = v_bundle.sha256
      )
    )
    or (v_bundle.run_id is not null and v_bundle.run_id is distinct from p_run_id)$replacement$;
begin
  select procedure.oid into strict v_function_oid
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
   where namespace.nspname = 'public'
     and procedure.proname = 'open_decision_invocation';
  select pg_get_functiondef(v_function_oid) into v_definition;
  if strpos(v_definition, v_original) = 0 then
    raise exception 'open_decision_invocation Bundle scope guard changed unexpectedly'
      using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_original, v_replacement);
  execute v_definition;
end;
$migration$;

comment on function public.open_decision_invocation(
  text, uuid, uuid, uuid, bigint, text, text, uuid, uuid, uuid,
  timestamptz, timestamptz, timestamptz, text[], timestamptz, text
) is
  'Opens one exact decision; artifact kinds follow the entrant execution class, and cross-Season Bundle reuse requires the current immutable entrant seat to bind the same SHA-256.';

commit;
