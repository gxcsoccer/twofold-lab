-- Agent Bundle bytes are content-addressed and may be reused by a later
-- immutable Season. Cross-Season reuse is allowed only when the current seat
-- independently freezes the exact same Bundle SHA-256.

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
  'Opens one exact decision; cross-Season Bundle reuse requires the current immutable entrant seat to bind the same SHA-256.';

commit;
