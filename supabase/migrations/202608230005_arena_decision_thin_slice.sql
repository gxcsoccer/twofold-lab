begin;

create table public.decision_invocation (
  decision_id uuid primary key,
  idempotency_key text not null unique check (idempotency_key <> ''),
  run_id uuid not null,
  season_id uuid not null,
  root_harness_session_id text not null unique
    check (root_harness_session_id <> ''),
  packet_artifact_id uuid not null unique
    references public.artifact_metadata(artifact_id),
  agent_bundle_artifact_id uuid not null
    references public.artifact_metadata(artifact_id),
  market_snapshot_id uuid not null
    references public.market_snapshot(snapshot_id),
  decision_at timestamptz not null,
  data_cutoff_at timestamptz not null,
  submission_deadline_at timestamptz not null,
  trigger_reasons text[] not null,
  source_event_id uuid not null unique
    references public.event_stream(event_id),
  source_stream_seq bigint not null check (source_stream_seq > 0),
  opened_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint decision_invocation_time_order check (
    data_cutoff_at <= decision_at
    and opened_at >= decision_at
    and submission_deadline_at > opened_at
  ),
  constraint decision_invocation_trigger_reasons check (
    cardinality(trigger_reasons) > 0
    and array_position(trigger_reasons, null) is null
    and array_position(trigger_reasons, '') is null
  ),
  constraint decision_invocation_scope_unique
    unique (decision_id, run_id, season_id),
  constraint decision_invocation_root_unique
    unique (decision_id, root_harness_session_id),
  constraint decision_invocation_submission_fence_unique
    unique (decision_id, root_harness_session_id, packet_artifact_id)
);

comment on table public.decision_invocation is
  'Immutable Arena decision opportunity binding one run, point-in-time market snapshot, packet artifact, Bundle artifact, and root Harness Session.';

create index decision_invocation_run_time_idx
  on public.decision_invocation (run_id, decision_at desc, decision_id);
create index decision_invocation_season_time_idx
  on public.decision_invocation (season_id, decision_at desc, decision_id);

create table public.agent_session_lineage (
  harness_session_id text primary key check (harness_session_id <> ''),
  idempotency_key text not null unique check (idempotency_key <> ''),
  decision_id uuid not null
    references public.decision_invocation(decision_id),
  root_harness_session_id text not null check (root_harness_session_id <> ''),
  parent_harness_session_id text,
  session_kind text not null check (session_kind in ('root', 'descendant')),
  agent_identity text not null check (agent_identity <> ''),
  agent_path text not null
    check (agent_path ~ '^root(?:/[A-Za-z0-9._:-]+)*$'),
  depth integer not null check (depth >= 0),
  started_at timestamptz not null,
  source_event_id uuid not null
    references public.event_stream(event_id),
  source_stream_seq bigint not null check (source_stream_seq > 0),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint agent_session_lineage_decision_session_unique
    unique (decision_id, harness_session_id),
  constraint agent_session_lineage_path_unique
    unique (decision_id, agent_path),
  constraint agent_session_lineage_shape check (
    (
      session_kind = 'root'
      and depth = 0
      and parent_harness_session_id is null
      and harness_session_id = root_harness_session_id
      and agent_path = 'root'
    )
    or (
      session_kind = 'descendant'
      and depth > 0
      and parent_harness_session_id is not null
      and harness_session_id <> root_harness_session_id
      and agent_path <> 'root'
    )
  ),
  constraint agent_session_lineage_root_fk
    foreign key (decision_id, root_harness_session_id)
    references public.agent_session_lineage(decision_id, harness_session_id)
    deferrable initially deferred,
  constraint agent_session_lineage_parent_fk
    foreign key (decision_id, parent_harness_session_id)
    references public.agent_session_lineage(decision_id, harness_session_id)
    deferrable initially deferred
);

comment on table public.agent_session_lineage is
  'Immutable root/parent lineage for every Harness Session in one decision tree. Session lifecycle completion remains event-sourced.';

alter table public.decision_invocation
  add constraint decision_invocation_root_binding_fk
  foreign key (decision_id, root_harness_session_id)
  references public.agent_session_lineage(decision_id, harness_session_id)
  deferrable initially deferred;

