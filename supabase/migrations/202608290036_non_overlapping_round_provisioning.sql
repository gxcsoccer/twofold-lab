-- A Strategy Run has one ledger.  Do not start a later decision against stale
-- balances while the prior two-session cycle is still in flight.  Enqueue one
-- durable next-Round provisioning request only after every entrant has reached
-- its prior S2 valuation and final work completion.

begin;

create table public.arena_round_provisioning (
  provisioning_id uuid primary key,
  source_round_id uuid not null,
  season_id uuid not null,
  next_round_index bigint not null check (next_round_index > 1),
  decision_snapshot_id uuid not null references public.market_snapshot(snapshot_id),
  decision_session_date date not null,
  decision_available_at timestamptz not null,
  recorded_by text not null check (recorded_by <> ''),
  status text not null default 'REQUESTED' check (status in (
    'REQUESTED', 'CLAIMED', 'SUCCEEDED', 'FAILED'
  )),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null,
  claimed_by text,
  lease_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  commit_fingerprint_sha256 text check (
    commit_fingerprint_sha256 is null
      or commit_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
  ),
  result jsonb,
  error_code text,
  error_message text,
  retryable boolean,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint arena_round_provisioning_source_unique unique (source_round_id),
  constraint arena_round_provisioning_season_index_unique
    unique (season_id, next_round_index),
  constraint arena_round_provisioning_source_fk foreign key (
    source_round_id, season_id
  ) references public.arena_round(round_id, season_id),
  constraint arena_round_provisioning_id_deterministic check (
    provisioning_id = public.deterministic_uuid_from_sha256(
      'twofold.arena_round_provisioning/v1', source_round_id::text
    )
  ),
  constraint arena_round_provisioning_result_object check (
    result is null or jsonb_typeof(result) = 'object'
  ),
  constraint arena_round_provisioning_result_decimal_safe check (
    result is null or not public.jsonb_contains_number(result)
  ),
  constraint arena_round_provisioning_claim_shape check (
    (status = 'CLAIMED'
      and claimed_by is not null and lease_token is not null
      and claimed_at is not null and lease_expires_at > claimed_at
      and completed_at is null)
    or
    (status <> 'CLAIMED'
      and claimed_by is null and lease_token is null
      and claimed_at is null and lease_expires_at is null)
  ),
  constraint arena_round_provisioning_terminal_shape check (
    (status in ('SUCCEEDED', 'FAILED') and completed_at is not null)
    or (status in ('REQUESTED', 'CLAIMED') and completed_at is null)
  )
);

comment on table public.arena_round_provisioning is
  'One leaseable request to create the next non-overlapping Round from the prior fully completed S2-close state.';

create index arena_round_provisioning_claim_idx
  on public.arena_round_provisioning(status, next_attempt_at, decision_available_at);

create or replace function public.guard_arena_round_provisioning_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Arena Round provisioning cannot be deleted'
      using errcode = '55000';
  end if;
  if current_setting('twofold.arena_round_provisioning_mutation', true)
       is distinct from 'on'
  then
    raise exception 'Arena Round provisioning may change only through queue RPCs'
      using errcode = '55000';
  end if;
  if new.provisioning_id is distinct from old.provisioning_id
    or new.source_round_id is distinct from old.source_round_id
    or new.season_id is distinct from old.season_id
    or new.next_round_index is distinct from old.next_round_index
    or new.decision_snapshot_id is distinct from old.decision_snapshot_id
    or new.decision_session_date is distinct from old.decision_session_date
    or new.decision_available_at is distinct from old.decision_available_at
    or new.recorded_by is distinct from old.recorded_by
    or new.recorded_at is distinct from old.recorded_at
  then
    raise exception 'Arena Round provisioning identity is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger arena_round_provisioning_guarded
before update or delete on public.arena_round_provisioning
for each row execute function public.guard_arena_round_provisioning_mutation();
create trigger arena_round_provisioning_rejects_truncate
before truncate on public.arena_round_provisioning
for each statement execute function public.reject_immutable_mutation();

