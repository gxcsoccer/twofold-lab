-- Close the two ambiguous-response windows used by the live Arena worker:
-- projection writes may be replayed exactly, while portfolio submissions must
-- physically reach PostgreSQL before the invocation deadline.

begin;

create or replace function public.put_projection(
  p_projection_name text,
  p_entity_id uuid,
  p_stream_id uuid,
  p_expected_last_stream_seq bigint,
  p_new_last_stream_seq bigint,
  p_last_event_id uuid,
  p_state jsonb,
  p_state_hash text
)
returns public.projection
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_current_seq bigint;
  v_projection public.projection%rowtype;
begin
  if p_expected_last_stream_seq < 0
    or p_new_last_stream_seq <= p_expected_last_stream_seq
  then
    raise exception 'invalid projection sequence transition % -> %',
      p_expected_last_stream_seq, p_new_last_stream_seq
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_projection_name || ':' || p_entity_id::text, 0)
  );

  select projection.*
    into v_projection
    from public.projection as projection
   where projection.projection_name = p_projection_name
     and projection.entity_id = p_entity_id;

  if found then
    if v_projection.last_stream_seq = p_new_last_stream_seq then
      if v_projection.stream_id is distinct from p_stream_id
        or v_projection.last_event_id is distinct from p_last_event_id
        or v_projection.state is distinct from p_state
        or v_projection.state_hash is distinct from p_state_hash
      then
        raise exception
          'projection exact retry content conflict for %/% at stream sequence %',
          p_projection_name, p_entity_id, p_new_last_stream_seq
          using errcode = '23505';
      end if;

      return v_projection;
    end if;

    v_current_seq := v_projection.last_stream_seq;
  else
    v_current_seq := 0;
  end if;

  if v_current_seq <> p_expected_last_stream_seq then
    raise exception 'projection head conflict for %/%', p_projection_name, p_entity_id
      using errcode = '40001';
  end if;

  if not exists (
    select 1
      from public.event_stream as event
     where event.event_id = p_last_event_id
       and event.stream_id = p_stream_id
       and event.stream_seq = p_new_last_stream_seq
  ) then
    raise exception 'projection head event does not match stream and sequence'
      using errcode = '23503';
  end if;

  insert into public.projection (
    projection_name,
    entity_id,
    stream_id,
    last_stream_seq,
    last_event_id,
    state,
    state_hash,
    updated_at
  ) values (
    p_projection_name,
    p_entity_id,
    p_stream_id,
    p_new_last_stream_seq,
    p_last_event_id,
    p_state,
    p_state_hash,
    clock_timestamp()
  )
  on conflict (projection_name, entity_id) do update
    set stream_id = excluded.stream_id,
        last_stream_seq = excluded.last_stream_seq,
        last_event_id = excluded.last_event_id,
        state = excluded.state,
        state_hash = excluded.state_hash,
        updated_at = excluded.updated_at
  returning * into v_projection;

  return v_projection;
end;
$$;

comment on function public.put_projection(
  text, uuid, uuid, bigint, bigint, uuid, jsonb, text
) is
  'Optimistically advances a projection. An exact retry at the committed new sequence returns the existing immutable content.';

create or replace function public.enforce_accepted_submission_database_deadline()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_submission_deadline_at timestamptz;
begin
  select invocation.submission_deadline_at
    into strict v_submission_deadline_at
    from public.decision_invocation as invocation
   where invocation.decision_id = new.decision_id;

  if clock_timestamp() > v_submission_deadline_at then
    raise exception
      'target submission reached the database after the invocation deadline'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

comment on function public.enforce_accepted_submission_database_deadline() is
  'Rejects a new accepted submission whose INSERT reaches PostgreSQL after the invocation deadline; exact retries of an existing row do not reinsert.';

revoke all on function public.enforce_accepted_submission_database_deadline()
  from public, anon, authenticated;

drop trigger if exists accepted_target_submission_database_deadline
  on public.accepted_target_submission;

create trigger accepted_target_submission_database_deadline
before insert on public.accepted_target_submission
for each row
execute function public.enforce_accepted_submission_database_deadline();

commit;
