-- A market phase is valid only inside its frozen temporal boundary.  A Worker
-- may start before a deadline and finish after it, so claim-time filtering is
-- insufficient.  Completion also needs an exact retry fence because a success
-- response can be lost after Postgres commits it.

begin;

alter table public.arena_work_item
  add column completion_fingerprint_sha256 text check (
    completion_fingerprint_sha256 is null
      or completion_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
  );

comment on column public.arena_work_item.completion_fingerprint_sha256 is
  'Exact terminal or retryable completion identity; cleared by the next successful claim.';

create or replace function public.claim_arena_work_item(
  p_worker_id text,
  p_lease_seconds integer,
  p_now timestamptz,
  p_round_id uuid,
  p_allowed_phases text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_item public.arena_work_item%rowtype;
  v_normalized_phases text[];
begin
  select array_agg(distinct phase order by phase)
    into v_normalized_phases
    from unnest(p_allowed_phases) as requested(phase);
  if p_worker_id is null or btrim(p_worker_id) = ''
    or p_worker_id is distinct from btrim(p_worker_id)
    or p_lease_seconds is null or p_lease_seconds < 5 or p_lease_seconds > 3600
    or p_now is null
    or p_allowed_phases is null or cardinality(p_allowed_phases) = 0
    or p_allowed_phases is distinct from v_normalized_phases
    or exists (
      select 1 from unnest(p_allowed_phases) as requested(phase)
       where requested.phase is null or requested.phase not in (
         'RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS',
         'CAPTURE_S1_OPEN_REFERENCE', 'CAPTURE_S1_CLOSE',
         'SETTLE_S1_AND_PREPARE_S2', 'CAPTURE_S2_OPEN_REFERENCE',
         'CAPTURE_S2_CLOSE', 'FINALIZE_ACCEPTED_TARGET_CYCLE'
       )
    )
  then
    raise exception 'invalid capability-filtered Arena work claim'
      using errcode = '22023';
  end if;

  perform set_config('twofold.arena_work_item_mutation', 'on', true);
  -- Release an abandoned lease first, then expire it in this same sweep when
  -- its market boundary has already passed.
  update public.arena_work_item
     set status = 'REQUESTED', claimed_by = null, lease_token = null,
         claimed_at = null, lease_expires_at = null, next_attempt_at = p_now
   where status = 'CLAIMED' and lease_expires_at <= p_now
     and (p_round_id is null or round_id = p_round_id);
  update public.arena_work_item
     set status = 'CANCELED', completed_at = p_now,
         completion_fingerprint_sha256 = null,
         result = jsonb_build_object('outcome', 'DEADLINE_EXPIRED'),
         error_code = 'DEADLINE_EXPIRED',
         error_message = 'Work item was not completed before its deadline',
         retryable = false
   where status = 'REQUESTED' and deadline_at <= p_now
     and (p_round_id is null or round_id = p_round_id);

  select item.* into v_item
    from public.arena_work_item as item
   where item.status = 'REQUESTED'
     and item.phase = any(p_allowed_phases)
     and (p_round_id is null or item.round_id = p_round_id)
     and item.scheduled_at <= p_now
     and item.next_attempt_at <= p_now
     and (item.deadline_at is null or p_now < item.deadline_at)
     and not exists (
       select 1
         from public.arena_work_dependency as dependency
         join public.arena_work_item as prerequisite
           on prerequisite.work_item_id = dependency.prerequisite_work_item_id
        where dependency.work_item_id = item.work_item_id
          and prerequisite.status <> 'SUCCEEDED'
     )
   order by item.scheduled_at, item.round_id, item.entrant_id, item.work_item_id
   for update of item skip locked
   limit 1;
  if not found then
    perform set_config('twofold.arena_work_item_mutation', 'off', true);
    return null;
  end if;
  update public.arena_work_item
     set status = 'CLAIMED', attempt_count = attempt_count + 1,
         claimed_by = p_worker_id, lease_token = gen_random_uuid(),
         claimed_at = p_now,
         lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
         completed_at = null, completion_fingerprint_sha256 = null,
         result = null, error_code = null, error_message = null,
         retryable = null
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
  v_completion_fingerprint text;
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
  v_completion_fingerprint := encode(extensions.digest(convert_to(
    p_work_item_id::text || chr(31) || p_lease_token::text || chr(31)
      || to_char(p_completed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || chr(31)
      || p_succeeded::text || chr(31) || p_result::text || chr(31)
      || coalesce(p_error_code, '') || chr(31)
      || coalesce(p_error_message, '') || chr(31) || p_retryable::text,
    'UTF8'
  ), 'sha256'), 'hex');
  select * into v_item from public.arena_work_item
   where work_item_id = p_work_item_id for update;
  if found and v_item.status <> 'CLAIMED'
    and v_item.completion_fingerprint_sha256 = v_completion_fingerprint
  then
    return public.arena_work_item_result(v_item);
  end if;
  if found and v_item.status <> 'CLAIMED'
    and v_item.completion_fingerprint_sha256 is not null
  then
    raise exception 'Arena work completion identity was reused with different content'
      using errcode = '23505';
  end if;
  if not found or v_item.status <> 'CLAIMED'
    or v_item.lease_token is distinct from p_lease_token
    or p_completed_at < v_item.claimed_at
    or p_completed_at > v_item.lease_expires_at
  then
    raise exception 'Arena work lease is missing, stale, or expired'
      using errcode = '40001';
  end if;
  if p_succeeded and v_item.deadline_at is not null
    and p_completed_at > v_item.deadline_at
  then
    raise exception 'Arena work success missed its deadline'
      using errcode = '55000';
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
         completion_fingerprint_sha256 = v_completion_fingerprint,
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

revoke all on function public.claim_arena_work_item(
  text, integer, timestamptz, uuid, text[]
) from public, anon, authenticated;
revoke all on function public.complete_arena_work_item(
  uuid, uuid, timestamptz, boolean, jsonb, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.claim_arena_work_item(
  text, integer, timestamptz, uuid, text[]
) to service_role;
grant execute on function public.complete_arena_work_item(
  uuid, uuid, timestamptz, boolean, jsonb, text, text, boolean
) to service_role;

commit;
