-- Close two operational gaps found during the S4 incident:
-- 1. no-trade carry-forward cannot burn retries before shared S2 evidence exists;
-- 2. superseded immutable Seasons can leave the live reconciliation set through
--    an append-only retirement record.
-- Unsupported corporate actions remain fail-closed, but surface as a stable
-- policy alert instead of making every otherwise healthy Worker tick fail.

begin;

create table public.arena_no_trade_recovery_rearm (
  rearm_id uuid primary key,
  recovery_id uuid not null
    references public.arena_no_trade_recovery(recovery_id),
  previous_attempt_count bigint not null check (previous_attempt_count > 0),
  reason text not null check (
    reason <> '' and reason = btrim(reason) and length(reason) <= 500
  ),
  rearmed_by text not null check (
    rearmed_by <> '' and rearmed_by = btrim(rearmed_by)
  ),
  rearmed_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint arena_no_trade_recovery_rearm_attempt_unique
    unique (recovery_id, previous_attempt_count),
  constraint arena_no_trade_recovery_rearm_id_deterministic check (
    rearm_id = public.deterministic_uuid_from_sha256(
      'twofold.arena_no_trade_recovery_rearm/v1',
      recovery_id::text || ':' || previous_attempt_count::text
    )
  )
);

comment on table public.arena_no_trade_recovery_rearm is
  'Immutable operator evidence for rearming one exhausted no-trade recovery after its shared S2 dependency becomes available.';

create trigger arena_no_trade_recovery_rearm_is_immutable
before update or delete on public.arena_no_trade_recovery_rearm
for each row execute function public.reject_immutable_mutation();
create trigger arena_no_trade_recovery_rearm_rejects_truncate
before truncate on public.arena_no_trade_recovery_rearm
for each statement execute function public.reject_immutable_mutation();

create table public.arena_season_retirement (
  season_id uuid primary key references public.arena_season(season_id),
  reason text not null check (
    reason <> '' and reason = btrim(reason) and length(reason) <= 500
  ),
  retired_by text not null check (
    retired_by <> '' and retired_by = btrim(retired_by)
  ),
  retired_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp()
);

comment on table public.arena_season_retirement is
  'Append-only operational retirement overlay; the Season and all economic evidence remain immutable.';

create trigger arena_season_retirement_is_immutable
before update or delete on public.arena_season_retirement
for each row execute function public.reject_immutable_mutation();
create trigger arena_season_retirement_rejects_truncate
before truncate on public.arena_season_retirement
for each statement execute function public.reject_immutable_mutation();

