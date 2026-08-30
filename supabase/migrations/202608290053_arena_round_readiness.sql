-- Static pre-market readiness for one immutable Round. Runtime liveness remains
-- in get_arena_operational_health; this boundary proves that the competition
-- structure, equal-genesis accounts, work DAG, decisions, and S1 plans exist.

begin;

create or replace function public.get_arena_round_readiness(
  p_round_id uuid,
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_round public.arena_round%rowtype;
  v_season public.arena_season%rowtype;
  v_blockers jsonb := '[]'::jsonb;
  v_rulebook_count bigint := 0;
  v_genesis_count bigint := 0;
  v_genesis_sha text;
  v_entrant_count bigint := 0;
  v_account_count bigint := 0;
  v_head_count bigint := 0;
  v_universe_count bigint := 0;
  v_entry_count bigint := 0;
  v_work_count bigint := 0;
  v_decision_count bigint := 0;
  v_frozen_s1_count bigint := 0;
  v_prepared_s1_count bigint := 0;
  v_successful_pre_s1_work_count bigint := 0;
  v_dag_complete boolean := false;
begin
  if p_round_id is null or p_now is null then
    raise exception 'invalid Arena Round readiness request'
      using errcode = '22023';
  end if;

  select * into v_round from public.arena_round
   where round_id = p_round_id;
  if v_round.round_id is null then
    return jsonb_build_object(
      'schema', 'twofold.arena_round_readiness/v1',
      'checkedAt', to_char(
        p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'status', 'BLOCKED',
      'readyForS1', false,
      'seasonId', null,
      'seasonCode', null,
      'roundId', p_round_id::text,
      'roundIndex', null,
      'evidence', jsonb_build_object(
        'rulebookCount', '0',
        'genesisCount', '0',
        'entrantCount', '0',
        'initializedAccountCount', '0',
        'ledgerHeadCount', '0',
        'universeMemberCount', '0',
        'roundEntryCount', '0',
        'workItemCount', '0',
        'acceptedDecisionCount', '0',
        'frozenS1PlanCount', '0',
        'preparedS1ResultCount', '0',
        'successfulPreS1WorkCount', '0'
      ),
      'blockers', jsonb_build_array(jsonb_build_object(
        'code', 'ROUND_MISSING',
        'detail', 'The requested immutable Arena Round does not exist.'
      ))
    );
  end if;

  select * into strict v_season from public.arena_season
   where season_id = v_round.season_id;
  select count(*) into v_rulebook_count
    from public.arena_execution_rulebook
   where season_id = v_round.season_id;
  select count(*), min(economic_state_sha256)
    into v_genesis_count, v_genesis_sha
    from public.competition_genesis
   where season_id = v_round.season_id;
  select count(*) into v_entrant_count
    from public.season_entrant
   where season_id = v_round.season_id;
  select count(*) into v_account_count
    from public.season_entrant as entrant
    join public.strategy_account as account on account.run_id = entrant.run_id
   where entrant.season_id = v_round.season_id
     and account.live_trading is false
     and account.metadata->>'seasonId' = v_round.season_id::text
     and account.metadata->>'competitionGenesisSha256' = v_genesis_sha;
  select count(*) into v_head_count
    from public.season_entrant as entrant
    join public.strategy_account as account on account.run_id = entrant.run_id
    join public.strategy_ledger_head as head
      on head.strategy_account_id = account.strategy_account_id
   where entrant.season_id = v_round.season_id
     and account.metadata->>'competitionGenesisSha256' = v_genesis_sha
     and head.genesis_manifest->>'competitionGenesisSha256' = v_genesis_sha;
  select count(*) into v_universe_count
    from public.market_snapshot_member
   where snapshot_id = v_round.decision_snapshot_id;
  select count(*) into v_entry_count
    from public.arena_round_entry
   where round_id = v_round.round_id;
  select count(*) into v_work_count
    from public.arena_work_item
   where round_id = v_round.round_id;
  select count(*) into v_decision_count
    from public.arena_round_entry as entry
    join public.accepted_target_submission as submission
      on submission.decision_id = entry.decision_id
   where entry.round_id = v_round.round_id;
  select count(*) into v_frozen_s1_count
    from public.arena_round_entry as entry
    join public.frozen_order_plan as plan
      on plan.decision_id = entry.decision_id and plan.stage = 'S1'
   where entry.round_id = v_round.round_id;
  select count(*) into v_prepared_s1_count
    from public.arena_round_entry as entry
    join public.arena_cycle_stage_result as result
      on result.round_entry_id = entry.round_entry_id
     and result.phase = 'PREPARE_S1_ORDERS'
   where entry.round_id = v_round.round_id;
  select count(*) into v_successful_pre_s1_work_count
    from public.arena_work_item
   where round_id = v_round.round_id
     and phase in ('RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS')
     and status = 'SUCCEEDED';
  v_dag_complete := v_entry_count > 0
    and v_work_count = v_entry_count * 8
    and not exists (
      select 1
        from public.arena_round_entry as entry
        left join public.arena_work_item as item
          on item.round_entry_id = entry.round_entry_id
       where entry.round_id = v_round.round_id
       group by entry.round_entry_id
      having count(item.work_item_id) <> 8
         or count(item.work_item_id) filter (where item.phase in (
              'RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS',
              'CAPTURE_S1_OPEN_REFERENCE', 'CAPTURE_S1_CLOSE',
              'SETTLE_S1_AND_PREPARE_S2', 'CAPTURE_S2_OPEN_REFERENCE',
              'CAPTURE_S2_CLOSE', 'FINALIZE_ACCEPTED_TARGET_CYCLE'
            )) <> 8
    );

  if v_rulebook_count <> 1 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'RULEBOOK_INCOMPLETE',
      'detail', 'The Season must bind exactly one immutable execution rulebook.'
    ));
  end if;
  if v_genesis_count <> 1 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'GENESIS_INCOMPLETE',
      'detail', 'The Season must bind exactly one shared competition genesis.'
    ));
  end if;
  if v_entrant_count < 2 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'COMPETITION_REQUIRES_TWO_ENTRANTS',
      'detail', 'A ranked competition requires at least two immutable entrants.'
    ));
  end if;
  if v_account_count <> v_entrant_count or v_head_count <> v_entrant_count then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'EQUAL_GENESIS_ACCOUNTS_INCOMPLETE',
      'detail', 'Every entrant must have one paper account and ledger head bound to the shared genesis hash.'
    ));
  end if;
  if v_universe_count = 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'DECISION_UNIVERSE_EMPTY',
      'detail', 'The shared decision snapshot must contain at least one instrument.'
    ));
  end if;
  if v_entry_count <> v_entrant_count then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'ROUND_ENTRIES_INCOMPLETE',
      'detail', 'Every Season entrant must have exactly one seat in the Round.'
    ));
  end if;
  if not v_dag_complete then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'ROUND_WORK_DAG_INCOMPLETE',
      'detail', 'Every Round entry must have all eight immutable cadence phases.'
    ));
  end if;
  if v_decision_count <> v_entry_count then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'ACCEPTED_DECISIONS_INCOMPLETE',
      'detail', 'Every Round entry must have one accepted target submission.'
    ));
  end if;
  if v_frozen_s1_count <> v_entry_count
    or v_prepared_s1_count <> v_entry_count
    or v_successful_pre_s1_work_count <> v_entry_count * 2
  then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'S1_PLANS_INCOMPLETE',
      'detail', 'Every accepted decision must have a successful immutable S1 plan before open.'
    ));
  end if;

  return jsonb_build_object(
    'schema', 'twofold.arena_round_readiness/v1',
    'checkedAt', to_char(
      p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'status', case when jsonb_array_length(v_blockers) = 0
      then 'READY_FOR_S1' else 'BLOCKED' end,
    'readyForS1', jsonb_array_length(v_blockers) = 0,
    'seasonId', v_season.season_id::text,
    'seasonCode', v_season.season_code,
    'roundId', v_round.round_id::text,
    'roundIndex', v_round.round_index::text,
    'evidence', jsonb_build_object(
      'rulebookCount', v_rulebook_count::text,
      'genesisCount', v_genesis_count::text,
      'entrantCount', v_entrant_count::text,
      'initializedAccountCount', v_account_count::text,
      'ledgerHeadCount', v_head_count::text,
      'universeMemberCount', v_universe_count::text,
      'roundEntryCount', v_entry_count::text,
      'workItemCount', v_work_count::text,
      'acceptedDecisionCount', v_decision_count::text,
      'frozenS1PlanCount', v_frozen_s1_count::text,
      'preparedS1ResultCount', v_prepared_s1_count::text,
      'successfulPreS1WorkCount', v_successful_pre_s1_work_count::text
    ),
    'blockers', v_blockers
  );
end;
$$;

comment on function public.get_arena_round_readiness(uuid, timestamptz) is
  'Fail-closed static proof that one immutable Round is structurally ready for S1; combine with operational health for runtime liveness.';

revoke all on function public.get_arena_round_readiness(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_arena_round_readiness(uuid, timestamptz)
  to service_role;

commit;
