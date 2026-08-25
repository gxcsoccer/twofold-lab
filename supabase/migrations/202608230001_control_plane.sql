begin;

create extension if not exists pgcrypto with schema extensions;

create or replace function public.jsonb_contains_number(p_value jsonb)
returns boolean
language plpgsql
immutable
strict
parallel safe
set search_path = public, pg_temp
as $$
declare
  v_child jsonb;
begin
  case jsonb_typeof(p_value)
    when 'number' then
      return true;
    when 'array' then
      for v_child in
        select item from jsonb_array_elements(p_value) as items(item)
      loop
        if public.jsonb_contains_number(v_child) then
          return true;
        end if;
      end loop;
    when 'object' then
      for v_child in
        select value from jsonb_each(p_value) as entries(key, value)
      loop
        if public.jsonb_contains_number(v_child) then
          return true;
        end if;
      end loop;
    else
      null;
  end case;

  return false;
end;
$$;

comment on function public.jsonb_contains_number(jsonb) is
  'Rejects JSON numeric tokens at durable financial/control boundaries; numeric values are canonical strings.';

create table public.event_stream (
  event_id uuid primary key default gen_random_uuid(),
  stream_id uuid not null,
  stream_type text not null
    check (stream_type in ('experiment', 'season', 'run', 'control')),
  stream_seq bigint not null check (stream_seq > 0),
  event_type text not null check (event_type <> ''),
  schema_version text not null check (schema_version <> ''),
  idempotency_key text not null check (idempotency_key <> ''),
  correlation_id uuid,
  causation_id uuid references public.event_stream(event_id),
  actor_kind text not null
    check (actor_kind in ('human', 'worker', 'system', 'model')),
  actor_id text not null check (actor_id <> ''),
  event_time timestamptz not null,
  effective_date date,
  settlement_date date,
  recorded_at timestamptz not null default clock_timestamp(),
  payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  constraint event_stream_sequence_unique unique (stream_id, stream_seq),
  constraint event_stream_idempotency_unique unique (stream_id, idempotency_key),
  constraint event_stream_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint event_stream_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint event_stream_payload_decimal_safe
    check (not public.jsonb_contains_number(payload)),
  constraint event_stream_metadata_decimal_safe
    check (not public.jsonb_contains_number(metadata))
);

comment on table public.event_stream is
  'Immutable source of truth. Corrections are compensating events; rows are never updated or deleted.';
comment on column public.event_stream.stream_seq is
  'One-based per-stream sequence assigned only by append_event after an expected-head check.';

create index event_stream_recorded_at_idx
  on public.event_stream (recorded_at, event_id);
create index event_stream_type_time_idx
  on public.event_stream (event_type, event_time, event_id);
create index event_stream_correlation_idx
  on public.event_stream (correlation_id)
  where correlation_id is not null;

create table public.projection (
  projection_name text not null check (projection_name <> ''),
  entity_id uuid not null,
  stream_id uuid not null,
  last_stream_seq bigint not null default 0 check (last_stream_seq >= 0),
  last_event_id uuid references public.event_stream(event_id),
  state jsonb not null default '{}'::jsonb,
  state_hash text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (projection_name, entity_id),
  constraint projection_state_object check (jsonb_typeof(state) = 'object'),
  constraint projection_state_decimal_safe
    check (not public.jsonb_contains_number(state)),
  constraint projection_head_pair check (
    (last_stream_seq = 0 and last_event_id is null)
    or (last_stream_seq > 0 and last_event_id is not null)
  )
);

comment on table public.projection is
  'Disposable, optimistic-concurrency read models derived from event_stream.';

create index projection_stream_idx
  on public.projection (stream_id, last_stream_seq);

