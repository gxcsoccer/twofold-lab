-- One database-authoritative input boundary for all three deterministic cycle
-- stages. Each stage receives only evidence that should exist at that point in
-- real time; future-session rows are omitted from the JSON shape entirely.

begin;

create or replace function public.arena_market_close_material(
  p_snapshot_id uuid
)
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
set row_security = off
as $$
  select jsonb_build_object(
    'schema', 'twofold.arena_market_close_material/v1',
    'snapshotId', snapshot.snapshot_id::text,
    'sourceVersionId', snapshot.source_version_id::text,
    'manifestSha256', snapshot.manifest_sha256,
    'sessionDate', snapshot.target_session_date::text,
    'cutoffAt', to_char(
      snapshot.cutoff_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'sealedAt', to_char(
      snapshot.sealed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'marks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'factId', fact.fact_id::text,
        'symbol', fact.symbol,
        'currency', fact.currency,
        'value', fact.close_price,
        'sessionDate', fact.bar_date::text,
        'visibleAt', to_char(
          delivery.first_observed_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'snapshotId', snapshot.snapshot_id::text,
        'factSha256', fact.fact_sha256,
        'sourceArtifactId', artifact.raw_artifact_id::text,
        'sourceContentSha256', artifact.response_sha256
      ) order by member.member_index)
        from public.market_snapshot_member as member
        join public.market_bar_fact as fact on fact.fact_id = member.fact_id
        join public.source_delivery as delivery
          on delivery.delivery_id = member.delivery_id
        join public.raw_artifact as artifact
          on artifact.raw_artifact_id = delivery.raw_artifact_id
       where member.snapshot_id = snapshot.snapshot_id
    ), '[]'::jsonb)
  )
    from public.market_snapshot as snapshot
   where snapshot.snapshot_id = p_snapshot_id
     and snapshot.snapshot_kind = 'market_close'
     and (
       select count(*) from public.market_snapshot_member as member
        where member.snapshot_id = snapshot.snapshot_id
     ) = cardinality(snapshot.symbols)
$$;