create index agent_session_lineage_root_idx
  on public.agent_session_lineage (
    root_harness_session_id,
    depth,
    started_at,
    harness_session_id
  );
create index agent_session_lineage_parent_idx
  on public.agent_session_lineage (
    decision_id,
    parent_harness_session_id,
    harness_session_id
  ) where parent_harness_session_id is not null;

create table public.accepted_target_submission (
  submission_id uuid primary key,
  idempotency_key text not null unique check (idempotency_key <> ''),
  decision_id uuid not null unique,
  root_harness_session_id text not null check (root_harness_session_id <> ''),
  packet_artifact_id uuid not null,
  packet_sha256 text not null check (packet_sha256 ~ '^[0-9a-f]{64}$'),
  targets jsonb not null,
  cash_weight_bps text not null,
  decision_summary text not null check (decision_summary <> ''),
  submission_sha256 text not null check (submission_sha256 ~ '^[0-9a-f]{64}$'),
  accepted_at timestamptz not null,
  source_event_id uuid not null unique
    references public.event_stream(event_id),
  source_stream_seq bigint not null check (source_stream_seq > 0),
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint accepted_target_submission_targets_array
    check (jsonb_typeof(targets) = 'array'),
  constraint accepted_target_submission_decimal_safe
    check (not public.jsonb_contains_number(targets)),
  constraint accepted_target_submission_cash_weight check (
    case
      when cash_weight_bps ~ '^(0|[1-9][0-9]{0,4})$'
        then cash_weight_bps::integer between 0 and 10000
      else false
    end
  ),
  constraint accepted_target_submission_invocation_fk
    foreign key (decision_id, root_harness_session_id, packet_artifact_id)
    references public.decision_invocation(
      decision_id,
      root_harness_session_id,
      packet_artifact_id
    )
);

comment on table public.accepted_target_submission is
  'Exactly one immutable, packet-fenced, schema-validated root submission per decision invocation.';

create index accepted_target_submission_time_idx
  on public.accepted_target_submission (accepted_at desc, submission_id);

create trigger decision_invocation_is_immutable
before update or delete on public.decision_invocation
for each row execute function public.reject_immutable_mutation();

create trigger agent_session_lineage_is_immutable
before update or delete on public.agent_session_lineage
for each row execute function public.reject_immutable_mutation();

create trigger accepted_target_submission_is_immutable
before update or delete on public.accepted_target_submission
for each row execute function public.reject_immutable_mutation();

create or replace function public.open_decision_invocation(
  p_idempotency_key text,
  p_decision_id uuid,
  p_run_id uuid,
  p_season_id uuid,
  p_expected_run_stream_seq bigint,
  p_root_harness_session_id text,
  p_root_agent_identity text,
  p_packet_artifact_id uuid,
  p_agent_bundle_artifact_id uuid,
  p_market_snapshot_id uuid,
  p_decision_at timestamptz,
  p_data_cutoff_at timestamptz,
  p_submission_deadline_at timestamptz,
  p_trigger_reasons text[],
  p_opened_at timestamptz,
  p_recorded_by text
)
returns public.decision_invocation
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_existing public.decision_invocation%rowtype;
  v_inserted public.decision_invocation%rowtype;
  v_root public.agent_session_lineage%rowtype;
  v_packet public.artifact_metadata%rowtype;
  v_bundle public.artifact_metadata%rowtype;
  v_snapshot public.market_snapshot%rowtype;
  v_source_event public.event_stream%rowtype;
  v_event public.event_stream%rowtype;
  v_trigger_reasons text[];
