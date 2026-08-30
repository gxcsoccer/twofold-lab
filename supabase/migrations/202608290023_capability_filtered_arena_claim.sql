-- A process must advertise the phases it can actually execute before leasing
-- work. This prevents a market-only Worker from consuming an Agent task when
-- DEEPSEEK_API_KEY is absent (and vice versa).

begin;

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
       where requested.phase not in (
         'RUN_AGENT_DECISION', 'CAPTURE_S1_OPEN_REFERENCE',
         'CAPTURE_S1_CLOSE', 'CAPTURE_S2_OPEN_REFERENCE',
         'FINALIZE_ACCEPTED_TARGET_CYCLE'
       )
    )
  then
    raise exception 'invalid capability-filtered Arena work claim'
      using errcode = '22023';
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
     and item.phase = any(p_allowed_phases)
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

revoke all on function public.claim_arena_work_item(
  text, integer, timestamptz, uuid, text[]
) from public, anon, authenticated;
grant execute on function public.claim_arena_work_item(
  text, integer, timestamptz, uuid, text[]
) to service_role;

commit;
