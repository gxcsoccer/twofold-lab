-- Durable, lease-based orchestration for the real market cadence.  A Worker
-- wakes only at evidence-availability boundaries; it does not compress a
-- multi-session decision into one immediate demo transaction.

begin;

alter table public.arena_round_entry
  add constraint arena_round_entry_full_identity_unique
  unique (round_entry_id, round_id, season_id, entrant_id, run_id);

create table public.arena_work_item (
  work_item_id uuid primary key,
  idempotency_key text not null unique check (idempotency_key <> ''),
  round_entry_id uuid not null,
  round_id uuid not null,
  season_id uuid not null,
  entrant_id uuid not null,
  run_id uuid not null,
  phase text not null check (phase in (
    'RUN_AGENT_DECISION',
    'CAPTURE_S1_OPEN_REFERENCE',
    'CAPTURE_S1_CLOSE',
    'CAPTURE_S2_OPEN_REFERENCE',
    'FINALIZE_ACCEPTED_TARGET_CYCLE'
  )),
  predecessor_work_item_id uuid references public.arena_work_item(work_item_id),
  scheduled_at timestamptz not null,
  deadline_at timestamptz,
  next_attempt_at timestamptz not null,
  status text not null default 'REQUESTED' check (status in (
    'REQUESTED', 'CLAIMED', 'SUCCEEDED', 'FAILED', 'CANCELED'
  )),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claimed_by text,
  lease_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error_code text,
  error_message text,
  retryable boolean,
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint arena_work_item_entry_fk foreign key (
    round_entry_id, round_id, season_id, entrant_id, run_id
  ) references public.arena_round_entry(
    round_entry_id, round_id, season_id, entrant_id, run_id
  ),
  constraint arena_work_item_phase_unique unique (round_entry_id, phase),
  constraint arena_work_item_id_deterministic check (
    work_item_id = public.deterministic_uuid_from_sha256(
      'twofold.arena_work_item/v1',
      round_entry_id::text || ':' || phase
    )
  ),
  constraint arena_work_item_time_order check (
    deadline_at is null or deadline_at > scheduled_at
  ),
  constraint arena_work_item_result_object check (
    result is null or jsonb_typeof(result) = 'object'
  ),
  constraint arena_work_item_result_decimal_safe check (
    result is null or not public.jsonb_contains_number(result)
  ),
  constraint arena_work_item_claim_shape check (
    (status = 'CLAIMED'
      and claimed_by is not null and lease_token is not null
      and claimed_at is not null and lease_expires_at > claimed_at
      and completed_at is null)
    or
    (status <> 'CLAIMED'
      and claimed_by is null and lease_token is null
      and claimed_at is null and lease_expires_at is null)
  ),
  constraint arena_work_item_terminal_shape check (
    (status in ('SUCCEEDED', 'FAILED', 'CANCELED') and completed_at is not null)
    or (status in ('REQUESTED', 'CLAIMED') and completed_at is null)
  )
);

comment on table public.arena_work_item is
  'Lease-based, prerequisite-ordered work at real decision/open/close availability boundaries.';

create index arena_work_item_claim_idx on public.arena_work_item(
  status, next_attempt_at, scheduled_at, round_id, entrant_id
);

create or replace function public.guard_arena_work_item_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'arena_work_item cannot be deleted' using errcode = '55000';
  end if;
  if current_setting('twofold.arena_work_item_mutation', true)
       is distinct from 'on'
  then
    raise exception 'arena_work_item may change only through queue RPCs'
      using errcode = '55000';
  end if;
  if new.work_item_id is distinct from old.work_item_id
    or new.idempotency_key is distinct from old.idempotency_key
    or new.round_entry_id is distinct from old.round_entry_id
    or new.round_id is distinct from old.round_id
    or new.season_id is distinct from old.season_id
    or new.entrant_id is distinct from old.entrant_id
    or new.run_id is distinct from old.run_id
    or new.phase is distinct from old.phase
    or new.predecessor_work_item_id
      is distinct from old.predecessor_work_item_id
    or new.scheduled_at is distinct from old.scheduled_at
    or new.deadline_at is distinct from old.deadline_at
    or new.recorded_by is distinct from old.recorded_by
    or new.recorded_at is distinct from old.recorded_at
  then
    raise exception 'Arena work identity and schedule are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger arena_work_item_guarded
before update or delete on public.arena_work_item
for each row execute function public.guard_arena_work_item_mutation();