begin
  if p_idempotency_key is null or p_idempotency_key = ''
    or p_decision_id is null
    or p_run_id is null
    or p_season_id is null
    or p_root_harness_session_id is null or p_root_harness_session_id = ''
    or p_root_agent_identity is null or p_root_agent_identity = ''
    or p_packet_artifact_id is null
    or p_agent_bundle_artifact_id is null
    or p_market_snapshot_id is null
    or p_decision_at is null
    or p_data_cutoff_at is null
    or p_submission_deadline_at is null
    or p_opened_at is null
    or p_recorded_by is null or p_recorded_by = ''
  then
    raise exception 'decision invocation required fields must be non-null and non-empty'
      using errcode = '22023';
  end if;

  if p_expected_run_stream_seq is null or p_expected_run_stream_seq < 0 then
    raise exception 'expected run stream sequence must be non-negative'
      using errcode = '22023';
  end if;

  select array_agg(reason order by reason collate "C")
    into v_trigger_reasons
    from (
      select distinct btrim(input_reason) as reason
        from unnest(p_trigger_reasons) as reasons(input_reason)
       where input_reason is not null and btrim(input_reason) <> ''
    ) as normalized;

  if v_trigger_reasons is null
    or p_trigger_reasons is distinct from v_trigger_reasons
  then
    raise exception 'trigger reasons must be non-empty, unique, sorted, and trimmed'
      using errcode = '22023';
  end if;

  if p_data_cutoff_at > p_decision_at
    or p_opened_at < p_decision_at
    or p_submission_deadline_at <= p_opened_at
  then
    raise exception 'decision cutoff, open, and deadline times are inconsistent'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('decision-invocation:' || p_idempotency_key, 0)
  );

  select invocation.* into v_existing
    from public.decision_invocation as invocation
   where invocation.idempotency_key = p_idempotency_key;

  if found then
    select session.* into strict v_root
      from public.agent_session_lineage as session
     where session.decision_id = v_existing.decision_id
       and session.harness_session_id = v_existing.root_harness_session_id;

    select event.* into strict v_source_event
      from public.event_stream as event
     where event.event_id = v_existing.source_event_id;

    if v_existing.decision_id is distinct from p_decision_id
      or v_existing.run_id is distinct from p_run_id
      or v_existing.season_id is distinct from p_season_id
      or v_existing.root_harness_session_id is distinct from p_root_harness_session_id
      or v_existing.packet_artifact_id is distinct from p_packet_artifact_id
      or v_existing.agent_bundle_artifact_id is distinct from p_agent_bundle_artifact_id
      or v_existing.market_snapshot_id is distinct from p_market_snapshot_id
      or v_existing.decision_at is distinct from p_decision_at
      or v_existing.data_cutoff_at is distinct from p_data_cutoff_at
      or v_existing.submission_deadline_at is distinct from p_submission_deadline_at
      or v_existing.trigger_reasons is distinct from v_trigger_reasons
      or v_existing.opened_at is distinct from p_opened_at
      or v_root.session_kind is distinct from 'root'
      or v_root.agent_identity is distinct from p_root_agent_identity
      or v_source_event.actor_id is distinct from p_recorded_by
    then
      raise exception 'decision invocation idempotency key was reused with different content'
        using errcode = '23505';
    end if;
    return v_existing;
  end if;

  select artifact.* into v_packet
    from public.artifact_metadata as artifact
   where artifact.artifact_id = p_packet_artifact_id;
  if not found then
    raise exception 'decision packet artifact does not exist'
      using errcode = '23503';
  end if;

  select artifact.* into v_bundle
    from public.artifact_metadata as artifact
   where artifact.artifact_id = p_agent_bundle_artifact_id;
  if not found then
    raise exception 'Agent Bundle artifact does not exist'
      using errcode = '23503';
  end if;

  select snapshot.* into v_snapshot
    from public.market_snapshot as snapshot
   where snapshot.snapshot_id = p_market_snapshot_id;
  if not found then
    raise exception 'market snapshot does not exist'
      using errcode = '23503';
  end if;

  if v_packet.artifact_kind <> 'decision_packet'
    or v_packet.content_type <> 'application/json'
    or v_packet.run_id is distinct from p_run_id
    or v_packet.season_id is distinct from p_season_id
    or v_packet.metadata->>'schema' is distinct from 'twofold.decision_packet/v1'
    or v_packet.metadata->>'decisionId' is distinct from p_decision_id::text
    or v_packet.metadata->>'marketSnapshotId' is distinct from p_market_snapshot_id::text
    or v_packet.metadata->>'marketManifestSha256' is distinct from v_snapshot.manifest_sha256
  then
    raise exception 'decision packet artifact does not match invocation scope or market snapshot'
      using errcode = '22023';
  end if;

  if v_bundle.artifact_kind <> 'dsh_agent_bundle_manifest'
    or v_bundle.content_type <> 'application/json'
    or v_bundle.season_id is distinct from p_season_id
    or (v_bundle.run_id is not null and v_bundle.run_id is distinct from p_run_id)
  then
    raise exception 'Agent Bundle artifact does not match invocation scope'
      using errcode = '22023';
  end if;

  if v_snapshot.cutoff_at is distinct from p_data_cutoff_at
    or v_snapshot.sealed_at > p_opened_at
  then
    raise exception 'market snapshot is not sealed at the invocation data cutoff'
      using errcode = '22023';
  end if;

  v_event := public.append_event(
    p_run_id,
    'run',
    p_expected_run_stream_seq,
    'decision.invocation_opened',
    '1',
    'arena:invocation:' || p_idempotency_key,
    'worker',
    p_recorded_by,
    p_opened_at,
    jsonb_build_object(
      'decisionId', p_decision_id::text,
      'seasonId', p_season_id::text,
      'rootHarnessSessionId', p_root_harness_session_id,
      'packetArtifactId', p_packet_artifact_id::text,
      'packetSha256', v_packet.sha256,
      'agentBundleArtifactId', p_agent_bundle_artifact_id::text,
      'marketSnapshotId', p_market_snapshot_id::text,
      'marketManifestSha256', v_snapshot.manifest_sha256,
      'dataCutoffAt', p_data_cutoff_at::text,
      'submissionDeadlineAt', p_submission_deadline_at::text,
      'triggerReasons', to_jsonb(v_trigger_reasons)
    ),
    '{}'::jsonb,
    gen_random_uuid(),
    p_decision_id
  );

  insert into public.decision_invocation (
    decision_id,
    idempotency_key,
    run_id,
    season_id,
    root_harness_session_id,
    packet_artifact_id,
    agent_bundle_artifact_id,
    market_snapshot_id,
    decision_at,
    data_cutoff_at,
    submission_deadline_at,
    trigger_reasons,
    source_event_id,
    source_stream_seq,
    opened_at
  ) values (
    p_decision_id,
    p_idempotency_key,
    p_run_id,
    p_season_id,
    p_root_harness_session_id,
    p_packet_artifact_id,
    p_agent_bundle_artifact_id,
    p_market_snapshot_id,
    p_decision_at,
    p_data_cutoff_at,
    p_submission_deadline_at,
    v_trigger_reasons,
    v_event.event_id,
    v_event.stream_seq,
    p_opened_at
  ) returning * into v_inserted;

  insert into public.agent_session_lineage (
    harness_session_id,
    idempotency_key,
    decision_id,
    root_harness_session_id,
    parent_harness_session_id,
    session_kind,
    agent_identity,
    agent_path,
    depth,
    started_at,
    source_event_id,
    source_stream_seq
  ) values (
    p_root_harness_session_id,
    p_idempotency_key || ':root',
    p_decision_id,
    p_root_harness_session_id,
    null,
    'root',
    p_root_agent_identity,
    'root',
    0,
    p_opened_at,
    v_event.event_id,
    v_event.stream_seq
  );

  return v_inserted;
