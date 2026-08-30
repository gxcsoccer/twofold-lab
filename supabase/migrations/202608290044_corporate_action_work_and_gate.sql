-- Turn evidence into an explicit per-account lifecycle. Preparation is due as
-- soon as a supported action is visible and must finish before ex-date open.
-- Split-adjusted units may be published operationally pre-open (the embedded
-- ledger transaction retains the exchange-open effective time); dividends do
-- not publish cash until their payable date.

begin;

-- Migration 042 originally required every application timestamp to be at or
-- after split effectiveAt. That prevents a broker-realistic pre-open share
-- adjustment and makes it impossible to freeze post-split opening orders. Patch
-- only that split clause while retaining the payable-date dividend fence.
do $$
declare
  v_oid regprocedure :=
    'public.commit_corporate_action_account_application(text,uuid,uuid,uuid,uuid,text,text,text,timestamptz,bigint,uuid,text)'::regprocedure;
  v_source text;
  v_old text := E'        or p_applied_at < (v_prepared.preparation#>>\n'
    || E'          ''{material,application,effectiveAt}'')::timestamptz\n';
begin
  select pg_get_functiondef(v_oid) into v_source;
  if position(v_old in v_source) = 0 then
    raise exception 'could not locate split due-time clause for corporate-action RPC'
      using errcode = '55000';
  end if;
  execute replace(v_source, v_old, '');
end;
$$;

create or replace function public.validate_corporate_action_preparation_economics()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_revision public.corporate_action_revision%rowtype;
  v_portfolio jsonb;
  v_position jsonb;
  v_instrument_id uuid;
  v_quantity numeric := 0;
  v_gross_cost numeric := 0;
  v_old_rate numeric;
  v_new_rate numeric;
  v_expected_quantity numeric;
