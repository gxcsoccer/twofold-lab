-- Migration 040 intentionally scans by provider process_date, so a late-
-- processed action can have an ex-date well before the current Season. A gate
-- with only an upper date would then block today's competition for history
-- already absorbed by the opening snapshot. Add the missing lower economic
-- boundary. Cash dividends whose ex-date predates the Season still remain
-- relevant when their payable date falls inside it.

begin;

create or replace function public.get_corporate_action_gate(
  p_symbols text[],
  p_since_date date,
  p_through_date date,
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
  v_scan public.corporate_action_scan%rowtype;
  v_actions jsonb;
  v_status text;
  v_reason text;
  v_result jsonb;
begin
  if p_symbols is null or cardinality(p_symbols) = 0
    or p_since_date is null or p_through_date is null
    or p_through_date < p_since_date or p_as_of is null
    or exists (
      select 1 from unnest(p_symbols) with ordinality as symbol(value, ordinal)
       where symbol.value !~ '^[A-Z][A-Z0-9.-]{0,14}$'
          or exists (
            select 1 from unnest(p_symbols) with ordinality as prior(value, ordinal)
             where prior.ordinal < symbol.ordinal
               and prior.value >= symbol.value
          )
    )
  then
    raise exception 'invalid season-bounded corporate-action gate request'
      using errcode = '22023';
  end if;
  select * into v_scan from public.corporate_action_scan
   where observed_at <= p_as_of
   order by observed_at desc, scan_id desc
   limit 1;
  if not found then
    v_status := 'NO_SCAN';
    v_reason := 'CORPORATE_ACTION_SCAN_REQUIRED';
    v_actions := '[]'::jsonb;
  elsif v_scan.process_date_start > p_since_date
    or v_scan.process_date_end < p_through_date
  then
    v_status := 'STALE_SCAN';
    v_reason := 'CORPORATE_ACTION_SCAN_COVERAGE_INCOMPLETE';
    v_actions := '[]'::jsonb;
  else
    with latest_observation as (
      select distinct on (revision.source_action_id)
        revision.*,
        scan.observed_at
      from public.corporate_action_scan_revision as observation
      join public.corporate_action_scan as scan
        on scan.scan_id = observation.scan_id
      join public.corporate_action_revision as revision
        on revision.source_action_id = observation.source_action_id
       and revision.revision_sha256 = observation.revision_sha256
      where scan.observed_at <= p_as_of
        and revision.symbol = any(p_symbols)
      order by revision.source_action_id, scan.observed_at desc,
               scan.scan_id desc
    ), relevant as (
      select * from latest_observation
       where (
         ex_date between p_since_date and p_through_date
       ) or (
         action_type = 'CASH_DIVIDEND'
         and ex_date < p_since_date
         and payable_date between p_since_date and p_through_date
       ) or (
         ex_date is null
         and process_date between p_since_date and p_through_date
       )
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'sourceActionId', source_action_id::text,
      'revisionSha256', revision_sha256,
      'symbol', symbol,
      'type', action_type,
      'interpretation', interpretation,
      'evidenceStatus', evidence_status,
      'processDate', case when process_date is null then null
        else to_jsonb(process_date::text) end,
      'exDate', case when ex_date is null then null
        else to_jsonb(ex_date::text) end,
      'payableDate', case when payable_date is null then null
        else to_jsonb(payable_date::text) end,
      'observedAt', to_char(
        observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    ) order by coalesce(ex_date, process_date), action_type, source_action_id),
      '[]'::jsonb) into v_actions
      from relevant;
    if jsonb_array_length(v_actions) = 0 then
      v_status := 'CLEAR';
      v_reason := null;
    else
      v_status := 'BLOCKED';
      v_reason := 'CORPORATE_ACTION_APPLICATION_REQUIRED';
    end if;
  end if;
  v_result := jsonb_build_object(
    'schema', 'twofold.corporate_action_gate/v2',
    'status', v_status,
    'reason', v_reason,
    'sinceDate', p_since_date::text,
    'throughDate', p_through_date::text,
    'asOf', to_char(
      p_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'scanId', case when v_scan.scan_id is null then null
      else to_jsonb(v_scan.scan_id::text) end,
    'scanObservedAt', case when v_scan.scan_id is null then null
      else to_jsonb(to_char(
        v_scan.observed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )) end,
    'actions', v_actions
  );
  if public.jsonb_contains_number(v_result) then
    raise exception 'corporate-action gate crossed the string-decimal boundary'
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
  v_symbols text[];
  v_since_date date;
  v_through_date date;
  v_gate jsonb;
begin
  if p_round_id is null or p_as_of is null
    or p_phase not in (
      'RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS',
      'SETTLE_S1_AND_PREPARE_S2', 'FINALIZE_ACCEPTED_TARGET_CYCLE'
    )
  then
    return false;
  end if;
  select * into v_round from public.arena_round
   where round_id = p_round_id;
  if not found then return false; end if;
  select * into v_season from public.arena_season
   where season_id = v_round.season_id;
  if not found then return false; end if;
  select symbols into v_symbols from public.market_snapshot
   where snapshot_id = v_round.decision_snapshot_id;
  if v_symbols is null or cardinality(v_symbols) = 0 then return false; end if;
  select array_agg(symbol order by symbol) into v_symbols
    from unnest(v_symbols) as symbol;
  v_since_date := (
    v_season.opens_at at time zone v_season.market_timezone
  )::date;
  v_through_date := case p_phase
    when 'RUN_AGENT_DECISION' then v_round.decision_session_date
    when 'PREPARE_S1_ORDERS' then v_round.s1_session_date
    else v_round.s2_session_date
  end;
  v_gate := public.get_corporate_action_gate(
    v_symbols, v_since_date, v_through_date, p_as_of
  );
  return v_gate->>'status' = 'CLEAR';
end;
$$;

-- Remove the unbounded v1 service surface; only the internal historical
-- function body remains for applied-migration compatibility.
revoke all on function public.get_corporate_action_gate(
  text[], date, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.get_corporate_action_gate(
  text[], date, date, timestamptz
) from public, anon, authenticated;
grant execute on function public.get_corporate_action_gate(
  text[], date, date, timestamptz
) to service_role;

commit;
