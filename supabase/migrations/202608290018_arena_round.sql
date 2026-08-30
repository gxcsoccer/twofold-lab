-- A Round is the shared comparison fence: every entrant sees one decision
-- snapshot and one frozen exchange-calendar path. Without this entity, two
-- isolated Strategy Runs cannot be ranked as participants in the same event.

begin;

create table public.arena_round (
  round_id uuid primary key,
  idempotency_key text not null unique check (idempotency_key <> ''),
  season_id uuid not null references public.arena_season(season_id),
  round_index bigint not null check (round_index > 0),
  decision_snapshot_id uuid not null references public.market_snapshot(snapshot_id),
  decision_session_date date not null,
  decision_window_opens_at timestamptz not null,
  decision_window_closes_at timestamptz not null,
  s1_session_date date not null,
  s1_open_at timestamptz not null,
  s1_reference_available_at timestamptz not null,
  s1_close_at timestamptz not null,
  s1_close_available_at timestamptz not null,
  s2_session_date date not null,
  s2_open_at timestamptz not null,
  s2_reference_available_at timestamptz not null,
  s2_close_at timestamptz not null,
  cycle_ready_at timestamptz not null,
  calendar_artifact_id uuid not null,
  calendar_artifact_sha256 text not null check (
    calendar_artifact_sha256 ~ '^[0-9a-f]{64}$'
  ),
  schedule jsonb not null,
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint arena_round_index_unique unique (season_id, round_index),
  constraint arena_round_session_unique unique (season_id, decision_session_date),
  constraint arena_round_identity_unique unique (round_id, season_id),
  constraint arena_round_calendar_artifact_fk foreign key (
    calendar_artifact_id,
    calendar_artifact_sha256
  ) references public.artifact_metadata(artifact_id, sha256),
  constraint arena_round_decision_window check (
    decision_window_opens_at < decision_window_closes_at
    and decision_window_closes_at < s1_open_at
  ),
  constraint arena_round_stage_order check (
    decision_session_date < s1_session_date
    and s1_session_date < s2_session_date
    and s1_open_at < s1_reference_available_at
    and s1_reference_available_at < s1_close_at
    and s1_close_at < s1_close_available_at
    and s1_close_available_at < s2_open_at
    and s2_open_at < s2_reference_available_at
    and s2_reference_available_at < s2_close_at
    and s2_close_at < cycle_ready_at
  ),
  constraint arena_round_schedule_object check (jsonb_typeof(schedule) = 'object'),
  constraint arena_round_schedule_decimal_safe check (
    not public.jsonb_contains_number(schedule)
  ),
  constraint arena_round_schedule_self_binding check (
    schedule ?& array[
      'schema', 'decisionSessionDate', 's1SessionDate', 's1OpenAt',
      's1ReferenceAvailableAt', 's1CloseAt', 's1CloseAvailableAt',
      's2SessionDate', 's2OpenAt', 's2ReferenceAvailableAt',
      's2CloseAt', 'cycleReadyAt'
    ]::text[]
    and schedule - array[
      'schema', 'decisionSessionDate', 's1SessionDate', 's1OpenAt',
      's1ReferenceAvailableAt', 's1CloseAt', 's1CloseAvailableAt',
      's2SessionDate', 's2OpenAt', 's2ReferenceAvailableAt',
      's2CloseAt', 'cycleReadyAt'
    ]::text[] = '{}'::jsonb
    and schedule->>'schema' = 'twofold.two_stage_cycle_calendar/v1'
    and schedule->>'decisionSessionDate' = decision_session_date::text
    and schedule->>'s1SessionDate' = s1_session_date::text
    and (schedule->>'s1OpenAt')::timestamptz = s1_open_at
    and (schedule->>'s1ReferenceAvailableAt')::timestamptz
      = s1_reference_available_at
    and (schedule->>'s1CloseAt')::timestamptz = s1_close_at
    and (schedule->>'s1CloseAvailableAt')::timestamptz
      = s1_close_available_at
    and schedule->>'s2SessionDate' = s2_session_date::text
    and (schedule->>'s2OpenAt')::timestamptz = s2_open_at
    and (schedule->>'s2ReferenceAvailableAt')::timestamptz
      = s2_reference_available_at
    and (schedule->>'s2CloseAt')::timestamptz = s2_close_at
    and (schedule->>'cycleReadyAt')::timestamptz = cycle_ready_at
  )
);

