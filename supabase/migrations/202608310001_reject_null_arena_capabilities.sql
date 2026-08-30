-- Reject malformed capability arrays even on databases that already applied
-- the original capability-filtered claim migrations.

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
  update public.arena_work_item
     set status = 'REQUESTED', claimed_by = null, lease_token = null,
         claimed_at = null, lease_expires_at = null, next_attempt_at = p_now
   where status = 'CLAIMED' and lease_expires_at <= p_now
     and (p_round_id is null or round_id = p_round_id);

  update public.arena_work_item as item
     set status = 'CANCELED', completed_at = p_now,
         completion_fingerprint_sha256 = null,
         result = jsonb_build_object(
           'outcome', 'CORPORATE_ACTION_GATE_BLOCKED'
         ),
         error_code = 'CORPORATE_ACTION_GATE_BLOCKED',
         error_message =
           'Corporate-action evidence or application was not ready by deadline',
         retryable = false
   where item.status = 'REQUESTED' and item.deadline_at <= p_now
     and item.phase in (
       'RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS',
       'SETTLE_S1_AND_PREPARE_S2', 'FINALIZE_ACCEPTED_TARGET_CYCLE'
     )
     and (p_round_id is null or item.round_id = p_round_id)
     and not public.arena_corporate_action_phase_is_clear(
       item.round_id, item.phase, p_now
     );
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
     and (
       item.phase in (
         'CAPTURE_S1_OPEN_REFERENCE', 'CAPTURE_S1_CLOSE',
         'CAPTURE_S2_OPEN_REFERENCE', 'CAPTURE_S2_CLOSE'
       )
       or public.arena_corporate_action_phase_is_clear(
         item.round_id, item.phase, p_now
       )
     )
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

revoke all on function public.claim_arena_work_item(
  text, integer, timestamptz, uuid, text[]
) from public, anon, authenticated;
grant execute on function public.claim_arena_work_item(
  text, integer, timestamptz, uuid, text[]
) to service_role;

commit;
