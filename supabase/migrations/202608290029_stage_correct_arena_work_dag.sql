-- A two-session cycle is not one post-hoc calculation. Freeze S1 before its
-- open, settle S1 and freeze S2 before the next open, then finalize only after
-- S2 evidence. Represent the multi-input prerequisites as data instead of a
-- hard-coded single-predecessor chain.

begin;

alter table public.arena_work_item
  drop constraint arena_work_item_phase_check;
alter table public.arena_work_item
  add constraint arena_work_item_phase_check check (phase in (
    'RUN_AGENT_DECISION',
    'PREPARE_S1_ORDERS',
    'CAPTURE_S1_OPEN_REFERENCE',
    'CAPTURE_S1_CLOSE',
    'SETTLE_S1_AND_PREPARE_S2',
    'CAPTURE_S2_OPEN_REFERENCE',
    'CAPTURE_S2_CLOSE',
    'FINALIZE_ACCEPTED_TARGET_CYCLE'
  ));

alter table public.arena_work_item
  add constraint arena_work_item_id_entry_unique
  unique (work_item_id, round_entry_id);

create table public.arena_work_dependency (
  work_item_id uuid not null,
  prerequisite_work_item_id uuid not null,
  round_entry_id uuid not null,
  primary key (work_item_id, prerequisite_work_item_id),
  constraint arena_work_dependency_item_fk foreign key (
    work_item_id, round_entry_id
  ) references public.arena_work_item(work_item_id, round_entry_id),
  constraint arena_work_dependency_prerequisite_fk foreign key (
    prerequisite_work_item_id, round_entry_id
  ) references public.arena_work_item(work_item_id, round_entry_id),
  constraint arena_work_dependency_not_self check (
    work_item_id <> prerequisite_work_item_id
  )
);

comment on table public.arena_work_dependency is
  'Immutable same-entry prerequisite edges for the real-time Arena work DAG.';

create index arena_work_dependency_prerequisite_idx
  on public.arena_work_dependency(prerequisite_work_item_id, work_item_id);
create trigger arena_work_dependency_is_immutable
before update or delete on public.arena_work_dependency
for each row execute function public.reject_immutable_mutation();
create trigger arena_work_dependency_rejects_truncate
before truncate on public.arena_work_dependency
for each statement execute function public.reject_immutable_mutation();

alter table public.arena_work_dependency enable row level security;
revoke all on table public.arena_work_dependency
  from public, anon, authenticated, service_role;
grant select on table public.arena_work_dependency to service_role;

create or replace function public.decouple_arena_shared_market_capture()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.phase in (
    'CAPTURE_S1_OPEN_REFERENCE', 'CAPTURE_S1_CLOSE',
    'CAPTURE_S2_OPEN_REFERENCE', 'CAPTURE_S2_CLOSE'
  ) then
    new.predecessor_work_item_id := null;
  end if;
  return new;
end;
$$;

-- Existing private-Round work is still unclaimed. Refuse to silently rewrite
-- a started historical chain if this migration is reused elsewhere.
do $$
begin
  if exists (
    select 1 from public.arena_work_item
     where phase in (
       'CAPTURE_S1_CLOSE', 'CAPTURE_S2_OPEN_REFERENCE', 'CAPTURE_S2_CLOSE'
     )
       and predecessor_work_item_id is not null
       and status <> 'REQUESTED'
  ) then
    raise exception 'cannot make already-started shared evidence independent'
      using errcode = '55000';
  end if;
end;
$$;

drop trigger arena_work_item_guarded on public.arena_work_item;
update public.arena_work_item
   set predecessor_work_item_id = null
 where phase in (
   'CAPTURE_S1_OPEN_REFERENCE', 'CAPTURE_S1_CLOSE',
   'CAPTURE_S2_OPEN_REFERENCE', 'CAPTURE_S2_CLOSE'
 ) and status = 'REQUESTED';
create trigger arena_work_item_guarded
before update or delete on public.arena_work_item
for each row execute function public.guard_arena_work_item_mutation();