create or replace function public.arena_work_item_result(
  p_item public.arena_work_item
)
returns jsonb
language sql
stable
strict
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'twofold.arena_work_item_result/v1',
    'workItemId', p_item.work_item_id::text,
    'roundEntryId', p_item.round_entry_id::text,
    'roundId', p_item.round_id::text,
    'seasonId', p_item.season_id::text,
    'entrantId', p_item.entrant_id::text,
    'runId', p_item.run_id::text,
    'phase', p_item.phase,
    'predecessorWorkItemId', p_item.predecessor_work_item_id::text,
    'scheduledAt', to_char(
      p_item.scheduled_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'deadlineAt', case when p_item.deadline_at is null then null else to_char(
      p_item.deadline_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) end,
    'nextAttemptAt', to_char(
      p_item.next_attempt_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'status', p_item.status,
    'attemptCount', p_item.attempt_count::text,
    'claimedBy', p_item.claimed_by,
    'leaseToken', p_item.lease_token::text,
    'leaseExpiresAt', case when p_item.lease_expires_at is null then null else to_char(
      p_item.lease_expires_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) end,
    'completedAt', case when p_item.completed_at is null then null else to_char(
      p_item.completed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) end,
    'result', p_item.result,
    'errorCode', p_item.error_code,
    'errorMessage', p_item.error_message,
    'retryable', p_item.retryable
  )
$$;

create or replace function public.seed_arena_round_work(
  p_round_id uuid,
  p_recorded_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_round public.arena_round%rowtype;
  v_entry public.arena_round_entry%rowtype;
  v_phase record;
  v_item_id uuid;
  v_predecessor_id uuid;
  v_existing public.arena_work_item%rowtype;
  v_count bigint := 0;
begin
  if p_round_id is null
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid Arena work seed' using errcode = '22023';
  end if;
  select * into v_round from public.arena_round where round_id = p_round_id;
  if not found then
    raise exception 'Arena Round is missing' using errcode = '23503';
  end if;

  for v_entry in
    select * from public.arena_round_entry
     where round_id = p_round_id
     order by entrant_id
  loop
    v_predecessor_id := null;
    for v_phase in
      select * from (values
        (1, 'RUN_AGENT_DECISION'::text,
          v_round.decision_window_opens_at,
          v_round.decision_window_closes_at),
        (2, 'CAPTURE_S1_OPEN_REFERENCE'::text,
          v_round.s1_reference_available_at, v_round.s1_close_at),
        (3, 'CAPTURE_S1_CLOSE'::text,
          v_round.s1_close_available_at, v_round.s2_open_at),
        (4, 'CAPTURE_S2_OPEN_REFERENCE'::text,
          v_round.s2_reference_available_at, v_round.s2_close_at),
        (5, 'FINALIZE_ACCEPTED_TARGET_CYCLE'::text,
          v_round.cycle_ready_at, null::timestamptz)
      ) as phases(phase_order, phase, scheduled_at, deadline_at)
      order by phase_order
    loop
      v_item_id := public.deterministic_uuid_from_sha256(
        'twofold.arena_work_item/v1',
        v_entry.round_entry_id::text || ':' || v_phase.phase
      );
      select * into v_existing from public.arena_work_item
       where work_item_id = v_item_id
          or idempotency_key = v_entry.round_entry_id::text || ':' || v_phase.phase
       limit 1;
      if found then
        if v_existing.round_entry_id is distinct from v_entry.round_entry_id
          or v_existing.phase is distinct from v_phase.phase
          or v_existing.predecessor_work_item_id
            is distinct from v_predecessor_id
          or v_existing.scheduled_at is distinct from v_phase.scheduled_at
          or v_existing.deadline_at is distinct from v_phase.deadline_at
          or v_existing.recorded_by is distinct from p_recorded_by
        then
          raise exception 'Arena work seed identity was reused with different content'
            using errcode = '23505';
        end if;
      else
        insert into public.arena_work_item (
          work_item_id, idempotency_key, round_entry_id, round_id,
          season_id, entrant_id, run_id, phase, predecessor_work_item_id,
          scheduled_at, deadline_at, next_attempt_at, recorded_by
        ) values (
          v_item_id, v_entry.round_entry_id::text || ':' || v_phase.phase,
          v_entry.round_entry_id, v_entry.round_id, v_entry.season_id,
          v_entry.entrant_id, v_entry.run_id, v_phase.phase,
          v_predecessor_id, v_phase.scheduled_at, v_phase.deadline_at,
          v_phase.scheduled_at, p_recorded_by
        );
      end if;
      v_predecessor_id := v_item_id;
      v_count := v_count + 1;
    end loop;
  end loop;
  if v_count = 0 then
    raise exception 'Arena Round has no entrant entries' using errcode = '55000';
  end if;
  return jsonb_build_object(
    'schema', 'twofold.arena_work_seed_result/v1',
    'roundId', p_round_id::text,
    'workItemCount', v_count::text,
    'recordedBy', p_recorded_by
  );
end;
$$;

create or replace function public.claim_arena_work_item(
  p_worker_id text,
  p_lease_seconds integer,
  p_now timestamptz default clock_timestamp(),
  p_round_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_item public.arena_work_item%rowtype;
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
    or p_worker_id is distinct from btrim(p_worker_id)
    or p_lease_seconds is null or p_lease_seconds < 5 or p_lease_seconds > 3600
    or p_now is null
  then
    raise exception 'invalid Arena work claim' using errcode = '22023';
  end if;
  perform set_config('twofold.arena_work_item_mutation', 'on', true);
  update public.arena_work_item
     set status = 'CANCELED', completed_at = p_now,
         error_code = 'DEADLINE_EXPIRED',
         error_message = 'Work item was not claimed before its deadline',
         retryable = false
   where status = 'REQUESTED' and deadline_at < p_now
     and (p_round_id is null or round_id = p_round_id);
  update public.arena_work_item
     set status = 'REQUESTED', claimed_by = null, lease_token = null,
         claimed_at = null, lease_expires_at = null,
         next_attempt_at = p_now
   where status = 'CLAIMED' and lease_expires_at <= p_now
     and (p_round_id is null or round_id = p_round_id);

  select item.* into v_item
    from public.arena_work_item as item
   where item.status = 'REQUESTED'
     and (p_round_id is null or item.round_id = p_round_id)
     and item.scheduled_at <= p_now
     and item.next_attempt_at <= p_now
     and (item.deadline_at is null or p_now <= item.deadline_at)
     and (
       item.predecessor_work_item_id is null
       or exists (
         select 1 from public.arena_work_item as predecessor
          where predecessor.work_item_id = item.predecessor_work_item_id
            and predecessor.status = 'SUCCEEDED'
       )
     )
   order by item.scheduled_at, item.round_id, item.entrant_id, item.work_item_id
   for update skip locked
   limit 1;
  if not found then
    perform set_config('twofold.arena_work_item_mutation', 'off', true);
    return null;
  end if;
  update public.arena_work_item
     set status = 'CLAIMED', attempt_count = attempt_count + 1,
         claimed_by = p_worker_id, lease_token = gen_random_uuid(),
         claimed_at = p_now,
         lease_expires_at = p_now + make_interval(secs => p_lease_seconds)
   where work_item_id = v_item.work_item_id
   returning * into v_item;
  perform set_config('twofold.arena_work_item_mutation', 'off', true);
  return public.arena_work_item_result(v_item);
end;
$$;

create or replace function public.complete_arena_work_item(
  p_work_item_id uuid,
  p_lease_token uuid,
  p_completed_at timestamptz,
  p_succeeded boolean,
  p_result jsonb,
  p_error_code text,
  p_error_message text,
  p_retryable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_item public.arena_work_item%rowtype;
  v_will_retry boolean;
begin
  if p_work_item_id is null or p_lease_token is null or p_completed_at is null
    or p_succeeded is null
    or p_result is null or jsonb_typeof(p_result) <> 'object'
    or public.jsonb_contains_number(p_result)
    or (p_succeeded and (
      p_error_code is not null or p_error_message is not null
      or p_retryable is distinct from false
    ))
    or (not p_succeeded and (
      p_error_code is null or btrim(p_error_code) = ''
      or p_error_message is null or btrim(p_error_message) = ''
      or p_retryable is null
    ))
  then
    raise exception 'invalid Arena work completion' using errcode = '22023';
  end if;
  select * into v_item from public.arena_work_item
   where work_item_id = p_work_item_id for update;
  if not found or v_item.status <> 'CLAIMED'
    or v_item.lease_token is distinct from p_lease_token
    or p_completed_at > v_item.lease_expires_at
  then
    raise exception 'Arena work lease is missing, stale, or expired'
      using errcode = '40001';
  end if;
  v_will_retry := not p_succeeded and p_retryable
    and v_item.attempt_count < 3
    and (v_item.deadline_at is null
      or p_completed_at + interval '1 minute' <= v_item.deadline_at);
  perform set_config('twofold.arena_work_item_mutation', 'on', true);
  update public.arena_work_item
     set status = case
           when p_succeeded then 'SUCCEEDED'
           when v_will_retry then 'REQUESTED'
           else 'FAILED'
         end,
         next_attempt_at = case when v_will_retry
           then p_completed_at + interval '1 minute'
           else next_attempt_at end,
         claimed_by = null, lease_token = null, claimed_at = null,
         lease_expires_at = null,
         completed_at = case when v_will_retry then null else p_completed_at end,
         result = p_result,
         error_code = p_error_code,
         error_message = p_error_message,
         retryable = case when v_will_retry then true else p_retryable end
   where work_item_id = p_work_item_id
   returning * into v_item;
  perform set_config('twofold.arena_work_item_mutation', 'off', true);
  return public.arena_work_item_result(v_item);
end;
$$;

alter table public.arena_work_item enable row level security;
revoke all on table public.arena_work_item
  from public, anon, authenticated, service_role;
grant select on table public.arena_work_item to service_role;
revoke all on function public.arena_work_item_result(public.arena_work_item)
  from public, anon, authenticated;
revoke all on function public.seed_arena_round_work(uuid, text)
  from public, anon, authenticated;
revoke all on function public.claim_arena_work_item(
  text, integer, timestamptz, uuid
)
  from public, anon, authenticated;
revoke all on function public.complete_arena_work_item(
  uuid, uuid, timestamptz, boolean, jsonb, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.seed_arena_round_work(uuid, text)
  to service_role;
grant execute on function public.claim_arena_work_item(
  text, integer, timestamptz, uuid
)
  to service_role;
grant execute on function public.complete_arena_work_item(
  uuid, uuid, timestamptz, boolean, jsonb, text, text, boolean
) to service_role;

commit;
