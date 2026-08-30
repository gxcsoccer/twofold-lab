-- Independently enforce the v2 minute-volume cap at both durable replay
-- boundaries. This is a database invariant, not a trusted Worker calculation.

begin;

create or replace function public.arena_maximum_minute_fill(
  p_observed_volume text,
  p_max_participation_bps text
)
returns text
language plpgsql
immutable
strict
set search_path = public, pg_temp
as $$
begin
  if p_observed_volume !~ '^(0|[1-9][0-9]*)$'
    or p_max_participation_bps !~ '^([1-9][0-9]{0,3}|10000)$'
    or p_max_participation_bps::integer not between 1 and 10000
  then
    raise exception 'invalid canonical minute-liquidity inputs'
      using errcode = '22023';
  end if;
  return floor(
    p_observed_volume::numeric * p_max_participation_bps::numeric / 10000
  )::text;
end;
$$;

create or replace function public.assert_arena_minute_participation_settlements(
  p_plan jsonb,
  p_settlements jsonb,
  p_reference_snapshot_id uuid,
  p_session_date date,
  p_max_participation_bps text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_snapshot public.market_open_reference_snapshot%rowtype;
  v_artifact public.raw_artifact%rowtype;
  v_settlement jsonb;
  v_execution jsonb;
  v_liquidity jsonb;
  v_order jsonb;
  v_fill jsonb;
  v_fact public.market_open_reference_fact%rowtype;
  v_order_quantity numeric;
  v_filled_quantity numeric;
  v_canceled_quantity numeric;
  v_maximum_fill numeric;
begin
  if p_reference_snapshot_id is null or p_session_date is null
    or p_max_participation_bps !~ '^([1-9][0-9]{0,3}|10000)$'
    or p_max_participation_bps::integer not between 1 and 10000
    or jsonb_typeof(p_plan) <> 'object'
    or jsonb_typeof(p_plan->'orders') <> 'array'
    or jsonb_typeof(p_settlements) <> 'array'
    or p_plan->>'executionModel' <> 'SIMULATED_MINUTE_PARTICIPATION'
    or p_plan->>'maxParticipationBps' <> p_max_participation_bps
    or jsonb_array_length(p_plan->'orders')
      <> jsonb_array_length(p_settlements)
  then
    raise exception 'minute-participation plan and settlements differ'
      using errcode = '22023';
  end if;

  select * into v_snapshot from public.market_open_reference_snapshot
   where reference_snapshot_id = p_reference_snapshot_id;
  select * into v_artifact from public.raw_artifact
   where raw_artifact_id = v_snapshot.raw_artifact_id;
  if v_snapshot.reference_snapshot_id is null
    or v_artifact.raw_artifact_id is null
    or v_snapshot.method
      <> 'ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE'
    or v_snapshot.session_date <> p_session_date
  then
    raise exception 'minute-participation settlement lacks v2 market evidence'
      using errcode = '23503';
  end if;

  for v_settlement in
    select item.value from jsonb_array_elements(p_settlements) as item(value)
  loop
    if jsonb_typeof(v_settlement) <> 'object'
      or v_settlement->>'status' <> 'READY'
      or jsonb_typeof(v_settlement#>'{intent,execution}') <> 'object'
    then
      raise exception 'minute-participation settlement has an invalid envelope'
        using errcode = '22023';
    end if;
    v_execution := v_settlement#>'{intent,execution}';
    v_liquidity := v_execution->'liquidityEvidence';
    select item.value into v_order
      from jsonb_array_elements(p_plan->'orders') as item(value)
     where item.value->>'orderId' = v_settlement#>>'{intent,orderId}'
       and item.value->>'instrumentId'
         = v_settlement#>>'{intent,instrumentId}';
    if v_order is null
      or v_order->>'quantity' !~ '^[1-9][0-9]*$'
      or v_execution->>'orderQuantity' <> v_order->>'quantity'
      or v_execution->>'orderId' <> v_order->>'orderId'
      or v_execution->>'instrumentId' <> v_order->>'instrumentId'
      or v_execution->>'tradeDate' <> p_session_date::text
      or jsonb_typeof(v_execution->'fills') <> 'array'
      or jsonb_typeof(v_liquidity) <> 'object'
    then
      raise exception 'minute-participation execution differs from its order'
        using errcode = '22023';
    end if;

    select * into v_fact from public.market_open_reference_fact
     where reference_snapshot_id = p_reference_snapshot_id
       and symbol = v_order->>'symbol';
    if v_fact.fact_id is null or v_fact.observed_volume is null
      or v_liquidity->>'semantics' <> 'MINUTE_VOLUME_PARTICIPATION_CAP'
      or v_liquidity->>'sourceId' <> v_snapshot.method
      or v_liquidity->>'sourceVersionId' <> v_snapshot.source_version_id::text
      or v_liquidity->>'factId' <> v_fact.fact_id::text
      or v_liquidity->>'sourceArtifactId' <> v_snapshot.raw_artifact_id::text
      or v_liquidity->>'sourceContentSha256' <> v_artifact.response_sha256
      or v_liquidity->>'snapshotId' <> p_reference_snapshot_id::text
      or v_liquidity->>'sessionDate' <> p_session_date::text
      or v_liquidity->>'observedVolume' <> v_fact.observed_volume
      or v_liquidity->>'maxParticipationBps' <> p_max_participation_bps
    then
      raise exception 'liquidity evidence differs from the immutable minute fact'
        using errcode = '22023';
    end if;

    if v_execution->>'filledQuantity' !~ '^(0|[1-9][0-9]*)$'
      or v_execution->>'canceledQuantity' !~ '^(0|[1-9][0-9]*)$'
      or exists (
        select 1 from jsonb_array_elements(v_execution->'fills') as item(value)
         where item.value->>'quantity' !~ '^[1-9][0-9]*$'
      )
    then
      raise exception 'execution quantities are not canonical whole shares'
        using errcode = '22023';
    end if;
    v_order_quantity := (v_order->>'quantity')::numeric;
    v_filled_quantity := (v_execution->>'filledQuantity')::numeric;
    v_canceled_quantity := (v_execution->>'canceledQuantity')::numeric;
    v_maximum_fill := public.arena_maximum_minute_fill(
      v_fact.observed_volume, p_max_participation_bps
    )::numeric;
    if v_filled_quantity <> coalesce((
        select sum((item.value->>'quantity')::numeric)
          from jsonb_array_elements(v_execution->'fills') as item(value)
      ), 0)
      or v_filled_quantity + v_canceled_quantity <> v_order_quantity
      or v_filled_quantity > v_maximum_fill
      or (
        v_execution->>'terminalStatus' = 'FILLED'
        and v_canceled_quantity <> 0
      )
      or (
        v_execution->>'terminalStatus' = 'PARTIALLY_FILLED'
        and (v_filled_quantity = 0 or v_canceled_quantity = 0)
      )
      or (
        v_execution->>'terminalStatus' = 'CANCELED'
        and (v_filled_quantity <> 0 or v_canceled_quantity <> v_order_quantity)
      )
      or v_execution->>'terminalStatus' not in (
        'FILLED', 'PARTIALLY_FILLED', 'CANCELED'
      )
    then
      raise exception 'execution exceeds its immutable minute participation cap'
        using errcode = '22023';
    end if;

    for v_fill in
      select item.value
        from jsonb_array_elements(v_execution->'fills') as item(value)
    loop
      if v_fill#>>'{priceEvidence,semantics}'
          <> 'SIMULATED_MINUTE_PARTICIPATION_DERIVED_PRICE'
        or v_fill#>>'{priceEvidence,sourceId}' <> v_snapshot.method
        or v_fill#>>'{priceEvidence,sourceVersionId}'
          <> v_snapshot.source_version_id::text
        or v_fill#>>'{priceEvidence,factId}' <> v_fact.fact_id::text
        or v_fill#>>'{priceEvidence,sourceArtifactId}'
          <> v_snapshot.raw_artifact_id::text
        or v_fill#>>'{priceEvidence,sourceContentSha256}'
          <> v_artifact.response_sha256
        or v_fill#>>'{priceEvidence,snapshotId}'
          <> p_reference_snapshot_id::text
        or v_fill#>>'{priceEvidence,officialOpenSessionDate}'
          <> p_session_date::text
        or v_fill#>>'{priceEvidence,officialOpenPrice}' <> v_fact.value
        or v_fill#>>'{priceEvidence,observedVolume}' <> v_fact.observed_volume
        or v_fill#>>'{priceEvidence,maxParticipationBps}'
          <> p_max_participation_bps
      then
        raise exception 'fill price and liquidity do not bind one minute fact'
          using errcode = '22023';
      end if;
    end loop;
  end loop;
end;
$$;

create or replace function public.guard_arena_volume_participation_stage()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_rulebook public.arena_execution_rulebook%rowtype;
begin
  select * into v_rulebook from public.arena_execution_rulebook
   where season_id = new.season_id;
  if v_rulebook.rulebook_schema = 'twofold.arena_execution_rulebook/v2' then
    if new.phase = 'PREPARE_S1_ORDERS' then
      if new.artifact#>>'{plan,executionModel}'
          is distinct from 'SIMULATED_MINUTE_PARTICIPATION'
        or new.artifact#>>'{plan,maxParticipationBps}'
          is distinct from v_rulebook.rulebook->>'maxParticipationBps'
      then
        raise exception 'Arena S1 plan differs from its v2 rulebook'
          using errcode = '22023';
      end if;
    else
      if new.artifact#>>'{s1,plan,executionModel}'
          is distinct from 'SIMULATED_MINUTE_PARTICIPATION'
        or new.artifact#>>'{s1,plan,maxParticipationBps}'
          is distinct from v_rulebook.rulebook->>'maxParticipationBps'
        or new.artifact#>>'{s2Plan,executionModel}'
          is distinct from 'SIMULATED_MINUTE_PARTICIPATION'
        or new.artifact#>>'{s2Plan,maxParticipationBps}'
          is distinct from v_rulebook.rulebook->>'maxParticipationBps'
      then
        raise exception 'Arena checkpoint plans differ from their v2 rulebook'
          using errcode = '22023';
      end if;
      perform public.assert_arena_minute_participation_settlements(
        new.artifact#>'{s1,plan}', new.artifact#>'{s1,settlements}',
        new.s1_open_reference_snapshot_id,
        (select s1_session_date from public.arena_round
          where round_id = new.round_id),
        v_rulebook.rulebook->>'maxParticipationBps'
      );
    end if;
  end if;
  return new;
end;
$$;

create trigger arena_cycle_stage_volume_participation_guard
before insert on public.arena_cycle_stage_result
for each row execute function public.guard_arena_volume_participation_stage();

create or replace function public.guard_arena_volume_participation_cycle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_entry public.arena_round_entry%rowtype;
  v_round public.arena_round%rowtype;
  v_rulebook public.arena_execution_rulebook%rowtype;
  v_open public.arena_round_open_reference%rowtype;
begin
  select * into v_entry from public.arena_round_entry
   where decision_id = new.decision_id;
  if v_entry.round_entry_id is null then return new; end if;
  select * into v_round from public.arena_round
   where round_id = v_entry.round_id;
  select * into v_rulebook from public.arena_execution_rulebook
   where season_id = v_entry.season_id;
  if v_rulebook.rulebook_schema = 'twofold.arena_execution_rulebook/v2' then
    select * into v_open from public.arena_round_open_reference
     where round_id = v_entry.round_id and stage = 'S2_OPEN_REFERENCE';
    if new.cycle#>>'{s2,plan,executionModel}'
        is distinct from 'SIMULATED_MINUTE_PARTICIPATION'
      or new.cycle#>>'{s2,plan,maxParticipationBps}'
        is distinct from v_rulebook.rulebook->>'maxParticipationBps'
    then
      raise exception 'Arena final S2 plan differs from its v2 rulebook'
        using errcode = '22023';
    end if;
    perform public.assert_arena_minute_participation_settlements(
      new.cycle#>'{s2,plan}', new.cycle#>'{s2,settlements}',
      v_open.reference_snapshot_id, v_round.s2_session_date,
      v_rulebook.rulebook->>'maxParticipationBps'
    );
  end if;
  return new;
end;
$$;

create trigger accepted_target_cycle_volume_participation_guard
before insert on public.accepted_target_cycle
for each row execute function public.guard_arena_volume_participation_cycle();

revoke all on function public.assert_arena_minute_participation_settlements(
  jsonb, jsonb, uuid, date, text
) from public, anon, authenticated;
grant execute on function public.assert_arena_minute_participation_settlements(
  jsonb, jsonb, uuid, date, text
) to service_role;

commit;