insert into public.arena_work_item (
  work_item_id, idempotency_key, round_entry_id, round_id, season_id,
  entrant_id, run_id, phase, predecessor_work_item_id, scheduled_at,
  deadline_at, next_attempt_at, recorded_by
)
select
  public.deterministic_uuid_from_sha256(
    'twofold.arena_work_item/v1',
    entry.round_entry_id::text || ':' || phase.phase
  ),
  entry.round_entry_id::text || ':' || phase.phase,
  entry.round_entry_id, entry.round_id, entry.season_id,
  entry.entrant_id, entry.run_id, phase.phase,
  public.deterministic_uuid_from_sha256(
    'twofold.arena_work_item/v1',
    entry.round_entry_id::text || ':' || phase.predecessor_phase
  ),
  phase.scheduled_at, phase.deadline_at, phase.scheduled_at,
  seed.recorded_by
from public.arena_round_entry as entry
join public.arena_round as round on round.round_id = entry.round_id
join public.arena_work_item as seed
  on seed.round_entry_id = entry.round_entry_id
 and seed.phase = 'RUN_AGENT_DECISION'
cross join lateral (values
  ('PREPARE_S1_ORDERS'::text, 'RUN_AGENT_DECISION'::text,
    round.decision_window_opens_at, round.s1_open_at),
  ('SETTLE_S1_AND_PREPARE_S2'::text, 'CAPTURE_S1_CLOSE'::text,
    round.s1_close_available_at, round.s2_open_at)
) as phase(phase, predecessor_phase, scheduled_at, deadline_at)
on conflict (work_item_id) do nothing;