create or replace function public.arena_round_provisioning_result(
  p_value public.arena_round_provisioning
)
returns jsonb
language sql
stable
strict
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'twofold.arena_round_provisioning/v1',
    'provisioningId', p_value.provisioning_id::text,
    'sourceRoundId', p_value.source_round_id::text,
    'seasonId', p_value.season_id::text,
    'seasonCode', season.season_code,
    'seasonClosesAt', to_char(
      season.closes_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'nextRoundIndex', p_value.next_round_index::text,
    'decisionSnapshotId', p_value.decision_snapshot_id::text,
    'decisionSessionDate', p_value.decision_session_date::text,
    'decisionAvailableAt', to_char(
      p_value.decision_available_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'recordedBy', p_value.recorded_by,
    'status', p_value.status,
    'attemptCount', p_value.attempt_count::text,
    'nextAttemptAt', to_char(
      p_value.next_attempt_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'claimedBy', p_value.claimed_by,
    'leaseToken', p_value.lease_token::text,
    'leaseExpiresAt', case when p_value.lease_expires_at is null then null else
      to_char(p_value.lease_expires_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'completedAt', case when p_value.completed_at is null then null else
      to_char(p_value.completed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'result', p_value.result,
    'errorCode', p_value.error_code,
    'errorMessage', p_value.error_message,
    'retryable', p_value.retryable
  )
  from public.arena_season as season
  where season.season_id = p_value.season_id
$$;

create or replace function public.enqueue_next_arena_round_provisioning()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_round public.arena_round%rowtype;
  v_snapshot public.market_snapshot%rowtype;
  v_available_at timestamptz;
begin
  if new.phase <> 'FINALIZE_ACCEPTED_TARGET_CYCLE'
    or new.status <> 'SUCCEEDED'
    or old.status = 'SUCCEEDED'
  then
    return new;
  end if;
  select * into v_round from public.arena_round
   where round_id = new.round_id;
  if not found
    or exists (
      select 1 from public.arena_work_item
       where round_id = new.round_id
         and phase = 'FINALIZE_ACCEPTED_TARGET_CYCLE'
         and status <> 'SUCCEEDED'
    )
    or exists (
      select 1 from public.arena_round_entry as entry
       where entry.round_id = new.round_id
         and not exists (
           select 1 from public.arena_valuation as valuation
            where valuation.round_entry_id = entry.round_entry_id
              and valuation.stage = 'S2_CLOSE'
         )
    )
    or exists (
      select 1 from public.arena_round
       where season_id = new.season_id
         and round_index = v_round.round_index + 1
    )
  then
    return new;
  end if;

  select snapshot.* into v_snapshot
    from public.arena_round_close_snapshot as close_binding
    join public.market_snapshot as snapshot
      on snapshot.snapshot_id = close_binding.snapshot_id
   where close_binding.round_id = new.round_id
     and close_binding.stage = 'S2_CLOSE';
  if not found then
    raise exception 'completed Round has no shared S2 close snapshot'
      using errcode = '23503';
  end if;
  select greatest(v_snapshot.sealed_at, max(item.completed_at))
    into v_available_at
    from public.arena_work_item as item
   where item.round_id = new.round_id
     and item.phase = 'FINALIZE_ACCEPTED_TARGET_CYCLE';

  insert into public.arena_round_provisioning (
    provisioning_id, source_round_id, season_id, next_round_index,
    decision_snapshot_id, decision_session_date, decision_available_at,
    recorded_by, next_attempt_at
  ) values (
    public.deterministic_uuid_from_sha256(
      'twofold.arena_round_provisioning/v1', new.round_id::text
    ),
    new.round_id, new.season_id, v_round.round_index + 1,
    v_snapshot.snapshot_id, v_snapshot.target_session_date, v_available_at,
    new.recorded_by, v_available_at
  ) on conflict (source_round_id) do nothing;
  return new;
end;
$$;

create trigger arena_work_item_enqueue_next_round
after update on public.arena_work_item
for each row execute function public.enqueue_next_arena_round_provisioning();

-- Backfill a request if this migration lands after a Round already completed.
insert into public.arena_round_provisioning (
  provisioning_id, source_round_id, season_id, next_round_index,
  decision_snapshot_id, decision_session_date, decision_available_at,
  recorded_by, next_attempt_at
)
select
  public.deterministic_uuid_from_sha256(
    'twofold.arena_round_provisioning/v1', round.round_id::text
  ),
  round.round_id, round.season_id, round.round_index + 1,
  snapshot.snapshot_id, snapshot.target_session_date,
  greatest(snapshot.sealed_at, completed.completed_at),
  completed.recorded_by,
  greatest(snapshot.sealed_at, completed.completed_at)
from public.arena_round as round
join public.arena_round_close_snapshot as close_binding
  on close_binding.round_id = round.round_id
 and close_binding.stage = 'S2_CLOSE'
join public.market_snapshot as snapshot
  on snapshot.snapshot_id = close_binding.snapshot_id
join lateral (
  select max(item.completed_at) as completed_at,
         min(item.recorded_by) as recorded_by,
         count(*) as completed_count
    from public.arena_work_item as item
   where item.round_id = round.round_id
     and item.phase = 'FINALIZE_ACCEPTED_TARGET_CYCLE'
     and item.status = 'SUCCEEDED'
) as completed on completed.completed_count = (
  select count(*) from public.arena_round_entry
   where round_id = round.round_id
)
where completed.completed_count > 0
  and not exists (
    select 1 from public.arena_round_entry as entry
     where entry.round_id = round.round_id
       and not exists (
         select 1 from public.arena_valuation as valuation
          where valuation.round_entry_id = entry.round_entry_id
            and valuation.stage = 'S2_CLOSE'
       )
  )
  and not exists (
    select 1 from public.arena_round as next_round
     where next_round.season_id = round.season_id
       and next_round.round_index = round.round_index + 1
  )
on conflict (source_round_id) do nothing;

create or replace function public.claim_arena_round_provisioning(
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
  v_request public.arena_round_provisioning%rowtype;
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
    or p_worker_id is distinct from btrim(p_worker_id)
    or p_lease_seconds is null or p_lease_seconds < 5 or p_lease_seconds > 3600
    or p_now is null
  then
    raise exception 'invalid Arena Round provisioning claim'
      using errcode = '22023';
  end if;
  perform set_config('twofold.arena_round_provisioning_mutation', 'on', true);
  update public.arena_round_provisioning
     set status = 'REQUESTED', claimed_by = null, lease_token = null,
         claimed_at = null, lease_expires_at = null, next_attempt_at = p_now
   where status = 'CLAIMED' and lease_expires_at <= p_now;
  select request.* into v_request
    from public.arena_round_provisioning as request
   where request.status = 'REQUESTED'
     and request.next_attempt_at <= p_now
     and request.decision_available_at <= p_now
   order by request.decision_available_at, request.season_id,
     request.next_round_index
   for update skip locked
   limit 1;
  if not found then
    perform set_config('twofold.arena_round_provisioning_mutation', 'off', true);
    return null;
  end if;
  update public.arena_round_provisioning
     set status = 'CLAIMED', attempt_count = attempt_count + 1,
         claimed_by = p_worker_id, lease_token = gen_random_uuid(),
         claimed_at = p_now,
         lease_expires_at = p_now + make_interval(secs => p_lease_seconds)
   where provisioning_id = v_request.provisioning_id
   returning * into v_request;
  perform set_config('twofold.arena_round_provisioning_mutation', 'off', true);
  return public.arena_round_provisioning_result(v_request);
end;
$$;

create or replace function public.fail_arena_round_provisioning(
  p_provisioning_id uuid,
  p_lease_token uuid,
  p_completed_at timestamptz,
  p_error_code text,
  p_error_message text,
  p_retryable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_request public.arena_round_provisioning%rowtype;
  v_will_retry boolean;
begin
  if p_provisioning_id is null or p_lease_token is null
    or p_completed_at is null
    or p_error_code is null or btrim(p_error_code) = ''
    or p_error_message is null or btrim(p_error_message) = ''
    or p_retryable is null
  then
    raise exception 'invalid Arena Round provisioning failure'
      using errcode = '22023';
  end if;
  select * into v_request from public.arena_round_provisioning
   where provisioning_id = p_provisioning_id for update;
  if not found or v_request.status <> 'CLAIMED'
    or v_request.lease_token is distinct from p_lease_token
    or p_completed_at < v_request.claimed_at
    or p_completed_at > v_request.lease_expires_at
  then
    raise exception 'Arena Round provisioning lease is stale or expired'
      using errcode = '40001';
  end if;
  v_will_retry := p_retryable and v_request.attempt_count < 3;
  perform set_config('twofold.arena_round_provisioning_mutation', 'on', true);
  update public.arena_round_provisioning
     set status = case when v_will_retry then 'REQUESTED' else 'FAILED' end,
         next_attempt_at = case when v_will_retry
           then p_completed_at + interval '1 minute' else next_attempt_at end,
         claimed_by = null, lease_token = null, claimed_at = null,
         lease_expires_at = null,
         completed_at = case when v_will_retry then null else p_completed_at end,
         result = jsonb_build_object('outcome', 'FAILED'),
         error_code = p_error_code, error_message = p_error_message,
         retryable = p_retryable
   where provisioning_id = p_provisioning_id
   returning * into v_request;
  perform set_config('twofold.arena_round_provisioning_mutation', 'off', true);
  return public.arena_round_provisioning_result(v_request);
end;
$$;

create or replace function public.commit_arena_round_provisioning(
  p_provisioning_id uuid,
  p_lease_token uuid,
  p_calendar_artifact_id uuid,
  p_calendar_artifact_sha256 text,
  p_schedule jsonb,
  p_completed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_request public.arena_round_provisioning%rowtype;
  v_season public.arena_season%rowtype;
  v_artifact public.artifact_metadata%rowtype;
  v_round_id uuid;
  v_round_result jsonb;
  v_entry public.season_entrant%rowtype;
  v_entry_count bigint := 0;
  v_work_count bigint := 0;
  v_result jsonb;
  v_decision_closes_at timestamptz;
  v_commit_fingerprint text;
begin
  if p_provisioning_id is null or p_lease_token is null
    or p_calendar_artifact_id is null
    or p_calendar_artifact_sha256 is null
      or p_calendar_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_schedule is null or jsonb_typeof(p_schedule) <> 'object'
    or public.jsonb_contains_number(p_schedule)
    or p_completed_at is null
  then
    raise exception 'invalid Arena Round provisioning commit'
      using errcode = '22023';
  end if;
  v_commit_fingerprint := encode(extensions.digest(convert_to(
    p_provisioning_id::text || chr(31) || p_lease_token::text || chr(31)
      || p_calendar_artifact_id::text || chr(31)
      || p_calendar_artifact_sha256 || chr(31) || p_schedule::text || chr(31)
      || to_char(p_completed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'UTF8'
  ), 'sha256'), 'hex');
  select * into v_request from public.arena_round_provisioning
   where provisioning_id = p_provisioning_id for update;
  if found and v_request.status = 'SUCCEEDED' then
    if v_request.commit_fingerprint_sha256 = v_commit_fingerprint then
      return v_request.result;
    end if;
    raise exception 'Arena Round provisioning identity was reused with different content'
      using errcode = '23505';
  end if;
  select * into v_season from public.arena_season
   where season_id = v_request.season_id;
  select * into v_artifact from public.artifact_metadata
   where artifact_id = p_calendar_artifact_id
     and sha256 = p_calendar_artifact_sha256
     and season_id = v_request.season_id
     and artifact_kind = 'exchange_calendar_schedule'
     and content_type = 'application/json';
  if v_request.provisioning_id is null or v_season.season_id is null
    or v_artifact.artifact_id is null
    or v_request.status <> 'CLAIMED'
    or v_request.lease_token is distinct from p_lease_token
    or p_completed_at < v_request.claimed_at
    or p_completed_at > v_request.lease_expires_at
  then
    raise exception 'Arena Round provisioning lease or calendar is invalid'
      using errcode = '40001';
  end if;
  if p_schedule->>'schema' <> 'twofold.two_stage_cycle_calendar/v1'
    or p_schedule->>'decisionSessionDate'
      is distinct from v_request.decision_session_date::text
  then
    raise exception 'Arena Round schedule does not match the completed S2 close'
      using errcode = '22023';
  end if;
  v_decision_closes_at := (p_schedule->>'s1OpenAt')::timestamptz
    - interval '15 minutes';

  if (p_schedule->>'cycleReadyAt')::timestamptz > v_season.closes_at then
    v_result := jsonb_build_object(
      'schema', 'twofold.arena_round_provisioning_commit/v1',
      'outcome', 'SEASON_COMPLETE',
      'provisioningId', v_request.provisioning_id::text,
      'seasonId', v_request.season_id::text,
      'sourceRoundId', v_request.source_round_id::text,
      'roundId', null,
      'roundIndex', v_request.next_round_index::text,
      'entryCount', '0',
      'workItemCount', '0'
    );
  else
    if greatest(v_request.decision_available_at, p_completed_at)
         >= v_decision_closes_at
    then
      raise exception 'next Round decision window was missed'
        using errcode = '57014';
    end if;
    v_round_id := public.deterministic_uuid_from_sha256(
      'twofold.arena_round/v1',
      v_request.season_id::text || ':' || v_request.next_round_index::text
    );
    v_round_result := public.register_arena_round(
      v_season.season_code || ':round:' || v_request.next_round_index::text,
      v_round_id, v_request.season_id, v_request.next_round_index,
      v_request.decision_snapshot_id,
      greatest(v_request.decision_available_at, p_completed_at),
      v_decision_closes_at, p_calendar_artifact_id,
      p_calendar_artifact_sha256, p_schedule, v_request.recorded_by
    );
    for v_entry in
      select * from public.season_entrant
       where season_id = v_request.season_id order by entrant_code
    loop
      perform public.register_arena_round_entry(
        v_season.season_code || ':round:'
          || v_request.next_round_index::text || ':' || v_entry.entrant_code,
        v_round_id, v_entry.entrant_id, v_request.recorded_by
      );
      v_entry_count := v_entry_count + 1;
    end loop;
    if v_entry_count = 0 then
      raise exception 'next Round has no Season entrants'
        using errcode = '55000';
    end if;
    v_work_count := (public.seed_arena_round_work(
      v_round_id, v_request.recorded_by
    )->>'workItemCount')::bigint;
    v_result := jsonb_build_object(
      'schema', 'twofold.arena_round_provisioning_commit/v1',
      'outcome', 'ROUND_PROVISIONED',
      'provisioningId', v_request.provisioning_id::text,
      'seasonId', v_request.season_id::text,
      'sourceRoundId', v_request.source_round_id::text,
      'roundId', v_round_result->>'roundId',
      'roundIndex', v_request.next_round_index::text,
      'entryCount', v_entry_count::text,
      'workItemCount', v_work_count::text
    );
  end if;

  perform set_config('twofold.arena_round_provisioning_mutation', 'on', true);
  update public.arena_round_provisioning
     set status = 'SUCCEEDED', claimed_by = null, lease_token = null,
         claimed_at = null, lease_expires_at = null,
         completed_at = p_completed_at,
         commit_fingerprint_sha256 = v_commit_fingerprint, result = v_result,
         error_code = null, error_message = null, retryable = false
   where provisioning_id = p_provisioning_id
   returning * into v_request;
  perform set_config('twofold.arena_round_provisioning_mutation', 'off', true);
  return v_result;
end;
$$;

alter table public.arena_round_provisioning enable row level security;
revoke all on table public.arena_round_provisioning
  from public, anon, authenticated, service_role;
grant select on table public.arena_round_provisioning to service_role;

revoke all on function public.arena_round_provisioning_result(
  public.arena_round_provisioning
) from public, anon, authenticated;
revoke all on function public.enqueue_next_arena_round_provisioning()
  from public, anon, authenticated, service_role;
revoke all on function public.claim_arena_round_provisioning(
  text, integer, timestamptz
) from public, anon, authenticated;
revoke all on function public.fail_arena_round_provisioning(
  uuid, uuid, timestamptz, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.commit_arena_round_provisioning(
  uuid, uuid, uuid, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_arena_round_provisioning(
  text, integer, timestamptz
) to service_role;
grant execute on function public.fail_arena_round_provisioning(
  uuid, uuid, timestamptz, text, text, boolean
) to service_role;
grant execute on function public.commit_arena_round_provisioning(
  uuid, uuid, uuid, text, jsonb, timestamptz
) to service_role;

commit;
