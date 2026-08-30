-- One private, read-only Arena projection built directly from authoritative
-- Season, Round, queue, and valuation state.  The dashboard must not wait for
-- a second mutable projection writer before a real competition can be seen.

begin;

create or replace function public.get_private_arena_overview(
  p_season_id uuid default null,
  p_as_of timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_season public.arena_season%rowtype;
  v_round public.arena_round%rowtype;
  v_as_of timestamptz;
  v_season_status text;
  v_round_stage text;
  v_entry_count bigint;
  v_final_count bigint;
  v_entrants jsonb;
begin
  if p_as_of is null then
    raise exception 'Arena overview requires an as-of instant'
      using errcode = '22023';
  end if;
  v_as_of := p_as_of;

  select season.* into v_season
    from public.arena_season as season
   where p_season_id is null or season.season_id = p_season_id
   order by season.opens_at desc, season.season_id
   limit 1;
  if not found then
    raise exception 'Arena Season is missing' using errcode = 'P0002';
  end if;

  select round.* into v_round
    from public.arena_round as round
   where round.season_id = v_season.season_id
   order by
     case when round.decision_window_opens_at <= v_as_of then 0 else 1 end,
     case when round.decision_window_opens_at <= v_as_of
       then round.round_index end desc,
     case when round.decision_window_opens_at > v_as_of
       then round.round_index end asc,
     round.round_id
   limit 1;

  if v_as_of < v_season.opens_at then
    v_season_status := 'UPCOMING';
  elsif v_as_of < v_season.closes_at then
    v_season_status := 'RUNNING';
  else
    v_season_status := 'COMPLETE';
  end if;

  if v_round.round_id is null then
    v_round_stage := null;
    v_entry_count := 0;
    v_final_count := 0;
  else
    select count(*) into v_entry_count
      from public.arena_round_entry
     where round_id = v_round.round_id;
    select count(*) into v_final_count
      from public.arena_valuation
     where round_id = v_round.round_id and stage = 'S2_CLOSE';

    v_round_stage := case
      when v_entry_count > 0 and v_final_count = v_entry_count then 'COMPLETE'
      when v_as_of < v_round.decision_window_opens_at then 'SCHEDULED'
      when v_as_of <= v_round.decision_window_closes_at then 'DECISION_WINDOW'
      when v_as_of < v_round.s1_open_at then 'WAITING_S1_OPEN'
      when v_as_of < v_round.s1_close_at then 'S1_EXECUTION'
      when v_as_of < v_round.s2_open_at then 'SETTLING_S1'
      when v_as_of < v_round.s2_close_at then 'S2_EXECUTION'
      else 'FINALIZING'
    end;
  end if;

  with leaderboard as (
    select item
      from jsonb_array_elements(
        public.get_arena_leaderboard(v_season.season_id)
      ) as entry(item)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'schema', 'twofold.private_arena_entrant_overview/v1',
    'rank', leaderboard.item->>'rank',
    'entrantId', entrant.entrant_id::text,
    'entrantCode', entrant.entrant_code,
    'runId', entrant.run_id::text,
    'bundleId', entrant.bundle_id,
    'presetId', entrant.preset_id,
    'provider', entrant.provider,
    'model', entrant.model,
    'executionClass', entrant.execution_class,
    'roundEntryId', round_entry.round_entry_id::text,
    'decisionId', round_entry.decision_id::text,
    'valuation', case when leaderboard.item is null then null else
      jsonb_build_object(
        'schema', 'twofold.private_arena_score/v1',
        'stage', leaderboard.item->>'stage',
        'roundIndex', leaderboard.item->>'roundIndex',
        'valuationAt', leaderboard.item->>'valuationAt',
        'brokerNav', leaderboard.item->>'brokerNav',
        'taxReservedNav', leaderboard.item->>'taxReservedNav',
        'liquidationNav', leaderboard.item->>'liquidationNav',
        'scoreBaseLiquidationNav',
          leaderboard.item->>'scoreBaseLiquidationNav',
        'returnMultiple', leaderboard.item->>'returnMultiple',
        'valuationSha256', leaderboard.item->>'valuationSha256'
      )
    end,
    'work', coalesce(work.items, '[]'::jsonb)
  ) order by
    coalesce((leaderboard.item->>'rank')::bigint, 9223372036854775807),
    entrant.entrant_code), '[]'::jsonb)
  into v_entrants
  from public.season_entrant as entrant
  left join public.arena_round_entry as round_entry
    on round_entry.round_id = v_round.round_id
   and round_entry.entrant_id = entrant.entrant_id
  left join leaderboard
    on leaderboard.item->>'entrantId' = entrant.entrant_id::text
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'schema', 'twofold.private_arena_work_overview/v1',
      'phase', item.phase,
      'status', item.status,
      'scheduledAt', to_char(
        item.scheduled_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'deadlineAt', case when item.deadline_at is null then null else to_char(
        item.deadline_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) end,
      'attemptCount', item.attempt_count::text,
      'errorCode', item.error_code
    ) order by case item.phase
      when 'RUN_AGENT_DECISION' then 1
      when 'PREPARE_S1_ORDERS' then 2
      when 'CAPTURE_S1_OPEN_REFERENCE' then 3
      when 'CAPTURE_S1_CLOSE' then 4
      when 'SETTLE_S1_AND_PREPARE_S2' then 5
      when 'CAPTURE_S2_OPEN_REFERENCE' then 6
      when 'CAPTURE_S2_CLOSE' then 7
      when 'FINALIZE_ACCEPTED_TARGET_CYCLE' then 8
    end) as items
    from public.arena_work_item as item
    where item.round_entry_id = round_entry.round_entry_id
  ) as work on true
  where entrant.season_id = v_season.season_id;

  return jsonb_build_object(
    'schema', 'twofold.private_arena_overview/v1',
    'asOf', to_char(
      v_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'season', jsonb_build_object(
      'schema', 'twofold.private_arena_season_overview/v1',
      'seasonId', v_season.season_id::text,
      'seasonCode', v_season.season_code,
      'displayName', v_season.display_name,
      'opensAt', to_char(
        v_season.opens_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'closesAt', to_char(
        v_season.closes_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'status', v_season_status,
      'decisionCadence', v_season.decision_cadence,
      'marketTimezone', v_season.market_timezone,
      'openingHolding', v_season.config->>'openingHolding',
      'openingCash', v_season.config->>'openingCash',
      'entrantCount', (
        select count(*)::text from public.season_entrant
         where season_id = v_season.season_id
      ),
      'roundCount', (
        select count(*)::text from public.arena_round
         where season_id = v_season.season_id
      )
    ),
    'currentRound', case when v_round.round_id is null then null else
      jsonb_build_object(
        'schema', 'twofold.private_arena_round_overview/v1',
        'roundId', v_round.round_id::text,
        'roundIndex', v_round.round_index::text,
        'stage', v_round_stage,
        'entryCount', v_entry_count::text,
        'finalCount', v_final_count::text,
        'decisionSessionDate', v_round.decision_session_date::text,
        'decisionWindowOpensAt', to_char(
          v_round.decision_window_opens_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'decisionWindowClosesAt', to_char(
          v_round.decision_window_closes_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        's1SessionDate', v_round.s1_session_date::text,
        's1OpenAt', to_char(
          v_round.s1_open_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        's1CloseAt', to_char(
          v_round.s1_close_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        's2SessionDate', v_round.s2_session_date::text,
        's2OpenAt', to_char(
          v_round.s2_open_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        's2CloseAt', to_char(
          v_round.s2_close_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'cycleReadyAt', to_char(
          v_round.cycle_ready_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      )
    end,
    'entrants', v_entrants
  );
end;
$$;

revoke all on function public.get_private_arena_overview(
  uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.get_private_arena_overview(
  uuid, timestamptz
) to service_role;

comment on function public.get_private_arena_overview(uuid, timestamptz) is
  'Returns one number-free, read-only private Arena snapshot derived directly from authoritative Season, Round, queue, and ranking state.';

commit;
