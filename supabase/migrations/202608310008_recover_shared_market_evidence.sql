-- Allow audited recovery of shared market-evidence work after a decision is
-- accepted.
--
-- recover_failed_arena_work_item refuses any seat that already holds an
-- accepted target submission. For a contestant-local phase that fence is
-- exactly right: reopening your own execution once the decision is known would
-- let a failed attempt be retried against later information.
--
-- It is wrong for the four shared capture phases. They record objective market
-- facts for the whole Round - the first-minute reference and the session close
-- - which are identical for every entrant and independent of any submission.
-- Refusing them means a provider-shape defect in the capture path is
-- unrecoverable for every Round that has reached S1, which is every Round that
-- has a decision at all.
--
-- The deadline fence and the no-active-downstream fence still apply unchanged,
-- so recovery still cannot resurrect work past its frozen window or behind work
-- that already consumed its output.

begin;

do $migration$
declare
  v_function_oid oid;
  v_definition text;
  v_original constant text := $original$    or exists (
      select 1 from public.arena_round_entry as entry
      join public.accepted_target_submission as submission
        on submission.decision_id = entry.decision_id
     where entry.round_entry_id = v_item.round_entry_id
    )$original$;
  v_replacement constant text := $replacement$    or (
      v_item.phase not in (
        'CAPTURE_S1_OPEN_REFERENCE', 'CAPTURE_S1_CLOSE',
        'CAPTURE_S2_OPEN_REFERENCE', 'CAPTURE_S2_CLOSE'
      )
      and exists (
        select 1 from public.arena_round_entry as entry
        join public.accepted_target_submission as submission
          on submission.decision_id = entry.decision_id
       where entry.round_entry_id = v_item.round_entry_id
      )
    )$replacement$;
begin
  select procedure.oid into strict v_function_oid
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
   where namespace.nspname = 'public'
     and procedure.proname = 'recover_failed_arena_work_item';
  select pg_get_functiondef(v_function_oid) into v_definition;
  if strpos(v_definition, v_original) = 0 then
    raise exception 'recover_failed_arena_work_item submission fence changed unexpectedly'
      using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_original, v_replacement);
  execute v_definition;
end;
$migration$;

comment on function public.recover_failed_arena_work_item(
  uuid, bigint, text, text
) is
  'Audited recovery of one failed Arena work item. A contestant-local phase is refused once its seat holds an accepted target; the four shared market-capture phases are recoverable because they record Round-wide market facts, not that entrant''s execution.';

commit;