create table public.control_command (
  command_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key <> ''),
  command_type text not null check (command_type in (
    'pause_after_safe_point',
    'resume',
    'cancel_pending_simulated_orders',
    'run_data_repair',
    'freeze_config',
    'create_restatement'
  )),
  scope text not null check (scope in ('system', 'season', 'run')),
  scope_id uuid,
  arguments jsonb not null default '{}'::jsonb,
  expected_projection_version bigint check (expected_projection_version >= 0),
  status text not null default 'requested' check (status in (
    'requested', 'claimed', 'succeeded', 'failed', 'rejected', 'canceled'
  )),
  requested_by text not null check (requested_by <> ''),
  requested_at timestamptz not null default clock_timestamp(),
  available_at timestamptz not null default clock_timestamp(),
  claimed_by text,
  claimed_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  completed_at timestamptz,
  result jsonb,
  error_code text,
  error_message text,
  retryable boolean,
  constraint control_command_scope_id check (
    (scope = 'system' and scope_id is null)
    or (scope in ('season', 'run') and scope_id is not null)
  ),
  constraint control_command_arguments_object check (jsonb_typeof(arguments) = 'object'),
  constraint control_command_arguments_decimal_safe
    check (not public.jsonb_contains_number(arguments)),
  constraint control_command_result_object check (
    result is null or jsonb_typeof(result) = 'object'
  ),
  constraint control_command_result_decimal_safe check (
    result is null or not public.jsonb_contains_number(result)
  ),
  constraint control_command_lifecycle check (
    (
      status = 'requested'
      and claimed_by is null
      and claimed_at is null
      and lease_token is null
      and lease_expires_at is null
      and completed_at is null
      and error_code is null
      and error_message is null
      and retryable is null
    )
    or (
      status = 'claimed'
      and claimed_by is not null
      and claimed_at is not null
      and lease_token is not null
      and lease_expires_at > claimed_at
      and completed_at is null
      and error_code is null
      and error_message is null
      and retryable is null
    )
    or (
      status = 'succeeded'
      and claimed_by is not null
      and claimed_at is not null
      and lease_token is not null
      and completed_at is not null
      and error_code is null
      and error_message is null
      and retryable is null
    )
    or (
      status in ('failed', 'rejected')
      and completed_at is not null
      and error_code is not null
      and error_message is not null
      and retryable is not null
    )
    or (
      status = 'canceled'
      and completed_at is not null
      and error_code is null
      and error_message is null
      and retryable is null
    )
  )
);

comment on table public.control_command is
  'Idempotent operator command queue. Mutations are available only through audited RPC functions.';

create index control_command_claim_idx
  on public.control_command (available_at, requested_at, command_id)
  where status = 'requested';
create index control_command_expired_claim_idx
  on public.control_command (lease_expires_at, command_id)
  where status = 'claimed';
create index control_command_scope_idx
  on public.control_command (scope, scope_id, requested_at desc);

create table public.worker_lease (
  worker_id text primary key check (worker_id <> ''),
  lease_token uuid not null default gen_random_uuid(),
  capabilities jsonb not null default '{}'::jsonb,
  acquired_at timestamptz not null default clock_timestamp(),
  heartbeat_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint worker_lease_capabilities_object
    check (jsonb_typeof(capabilities) = 'object'),
  constraint worker_lease_expiry check (expires_at > heartbeat_at)
);

comment on table public.worker_lease is
  'Ephemeral worker liveness leases; a token changes when an expired worker identity is reacquired.';

create index worker_lease_expiry_idx on public.worker_lease (expires_at);

create table public.artifact_metadata (
  artifact_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key <> ''),
  run_id uuid,
  season_id uuid,
  source_event_id uuid references public.event_stream(event_id),
  artifact_kind text not null check (artifact_kind <> ''),
  storage_bucket text not null check (storage_bucket <> ''),
  object_path text not null check (object_path <> ''),
  content_type text not null check (content_type <> ''),
  byte_size bigint not null check (byte_size >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  supersedes_artifact_id uuid references public.artifact_metadata(artifact_id),
  created_by text not null check (created_by <> ''),
  created_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb,
  constraint artifact_storage_object_unique unique (storage_bucket, object_path),
  constraint artifact_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint artifact_metadata_decimal_safe
    check (not public.jsonb_contains_number(metadata)),
  constraint artifact_scope_present check (run_id is not null or season_id is not null)
);

comment on table public.artifact_metadata is
  'Immutable content-addressed references. Replacements append a new row using supersedes_artifact_id.';

create index artifact_metadata_run_idx
  on public.artifact_metadata (run_id, artifact_kind, created_at desc)
  where run_id is not null;
create index artifact_metadata_season_idx
  on public.artifact_metadata (season_id, artifact_kind, created_at desc)
  where season_id is not null;

create or replace function public.reject_immutable_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '% is append-only; append a compensating or superseding record instead', tg_table_name
    using errcode = '55000';