create or replace function public.claim_arena_no_trade_recovery(
  p_worker_id text,
  p_lease_seconds integer,
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_request public.arena_no_trade_recovery%rowtype;
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
    or p_worker_id is distinct from btrim(p_worker_id)
    or p_lease_seconds is null or p_lease_seconds < 5 or p_lease_seconds > 3600
    or p_now is null
  then
    raise exception 'invalid Arena no-trade recovery claim'
      using errcode = '22023';
  end if;
  perform set_config('twofold.arena_no_trade_recovery_mutation', 'on', true);
  update public.arena_no_trade_recovery
     set status = 'REQUESTED', claimed_by = null, lease_token = null,
         claimed_at = null, lease_expires_at = null, next_attempt_at = p_now
   where status = 'CLAIMED' and lease_expires_at <= p_now;
  select request.* into v_request
    from public.arena_no_trade_recovery as request
   where request.status = 'REQUESTED'
     and request.next_attempt_at <= p_now
     and request.scheduled_at <= p_now
     and exists (
       select 1
         from public.arena_round_close_snapshot as binding
         join public.market_snapshot as snapshot
           on snapshot.snapshot_id = binding.snapshot_id
        where binding.round_id = request.round_id
          and binding.season_id = request.season_id
          and binding.stage = 'S2_CLOSE'
     )
   order by request.scheduled_at, request.season_id, request.round_id,
     request.entrant_id
   for update skip locked limit 1;
  if not found then
    perform set_config('twofold.arena_no_trade_recovery_mutation', 'off', true);
    return null;
  end if;
  update public.arena_no_trade_recovery
     set status = 'CLAIMED', attempt_count = attempt_count + 1,
         claimed_by = p_worker_id, lease_token = gen_random_uuid(),
         claimed_at = p_now,
         lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
         completed_at = null, completion_fingerprint_sha256 = null,
         valuation_id = null, result = null, error_code = null,
         error_message = null, retryable = null
   where recovery_id = v_request.recovery_id returning * into v_request;
  perform set_config('twofold.arena_no_trade_recovery_mutation', 'off', true);
  return public.arena_no_trade_recovery_result(v_request);
end;
$$;

create or replace function public.rearm_failed_arena_no_trade_recovery(
  p_recovery_id uuid,
  p_expected_attempt_count bigint,
  p_reason text,
  p_rearmed_by text,
  p_rearmed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_request public.arena_no_trade_recovery%rowtype;
  v_rearm public.arena_no_trade_recovery_rearm%rowtype;
  v_rearm_id uuid;
begin
  if p_recovery_id is null
    or p_expected_attempt_count is null or p_expected_attempt_count <= 0
    or p_reason is null or btrim(p_reason) = ''
    or p_reason is distinct from btrim(p_reason) or length(p_reason) > 500
    or p_rearmed_by is null or btrim(p_rearmed_by) = ''
    or p_rearmed_by is distinct from btrim(p_rearmed_by)
    or p_rearmed_at is null
  then
    raise exception 'invalid no-trade recovery rearm request'
      using errcode = '22023';
  end if;
  v_rearm_id := public.deterministic_uuid_from_sha256(
    'twofold.arena_no_trade_recovery_rearm/v1',
    p_recovery_id::text || ':' || p_expected_attempt_count::text
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'arena-no-trade-rearm:' || p_recovery_id::text, 0
  ));
  select * into v_request
    from public.arena_no_trade_recovery
   where recovery_id = p_recovery_id
   for update;
  if not found then
    raise exception 'Arena no-trade recovery does not exist'
      using errcode = '23503';
  end if;
  select * into v_rearm
    from public.arena_no_trade_recovery_rearm
   where rearm_id = v_rearm_id;
  if found then
    if v_rearm.recovery_id is distinct from p_recovery_id
      or v_rearm.previous_attempt_count
        is distinct from p_expected_attempt_count
      or v_rearm.reason is distinct from p_reason
      or v_rearm.rearmed_by is distinct from p_rearmed_by
      or v_rearm.rearmed_at is distinct from p_rearmed_at
    then
      raise exception 'no-trade recovery rearm identity was reused'
        using errcode = '23505';
    end if;
    return public.arena_no_trade_recovery_result(v_request);
  end if;
  if v_request.status <> 'FAILED'
    or v_request.attempt_count <> p_expected_attempt_count
    or v_request.valuation_id is not null
    or exists (
      select 1 from public.arena_valuation as valuation
       where valuation.round_entry_id = v_request.round_entry_id
         and valuation.stage = 'S2_CLOSE'
    )
    or not exists (
      select 1
        from public.arena_round_close_snapshot as binding
        join public.market_snapshot as snapshot
          on snapshot.snapshot_id = binding.snapshot_id
       where binding.round_id = v_request.round_id
         and binding.season_id = v_request.season_id
         and binding.stage = 'S2_CLOSE'
    )
    or not exists (
      select 1 from public.arena_work_item as item
       where item.work_item_id = v_request.source_work_item_id
         and item.status in ('FAILED', 'CANCELED')
    )
  then
    raise exception 'failed no-trade recovery is not safely rearmable'
      using errcode = '55000';
  end if;
  insert into public.arena_no_trade_recovery_rearm (
    rearm_id, recovery_id, previous_attempt_count,
    reason, rearmed_by, rearmed_at
  ) values (
    v_rearm_id, p_recovery_id, p_expected_attempt_count,
    p_reason, p_rearmed_by, p_rearmed_at
  );
  perform set_config('twofold.arena_no_trade_recovery_mutation', 'on', true);
  update public.arena_no_trade_recovery
     set status = 'REQUESTED', next_attempt_at = p_rearmed_at,
         claimed_by = null, lease_token = null, claimed_at = null,
         lease_expires_at = null, completed_at = null,
         completion_fingerprint_sha256 = null, valuation_id = null,
         result = null, error_code = null, error_message = null,
         retryable = null
   where recovery_id = p_recovery_id
   returning * into v_request;
  perform set_config('twofold.arena_no_trade_recovery_mutation', 'off', true);
  return public.arena_no_trade_recovery_result(v_request);
end;
$$;

create or replace function public.retire_arena_season(
  p_season_id uuid,
  p_reason text,
  p_retired_by text,
  p_retired_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_retirement public.arena_season_retirement%rowtype;
  v_season public.arena_season%rowtype;
begin
  if p_season_id is null
    or p_reason is null or btrim(p_reason) = ''
    or p_reason is distinct from btrim(p_reason) or length(p_reason) > 500
    or p_retired_by is null or btrim(p_retired_by) = ''
    or p_retired_by is distinct from btrim(p_retired_by)
    or p_retired_at is null
  then
    raise exception 'invalid Arena Season retirement request'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'arena-season-retirement:' || p_season_id::text, 0
  ));
  select * into v_season from public.arena_season
   where season_id = p_season_id;
  if not found then
    raise exception 'Arena Season does not exist' using errcode = '23503';
  end if;
  select * into v_retirement from public.arena_season_retirement
   where season_id = p_season_id;
  if found then
    if v_retirement.reason is distinct from p_reason
      or v_retirement.retired_by is distinct from p_retired_by
      or v_retirement.retired_at is distinct from p_retired_at
    then
      raise exception 'Arena Season retirement identity was reused'
        using errcode = '23505';
    end if;
  else
    insert into public.arena_season_retirement (
      season_id, reason, retired_by, retired_at
    ) values (
      p_season_id, p_reason, p_retired_by, p_retired_at
    ) returning * into v_retirement;
  end if;
  return jsonb_build_object(
    'schema', 'twofold.arena_season_retirement/v1',
    'seasonId', v_retirement.season_id::text,
    'seasonCode', v_season.season_code,
    'reason', v_retirement.reason,
    'retiredBy', v_retirement.retired_by,
    'retiredAt', to_char(v_retirement.retired_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;

create or replace function public.get_active_arena_season_symbols(
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
  v_symbols jsonb;
begin
  if p_as_of is null then
    raise exception 'active Arena Season symbol as-of is required'
      using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(candidate.symbol order by candidate.symbol), '[]'::jsonb)
    into v_symbols
    from (
      select distinct unnest(snapshot.symbols) as symbol
        from public.arena_season as season
        join public.arena_round as round on round.season_id = season.season_id
        join public.market_snapshot as snapshot
          on snapshot.snapshot_id = round.decision_snapshot_id
       where season.opens_at <= p_as_of and season.closes_at > p_as_of
         and not exists (
           select 1 from public.arena_season_retirement as retirement
            where retirement.season_id = season.season_id
              and retirement.retired_at <= p_as_of
         )
    ) as candidate;
  return jsonb_build_object(
    'schema', 'twofold.active_arena_season_symbols/v1',
    'asOf', to_char(p_as_of at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'symbols', v_symbols
  );
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
       and not exists (
         select 1 from public.arena_season_retirement as retirement
          where retirement.season_id = season.season_id
            and retirement.retired_at <= p_as_of
       )
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

create or replace function public.get_arena_operational_health(
  p_worker_id text,
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_tick public.arena_tick_observation%rowtype;
  v_lease public.worker_lease%rowtype;
  v_season public.arena_season%rowtype;
  v_latest_scan_at timestamptz;
  v_policy_work jsonb;
  v_alerts jsonb := '[]'::jsonb;
  v_worker_live boolean := false;
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
    or p_worker_id is distinct from btrim(p_worker_id)
    or p_now is null
  then
    raise exception 'invalid Arena operational health request'
      using errcode = '22023';
  end if;
  select * into v_tick
    from public.arena_tick_observation
   where worker_id = p_worker_id
   order by finished_at desc, tick_id desc
   limit 1;
  select * into v_lease from public.worker_lease
   where worker_id = p_worker_id;
  select * into v_season
    from public.arena_season as season
   where season.opens_at <= p_now and season.closes_at > p_now
     and not exists (
       select 1 from public.arena_season_retirement as retirement
        where retirement.season_id = season.season_id
          and retirement.retired_at <= p_now
     )
   order by season.opens_at desc, season.season_id
   limit 1;
  select max(observed_at) into v_latest_scan_at
    from public.corporate_action_scan;
  v_worker_live := v_lease.worker_id is not null
    and v_lease.expires_at > p_now;
  if v_tick.tick_id is null then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'TICK_MISSING', 'severity', 'critical',
      'detail', 'No completed Arena tick has been recorded for this worker.'
    ));
  elsif v_tick.finished_at < p_now - interval '3 minutes' then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'TICK_STALE', 'severity', 'critical',
      'detail', 'The latest Arena tick is older than the three-minute liveness window.'
    ));
  end if;
  if not v_worker_live then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'WORKER_LEASE_EXPIRED', 'severity', 'critical',
      'detail', 'The Arena worker lease is missing or expired.'
    ));
  end if;
  if v_tick.outcome = 'failed' then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'LAST_TICK_FAILED', 'severity', 'critical',
      'detail', 'At least one phase in the latest Arena tick reported failure.'
    ));
  end if;
  if v_season.season_id is not null and (
    v_latest_scan_at is null or v_latest_scan_at < p_now - interval '20 minutes'
  ) then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'CORPORATE_ACTION_SCAN_STALE', 'severity', 'critical',
      'detail', 'Corporate-action evidence is older than the active-season scan window.'
    ));
  end if;
  if v_season.season_id is not null then
    v_policy_work := public.get_corporate_action_account_work(p_now);
    if exists (
      select 1 from jsonb_array_elements(v_policy_work->'items') as item(value)
       where item.value->>'phase' = 'UNSUPPORTED'
    ) then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
        'code', 'CORPORATE_ACTION_POLICY_REQUIRED',
        'severity', 'critical',
        'detail', 'An active-season corporate action is fail-closed pending an explicit accounting policy.'
      ));
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_policy_work->'items') as item(value)
       where item.value->>'phase' = 'MISSED_PREPARATION'
    ) then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
        'code', 'CORPORATE_ACTION_PREPARATION_MISSED',
        'severity', 'critical',
        'detail', 'An active-season corporate action missed its immutable pre-open preparation boundary.'
      ));
    end if;
  end if;
  if v_season.season_id is not null and exists (
    select 1 from public.arena_work_item as item
     where item.season_id = v_season.season_id
       and item.status in ('REQUESTED', 'CLAIMED')
       and item.deadline_at is not null and item.deadline_at <= p_now
  ) then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'MISSED_DEADLINE', 'severity', 'critical',
      'detail', 'Active-season work remains unfinished after its immutable deadline.'
    ));
  end if;
  if v_season.season_id is not null and exists (
    select 1 from public.arena_work_item as item
     where item.season_id = v_season.season_id
       and item.status in ('FAILED', 'CANCELED')
       and not exists (
         select 1 from public.arena_no_trade_recovery as recovery
          where recovery.source_work_item_id = item.work_item_id
            and recovery.status = 'SUCCEEDED'
       )
       and not exists (
         select 1 from public.arena_valuation as valuation
          where valuation.round_entry_id = item.round_entry_id
            and valuation.stage = 'S2_CLOSE'
       )
  ) then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'TERMINAL_WORK_FAILURE', 'severity', 'critical',
      'detail', 'Contestant work failed without a completed no-trade carry-forward.'
    ));
  end if;
  return jsonb_build_object(
    'schema', 'twofold.arena_operational_health/v1',
    'checkedAt', to_char(p_now at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'ok', jsonb_array_length(v_alerts) = 0,
    'worker', jsonb_build_object(
      'workerId', p_worker_id,
      'lastTickAt', case when v_tick.tick_id is null then null else to_char(
        v_tick.finished_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'lastOutcome', v_tick.outcome,
      'heartbeatAt', case when v_lease.worker_id is null then null else to_char(
        v_lease.heartbeat_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'leaseExpiresAt', case when v_lease.worker_id is null then null else to_char(
        v_lease.expires_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'live', v_worker_live
    ),
    'activeSeasonCode', v_season.season_code,
    'latestCorporateActionScanAt', case
      when v_latest_scan_at is null then null else to_char(
        v_latest_scan_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'alerts', v_alerts
  );
end;
$$;

alter table public.arena_no_trade_recovery_rearm enable row level security;
alter table public.arena_season_retirement enable row level security;

revoke all on table public.arena_no_trade_recovery_rearm
  from public, anon, authenticated, service_role;
revoke all on table public.arena_season_retirement
  from public, anon, authenticated, service_role;
grant select on table public.arena_no_trade_recovery_rearm to service_role;
grant select on table public.arena_season_retirement to service_role;

revoke all on function public.rearm_failed_arena_no_trade_recovery(
  uuid, bigint, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.retire_arena_season(
  uuid, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.get_active_arena_season_symbols(timestamptz)
  from public, anon, authenticated;
grant execute on function public.rearm_failed_arena_no_trade_recovery(
  uuid, bigint, text, text, timestamptz
) to service_role;
grant execute on function public.retire_arena_season(
  uuid, text, text, timestamptz
) to service_role;
grant execute on function public.get_active_arena_season_symbols(timestamptz)
  to service_role;

commit;