end;
$$;

create or replace function public.register_descendant_session(
  p_idempotency_key text,
  p_root_harness_session_id text,
  p_parent_harness_session_id text,
  p_harness_session_id text,
  p_agent_identity text,
  p_agent_path text,
  p_started_at timestamptz,
  p_expected_run_stream_seq bigint,
  p_recorded_by text
)
returns public.agent_session_lineage
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_invocation public.decision_invocation%rowtype;
  v_parent public.agent_session_lineage%rowtype;
  v_existing public.agent_session_lineage%rowtype;
  v_inserted public.agent_session_lineage%rowtype;
  v_source_event public.event_stream%rowtype;
  v_event public.event_stream%rowtype;
  v_depth integer;
  v_child_segment text;
begin
  if p_idempotency_key is null or p_idempotency_key = ''
    or p_root_harness_session_id is null or p_root_harness_session_id = ''
    or p_parent_harness_session_id is null or p_parent_harness_session_id = ''
    or p_harness_session_id is null or p_harness_session_id = ''
    or p_agent_identity is null or p_agent_identity = ''
    or p_agent_path is null or p_agent_path = ''
    or p_started_at is null
    or p_recorded_by is null or p_recorded_by = ''
  then
    raise exception 'descendant Session required fields must be non-null and non-empty'
      using errcode = '22023';
  end if;

  if p_expected_run_stream_seq is null or p_expected_run_stream_seq < 0 then
    raise exception 'expected run stream sequence must be non-negative'
      using errcode = '22023';
  end if;

  select invocation.* into v_invocation
    from public.decision_invocation as invocation
   where invocation.root_harness_session_id = p_root_harness_session_id;
  if not found then
    raise exception 'root Harness Session is not bound to a decision invocation'
      using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('decision-session:' || p_idempotency_key, 0)
  );

  select session.* into v_existing
    from public.agent_session_lineage as session
   where session.idempotency_key = p_idempotency_key;
  if found then
    select event.* into strict v_source_event
      from public.event_stream as event
     where event.event_id = v_existing.source_event_id;

    if v_existing.decision_id is distinct from v_invocation.decision_id
      or v_existing.root_harness_session_id is distinct from p_root_harness_session_id
      or v_existing.parent_harness_session_id is distinct from p_parent_harness_session_id
      or v_existing.harness_session_id is distinct from p_harness_session_id
      or v_existing.session_kind is distinct from 'descendant'
      or v_existing.agent_identity is distinct from p_agent_identity
      or v_existing.agent_path is distinct from p_agent_path
      or v_existing.started_at is distinct from p_started_at
      or v_source_event.actor_id is distinct from p_recorded_by
    then
      raise exception 'descendant Session idempotency key was reused with different content'
        using errcode = '23505';
    end if;
    return v_existing;
  end if;

  select session.* into v_parent
    from public.agent_session_lineage as session
   where session.decision_id = v_invocation.decision_id
     and session.root_harness_session_id = p_root_harness_session_id
     and session.harness_session_id = p_parent_harness_session_id;
  if not found then
    raise exception 'parent Harness Session is not in the root decision tree'
      using errcode = '23503';
  end if;

  if p_harness_session_id = p_root_harness_session_id
    or p_started_at < v_parent.started_at
    or p_started_at > v_invocation.submission_deadline_at
  then
    raise exception 'descendant Session identity or start time is invalid'
      using errcode = '22023';
  end if;

  v_child_segment := substring(
    p_agent_path from length(v_parent.agent_path) + 2
  );
  if left(p_agent_path, length(v_parent.agent_path) + 1)
      is distinct from v_parent.agent_path || '/'
    or v_child_segment = ''
    or position('/' in v_child_segment) > 0
  then
    raise exception 'descendant agent path must be one direct child of its parent path'
      using errcode = '22023';
  end if;

  v_depth := v_parent.depth + 1;
  v_event := public.append_event(
    v_invocation.run_id,
    'run',
    p_expected_run_stream_seq,
    'decision.session_linked',
    '1',
    'arena:session:' || p_idempotency_key,
    'worker',
    p_recorded_by,
    p_started_at,
    jsonb_build_object(
      'decisionId', v_invocation.decision_id::text,
      'rootHarnessSessionId', p_root_harness_session_id,
      'parentHarnessSessionId', p_parent_harness_session_id,
      'harnessSessionId', p_harness_session_id,
      'agentIdentity', p_agent_identity,
      'agentPath', p_agent_path,
      'depth', v_depth::text
    ),
    '{}'::jsonb,
    gen_random_uuid(),
    v_invocation.decision_id,
    v_parent.source_event_id
  );

  insert into public.agent_session_lineage (
    harness_session_id,
    idempotency_key,
    decision_id,
    root_harness_session_id,
    parent_harness_session_id,
    session_kind,
    agent_identity,
    agent_path,
    depth,
    started_at,
    source_event_id,
    source_stream_seq
  ) values (
    p_harness_session_id,
    p_idempotency_key,
    v_invocation.decision_id,
    p_root_harness_session_id,
    p_parent_harness_session_id,
    'descendant',
    p_agent_identity,
    p_agent_path,
    v_depth,
    p_started_at,
    v_event.event_id,
    v_event.stream_seq
  ) returning * into v_inserted;

  return v_inserted;