comment on table public.arena_round is
  'Immutable shared snapshot, decision window, and S1/S2 exchange-calendar fence for every entrant in one competition Round.';

create trigger arena_round_is_immutable
before update or delete on public.arena_round
for each row execute function public.reject_immutable_mutation();
create trigger arena_round_rejects_truncate
before truncate on public.arena_round
for each statement execute function public.reject_immutable_mutation();

create or replace function public.register_arena_round(
  p_idempotency_key text,
  p_round_id uuid,
  p_season_id uuid,
  p_round_index bigint,
  p_decision_snapshot_id uuid,
  p_decision_window_opens_at timestamptz,
  p_decision_window_closes_at timestamptz,
  p_calendar_artifact_id uuid,
  p_calendar_artifact_sha256 text,
  p_schedule jsonb,
  p_recorded_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_existing public.arena_round%rowtype;
  v_inserted public.arena_round%rowtype;
  v_snapshot public.market_snapshot%rowtype;
  v_artifact public.artifact_metadata%rowtype;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_round_id is null or p_season_id is null
    or p_round_index is null or p_round_index <= 0
    or p_decision_snapshot_id is null
    or p_decision_window_opens_at is null
    or p_decision_window_closes_at is null
    or p_calendar_artifact_id is null
    or p_calendar_artifact_sha256 is null
      or p_calendar_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_schedule is null or jsonb_typeof(p_schedule) <> 'object'
    or public.jsonb_contains_number(p_schedule)
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid immutable Arena Round'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('arena-round:' || p_idempotency_key, 0)
  );
  select * into v_existing from public.arena_round
   where idempotency_key = p_idempotency_key
      or round_id = p_round_id
      or (season_id = p_season_id and round_index = p_round_index)
   order by case when idempotency_key = p_idempotency_key then 0 else 1 end
   limit 1;
  if found then
    if v_existing.idempotency_key is distinct from p_idempotency_key
      or v_existing.round_id is distinct from p_round_id
      or v_existing.season_id is distinct from p_season_id
      or v_existing.round_index is distinct from p_round_index
      or v_existing.decision_snapshot_id is distinct from p_decision_snapshot_id
      or v_existing.decision_window_opens_at
        is distinct from p_decision_window_opens_at
      or v_existing.decision_window_closes_at
        is distinct from p_decision_window_closes_at
      or v_existing.calendar_artifact_id is distinct from p_calendar_artifact_id
      or v_existing.calendar_artifact_sha256
        is distinct from p_calendar_artifact_sha256
      or v_existing.schedule is distinct from p_schedule
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'Arena Round identity was reused with different content'
        using errcode = '23505';
    end if;
    return jsonb_build_object(
      'schema', 'twofold.arena_round_result/v1',
      'roundId', v_existing.round_id::text,
      'seasonId', v_existing.season_id::text,
      'roundIndex', v_existing.round_index::text,
      'decisionSnapshotId', v_existing.decision_snapshot_id::text,
      'decisionSessionDate', v_existing.decision_session_date::text,
      'decisionWindowOpensAt', to_char(v_existing.decision_window_opens_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'decisionWindowClosesAt', to_char(v_existing.decision_window_closes_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      's1SessionDate', v_existing.s1_session_date::text,
      's2SessionDate', v_existing.s2_session_date::text,
      'cycleReadyAt', to_char(v_existing.cycle_ready_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'calendarArtifactId', v_existing.calendar_artifact_id::text,
      'calendarArtifactSha256', v_existing.calendar_artifact_sha256,
      'recordedBy', v_existing.recorded_by,
      'recordedAt', to_char(v_existing.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  end if;

  select * into v_snapshot from public.market_snapshot
   where snapshot_id = p_decision_snapshot_id;
  if not found or v_snapshot.snapshot_kind <> 'market_close'
    or v_snapshot.target_session_date::text
      is distinct from p_schedule->>'decisionSessionDate'
  then
    raise exception 'Arena Round decision snapshot is missing or mismatched'
      using errcode = '22023';
  end if;
  select * into v_artifact from public.artifact_metadata
   where artifact_id = p_calendar_artifact_id
     and sha256 = p_calendar_artifact_sha256
     and season_id = p_season_id
     and artifact_kind = 'exchange_calendar_schedule'
     and content_type = 'application/json';
  if not found then
    raise exception 'Arena Round calendar artifact is missing or mismatched'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.arena_season where season_id = p_season_id)
    or p_decision_window_opens_at < v_snapshot.sealed_at
  then
    raise exception 'Arena Round Season or decision availability is invalid'
      using errcode = '22023';
  end if;

  insert into public.arena_round (
    round_id, idempotency_key, season_id, round_index,
    decision_snapshot_id, decision_session_date,
    decision_window_opens_at, decision_window_closes_at,
    s1_session_date, s1_open_at, s1_reference_available_at,
    s1_close_at, s1_close_available_at,
    s2_session_date, s2_open_at, s2_reference_available_at,
    s2_close_at, cycle_ready_at,
    calendar_artifact_id, calendar_artifact_sha256, schedule,
    recorded_by
  ) values (
    p_round_id, p_idempotency_key, p_season_id, p_round_index,
    p_decision_snapshot_id, (p_schedule->>'decisionSessionDate')::date,
    p_decision_window_opens_at, p_decision_window_closes_at,
    (p_schedule->>'s1SessionDate')::date,
    (p_schedule->>'s1OpenAt')::timestamptz,
    (p_schedule->>'s1ReferenceAvailableAt')::timestamptz,
    (p_schedule->>'s1CloseAt')::timestamptz,
    (p_schedule->>'s1CloseAvailableAt')::timestamptz,
    (p_schedule->>'s2SessionDate')::date,
    (p_schedule->>'s2OpenAt')::timestamptz,
    (p_schedule->>'s2ReferenceAvailableAt')::timestamptz,
    (p_schedule->>'s2CloseAt')::timestamptz,
    (p_schedule->>'cycleReadyAt')::timestamptz,
    p_calendar_artifact_id, p_calendar_artifact_sha256, p_schedule,
    p_recorded_by
  ) returning * into v_inserted;

  return jsonb_build_object(
    'schema', 'twofold.arena_round_result/v1',
    'roundId', v_inserted.round_id::text,
    'seasonId', v_inserted.season_id::text,
    'roundIndex', v_inserted.round_index::text,
    'decisionSnapshotId', v_inserted.decision_snapshot_id::text,
    'decisionSessionDate', v_inserted.decision_session_date::text,
    'decisionWindowOpensAt', to_char(v_inserted.decision_window_opens_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'decisionWindowClosesAt', to_char(v_inserted.decision_window_closes_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    's1SessionDate', v_inserted.s1_session_date::text,
    's2SessionDate', v_inserted.s2_session_date::text,
    'cycleReadyAt', to_char(v_inserted.cycle_ready_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'calendarArtifactId', v_inserted.calendar_artifact_id::text,
    'calendarArtifactSha256', v_inserted.calendar_artifact_sha256,
    'recordedBy', v_inserted.recorded_by,
    'recordedAt', to_char(v_inserted.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;

alter table public.arena_round enable row level security;
revoke all on table public.arena_round from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.arena_round from service_role;
grant select on table public.arena_round to service_role;
revoke all on function public.register_arena_round(
  text, uuid, uuid, bigint, uuid, timestamptz, timestamptz,
  uuid, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.register_arena_round(
  text, uuid, uuid, bigint, uuid, timestamptz, timestamptz,
  uuid, text, jsonb, text
) to service_role;

commit;