create or replace function public.get_arena_cycle_material(
  p_round_entry_id uuid,
  p_stage text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_entry public.arena_round_entry%rowtype;
  v_round public.arena_round%rowtype;
  v_submission public.accepted_target_submission%rowtype;
  v_account public.strategy_account%rowtype;
  v_genesis public.competition_genesis%rowtype;
  v_rulebook public.arena_execution_rulebook%rowtype;
  v_targets jsonb;
  v_portfolio jsonb;
  v_prior_cycles jsonb;
  v_decision_close jsonb;
  v_s1_open jsonb;
  v_s1_close jsonb;
  v_s1_fx jsonb;
  v_s2_open jsonb;
  v_s2_close jsonb;
  v_s2_fx jsonb;
  v_evidence jsonb;
  v_result jsonb;
begin
  if p_round_entry_id is null
    or p_stage not in (
      'PREPARE_S1_ORDERS',
      'SETTLE_S1_AND_PREPARE_S2',
      'FINALIZE_ACCEPTED_TARGET_CYCLE'
    )
  then
    raise exception 'invalid Arena cycle material request'
      using errcode = '22023';
  end if;

  select * into v_entry from public.arena_round_entry
   where round_entry_id = p_round_entry_id;
  if not found then
    raise exception 'Arena Round entry is missing'
      using errcode = 'P0002';
  end if;
  select * into strict v_round from public.arena_round
   where round_id = v_entry.round_id and season_id = v_entry.season_id;
  select * into v_submission from public.accepted_target_submission
   where decision_id = v_entry.decision_id;
  if not found then
    raise exception 'Arena entry has no accepted target submission'
      using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.decision_invocation as invocation
     where invocation.decision_id = v_entry.decision_id
       and invocation.run_id = v_entry.run_id
       and invocation.season_id = v_entry.season_id
       and invocation.market_snapshot_id = v_round.decision_snapshot_id
       and invocation.decision_at = v_round.decision_window_opens_at
       and invocation.submission_deadline_at = v_round.decision_window_closes_at
  ) then
    raise exception 'Arena decision does not match its Round fence'
      using errcode = '55000';
  end if;

  select * into v_account from public.strategy_account
   where run_id = v_entry.run_id and live_trading is false;
  if not found then
    raise exception 'Arena entry has no paper Strategy Account'
      using errcode = 'P0002';
  end if;
  select * into v_genesis from public.competition_genesis
   where season_id = v_entry.season_id
     and economic_state_sha256
       = v_account.metadata->>'competitionGenesisSha256';
  if not found then
    raise exception 'Arena account is not bound to its competition genesis'
      using errcode = '55000';
  end if;
  select * into v_rulebook from public.arena_execution_rulebook
   where season_id = v_entry.season_id;
  if not found then
    raise exception 'Arena Season has no execution rulebook'
      using errcode = 'P0002';
  end if;

  select jsonb_agg(jsonb_build_object(
    'instrumentId', symbol.instrument_id::text,
    'symbol', target.item->>'symbol',
    'targetWeightBps', target.item->>'target_weight_bps'
  ) order by (target.item->>'symbol') collate "C")
    into v_targets
    from jsonb_array_elements(v_submission.targets) as target(item)
    join lateral (
      select version.instrument_id
        from public.instrument_symbol_version as version
       where version.symbol = target.item->>'symbol'
         and version.effective_from <= v_round.decision_session_date
         and (
           version.effective_to is null
           or version.effective_to > v_round.decision_session_date
         )
       order by version.effective_from desc, version.symbol_version_id
       limit 1
    ) as symbol on true;
  if v_targets is null
    or jsonb_array_length(v_targets) <> jsonb_array_length(v_submission.targets)
  then
    raise exception 'accepted target has no unique effective stable instrument'
      using errcode = '55000';
  end if;

  v_portfolio := public.get_strategy_portfolio_state(v_entry.run_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'cycleId', cycle.cycle_id::text,
    'cycleSha256', cycle.cycle_sha256,
    'completedAt', to_char(
      cycle.completed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'cycle', cycle.cycle
  ) order by cycle.completed_at, cycle.source_stream_seq, cycle.cycle_id), '[]'::jsonb)
    into v_prior_cycles
    from public.accepted_target_cycle as cycle
   where cycle.strategy_account_id = v_account.strategy_account_id;

  v_decision_close := public.arena_market_close_material(
    v_round.decision_snapshot_id
  );
  if v_decision_close is null then
    raise exception 'decision close material is incomplete'
      using errcode = '55000';
  end if;
  v_evidence := jsonb_build_object('decisionClose', v_decision_close);

  if p_stage in (
    'SETTLE_S1_AND_PREPARE_S2', 'FINALIZE_ACCEPTED_TARGET_CYCLE'
  ) then
    v_s1_open := public.get_arena_round_open_reference(
      v_round.round_id, 'S1_OPEN_REFERENCE'
    );
    v_s1_close := public.get_arena_round_close_snapshot(
      v_round.round_id, 'S1_CLOSE'
    );
    v_s1_fx := public.get_arena_round_tax_fx_reference(
      v_round.round_id, 'S1_DISPOSITION'
    );
    if v_s1_open is null or v_s1_close is null or v_s1_fx is null then
      raise exception 'Arena cycle material evidence is not ready for requested stage'
        using errcode = 'P0002';
    end if;
    v_evidence := v_evidence || jsonb_build_object(
      's1Open', v_s1_open,
      's1Close', v_s1_close,
      's1DispositionFx', v_s1_fx
    );
  end if;

  if p_stage = 'FINALIZE_ACCEPTED_TARGET_CYCLE' then
    v_s2_open := public.get_arena_round_open_reference(
      v_round.round_id, 'S2_OPEN_REFERENCE'
    );
    v_s2_close := public.get_arena_round_close_snapshot(
      v_round.round_id, 'S2_CLOSE'
    );
    v_s2_fx := public.get_arena_round_tax_fx_reference(
      v_round.round_id, 'S2_ACQUISITION'
    );
    if v_s2_open is null or v_s2_close is null or v_s2_fx is null then
      raise exception 'Arena cycle material evidence is not ready for requested stage'
        using errcode = 'P0002';
    end if;
    v_evidence := v_evidence || jsonb_build_object(
      's2Open', v_s2_open,
      's2Close', v_s2_close,
      's2AcquisitionFx', v_s2_fx
    );
  end if;

  v_result := jsonb_build_object(
    'schema', 'twofold.arena_cycle_material/v1',
    'stage', p_stage,
    'roundEntry', jsonb_build_object(
      'roundEntryId', v_entry.round_entry_id::text,
      'roundId', v_entry.round_id::text,
      'seasonId', v_entry.season_id::text,
      'entrantId', v_entry.entrant_id::text,
      'runId', v_entry.run_id::text,
      'decisionId', v_entry.decision_id::text
    ),
    'round', jsonb_build_object(
      'roundIndex', v_round.round_index::text,
      'decisionSnapshotId', v_round.decision_snapshot_id::text,
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
      's1OpenAt', to_char(v_round.s1_open_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      's1ReferenceAvailableAt', to_char(
        v_round.s1_reference_available_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      's1CloseAt', to_char(v_round.s1_close_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      's1CloseAvailableAt', to_char(
        v_round.s1_close_available_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      's2SessionDate', v_round.s2_session_date::text,
      's2OpenAt', to_char(v_round.s2_open_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      's2ReferenceAvailableAt', to_char(
        v_round.s2_reference_available_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      's2CloseAt', to_char(v_round.s2_close_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'cycleReadyAt', to_char(v_round.cycle_ready_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'acceptedSubmission', jsonb_build_object(
      'submissionId', v_submission.submission_id::text,
      'decisionId', v_submission.decision_id::text,
      'targets', v_targets,
      'cashWeightBps', v_submission.cash_weight_bps,
      'acceptedAt', to_char(v_submission.accepted_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'rulebook', v_rulebook.rulebook,
    'portfolio', v_portfolio,
    'genesis', v_genesis.economic_state,
    'priorCycles', v_prior_cycles,
    'evidence', v_evidence
  );
  if public.jsonb_contains_number(v_result) then
    raise exception 'Arena cycle material crossed the string-decimal boundary'
      using errcode = '55000';
  end if;
  return v_result;
end;
$$;

revoke all on function public.arena_market_close_material(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_arena_cycle_material(uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_arena_cycle_material(uuid, text)
  to service_role;

comment on function public.get_arena_cycle_material(uuid, text) is
  'Returns stage-gated, number-free, evidence-bound deterministic cycle inputs; future-stage evidence keys are structurally absent.';

commit;
