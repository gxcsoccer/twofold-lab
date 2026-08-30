-- Daily close marks are execution inputs, not per-entrant observations. Bind
-- one already raw-artifact-backed market snapshot to each Round stage and make
-- S2 close an explicit queue boundary before final settlement.

begin;

create table public.arena_round_close_snapshot (
  idempotency_key text not null unique check (idempotency_key <> ''),
  round_id uuid not null,
  season_id uuid not null,
  stage text not null check (stage in ('S1_CLOSE', 'S2_CLOSE')),
  snapshot_id uuid not null references public.market_snapshot(snapshot_id),
  bound_by text not null check (bound_by <> ''),
  bound_at timestamptz not null default clock_timestamp(),
  primary key (round_id, stage),
  constraint arena_round_close_snapshot_round_fk foreign key (
    round_id, season_id
  ) references public.arena_round(round_id, season_id),
  constraint arena_round_close_snapshot_round_value_unique
    unique (round_id, snapshot_id)
);

comment on table public.arena_round_close_snapshot is
  'The single raw-artifact-backed daily close snapshot shared by every entrant at one Round stage.';

create trigger arena_round_close_snapshot_is_immutable
before update or delete on public.arena_round_close_snapshot
for each row execute function public.reject_immutable_mutation();
create trigger arena_round_close_snapshot_rejects_truncate
before truncate on public.arena_round_close_snapshot
for each statement execute function public.reject_immutable_mutation();

