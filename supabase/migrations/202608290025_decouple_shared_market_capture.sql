-- Shared market evidence must be captured even when an entrant has no valid
-- model submission. Final settlement remains entrant-specific and therefore
-- still requires that entrant's Agent phase to have succeeded.

begin;

create or replace function public.decouple_arena_shared_market_capture()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.phase = 'CAPTURE_S1_OPEN_REFERENCE' then
    new.predecessor_work_item_id := null;
  end if;
  return new;
end;
$$;

create trigger arena_work_item_decouples_shared_market_capture
before insert on public.arena_work_item
for each row execute function public.decouple_arena_shared_market_capture();

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
      if v_phase.phase = 'CAPTURE_S1_OPEN_REFERENCE' then
        v_predecessor_id := null;
      end if;
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

drop trigger arena_work_item_guarded on public.arena_work_item;
update public.arena_work_item
   set predecessor_work_item_id = null
 where phase = 'CAPTURE_S1_OPEN_REFERENCE'
   and status = 'REQUESTED';
create trigger arena_work_item_guarded
before update or delete on public.arena_work_item
for each row execute function public.guard_arena_work_item_mutation();

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
     and (
       item.phase <> 'FINALIZE_ACCEPTED_TARGET_CYCLE'
       or exists (
         select 1 from public.arena_work_item as agent
          where agent.round_entry_id = item.round_entry_id
            and agent.phase = 'RUN_AGENT_DECISION'
            and agent.status = 'SUCCEEDED'
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

revoke all on function public.decouple_arena_shared_market_capture()
  from public, anon, authenticated, service_role;

commit;