create or replace function public.seed_arena_work_dependencies(
  p_round_entry_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_edge record;
  v_work_item_id uuid;
  v_prerequisite_work_item_id uuid;
begin
  if p_round_entry_id is null or not exists (
    select 1 from public.arena_round_entry
     where round_entry_id = p_round_entry_id
  ) then
    raise exception 'Arena Round entry is missing for dependency seed'
      using errcode = '23503';
  end if;

  for v_edge in
    select * from (values
      ('PREPARE_S1_ORDERS'::text, 'RUN_AGENT_DECISION'::text),
      ('SETTLE_S1_AND_PREPARE_S2'::text, 'PREPARE_S1_ORDERS'::text),
      ('SETTLE_S1_AND_PREPARE_S2'::text, 'CAPTURE_S1_OPEN_REFERENCE'::text),
      ('SETTLE_S1_AND_PREPARE_S2'::text, 'CAPTURE_S1_CLOSE'::text),
      ('FINALIZE_ACCEPTED_TARGET_CYCLE'::text,
        'SETTLE_S1_AND_PREPARE_S2'::text),
      ('FINALIZE_ACCEPTED_TARGET_CYCLE'::text,
        'CAPTURE_S2_OPEN_REFERENCE'::text),
      ('FINALIZE_ACCEPTED_TARGET_CYCLE'::text, 'CAPTURE_S2_CLOSE'::text)
    ) as edges(phase, prerequisite_phase)
  loop
    v_work_item_id := public.deterministic_uuid_from_sha256(
      'twofold.arena_work_item/v1',
      p_round_entry_id::text || ':' || v_edge.phase
    );
    v_prerequisite_work_item_id := public.deterministic_uuid_from_sha256(
      'twofold.arena_work_item/v1',
      p_round_entry_id::text || ':' || v_edge.prerequisite_phase
    );
    if not exists (
      select 1 from public.arena_work_item
       where work_item_id in (v_work_item_id, v_prerequisite_work_item_id)
       group by round_entry_id
      having round_entry_id = p_round_entry_id and count(*) = 2
    ) then
      raise exception 'Arena dependency references a missing work phase'
        using errcode = '23503';
    end if;
    insert into public.arena_work_dependency (
      work_item_id, prerequisite_work_item_id, round_entry_id
    ) values (
      v_work_item_id, v_prerequisite_work_item_id, p_round_entry_id
    ) on conflict (work_item_id, prerequisite_work_item_id) do nothing;
  end loop;
end;
$$;

do $$
declare
  v_entry record;
begin
  for v_entry in select round_entry_id from public.arena_round_entry loop
    perform public.seed_arena_work_dependencies(v_entry.round_entry_id);
  end loop;
end;
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
    for v_phase in
      select * from (values
        (1, 'RUN_AGENT_DECISION'::text,
          v_round.decision_window_opens_at,
          v_round.decision_window_closes_at),
        (2, 'PREPARE_S1_ORDERS'::text,
          v_round.decision_window_opens_at, v_round.s1_open_at),
        (3, 'CAPTURE_S1_OPEN_REFERENCE'::text,
          v_round.s1_reference_available_at, v_round.s1_close_at),
        (4, 'CAPTURE_S1_CLOSE'::text,
          v_round.s1_close_available_at, v_round.s2_open_at),
        (5, 'SETTLE_S1_AND_PREPARE_S2'::text,
          v_round.s1_close_available_at, v_round.s2_open_at),
        (6, 'CAPTURE_S2_OPEN_REFERENCE'::text,
          v_round.s2_reference_available_at, v_round.s2_close_at),
        (7, 'CAPTURE_S2_CLOSE'::text,
          v_round.cycle_ready_at, null::timestamptz),
        (8, 'FINALIZE_ACCEPTED_TARGET_CYCLE'::text,
          v_round.cycle_ready_at, null::timestamptz)
      ) as phases(phase_order, phase, scheduled_at, deadline_at)
      order by phase_order
    loop
      v_predecessor_id := case v_phase.phase
        when 'PREPARE_S1_ORDERS' then
          public.deterministic_uuid_from_sha256(
            'twofold.arena_work_item/v1',
            v_entry.round_entry_id::text || ':RUN_AGENT_DECISION'
          )
        when 'SETTLE_S1_AND_PREPARE_S2' then
          public.deterministic_uuid_from_sha256(
            'twofold.arena_work_item/v1',
            v_entry.round_entry_id::text || ':CAPTURE_S1_CLOSE'
          )
        when 'FINALIZE_ACCEPTED_TARGET_CYCLE' then
          public.deterministic_uuid_from_sha256(
            'twofold.arena_work_item/v1',
            v_entry.round_entry_id::text || ':CAPTURE_S2_CLOSE'
          )
        else null
      end;
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
      v_count := v_count + 1;
    end loop;
    perform public.seed_arena_work_dependencies(v_entry.round_entry_id);
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
         lease_expires_at = p_now + make_interval(secs => p_lease_seconds)
   where work_item_id = v_item.work_item_id
   returning * into v_item;
  perform set_config('twofold.arena_work_item_mutation', 'off', true);
  return public.arena_work_item_result(v_item);
end;
$$;

create or replace function public.claim_arena_work_item(
  p_worker_id text,
  p_lease_seconds integer,
  p_now timestamptz default clock_timestamp(),
  p_round_id uuid default null
)
returns jsonb
language sql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
  select public.claim_arena_work_item(
    p_worker_id, p_lease_seconds, p_now, p_round_id,
    array[
      'CAPTURE_S1_CLOSE', 'CAPTURE_S1_OPEN_REFERENCE',
      'CAPTURE_S2_CLOSE', 'CAPTURE_S2_OPEN_REFERENCE',
      'FINALIZE_ACCEPTED_TARGET_CYCLE', 'PREPARE_S1_ORDERS',
      'RUN_AGENT_DECISION', 'SETTLE_S1_AND_PREPARE_S2'
    ]::text[]
  )
$$;

revoke all on function public.seed_arena_work_dependencies(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_arena_work_item(
  text, integer, timestamptz, uuid, text[]
) from public, anon, authenticated;
revoke all on function public.claim_arena_work_item(
  text, integer, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.claim_arena_work_item(
  text, integer, timestamptz, uuid, text[]
) to service_role;
grant execute on function public.claim_arena_work_item(
  text, integer, timestamptz, uuid
) to service_role;

commit;