create or replace function public.get_arena_round_close_snapshot(
  p_round_id uuid,
  p_stage text
)
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
set row_security = off
as $$
  select jsonb_build_object(
    'schema', 'twofold.arena_round_close_snapshot/v1',
    'roundId', binding.round_id::text,
    'seasonId', binding.season_id::text,
    'stage', binding.stage,
    'snapshotId', snapshot.snapshot_id::text,
    'sourceVersionId', snapshot.source_version_id::text,
    'manifestSha256', snapshot.manifest_sha256,
    'sessionDate', snapshot.target_session_date::text,
    'cutoffAt', to_char(
      snapshot.cutoff_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'sealedAt', to_char(
      snapshot.sealed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'marks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'factId', fact.fact_id::text,
        'symbol', fact.symbol,
        'barStart', to_char(
          fact.bar_start at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'sessionDate', fact.bar_date::text,
        'currency', fact.currency,
        'value', fact.close_price,
        'factSha256', fact.fact_sha256,
        'deliveryId', delivery.delivery_id::text,
        'observedAt', to_char(
          delivery.first_observed_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'sourceArtifactId', artifact.raw_artifact_id::text,
        'sourceContentSha256', artifact.response_sha256
      ) order by member.member_index)
      from public.market_snapshot_member as member
      join public.market_bar_fact as fact on fact.fact_id = member.fact_id
      join public.source_delivery as delivery
        on delivery.delivery_id = member.delivery_id
      join public.raw_artifact as artifact
        on artifact.raw_artifact_id = delivery.raw_artifact_id
      where member.snapshot_id = snapshot.snapshot_id
    ), '[]'::jsonb),
    'boundBy', binding.bound_by,
    'boundAt', to_char(
      binding.bound_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  )
  from public.arena_round_close_snapshot as binding
  join public.market_snapshot as snapshot
    on snapshot.snapshot_id = binding.snapshot_id
  where binding.round_id = p_round_id and binding.stage = p_stage
$$;

create or replace function public.register_arena_round_close_snapshot(
  p_idempotency_key text,
  p_round_id uuid,
  p_stage text,
  p_snapshot_id uuid,
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
  v_snapshot public.market_snapshot%rowtype;
  v_decision_snapshot public.market_snapshot%rowtype;
  v_source public.data_source_version%rowtype;
  v_existing public.arena_round_close_snapshot%rowtype;
  v_session_date date;
  v_available_at timestamptz;
  v_deadline_at timestamptz;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_round_id is null
    or p_stage not in ('S1_CLOSE', 'S2_CLOSE')
    or p_snapshot_id is null
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid Arena close-snapshot registration'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'arena-round-close:' || p_round_id::text || ':' || p_stage, 0
  ));
  select * into v_existing
    from public.arena_round_close_snapshot
   where idempotency_key = p_idempotency_key
      or (round_id = p_round_id and stage = p_stage)
      or (round_id = p_round_id and snapshot_id = p_snapshot_id)
   order by case when idempotency_key = p_idempotency_key then 0 else 1 end
   limit 1;
  if found then
    if v_existing.idempotency_key is distinct from p_idempotency_key
      or v_existing.round_id is distinct from p_round_id
      or v_existing.stage is distinct from p_stage
      or v_existing.snapshot_id is distinct from p_snapshot_id
      or v_existing.bound_by is distinct from p_recorded_by
    then
      raise exception 'Arena close-snapshot identity was reused with different content'
        using errcode = '23505';
    end if;
    return public.get_arena_round_close_snapshot(p_round_id, p_stage);
  end if;

  select * into v_round from public.arena_round where round_id = p_round_id;
  select * into v_snapshot from public.market_snapshot
   where snapshot_id = p_snapshot_id;
  if v_round.round_id is null or v_snapshot.snapshot_id is null then
    raise exception 'Arena Round or close snapshot is missing'
      using errcode = '23503';
  end if;
  select * into strict v_decision_snapshot from public.market_snapshot
   where snapshot_id = v_round.decision_snapshot_id;
  select * into strict v_source from public.data_source_version
   where source_version_id = v_snapshot.source_version_id;

  if p_stage = 'S1_CLOSE' then
    v_session_date := v_round.s1_session_date;
    v_available_at := v_round.s1_close_available_at;
    v_deadline_at := v_round.s2_open_at;
  else
    v_session_date := v_round.s2_session_date;
    v_available_at := v_round.cycle_ready_at;
    v_deadline_at := null;
  end if;

  if v_snapshot.snapshot_kind <> 'market_close'
    or v_snapshot.target_session_date <> v_session_date
    or v_snapshot.symbols is distinct from v_decision_snapshot.symbols
    or v_snapshot.source_version_id
      is distinct from v_decision_snapshot.source_version_id
    or v_snapshot.cutoff_at < v_available_at
    or (v_deadline_at is not null and v_snapshot.cutoff_at > v_deadline_at)
    or v_source.provider <> 'alpaca'
    or v_source.dataset <> 'us_stock_daily_bars'
    or v_source.feed <> 'sip'
    or v_source.adjustment <> 'raw'
    or v_source.timeframe <> '1Day'
  then
    raise exception 'close snapshot does not match the frozen Round evidence fence'
      using errcode = '22023';
  end if;

  if (select count(*) from public.market_snapshot_member
       where snapshot_id = p_snapshot_id)
       <> cardinality(v_snapshot.symbols)
    or exists (
      select 1
        from public.market_snapshot_member as member
        join public.market_bar_fact as fact on fact.fact_id = member.fact_id
        join public.source_delivery as delivery
          on delivery.delivery_id = member.delivery_id
        join public.raw_artifact as artifact
          on artifact.raw_artifact_id = delivery.raw_artifact_id
       where member.snapshot_id = p_snapshot_id
         and (
           fact.source_version_id <> v_snapshot.source_version_id
           or fact.timeframe <> '1Day'
           or fact.bar_date <> v_session_date
           or fact.currency <> 'USD'
           or fact.close_price::numeric <= 0
           or delivery.source_version_id <> v_snapshot.source_version_id
           or delivery.available_at < v_available_at
           or delivery.available_at > v_snapshot.cutoff_at
           or (v_deadline_at is not null
             and delivery.available_at > v_deadline_at)
           or artifact.storage_bucket <> 'twofold-private-artifacts'
         )
    )
  then
    raise exception 'close snapshot members are incomplete or outside the frozen window'
      using errcode = '22023';
  end if;

  insert into public.arena_round_close_snapshot (
    idempotency_key, round_id, season_id, stage, snapshot_id, bound_by
  ) values (
    p_idempotency_key, p_round_id, v_round.season_id, p_stage,
    p_snapshot_id, p_recorded_by
  );
  return public.get_arena_round_close_snapshot(p_round_id, p_stage);
