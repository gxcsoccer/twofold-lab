-- One immutable seat per (Round, entrant). The decision identity is allocated
-- before a Harness process starts, so a Worker restart rebuilds the same packet
-- instead of silently creating a second attempt for the same competitor.

begin;

alter table public.season_entrant
  add constraint season_entrant_identity_unique
  unique (entrant_id, season_id, run_id);

create table public.arena_round_entry (
  round_entry_id uuid primary key,
  idempotency_key text not null unique check (idempotency_key <> ''),
  round_id uuid not null,
  season_id uuid not null,
  entrant_id uuid not null,
  run_id uuid not null,
  decision_id uuid not null unique,
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint arena_round_entry_round_entrant_unique
    unique (round_id, entrant_id),
  constraint arena_round_entry_round_run_unique
    unique (round_id, run_id),
  constraint arena_round_entry_round_fk foreign key (round_id, season_id)
    references public.arena_round(round_id, season_id),
  constraint arena_round_entry_entrant_fk foreign key (
    entrant_id, season_id, run_id
  ) references public.season_entrant(entrant_id, season_id, run_id),
  constraint arena_round_entry_id_deterministic check (
    round_entry_id = public.deterministic_uuid_from_sha256(
      'twofold.arena_round_entry/v1',
      round_id::text || ':' || entrant_id::text
    )
  ),
  constraint arena_round_entry_decision_deterministic check (
    decision_id = public.deterministic_uuid_from_sha256(
      'twofold.arena_round_entry.decision/v1',
      round_id::text || ':' || entrant_id::text
    )
  )
);

comment on table public.arena_round_entry is
  'Immutable entrant seat and deterministic decision identity for one shared Arena Round.';

create index arena_round_entry_season_round_idx
  on public.arena_round_entry(season_id, round_id, entrant_id);

create trigger arena_round_entry_is_immutable
before update or delete on public.arena_round_entry
for each row execute function public.reject_immutable_mutation();
create trigger arena_round_entry_rejects_truncate
before truncate on public.arena_round_entry
for each statement execute function public.reject_immutable_mutation();

create or replace function public.register_arena_round_entry(
  p_idempotency_key text,
  p_round_id uuid,
  p_entrant_id uuid,
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
  v_entrant public.season_entrant%rowtype;
  v_existing public.arena_round_entry%rowtype;
  v_round_entry_id uuid;
  v_decision_id uuid;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_round_id is null or p_entrant_id is null
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid immutable Arena Round entry'
      using errcode = '22023';
  end if;

  select * into v_round from public.arena_round
   where round_id = p_round_id;
  select * into v_entrant from public.season_entrant
   where entrant_id = p_entrant_id;
  if v_round.round_id is null or v_entrant.entrant_id is null
    or v_round.season_id is distinct from v_entrant.season_id
  then
    raise exception 'Arena Round and entrant are missing or cross-Season'
      using errcode = '23503';
  end if;

  v_round_entry_id := public.deterministic_uuid_from_sha256(
    'twofold.arena_round_entry/v1',
    p_round_id::text || ':' || p_entrant_id::text
  );
  v_decision_id := public.deterministic_uuid_from_sha256(
    'twofold.arena_round_entry.decision/v1',
    p_round_id::text || ':' || p_entrant_id::text
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'arena-round-entry:' || p_round_id::text || ':' || p_entrant_id::text,
      0
    )
  );
  select * into v_existing from public.arena_round_entry
   where idempotency_key = p_idempotency_key
      or round_entry_id = v_round_entry_id
      or decision_id = v_decision_id
      or (round_id = p_round_id and entrant_id = p_entrant_id)
   order by (idempotency_key = p_idempotency_key) desc
   limit 1;
  if found then
    if v_existing.idempotency_key is distinct from p_idempotency_key
      or v_existing.round_id is distinct from p_round_id
      or v_existing.season_id is distinct from v_round.season_id
      or v_existing.entrant_id is distinct from p_entrant_id
      or v_existing.run_id is distinct from v_entrant.run_id
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'Arena Round entry identity was reused with different content'
        using errcode = '23505';
    end if;
  else
    insert into public.arena_round_entry (
      round_entry_id, idempotency_key, round_id, season_id, entrant_id,
      run_id, decision_id, recorded_by
    ) values (
      v_round_entry_id, p_idempotency_key, p_round_id, v_round.season_id,
      p_entrant_id, v_entrant.run_id, v_decision_id, p_recorded_by
    ) returning * into v_existing;
  end if;

  return jsonb_build_object(
    'schema', 'twofold.arena_round_entry_result/v1',
    'roundEntryId', v_existing.round_entry_id::text,
    'roundId', v_existing.round_id::text,
    'seasonId', v_existing.season_id::text,
    'entrantId', v_existing.entrant_id::text,
    'runId', v_existing.run_id::text,
    'decisionId', v_existing.decision_id::text,
    'recordedBy', v_existing.recorded_by,
    'recordedAt', to_char(
      v_existing.recorded_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
end;
$$;

alter table public.arena_round_entry enable row level security;
revoke all on table public.arena_round_entry
  from public, anon, authenticated, service_role;
grant select on table public.arena_round_entry to service_role;
revoke all on function public.register_arena_round_entry(text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.register_arena_round_entry(text, uuid, uuid, text)
  to service_role;

commit;
