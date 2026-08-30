-- Compose structural Round readiness with the nominal capacity of the frozen
-- one-minute Worker cadence. A structurally complete competition must still
-- fail closed when its entrant fan-out cannot drain before market deadlines.

begin;

alter function public.get_arena_round_readiness(uuid, timestamptz)
  rename to get_arena_round_structural_readiness_base;

comment on function public.get_arena_round_structural_readiness_base(
  uuid, timestamptz
) is
  'Internal structural proof used by the public Round readiness and capacity gate.';

revoke all on function public.get_arena_round_structural_readiness_base(
  uuid, timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.arena_tick_capacity_fits(
  p_entrant_count bigint,
  p_window_minutes bigint,
  p_dependency_lag_ticks bigint,
  p_retry_reserve_ticks bigint
)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(
    p_entrant_count >= 2
    and p_window_minutes > 0
    and p_dependency_lag_ticks >= 0
    and p_retry_reserve_ticks >= 0
    -- Keep one complete cron slot unused before the hard deadline. This
    -- prevents nominal capacity from treating completion exactly at the
    -- deadline as safe and leaves room for scheduling jitter.
    and p_entrant_count
      + p_dependency_lag_ticks
      + p_retry_reserve_ticks < p_window_minutes,
    false
  );
$$;

comment on function public.arena_tick_capacity_fits(
  bigint, bigint, bigint, bigint
) is
  'Generic one-item-per-minute lane capacity predicate with dependency and retry reserve.';

revoke all on function public.arena_tick_capacity_fits(
  bigint, bigint, bigint, bigint
) from public, anon, authenticated, service_role;

create function public.get_arena_round_readiness(
  p_round_id uuid,
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_result jsonb;
  v_entrant_count bigint;
  v_s1_open_count bigint;
  v_s1_open_window bigint;
  v_s1_close_count bigint;
  v_s1_settlement_count bigint;
  v_s1_close_window bigint;
  v_s2_open_count bigint;
  v_s2_open_window bigint;
  v_retry_reserve_ticks constant bigint := 5;
  v_capacity_ok boolean;
begin
  v_result := public.get_arena_round_structural_readiness_base(
    p_round_id,
    p_now
  );
  if (v_result->>'readyForS1')::boolean is false then
    return v_result;
  end if;

  select count(*) into v_entrant_count
    from public.arena_round_entry
   where round_id = p_round_id;

  select count(*), min(floor(extract(epoch from (
           deadline_at - scheduled_at
         )) / 60)::bigint)
    into v_s1_open_count, v_s1_open_window
    from public.arena_work_item
   where round_id = p_round_id
     and phase = 'CAPTURE_S1_OPEN_REFERENCE'
     and deadline_at is not null;

  select
      count(*) filter (where phase = 'CAPTURE_S1_CLOSE'),
      count(*) filter (where phase = 'SETTLE_S1_AND_PREPARE_S2'),
      min(floor(extract(epoch from (
        deadline_at - scheduled_at
      )) / 60)::bigint)
    into v_s1_close_count, v_s1_settlement_count, v_s1_close_window
    from public.arena_work_item
   where round_id = p_round_id
     and phase in ('CAPTURE_S1_CLOSE', 'SETTLE_S1_AND_PREPARE_S2')
     and deadline_at is not null;

  select count(*), min(floor(extract(epoch from (
           deadline_at - scheduled_at
         )) / 60)::bigint)
    into v_s2_open_count, v_s2_open_window
    from public.arena_work_item
   where round_id = p_round_id
     and phase = 'CAPTURE_S2_OPEN_REFERENCE'
     and deadline_at is not null;

  v_capacity_ok :=
    v_s1_open_count = v_entrant_count
    and v_s1_close_count = v_entrant_count
    and v_s1_settlement_count = v_entrant_count
    and v_s2_open_count = v_entrant_count
    and public.arena_tick_capacity_fits(
      v_entrant_count, v_s1_open_window, 0, v_retry_reserve_ticks
    )
    and public.arena_tick_capacity_fits(
      v_entrant_count, v_s1_close_window, 1, v_retry_reserve_ticks
    )
    and public.arena_tick_capacity_fits(
      v_entrant_count, v_s2_open_window, 0, v_retry_reserve_ticks
    );

  if not coalesce(v_capacity_ok, false) then
    v_result := jsonb_set(v_result, '{status}', '"BLOCKED"'::jsonb);
    v_result := jsonb_set(v_result, '{readyForS1}', 'false'::jsonb);
    v_result := jsonb_set(
      v_result,
      '{blockers}',
      v_result->'blockers' || jsonb_build_array(jsonb_build_object(
        'code', 'ROUND_TICK_CAPACITY_INSUFFICIENT',
        'detail', 'Entrant fan-out plus dependency and retry reserve cannot drain on the frozen one-minute cadence before every market deadline.'
      ))
    );
  end if;
  return v_result;
end;
$$;

comment on function public.get_arena_round_readiness(uuid, timestamptz) is
  'Fail-closed proof that one immutable Round is structurally complete and fits the one-minute Worker cadence before S1.';

revoke all on function public.get_arena_round_readiness(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_arena_round_readiness(uuid, timestamptz)
  to service_role;

commit;