begin
  select * into strict v_revision from public.corporate_action_revision
   where source_action_id = new.source_action_id
     and revision_sha256 = new.revision_sha256;
  v_portfolio := public.get_strategy_portfolio_state(new.run_id);
  if v_portfolio#>>'{ledgerHead,sequence}' <> new.ledger_head_sequence::text
    or v_portfolio#>>'{ledgerHead,sha256}' <> new.ledger_head_sha256
  then
    raise exception 'corporate-action preparation portfolio crossed its ledger fence'
      using errcode = '40001';
  end if;
  select version.instrument_id into v_instrument_id
    from public.instrument_symbol_version as version
   where version.symbol = v_revision.symbol
     and version.effective_from <= v_revision.ex_date
     and (version.effective_to is null or version.effective_to > v_revision.ex_date)
   order by version.effective_from desc, version.symbol_version_id
   limit 1;
  if v_instrument_id is null then
    raise exception 'corporate action has no unique effective instrument'
      using errcode = '55000';
  end if;
  select item.value into v_position
    from jsonb_array_elements(v_portfolio->'positions') as item(value)
   where item.value->>'instrumentId' = v_instrument_id::text;
  if found then
    v_quantity := (v_position->>'quantity')::numeric;
    v_gross_cost := (v_position->>'grossCost')::numeric;
  end if;

  if new.action_type = 'CASH_DIVIDEND' then
    if v_revision.normalized_action->>'foreign' <> 'false'
      or v_revision.normalized_action->>'special' <> 'false'
    then
      raise exception 'special or foreign cash dividend needs a newer policy interpreter'
        using errcode = '0A000';
    end if;
    if new.preparation#>>'{material,entitlement,instrumentId}'
         <> v_instrument_id::text
      or new.preparation#>>'{material,entitlement,symbol}' <> v_revision.symbol
      or (new.preparation#>>'{material,entitlement,quantity}')::numeric
         <> v_quantity
      or (new.status = 'NO_ENTITLEMENT') <> (v_quantity = 0)
    then
      raise exception 'cash-dividend entitlement differs from the fenced portfolio'
        using errcode = '22023';
    end if;
  else
    v_old_rate := (v_revision.normalized_action->>'oldRate')::numeric;
    v_new_rate := (v_revision.normalized_action->>'newRate')::numeric;
    v_expected_quantity := v_quantity * v_new_rate / v_old_rate;
    if (new.status = 'NO_POSITION') <> (v_quantity = 0) then
      raise exception 'split no-position status differs from the fenced portfolio'
        using errcode = '22023';
    end if;
    if v_quantity > 0 and (
      v_expected_quantity <> trunc(v_expected_quantity)
      or new.preparation#>>'{material,application,position,instrumentId}'
         <> v_instrument_id::text
      or new.preparation#>>'{material,application,position,symbol}'
         <> v_revision.symbol
      or (new.preparation#>>'{material,application,position,quantity}')::numeric
         <> v_expected_quantity
      or (new.preparation#>>'{material,application,position,grossCost}')::numeric
         <> v_gross_cost
      or coalesce((select sum((lot.value->>'quantity')::numeric)
        from jsonb_array_elements(
          new.preparation#>'{material,application,position,lots}'
        ) as lot(value)),0) <> v_expected_quantity
      or coalesce((select sum((lot.value->>'grossPurchasePrice')::numeric)
        from jsonb_array_elements(
          new.preparation#>'{material,application,position,lots}'
        ) as lot(value)),0) <> v_gross_cost
    ) then
      raise exception 'split adjustment differs from the fenced portfolio'
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

create trigger corporate_action_preparation_economic_fence
before insert on public.corporate_action_account_preparation
for each row execute function public.validate_corporate_action_preparation_economics();

create or replace function public.get_corporate_action_account_replay_material(
  p_strategy_account_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_account public.strategy_account%rowtype;
  v_genesis public.competition_genesis%rowtype;
  v_result jsonb;
begin
  select * into v_account from public.strategy_account
   where strategy_account_id = p_strategy_account_id and live_trading is false;
  if not found then
    raise exception 'paper Strategy Account is missing' using errcode = 'P0002';
  end if;
  select * into v_genesis from public.competition_genesis
   where economic_state_sha256 = v_account.metadata->>'competitionGenesisSha256';
  if not found then
    raise exception 'Strategy Account has no competition genesis'
      using errcode = '55000';
  end if;
  v_result := jsonb_build_object(
    'schema','twofold.corporate_action_account_replay_material/v1',
    'strategyAccountId',v_account.strategy_account_id::text,
    'runId',v_account.run_id::text,
    'portfolio',public.get_strategy_portfolio_state(v_account.run_id),
    'genesis',v_genesis.economic_state,
    'priorCycles',coalesce((select jsonb_agg(jsonb_build_object(
      'cycleId',cycle.cycle_id::text,
      'cycleSha256',cycle.cycle_sha256,
      'completedAt',to_char(cycle.completed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'cycle',cycle.cycle
    ) order by cycle.completed_at,cycle.source_stream_seq,cycle.cycle_id)
      from public.accepted_target_cycle as cycle
     where cycle.strategy_account_id = v_account.strategy_account_id),'[]'::jsonb),
    'priorCorporateActions',coalesce((select jsonb_agg(jsonb_build_object(
      'applicationId',action.application_id::text,
      'contentSha256',action.content_sha256,
      'appliedAt',to_char(action.applied_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'openingHeadSequence',action.opening_head_sequence::text,
      'finalHeadSequence',action.final_head_sequence::text,
      'application',action.application
    ) order by action.applied_at,action.source_stream_seq,action.application_id)
      from public.corporate_action_account_application as action
     where action.strategy_account_id = v_account.strategy_account_id),'[]'::jsonb),
    'runStreamHead',public.get_event_stream_head(v_account.run_id,'run')
  );
  if public.jsonb_contains_number(v_result) then
    raise exception 'corporate-action replay material contains numeric tokens'
      using errcode = '55000';
  end if;
  return v_result;
end;
$$;

create or replace function public.get_corporate_action_account_work(
  p_as_of timestamptz
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_items jsonb;
  v_result jsonb;
begin
  if p_as_of is null then
    raise exception 'corporate-action work as-of is required' using errcode = '22023';
  end if;
  with latest_revision as (
    select distinct on (revision.source_action_id)
      revision.*,scan.observed_at
      from public.corporate_action_scan_revision as observation
      join public.corporate_action_scan as scan on scan.scan_id = observation.scan_id
      join public.corporate_action_revision as revision
        on revision.source_action_id = observation.source_action_id
       and revision.revision_sha256 = observation.revision_sha256
     where scan.observed_at <= p_as_of
     order by revision.source_action_id,scan.observed_at desc,scan.scan_id desc
  ), candidates as (
    select season.season_id,account.strategy_account_id,account.run_id,
      revision.*,
      (revision.ex_date::text || ' 09:30 America/New_York')::timestamptz
        as ex_open_at,
      case when revision.action_type = 'CASH_DIVIDEND'
        then (revision.payable_date::text || ' 09:30 America/New_York')::timestamptz
        else (revision.ex_date::text || ' 09:30 America/New_York')::timestamptz
      end as due_at
      from public.arena_season as season
      join public.season_entrant as entrant on entrant.season_id = season.season_id
      join public.strategy_account as account on account.run_id = entrant.run_id
      join latest_revision as revision on revision.ex_date between
        (season.opens_at at time zone season.market_timezone)::date and
        (season.closes_at at time zone season.market_timezone)::date
     where p_as_of between season.opens_at and season.closes_at
       and exists (
         select 1 from public.arena_round as round
         join public.market_snapshot as snapshot
           on snapshot.snapshot_id = round.decision_snapshot_id
        where round.season_id = season.season_id
          and revision.symbol = any(snapshot.symbols)
       )
  ), classified as (
    select candidate.*,
      preparation.preparation_id,preparation.content_sha256 as preparation_sha256,
      preparation.status as preparation_status,preparation.preparation,
      application.application_id,
      case
        when candidate.evidence_status <> 'COMPLETE'
          or candidate.interpretation not in ('SPLIT','CASH_DIVIDEND')
          or (candidate.interpretation = 'SPLIT' and (
            candidate.normalized_action->>'oldRate' !~ '^[1-9][0-9]*$'
            or candidate.normalized_action->>'newRate' !~ '^[1-9][0-9]*$'
          ))
          or (candidate.interpretation = 'CASH_DIVIDEND' and (
            candidate.normalized_action->>'foreign' <> 'false'
            or candidate.normalized_action->>'special' <> 'false'
          )) then 'UNSUPPORTED'
        when preparation.preparation_id is null and p_as_of >= candidate.ex_open_at
          then 'MISSED_PREPARATION'
        when preparation.preparation_id is null then 'PREPARE'
        when application.application_id is not null then 'COMPLETE'
        when candidate.action_type <> 'CASH_DIVIDEND' then 'APPLY'
        when p_as_of >= candidate.due_at then 'APPLY'
        else 'WAITING_DUE'
      end as phase
      from candidates as candidate
      left join public.corporate_action_account_preparation as preparation
        on preparation.strategy_account_id = candidate.strategy_account_id
       and preparation.source_action_id = candidate.source_action_id
       and preparation.revision_sha256 = candidate.revision_sha256
      left join public.corporate_action_account_application as application
        on application.strategy_account_id = candidate.strategy_account_id
       and application.source_action_id = candidate.source_action_id
       and application.revision_sha256 = candidate.revision_sha256
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'seasonId',item.season_id::text,
    'strategyAccountId',item.strategy_account_id::text,
    'runId',item.run_id::text,
    'sourceActionId',item.source_action_id::text,
    'revisionSha256',item.revision_sha256,
    'actionType',item.action_type,
    'symbol',item.symbol,
    'interpretation',item.interpretation,
    'evidenceStatus',item.evidence_status,
    'exDate',item.ex_date::text,
    'payableDate',case when item.payable_date is null then null
      else to_jsonb(item.payable_date::text) end,
    'exDateOpenAt',to_char(item.ex_open_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'dueAt',to_char(item.due_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'observedAt',to_char(item.observed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'phase',item.phase,
    'normalizedAction',item.normalized_action,
    'preparationId',case when item.preparation_id is null then null
      else to_jsonb(item.preparation_id::text) end,
    'preparationSha256',case when item.preparation_sha256 is null then null
      else to_jsonb(item.preparation_sha256) end,
    'preparation',case when item.preparation_id is null then null
      else item.preparation end,
    'replayMaterial',public.get_corporate_action_account_replay_material(
      item.strategy_account_id)
  ) order by item.ex_open_at,item.source_action_id,item.strategy_account_id),
    '[]'::jsonb) into v_items
    from classified as item
   where item.phase in ('PREPARE','APPLY','MISSED_PREPARATION','UNSUPPORTED');
  v_result := jsonb_build_object(
    'schema','twofold.corporate_action_account_work/v1',
    'asOf',to_char(p_as_of at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'items',v_items
  );
  if public.jsonb_contains_number(v_result) then
    raise exception 'corporate-action work contains numeric tokens'
      using errcode = '55000';
  end if;
  return v_result;
end;
$$;

create or replace function public.arena_corporate_action_phase_is_clear(
  p_round_id uuid,
  p_phase text,
  p_as_of timestamptz
)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_round public.arena_round%rowtype;
  v_season public.arena_season%rowtype;
  v_through_date date;
begin
  if p_round_id is null or p_as_of is null
    or p_phase not in (
      'RUN_AGENT_DECISION','PREPARE_S1_ORDERS',
      'SETTLE_S1_AND_PREPARE_S2','FINALIZE_ACCEPTED_TARGET_CYCLE'
    ) then return false; end if;
  select * into v_round from public.arena_round where round_id = p_round_id;
  if not found then return false; end if;
  select * into v_season from public.arena_season where season_id = v_round.season_id;
  if not found then return false; end if;
  v_through_date := case p_phase
    when 'RUN_AGENT_DECISION' then v_round.decision_session_date
    when 'PREPARE_S1_ORDERS' then v_round.s1_session_date
    else v_round.s2_session_date end;

  if not exists (select 1 from public.corporate_action_scan
    where observed_at <= p_as_of
      and process_date_start <=
        (v_season.opens_at at time zone v_season.market_timezone)::date
      and process_date_end >= v_through_date)
  then return false; end if;

  return not exists (
    with latest as (
      select distinct on (revision.source_action_id) revision.*
        from public.corporate_action_scan_revision as observation
        join public.corporate_action_scan as scan on scan.scan_id = observation.scan_id
        join public.corporate_action_revision as revision
          on revision.source_action_id = observation.source_action_id
         and revision.revision_sha256 = observation.revision_sha256
       where scan.observed_at <= p_as_of
       order by revision.source_action_id,scan.observed_at desc,scan.scan_id desc
    ), relevant as (
      select revision.* from latest as revision
       where revision.ex_date <= v_through_date
         and revision.ex_date >=
           (v_season.opens_at at time zone v_season.market_timezone)::date
         and exists (
           select 1 from public.arena_round as round
           join public.market_snapshot as snapshot
             on snapshot.snapshot_id = round.decision_snapshot_id
          where round.season_id = v_season.season_id
            and revision.symbol = any(snapshot.symbols)
         )
    )
    select 1 from relevant as revision
     where revision.evidence_status <> 'COMPLETE'
        or revision.interpretation not in ('SPLIT','CASH_DIVIDEND')
        or (revision.interpretation = 'SPLIT' and (
          revision.normalized_action->>'oldRate' !~ '^[1-9][0-9]*$'
          or revision.normalized_action->>'newRate' !~ '^[1-9][0-9]*$'
        ))
        or (revision.interpretation = 'CASH_DIVIDEND' and (
          revision.normalized_action->>'foreign' <> 'false'
          or revision.normalized_action->>'special' <> 'false'
        ))
        or exists (
          select 1 from public.season_entrant as entrant
          join public.strategy_account as account on account.run_id = entrant.run_id
         where entrant.season_id = v_season.season_id
           and (
             not exists (
               select 1 from public.corporate_action_account_preparation as prep
                where prep.strategy_account_id = account.strategy_account_id
                  and prep.source_action_id = revision.source_action_id
                  and prep.revision_sha256 = revision.revision_sha256
             )
             or (
               revision.interpretation = 'SPLIT'
               and not exists (
                 select 1 from public.corporate_action_account_application as app
                  where app.strategy_account_id = account.strategy_account_id
                    and app.source_action_id = revision.source_action_id
                    and app.revision_sha256 = revision.revision_sha256
               )
             )
             or (
               revision.interpretation = 'CASH_DIVIDEND'
               and revision.payable_date <= v_through_date
               and not exists (
                 select 1 from public.corporate_action_account_application as app
                  where app.strategy_account_id = account.strategy_account_id
                    and app.source_action_id = revision.source_action_id
                    and app.revision_sha256 = revision.revision_sha256
               )
             )
           )
        )
  );
end;
$$;

revoke all on function public.validate_corporate_action_preparation_economics()
  from public, anon, authenticated, service_role;
revoke all on function public.get_corporate_action_account_replay_material(uuid)
  from public, anon, authenticated;
revoke all on function public.get_corporate_action_account_work(timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_corporate_action_account_replay_material(uuid)
  to service_role;
grant execute on function public.get_corporate_action_account_work(timestamptz)
  to service_role;

commit;
