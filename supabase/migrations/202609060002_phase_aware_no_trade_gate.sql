-- An accepted target invalidates a stale decision-failure recovery, but does
-- not prove execution succeeded. Later execution failures still need valuation
-- of the actual ledger. Keep the terminal-source and existing-valuation fences.
begin;
do $migration$
declare
  v_definition text;
  v_original constant text := $original$         join public.accepted_target_submission as submission
           on submission.decision_id = entry.decision_id
        where entry.round_entry_id = request.round_entry_id$original$;
  v_replacement constant text := $replacement$         join public.accepted_target_submission as submission
           on submission.decision_id = entry.decision_id
         join public.arena_work_item as source
           on source.work_item_id = request.source_work_item_id
        where entry.round_entry_id = request.round_entry_id
          and source.phase = 'RUN_AGENT_DECISION'$replacement$;
begin
  select pg_get_functiondef('public.claim_arena_no_trade_recovery(text,integer,timestamptz)'::regprocedure)
    into v_definition;
  if strpos(v_definition, v_original) = 0 then
    raise exception 'no-trade accepted-submission fence changed unexpectedly' using errcode = '55000';
  end if;
  execute replace(v_definition, v_original, v_replacement);
end;
$migration$;
comment on function public.claim_arena_no_trade_recovery(text,integer,timestamptz) is
  'Claims after shared S2 evidence while the source remains terminal and no S2 valuation exists; accepted submissions fence stale decision failures, not later execution failures.';
commit;
