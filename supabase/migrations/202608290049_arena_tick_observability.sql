-- Operational truth for the serverless Arena loop. A successful HTTP cron
-- response is not enough: every pass must leave a durable, exact seven-phase
-- observation and the private lab must be able to derive health from evidence.

begin;

create table public.arena_tick_observation (
  tick_id uuid primary key,
  worker_id text not null check (
    worker_id <> '' and worker_id = btrim(worker_id)
  ),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  outcome text not null check (outcome in ('idle', 'completed', 'failed')),
  capabilities jsonb not null,
  phase_outcomes jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint arena_tick_observation_worker_start_unique
    unique (worker_id, started_at),
  constraint arena_tick_observation_time_order
    check (finished_at >= started_at),
  constraint arena_tick_observation_id_deterministic check (
    tick_id = public.deterministic_uuid_from_sha256(
      'twofold.arena_tick_observation/v1',
      worker_id || ':' || to_char(
        started_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    )
  ),
  constraint arena_tick_observation_capabilities_array check (
    jsonb_typeof(capabilities) = 'array'
      and jsonb_array_length(capabilities) > 0
      and not public.jsonb_contains_number(capabilities)
  ),
  constraint arena_tick_observation_phases_object check (
    jsonb_typeof(phase_outcomes) = 'object'
      and not public.jsonb_contains_number(phase_outcomes)
  )
);

comment on table public.arena_tick_observation is
  'Immutable evidence that one serverless Arena pass completed all seven bounded phases.';

create index arena_tick_observation_latest_idx
  on public.arena_tick_observation (worker_id, finished_at desc, tick_id desc);

create trigger arena_tick_observation_is_immutable
before update or delete on public.arena_tick_observation
for each row execute function public.reject_immutable_mutation();
create trigger arena_tick_observation_rejects_truncate
before truncate on public.arena_tick_observation
for each statement execute function public.reject_immutable_mutation();

create or replace function public.arena_tick_observation_result(
  p_value public.arena_tick_observation
)
returns jsonb
language sql
stable
strict
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'twofold.arena_tick_observation/v1',
    'tickId', p_value.tick_id::text,
    'workerId', p_value.worker_id,
    'startedAt', to_char(
      p_value.started_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'finishedAt', to_char(
      p_value.finished_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'outcome', p_value.outcome,
    'capabilities', p_value.capabilities,
    'phaseOutcomes', p_value.phase_outcomes
  )
$$;

create or replace function public.register_arena_tick_observation(
  p_worker_id text,
  p_started_at timestamptz,
  p_finished_at timestamptz,
  p_outcome text,
  p_capabilities jsonb,
  p_phase_outcomes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_tick_id uuid;
  v_expected_outcome text;
  v_existing public.arena_tick_observation%rowtype;
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
    or p_worker_id is distinct from btrim(p_worker_id)
    or p_started_at is null or p_finished_at is null
    or p_finished_at < p_started_at
    or p_outcome not in ('idle', 'completed', 'failed')
    or jsonb_typeof(p_capabilities) is distinct from 'array'
    or jsonb_array_length(p_capabilities) = 0
    or public.jsonb_contains_number(p_capabilities)
    or jsonb_typeof(p_phase_outcomes) is distinct from 'object'
    or public.jsonb_contains_number(p_phase_outcomes)
    or not (p_phase_outcomes ?& array[
      'agent', 'cycle', 'market', 'corporateActionScan',
      'corporateActionAccount', 'recovery', 'season'
    ]::text[])
    or p_phase_outcomes - array[
      'agent', 'cycle', 'market', 'corporateActionScan',
      'corporateActionAccount', 'recovery', 'season'
    ]::text[] <> '{}'::jsonb
    or exists (
      select 1
        from jsonb_array_elements(p_capabilities) as capability(value)
       where jsonb_typeof(capability.value) <> 'string'
          or capability.value #>> '{}' = ''
          or capability.value #>> '{}' <> btrim(capability.value #>> '{}')
    )
    or (
      select count(*) <> count(distinct capability.value #>> '{}')
        from jsonb_array_elements(p_capabilities) as capability(value)
    )
    or exists (
      select 1
        from jsonb_each_text(p_phase_outcomes) as phase(key, value)
       where phase.value not in ('idle', 'completed', 'failed')
    )
  then
    raise exception 'invalid Arena tick observation'
      using errcode = '22023';
  end if;

  v_expected_outcome := case
    when exists (
      select 1 from jsonb_each_text(p_phase_outcomes) where value = 'failed'
    ) then 'failed'
    when exists (
      select 1 from jsonb_each_text(p_phase_outcomes) where value = 'completed'
    ) then 'completed'
    else 'idle'
  end;
  if p_outcome is distinct from v_expected_outcome then
    raise exception 'Arena tick outcome does not match its phase outcomes'
      using errcode = '22023';
  end if;

  v_tick_id := public.deterministic_uuid_from_sha256(
    'twofold.arena_tick_observation/v1',
    p_worker_id || ':' || to_char(
      p_started_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended('arena-tick:' || v_tick_id::text, 0)
  );
  select * into v_existing
    from public.arena_tick_observation
   where tick_id = v_tick_id
      or (worker_id = p_worker_id and started_at = p_started_at)
   limit 1;
  if found then
    if v_existing.tick_id is distinct from v_tick_id
      or v_existing.worker_id is distinct from p_worker_id
      or v_existing.started_at is distinct from p_started_at
      or v_existing.finished_at is distinct from p_finished_at
      or v_existing.outcome is distinct from p_outcome
      or v_existing.capabilities is distinct from p_capabilities
      or v_existing.phase_outcomes is distinct from p_phase_outcomes
    then
      raise exception 'Arena tick identity was reused with different content'
        using errcode = '23505';
    end if;
    return public.arena_tick_observation_result(v_existing);
  end if;

  insert into public.arena_tick_observation (
    tick_id, worker_id, started_at, finished_at, outcome,
    capabilities, phase_outcomes
  ) values (
    v_tick_id, p_worker_id, p_started_at, p_finished_at, p_outcome,
    p_capabilities, p_phase_outcomes
  ) returning * into v_existing;
  return public.arena_tick_observation_result(v_existing);
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
  select * into v_lease
    from public.worker_lease
   where worker_id = p_worker_id;
  select * into v_season
    from public.arena_season
   where opens_at <= p_now and closes_at > p_now
   order by opens_at desc, season_id
   limit 1;
  select max(observed_at) into v_latest_scan_at
    from public.corporate_action_scan;

  v_worker_live := v_lease.worker_id is not null
    and v_lease.expires_at > p_now;
  if v_tick.tick_id is null then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'TICK_MISSING',
      'severity', 'critical',
      'detail', 'No completed Arena tick has been recorded for this worker.'
    ));
  elsif v_tick.finished_at < p_now - interval '3 minutes' then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'TICK_STALE',
      'severity', 'critical',
      'detail', 'The latest Arena tick is older than the three-minute liveness window.'
    ));
  end if;
  if not v_worker_live then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'WORKER_LEASE_EXPIRED',
      'severity', 'critical',
      'detail', 'The Arena worker lease is missing or expired.'
    ));
  end if;
  if v_tick.outcome = 'failed' then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'LAST_TICK_FAILED',
      'severity', 'critical',
      'detail', 'At least one phase in the latest Arena tick reported failure.'
    ));
  end if;
  if v_season.season_id is not null and (
    v_latest_scan_at is null
      or v_latest_scan_at < p_now - interval '20 minutes'
  ) then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'CORPORATE_ACTION_SCAN_STALE',
      'severity', 'critical',
      'detail', 'Corporate-action evidence is older than the active-season scan window.'
    ));
  end if;
  if v_season.season_id is not null and exists (
    select 1
      from public.arena_work_item as item
     where item.season_id = v_season.season_id
       and item.status in ('REQUESTED', 'CLAIMED')
       and item.deadline_at is not null
       and item.deadline_at <= p_now
  ) then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'MISSED_DEADLINE',
      'severity', 'critical',
      'detail', 'Active-season work remains unfinished after its immutable deadline.'
    ));
  end if;
  if v_season.season_id is not null and exists (
    select 1
      from public.arena_work_item as item
     where item.season_id = v_season.season_id
       and item.status in ('FAILED', 'CANCELED')
       and not exists (
         select 1
           from public.arena_no_trade_recovery as recovery
          where recovery.source_work_item_id = item.work_item_id
            and recovery.status = 'SUCCEEDED'
       )
       and not exists (
         select 1
           from public.arena_valuation as valuation
          where valuation.round_entry_id = item.round_entry_id
            and valuation.stage = 'S2_CLOSE'
       )
  ) then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'TERMINAL_WORK_FAILURE',
      'severity', 'critical',
      'detail', 'Contestant work failed without a completed no-trade carry-forward.'
    ));
  end if;

  return jsonb_build_object(
    'schema', 'twofold.arena_operational_health/v1',
    'checkedAt', to_char(
      p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'ok', jsonb_array_length(v_alerts) = 0,
    'worker', jsonb_build_object(
      'workerId', p_worker_id,
      'lastTickAt', case when v_tick.tick_id is null then null else to_char(
        v_tick.finished_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) end,
      'lastOutcome', v_tick.outcome,
      'heartbeatAt', case when v_lease.worker_id is null then null else to_char(
        v_lease.heartbeat_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) end,
      'leaseExpiresAt', case when v_lease.worker_id is null then null else to_char(
        v_lease.expires_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) end,
      'live', v_worker_live
    ),
    'activeSeasonCode', v_season.season_code,
    'latestCorporateActionScanAt', case
      when v_latest_scan_at is null then null else to_char(
        v_latest_scan_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) end,
    'alerts', v_alerts
  );
end;
$$;

grant select on table public.arena_tick_observation to service_role;

revoke all on function public.arena_tick_observation_result(
  public.arena_tick_observation
) from public, anon, authenticated;
revoke all on function public.register_arena_tick_observation(
  text, timestamptz, timestamptz, text, jsonb, jsonb
) from public, anon, authenticated;
revoke all on function public.get_arena_operational_health(
  text, timestamptz
) from public, anon, authenticated;

grant execute on function public.register_arena_tick_observation(
  text, timestamptz, timestamptz, text, jsonb, jsonb
) to service_role;
grant execute on function public.get_arena_operational_health(
  text, timestamptz
) to service_role;

commit;