end;
$$;

create trigger event_stream_is_immutable
before update or delete on public.event_stream
for each row execute function public.reject_immutable_mutation();

create trigger artifact_metadata_is_immutable
before update or delete on public.artifact_metadata
for each row execute function public.reject_immutable_mutation();

create or replace function public.append_event(
  p_stream_id uuid,
  p_stream_type text,
  p_expected_stream_seq bigint,
  p_event_type text,
  p_schema_version text,
  p_idempotency_key text,
  p_actor_kind text,
  p_actor_id text,
  p_event_time timestamptz,
  p_payload jsonb,
  p_metadata jsonb default '{}'::jsonb,
  p_event_id uuid default gen_random_uuid(),
  p_correlation_id uuid default null,
  p_causation_id uuid default null,
  p_effective_date date default null,
  p_settlement_date date default null
)
returns public.event_stream
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_existing public.event_stream%rowtype;
  v_current_seq bigint;
  v_existing_stream_type text;
  v_inserted public.event_stream%rowtype;
begin
  if p_expected_stream_seq < 0 then
    raise exception 'expected stream sequence must be non-negative'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_stream_id::text, 0));

  select event.*
    into v_existing
    from public.event_stream as event
   where event.stream_id = p_stream_id
     and event.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.stream_type is distinct from p_stream_type
      or v_existing.event_type is distinct from p_event_type
      or v_existing.schema_version is distinct from p_schema_version
      or v_existing.actor_kind is distinct from p_actor_kind
      or v_existing.actor_id is distinct from p_actor_id
      or v_existing.event_time is distinct from p_event_time
      or v_existing.effective_date is distinct from p_effective_date
      or v_existing.settlement_date is distinct from p_settlement_date
      or v_existing.correlation_id is distinct from p_correlation_id
      or v_existing.causation_id is distinct from p_causation_id
      or v_existing.payload is distinct from p_payload
      or v_existing.metadata is distinct from p_metadata
    then
      raise exception 'idempotency key % was reused with different event content', p_idempotency_key
        using errcode = '23505';
    end if;

    return v_existing;
  end if;

  select coalesce(max(event.stream_seq), 0), min(event.stream_type)
    into v_current_seq, v_existing_stream_type
    from public.event_stream as event
   where event.stream_id = p_stream_id;

  if v_existing_stream_type is not null
    and v_existing_stream_type is distinct from p_stream_type
  then
    raise exception 'stream % already has type %, not %',
      p_stream_id, v_existing_stream_type, p_stream_type
      using errcode = '22023';
  end if;

  if v_current_seq <> p_expected_stream_seq then
    raise exception 'stream head conflict for %', p_stream_id
      using
        errcode = '40001',
        detail = format(
          'expected current sequence %s, actual current sequence %s',
          p_expected_stream_seq,
          v_current_seq
        ),
        hint = 'Reload the stream head and retry with a new command or event.';
  end if;

  insert into public.event_stream (
    event_id,
    stream_id,
    stream_type,
    stream_seq,
    event_type,
    schema_version,
    idempotency_key,
    correlation_id,
    causation_id,
    actor_kind,
    actor_id,
    event_time,
    effective_date,
    settlement_date,
    payload,
    metadata
  ) values (
    p_event_id,
    p_stream_id,
    p_stream_type,
    p_expected_stream_seq + 1,
    p_event_type,
    p_schema_version,
    p_idempotency_key,
    p_correlation_id,
    p_causation_id,
    p_actor_kind,
    p_actor_id,
    p_event_time,
    p_effective_date,
    p_settlement_date,
    p_payload,
    p_metadata
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

comment on function public.append_event(
  uuid, text, bigint, text, text, text, text, text, timestamptz, jsonb,
  jsonb, uuid, uuid, uuid, date, date
) is
  'Atomically appends expected_seq + 1. An exact idempotent retry returns the original event.';

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

  perform pg_advisory_xact_lock(
    hashtextextended(p_projection_name || ':' || p_entity_id::text, 0)
  );

  select projection.last_stream_seq
    into v_current_seq
    from public.projection as projection
   where projection.projection_name = p_projection_name
     and projection.entity_id = p_entity_id;

  if not found then
    v_current_seq := 0;
  end if;

  if v_current_seq <> p_expected_last_stream_seq then
    raise exception 'projection head conflict for %/%', p_projection_name, p_entity_id
      using errcode = '40001';
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

create or replace function public.request_control_command(
  p_idempotency_key text,
  p_command_type text,
  p_scope text,
  p_scope_id uuid,
  p_arguments jsonb,
  p_requested_by text,
  p_expected_projection_version bigint default null,
  p_available_at timestamptz default null
)
returns public.control_command
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_existing public.control_command%rowtype;
  v_inserted public.control_command%rowtype;
  v_requested_by text := coalesce(auth.uid()::text, p_requested_by);
begin
  if v_requested_by is null or v_requested_by = '' then
    raise exception 'requested_by is required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('control-command:' || p_idempotency_key, 0)
  );

  select command.*
    into v_existing
    from public.control_command as command
   where command.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.command_type is distinct from p_command_type
      or v_existing.scope is distinct from p_scope
      or v_existing.scope_id is distinct from p_scope_id
      or v_existing.arguments is distinct from p_arguments
      or v_existing.requested_by is distinct from v_requested_by
      or v_existing.expected_projection_version
        is distinct from p_expected_projection_version
    then
      raise exception 'idempotency key % was reused with different command content',
        p_idempotency_key
        using errcode = '23505';
    end if;

    return v_existing;
  end if;

  insert into public.control_command (
    idempotency_key,
    command_type,
    scope,
    scope_id,
    arguments,
    expected_projection_version,
    requested_by,
    available_at
  ) values (
    p_idempotency_key,
    p_command_type,
    p_scope,
    p_scope_id,
    p_arguments,
    p_expected_projection_version,
    v_requested_by,
    coalesce(p_available_at, clock_timestamp())
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

create or replace function public.claim_control_command(
  p_worker_id text,
  p_lease_seconds integer default 60
)
returns public.control_command
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_command public.control_command%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_worker_id = '' or p_lease_seconds < 5 or p_lease_seconds > 3600 then
    raise exception 'invalid worker ID or lease duration'
      using errcode = '22023';
  end if;

  select command.*
    into v_command
    from public.control_command as command
   where command.available_at <= v_now
     and (
       command.status = 'requested'
       or (
         command.status = 'claimed'
         and command.lease_expires_at <= v_now
       )
     )
   order by command.available_at, command.requested_at, command.command_id
   for update skip locked
   limit 1;

  if not found then
    return null;
  end if;

  update public.control_command as command
     set status = 'claimed',
         claimed_by = p_worker_id,
         claimed_at = v_now,
         lease_token = gen_random_uuid(),
         lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
         attempt_count = command.attempt_count + 1
   where command.command_id = v_command.command_id
  returning command.* into v_command;

  return v_command;
end;
$$;

comment on function public.request_control_command(
  text, text, text, uuid, jsonb, text, bigint, timestamptz
) is
  'Requests an idempotent command. For JWT-authenticated calls requested_by is always derived from auth.uid(); the argument is used only when auth.uid() is null (for trusted service calls).';

create or replace function public.complete_control_command(
  p_command_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_result jsonb default '{}'::jsonb
)
returns public.control_command
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_command public.control_command%rowtype;
begin
  update public.control_command as command
     set status = 'succeeded',
         completed_at = clock_timestamp(),
         result = p_result
   where command.command_id = p_command_id
     and command.status = 'claimed'
     and command.claimed_by = p_worker_id
     and command.lease_token = p_lease_token
     and command.lease_expires_at > clock_timestamp()
  returning command.* into v_command;

  if not found then
    raise exception 'command lease is missing, expired, or owned by another worker'
      using errcode = '55000';
  end if;

  return v_command;
end;
$$;

create or replace function public.fail_control_command(
  p_command_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_error_code text,
  p_error_message text,
  p_retryable boolean default false
)
returns public.control_command
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_command public.control_command%rowtype;
begin
  update public.control_command as command
     set status = 'failed',
         completed_at = clock_timestamp(),
         error_code = p_error_code,
         error_message = p_error_message,
         retryable = p_retryable
   where command.command_id = p_command_id
     and command.status = 'claimed'
     and command.claimed_by = p_worker_id
     and command.lease_token = p_lease_token
     and command.lease_expires_at > clock_timestamp()
  returning command.* into v_command;

  if not found then
    raise exception 'command lease is missing, expired, or owned by another worker'
      using errcode = '55000';
  end if;

  return v_command;
end;
$$;

create or replace function public.renew_worker_lease(
  p_worker_id text,
  p_lease_seconds integer default 60,
  p_capabilities jsonb default '{}'::jsonb
)
returns public.worker_lease
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_lease public.worker_lease%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_worker_id = '' or p_lease_seconds < 5 or p_lease_seconds > 3600 then
    raise exception 'invalid worker ID or lease duration'
      using errcode = '22023';
  end if;

  insert into public.worker_lease (
    worker_id,
    capabilities,
    acquired_at,
    heartbeat_at,
    expires_at
  ) values (
    p_worker_id,
    p_capabilities,
    v_now,
    v_now,
    v_now + make_interval(secs => p_lease_seconds)
  )
  on conflict (worker_id) do update
    set lease_token = case
          when public.worker_lease.expires_at <= v_now then gen_random_uuid()
          else public.worker_lease.lease_token
        end,
        capabilities = excluded.capabilities,
        acquired_at = case
          when public.worker_lease.expires_at <= v_now then v_now
          else public.worker_lease.acquired_at
        end,
        heartbeat_at = v_now,
        expires_at = excluded.expires_at
  returning * into v_lease;

  return v_lease;
end;
$$;

create or replace function public.release_worker_lease(
  p_worker_id text,
  p_lease_token uuid
)
returns public.worker_lease
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_lease public.worker_lease%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  update public.worker_lease as lease
     set heartbeat_at = v_now - interval '1 microsecond',
         expires_at = v_now
   where lease.worker_id = p_worker_id
     and lease.lease_token = p_lease_token
  returning lease.* into v_lease;

  if not found then
    raise exception 'worker lease is missing or token does not match'
      using errcode = '55000';
  end if;

  return v_lease;
end;
$$;

create or replace function public.register_artifact(
  p_idempotency_key text,
  p_run_id uuid,
  p_season_id uuid,
  p_source_event_id uuid,
  p_artifact_kind text,
  p_storage_bucket text,
  p_object_path text,
  p_content_type text,
  p_byte_size bigint,
  p_sha256 text,
  p_created_by text,
  p_metadata jsonb default '{}'::jsonb,
  p_supersedes_artifact_id uuid default null
)
returns public.artifact_metadata
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_existing public.artifact_metadata%rowtype;
  v_inserted public.artifact_metadata%rowtype;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('artifact:' || p_idempotency_key, 0)
  );

  select artifact.*
    into v_existing
    from public.artifact_metadata as artifact
   where artifact.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.run_id is distinct from p_run_id
      or v_existing.season_id is distinct from p_season_id
      or v_existing.source_event_id is distinct from p_source_event_id
      or v_existing.artifact_kind is distinct from p_artifact_kind
      or v_existing.storage_bucket is distinct from p_storage_bucket
      or v_existing.object_path is distinct from p_object_path
      or v_existing.content_type is distinct from p_content_type
      or v_existing.byte_size is distinct from p_byte_size
      or v_existing.sha256 is distinct from p_sha256
      or v_existing.created_by is distinct from p_created_by
      or v_existing.metadata is distinct from p_metadata
      or v_existing.supersedes_artifact_id is distinct from p_supersedes_artifact_id
    then
      raise exception 'idempotency key % was reused with different artifact content',
        p_idempotency_key
        using errcode = '23505';
    end if;

    return v_existing;
  end if;

  insert into public.artifact_metadata (
    idempotency_key,
    run_id,
    season_id,
    source_event_id,
    artifact_kind,
    storage_bucket,
    object_path,
    content_type,
    byte_size,
    sha256,
    supersedes_artifact_id,
    created_by,
    metadata
  ) values (
    p_idempotency_key,
    p_run_id,
    p_season_id,
    p_source_event_id,
    p_artifact_kind,
    p_storage_bucket,
    p_object_path,
    p_content_type,
    p_byte_size,
    p_sha256,
    p_supersedes_artifact_id,
    p_created_by,
    p_metadata
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

alter table public.event_stream enable row level security;
alter table public.projection enable row level security;
alter table public.control_command enable row level security;
alter table public.worker_lease enable row level security;
alter table public.artifact_metadata enable row level security;

create policy event_stream_read_authenticated
  on public.event_stream for select to authenticated using (true);
create policy projection_read_authenticated
  on public.projection for select to authenticated using (true);
create policy control_command_read_authenticated
  on public.control_command for select to authenticated using (true);
create policy worker_lease_read_authenticated
  on public.worker_lease for select to authenticated using (true);
create policy artifact_metadata_read_authenticated
  on public.artifact_metadata for select to authenticated using (true);

revoke all on table public.event_stream from public, anon, authenticated;
revoke all on table public.projection from public, anon, authenticated;
revoke all on table public.control_command from public, anon, authenticated;
revoke all on table public.worker_lease from public, anon, authenticated;
revoke all on table public.artifact_metadata from public, anon, authenticated;

revoke insert, update, delete, truncate on table public.event_stream from service_role;
revoke insert, update, delete, truncate on table public.projection from service_role;
revoke insert, update, delete, truncate on table public.control_command from service_role;
revoke insert, update, delete, truncate on table public.worker_lease from service_role;
revoke insert, update, delete, truncate on table public.artifact_metadata from service_role;

grant select on table public.event_stream to authenticated;
grant select on table public.projection to authenticated;
grant select on table public.control_command to authenticated;
grant select on table public.worker_lease to authenticated;
grant select on table public.artifact_metadata to authenticated;

grant select on table public.event_stream to service_role;
grant select on table public.projection to service_role;
grant select on table public.control_command to service_role;
grant select on table public.worker_lease to service_role;
grant select on table public.artifact_metadata to service_role;

revoke execute on function public.jsonb_contains_number(jsonb)
  from public, anon, authenticated;
revoke execute on function public.reject_immutable_mutation()
  from public, anon, authenticated;
revoke execute on function public.append_event(
  uuid, text, bigint, text, text, text, text, text, timestamptz, jsonb,
  jsonb, uuid, uuid, uuid, date, date
) from public, anon, authenticated;
revoke execute on function public.put_projection(
  text, uuid, uuid, bigint, bigint, uuid, jsonb, text
) from public, anon, authenticated;
revoke execute on function public.request_control_command(
  text, text, text, uuid, jsonb, text, bigint, timestamptz
) from public, anon;
revoke execute on function public.claim_control_command(text, integer)
  from public, anon, authenticated;
revoke execute on function public.complete_control_command(uuid, text, uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function public.fail_control_command(uuid, text, uuid, text, text, boolean)
  from public, anon, authenticated;
revoke execute on function public.renew_worker_lease(text, integer, jsonb)
  from public, anon, authenticated;
revoke execute on function public.release_worker_lease(text, uuid)
  from public, anon, authenticated;
revoke execute on function public.register_artifact(
  text, uuid, uuid, uuid, text, text, text, text, bigint, text, text, jsonb, uuid
) from public, anon, authenticated;

grant execute on function public.append_event(
  uuid, text, bigint, text, text, text, text, text, timestamptz, jsonb,
  jsonb, uuid, uuid, uuid, date, date
) to service_role;
grant execute on function public.put_projection(
  text, uuid, uuid, bigint, bigint, uuid, jsonb, text
) to service_role;
grant execute on function public.request_control_command(
  text, text, text, uuid, jsonb, text, bigint, timestamptz
) to authenticated, service_role;
grant execute on function public.claim_control_command(text, integer)
  to service_role;
grant execute on function public.complete_control_command(uuid, text, uuid, jsonb)
  to service_role;
grant execute on function public.fail_control_command(uuid, text, uuid, text, text, boolean)
  to service_role;
grant execute on function public.renew_worker_lease(text, integer, jsonb)
  to service_role;
grant execute on function public.release_worker_lease(text, uuid)
  to service_role;
grant execute on function public.register_artifact(
  text, uuid, uuid, uuid, text, text, text, text, bigint, text, text, jsonb, uuid
) to service_role;

alter table public.projection replica identity full;
alter table public.control_command replica identity full;
alter table public.worker_lease replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.event_stream;
  alter publication supabase_realtime add table public.projection;
  alter publication supabase_realtime add table public.control_command;
  alter publication supabase_realtime add table public.worker_lease;
  alter publication supabase_realtime add table public.artifact_metadata;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

commit;