end;
$$;

create or replace function public.accept_portfolio_targets(
  p_idempotency_key text,
  p_submission_id uuid,
  p_root_harness_session_id text,
  p_packet_artifact_id uuid,
  p_packet_sha256 text,
  p_targets jsonb,
  p_cash_weight_bps text,
  p_decision_summary text,
  p_accepted_at timestamptz,
  p_expected_run_stream_seq bigint,
  p_recorded_by text
)
returns public.accepted_target_submission
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_invocation public.decision_invocation%rowtype;
  v_packet public.artifact_metadata%rowtype;
  v_snapshot public.market_snapshot%rowtype;
  v_existing public.accepted_target_submission%rowtype;
  v_decision_submission public.accepted_target_submission%rowtype;
  v_inserted public.accepted_target_submission%rowtype;
  v_targets jsonb;
  v_invested_bps bigint;
  v_submission_sha256 text;
  v_event public.event_stream%rowtype;
begin
  if p_idempotency_key is null or p_idempotency_key = ''
    or p_submission_id is null
    or p_root_harness_session_id is null or p_root_harness_session_id = ''
    or p_packet_artifact_id is null
    or p_accepted_at is null
    or p_recorded_by is null or p_recorded_by = ''
  then
    raise exception 'target submission required fields must be non-null and non-empty'
      using errcode = '22023';
  end if;

  if p_expected_run_stream_seq is null or p_expected_run_stream_seq < 0 then
    raise exception 'expected run stream sequence must be non-negative'
      using errcode = '22023';
  end if;

  select invocation.* into v_invocation
    from public.decision_invocation as invocation
   where invocation.root_harness_session_id = p_root_harness_session_id;
  if not found then
    raise exception 'only the bound root Harness Session may submit portfolio targets'
      using errcode = 'P0002';
  end if;

  if jsonb_typeof(p_targets) is distinct from 'array'
    or public.jsonb_contains_number(p_targets)
  then
    raise exception 'targets must be a JSON array containing no JSON numeric tokens'
      using errcode = '22023';
  end if;

  if p_cash_weight_bps is null
    or p_cash_weight_bps !~ '^(0|[1-9][0-9]{0,4})$'
    or p_cash_weight_bps::integer > 10000
  then
    raise exception 'cash weight must be a canonical integer string from 0 through 10000'
      using errcode = '22023';
  end if;

  if p_decision_summary is null
    or p_decision_summary = ''
    or p_decision_summary is distinct from btrim(p_decision_summary)
  then
    raise exception 'decision summary must be non-empty and trimmed'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_targets) as target(item)
     where jsonb_typeof(target.item) is distinct from 'object'
        or not (target.item ? 'symbol')
        or not (target.item ? 'target_weight_bps')
        or target.item - array['symbol', 'target_weight_bps', 'rationale']::text[]
             <> '{}'::jsonb
        or jsonb_typeof(target.item->'symbol') is distinct from 'string'
        or jsonb_typeof(target.item->'target_weight_bps') is distinct from 'string'
        or (
          target.item ? 'rationale'
          and (
            jsonb_typeof(target.item->'rationale') is distinct from 'string'
            or target.item->>'rationale' = ''
            or target.item->>'rationale' is distinct from btrim(target.item->>'rationale')
          )
        )
        or target.item->>'symbol' !~ '^[A-Z][A-Z0-9.-]{0,14}$'
        or not case
          when target.item->>'target_weight_bps' ~ '^[1-9][0-9]{0,4}$'
            then (target.item->>'target_weight_bps')::integer between 1 and 10000
          else false
        end
  ) then
    raise exception 'targets contain invalid fields, symbols, rationales, or weights'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_targets) as target(item)
     group by target.item->>'symbol'
    having count(*) > 1
  ) then
    raise exception 'targets contain duplicate symbols'
      using errcode = '22023';
  end if;

  select snapshot.* into strict v_snapshot
    from public.market_snapshot as snapshot
   where snapshot.snapshot_id = v_invocation.market_snapshot_id;

  if exists (
    select 1
      from jsonb_array_elements(p_targets) as target(item)
     where not ((target.item->>'symbol') = any(v_snapshot.symbols))
  ) then
    raise exception 'targets contain a symbol outside the bound market snapshot'
      using errcode = '22023';
  end if;

  select coalesce(
           jsonb_agg(
             case
               when target.item ? 'rationale' then jsonb_build_object(
                 'symbol', target.item->>'symbol',
                 'target_weight_bps', target.item->>'target_weight_bps',
                 'rationale', target.item->>'rationale'
               )
               else jsonb_build_object(
                 'symbol', target.item->>'symbol',
                 'target_weight_bps', target.item->>'target_weight_bps'
               )
             end
             order by (target.item->>'symbol') collate "C"
           ),
           '[]'::jsonb
         ),
         coalesce(sum((target.item->>'target_weight_bps')::bigint), 0)
    into v_targets, v_invested_bps
    from jsonb_array_elements(p_targets) as target(item);

  if v_invested_bps + p_cash_weight_bps::bigint <> 10000 then
    raise exception 'target weights plus cash weight must total exactly 10000 basis points'
      using errcode = '22023';
  end if;

  select artifact.* into strict v_packet
    from public.artifact_metadata as artifact
   where artifact.artifact_id = v_invocation.packet_artifact_id;

  if p_packet_artifact_id is distinct from v_invocation.packet_artifact_id
    or p_packet_sha256 is distinct from v_packet.sha256
  then
    raise exception 'packet artifact id or SHA-256 fence does not match the root invocation'
      using errcode = '22023';
  end if;

  v_submission_sha256 := encode(
    digest(
      'twofold.accepted_portfolio_targets/v1' || chr(31)
      || v_invocation.decision_id::text || chr(31)
      || p_root_harness_session_id || chr(31)
      || p_packet_artifact_id::text || chr(31)
      || p_packet_sha256 || chr(31)
      || v_targets::text || chr(31)
      || p_cash_weight_bps || chr(31)
      || p_decision_summary,
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended('portfolio-submission:' || v_invocation.decision_id::text, 0)
  );

  select submission.* into v_existing
    from public.accepted_target_submission as submission
   where submission.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.submission_id is distinct from p_submission_id
      or v_existing.decision_id is distinct from v_invocation.decision_id
      or v_existing.root_harness_session_id is distinct from p_root_harness_session_id
      or v_existing.packet_artifact_id is distinct from p_packet_artifact_id
      or v_existing.packet_sha256 is distinct from p_packet_sha256
      or v_existing.targets is distinct from v_targets
      or v_existing.cash_weight_bps is distinct from p_cash_weight_bps
      or v_existing.decision_summary is distinct from p_decision_summary
      or v_existing.submission_sha256 is distinct from v_submission_sha256
      or v_existing.accepted_at is distinct from p_accepted_at
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'target submission idempotency key was reused with different content'
        using errcode = '23505';
    end if;
    return v_existing;
  end if;

  select submission.* into v_decision_submission
    from public.accepted_target_submission as submission
   where submission.decision_id = v_invocation.decision_id;
  if found then
    raise exception 'decision invocation already has an accepted target submission'
      using errcode = '23505';
  end if;

  if p_accepted_at < v_invocation.opened_at
    or p_accepted_at > v_invocation.submission_deadline_at
  then
    raise exception 'target submission is outside the invocation deadline'
      using errcode = '22023';
  end if;

  v_event := public.append_event(
    v_invocation.run_id,
    'run',
    p_expected_run_stream_seq,
    'decision.targets_accepted',
    '1',
    'arena:submission:' || p_idempotency_key,
    'worker',
    p_recorded_by,
    p_accepted_at,
    jsonb_build_object(
      'decisionId', v_invocation.decision_id::text,
      'submissionId', p_submission_id::text,
      'rootHarnessSessionId', p_root_harness_session_id,
      'packetArtifactId', p_packet_artifact_id::text,
      'packetSha256', p_packet_sha256,
      'submissionSha256', v_submission_sha256,
      'cashWeightBps', p_cash_weight_bps
    ),
    '{}'::jsonb,
    gen_random_uuid(),
    v_invocation.decision_id,
    v_invocation.source_event_id
  );

  insert into public.accepted_target_submission (
    submission_id,
    idempotency_key,
    decision_id,
    root_harness_session_id,
    packet_artifact_id,
    packet_sha256,
    targets,
    cash_weight_bps,
    decision_summary,
    submission_sha256,
    accepted_at,
    source_event_id,
    source_stream_seq,
    recorded_by
  ) values (
    p_submission_id,
    p_idempotency_key,
    v_invocation.decision_id,
    p_root_harness_session_id,
    p_packet_artifact_id,
    p_packet_sha256,
    v_targets,
    p_cash_weight_bps,
    p_decision_summary,
    v_submission_sha256,
    p_accepted_at,
    v_event.event_id,
    v_event.stream_seq,
    p_recorded_by
  ) returning * into v_inserted;

  return v_inserted;
end;
$$;

create view public.model_usage_root_attribution
with (security_invoker = true)
as
select
  usage.*,
  lineage.root_harness_session_id,
  lineage.parent_harness_session_id,
  lineage.session_kind,
  lineage.agent_identity,
  lineage.agent_path,
  lineage.depth,
  case
    when lineage.harness_session_id is null then 'unattributed'
    else 'attributed'
  end as attribution_status
from public.model_usage_record as usage
left join public.agent_session_lineage as lineage
  on lineage.decision_id = usage.decision_id
 and lineage.harness_session_id = usage.harness_session_id;

comment on view public.model_usage_root_attribution is
  'Read-only lineage join. Legacy usage remains visible as explicitly unattributed; no model_usage_record foreign key is introduced.';

alter table public.decision_invocation enable row level security;
alter table public.agent_session_lineage enable row level security;
alter table public.accepted_target_submission enable row level security;

revoke all on table public.decision_invocation from public, anon, authenticated;
revoke all on table public.agent_session_lineage from public, anon, authenticated;
revoke all on table public.accepted_target_submission from public, anon, authenticated;
revoke all on table public.model_usage_root_attribution from public, anon, authenticated;

revoke insert, update, delete, truncate, references, trigger
  on table public.decision_invocation from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.agent_session_lineage from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.accepted_target_submission from service_role;

grant select on table public.decision_invocation to service_role;
grant select on table public.agent_session_lineage to service_role;
grant select on table public.accepted_target_submission to service_role;
grant select on table public.model_usage_root_attribution to service_role;

revoke all on function public.open_decision_invocation(
  text, uuid, uuid, uuid, bigint, text, text, uuid, uuid, uuid,
  timestamptz, timestamptz, timestamptz, text[], timestamptz, text
) from public, anon, authenticated;
revoke all on function public.register_descendant_session(
  text, text, text, text, text, text, timestamptz, bigint, text
) from public, anon, authenticated;
revoke all on function public.accept_portfolio_targets(
  text, uuid, text, uuid, text, jsonb, text, text, timestamptz, bigint, text
) from public, anon, authenticated;

grant execute on function public.open_decision_invocation(
  text, uuid, uuid, uuid, bigint, text, text, uuid, uuid, uuid,
  timestamptz, timestamptz, timestamptz, text[], timestamptz, text
) to service_role;
grant execute on function public.register_descendant_session(
  text, text, text, text, text, text, timestamptz, bigint, text
) to service_role;
grant execute on function public.accept_portfolio_targets(
  text, uuid, text, uuid, text, jsonb, text, text, timestamptz, bigint, text
) to service_role;

alter table public.decision_invocation replica identity full;
alter table public.agent_session_lineage replica identity full;
alter table public.accepted_target_submission replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.decision_invocation;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.agent_session_lineage;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.accepted_target_submission;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

commit;