end;
$$;

alter table public.arena_round_close_snapshot enable row level security;
revoke all on table public.arena_round_close_snapshot
  from public, anon, authenticated, service_role;
grant select on table public.arena_round_close_snapshot to service_role;
revoke all on function public.get_arena_round_close_snapshot(uuid, text)
  from public, anon, authenticated;
revoke all on function public.register_arena_round_close_snapshot(
  text, uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.get_arena_round_close_snapshot(uuid, text)
  to service_role;
grant execute on function public.register_arena_round_close_snapshot(
  text, uuid, text, uuid, text
) to service_role;

-- Make S2 close a first-class phase rather than hiding a provider request
-- inside final settlement.
alter table public.arena_work_item
  drop constraint arena_work_item_phase_check;
alter table public.arena_work_item
  add constraint arena_work_item_phase_check check (phase in (
    'RUN_AGENT_DECISION',
    'CAPTURE_S1_OPEN_REFERENCE',
    'CAPTURE_S1_CLOSE',
    'CAPTURE_S2_OPEN_REFERENCE',
    'CAPTURE_S2_CLOSE',
    'FINALIZE_ACCEPTED_TARGET_CYCLE'
  ));

insert into public.arena_work_item (
  work_item_id, idempotency_key, round_entry_id, round_id, season_id,
  entrant_id, run_id, phase, predecessor_work_item_id, scheduled_at,
  deadline_at, next_attempt_at, recorded_by
)
select
  public.deterministic_uuid_from_sha256(
    'twofold.arena_work_item/v1',
    entry.round_entry_id::text || ':CAPTURE_S2_CLOSE'
  ),
  entry.round_entry_id::text || ':CAPTURE_S2_CLOSE',
  entry.round_entry_id, entry.round_id, entry.season_id,
  entry.entrant_id, entry.run_id, 'CAPTURE_S2_CLOSE',
  public.deterministic_uuid_from_sha256(
    'twofold.arena_work_item/v1',
    entry.round_entry_id::text || ':CAPTURE_S2_OPEN_REFERENCE'
  ),
  round.cycle_ready_at, null, round.cycle_ready_at, seed.recorded_by
from public.arena_round_entry as entry
join public.arena_round as round on round.round_id = entry.round_id
join public.arena_work_item as seed
  on seed.round_entry_id = entry.round_entry_id
 and seed.phase = 'RUN_AGENT_DECISION'
where exists (
  select 1 from public.arena_work_item as prior
   where prior.round_entry_id = entry.round_entry_id
     and prior.phase = 'CAPTURE_S2_OPEN_REFERENCE'
)
on conflict (work_item_id) do nothing;

do $$
begin
  if exists (
    select 1 from public.arena_work_item
     where phase = 'FINALIZE_ACCEPTED_TARGET_CYCLE'
       and status <> 'REQUESTED'
       and predecessor_work_item_id is distinct from
         public.deterministic_uuid_from_sha256(
           'twofold.arena_work_item/v1',
           round_entry_id::text || ':CAPTURE_S2_CLOSE'
         )
  ) then
    raise exception 'cannot insert S2 close before an already-started finalizer'
      using errcode = '55000';
  end if;
end;
$$;

drop trigger arena_work_item_guarded on public.arena_work_item;
update public.arena_work_item
   set predecessor_work_item_id = public.deterministic_uuid_from_sha256(
     'twofold.arena_work_item/v1',
     round_entry_id::text || ':CAPTURE_S2_CLOSE'
   )
 where phase = 'FINALIZE_ACCEPTED_TARGET_CYCLE'
   and status = 'REQUESTED';
create trigger arena_work_item_guarded
before update or delete on public.arena_work_item
for each row execute function public.guard_arena_work_item_mutation();

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
        (5, 'CAPTURE_S2_CLOSE'::text,
          v_round.cycle_ready_at, null::timestamptz),
        (6, 'FINALIZE_ACCEPTED_TARGET_CYCLE'::text,
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

commit;
