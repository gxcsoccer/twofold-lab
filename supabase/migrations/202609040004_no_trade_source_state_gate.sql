-- A terminal Agent task enqueues no-trade recovery immediately. If an operator
-- safely reopens that task, the old recovery row remains immutable and must not
-- race the repaired task at S2 close. Claim only while the source is still
-- terminal and the seat has neither an accepted decision nor an S2 valuation.

begin;

do $migration$
declare
  v_function_oid oid;
  v_definition text;
  v_original constant text := $original$     and request.scheduled_at <= p_now
     and exists ($original$;
  v_replacement constant text := $replacement$     and request.scheduled_at <= p_now
     and exists (
       select 1
         from public.arena_work_item as source
        where source.work_item_id = request.source_work_item_id
          and source.status in ('FAILED', 'CANCELED')
     )
     and not exists (
       select 1
         from public.arena_round_entry as entry
         join public.accepted_target_submission as submission
           on submission.decision_id = entry.decision_id
        where entry.round_entry_id = request.round_entry_id
     )
     and not exists (
       select 1
         from public.arena_valuation as valuation
        where valuation.round_entry_id = request.round_entry_id
          and valuation.stage = 'S2_CLOSE'
     )
     and exists ($replacement$;
begin
  select procedure.oid into strict v_function_oid
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
   where namespace.nspname = 'public'
     and procedure.proname = 'claim_arena_no_trade_recovery';
  select pg_get_functiondef(v_function_oid) into v_definition;
  if strpos(v_definition, v_original) = 0 then
    raise exception 'claim_arena_no_trade_recovery schedule fence changed unexpectedly'
      using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_original, v_replacement);
  execute v_definition;
end;
$migration$;

comment on function public.claim_arena_no_trade_recovery(
  text, integer, timestamptz
) is
  'Claims no-trade carry-forward only after shared S2 evidence exists, while the source task remains terminal and the seat has no accepted decision or S2 valuation.';

commit;
