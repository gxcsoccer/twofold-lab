-- A ranked contestant that consumes no model. A deterministic baseline holds a
-- single instrument under a frozen, content-addressed policy so the leaderboard
-- can show what the Agent entrants actually had to beat. It reuses the whole
-- existing accepted-target -> S1/S2 -> ledger -> NAV path unchanged: everything
-- downstream keys off decision_id, so only entrant identity and the decision's
-- own provenance need to learn about the new kind.
--
-- The zero-token property is a database invariant here, not a convention. A
-- baseline decision that ever billed a provider request is rejected at insert.

begin;

-- 1. Entrant identity ---------------------------------------------------------

alter table public.season_entrant
  drop constraint season_entrant_execution_class_check;
alter table public.season_entrant
  add constraint season_entrant_execution_class_check check (
    execution_class in ('ROOT_ONLY', 'ORCHESTRATED', 'DETERMINISTIC_BASELINE')
  );

-- provider/model stay NOT NULL: a baseline records an explicit 'none' sentinel
-- rather than a nullable column that reads as "unknown". The equivalence makes
-- the sentinel unforgeable in both directions - a model entrant cannot claim
-- 'none', and a baseline cannot name a real route.
alter table public.season_entrant
  add constraint season_entrant_baseline_has_no_model_route check (
    (execution_class = 'DETERMINISTIC_BASELINE')
      = (provider = 'none' and model = 'none')
  );

comment on constraint season_entrant_baseline_has_no_model_route
  on public.season_entrant is
  'A DETERMINISTIC_BASELINE entrant has no provider route; every other class must name one.';

-- bundle_sha256 keeps its meaning for a baseline: it is the SHA-256 of the
-- frozen twofold.deterministic_baseline_policy/v1 bytes, so the existing
-- immutable entrant-identity fence already prevents redefining a baseline
-- mid-Season without registering a different entrant.
comment on column public.season_entrant.bundle_sha256 is
  'Content address of the frozen entrant policy: an Agent Bundle artifact, or a deterministic baseline policy document.';

-- 2. Decision provenance ------------------------------------------------------

alter table public.decision_invocation
  add column decision_kind text not null default 'AGENT'
  check (decision_kind in ('AGENT', 'DETERMINISTIC_BASELINE'));

comment on column public.decision_invocation.decision_kind is
  'Whether this decision was produced by a Harness Agent tree or by a deterministic, model-free baseline policy.';

-- The label must match the recorded root execution identity, so a baseline
-- decision can never be read back as an Agent result or the reverse. Existing
-- rows carry Harness session ids and are unaffected; the migration fails loudly
-- rather than silently if that ever stopped being true.
alter table public.decision_invocation
  add constraint decision_invocation_baseline_identity check (
    (decision_kind = 'DETERMINISTIC_BASELINE')
      = (root_harness_session_id ~ '^baseline:[a-z0-9][a-z0-9-]{1,63}:')
  );

-- decision_kind is derived from immutable entrant identity rather than trusted
-- from the caller, so a worker cannot mislabel a decision in either direction.
-- A non-competition one-shot invocation has no Season entrant and stays AGENT.
create or replace function public.derive_decision_kind()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_execution_class text;
begin
  select entrant.execution_class into v_execution_class
    from public.season_entrant as entrant
   where entrant.run_id = new.run_id;

  new.decision_kind := case
    when v_execution_class = 'DETERMINISTIC_BASELINE'
      then 'DETERMINISTIC_BASELINE'
    else 'AGENT'
  end;
  return new;
end;
$$;

create trigger decision_invocation_derives_kind
before insert on public.decision_invocation
for each row execute function public.derive_decision_kind();

-- 3. Zero-token invariant -----------------------------------------------------

create or replace function public.reject_baseline_model_usage()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.decision_invocation as invocation
     where invocation.decision_id = new.decision_id
       and invocation.decision_kind = 'DETERMINISTIC_BASELINE'
  ) then
    raise exception
      'a deterministic baseline decision cannot record model usage'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger model_usage_record_rejects_baseline_usage
before insert on public.model_usage_record
for each row execute function public.reject_baseline_model_usage();

comment on function public.reject_baseline_model_usage() is
  'Fail-closed guarantee that a model-free baseline entrant never bills a provider request.';

-- 4. Registration boundary ----------------------------------------------------

create or replace function public.register_season_entrant(
  p_idempotency_key text,
  p_entrant_id uuid,
  p_season_id uuid,
  p_entrant_code text,
  p_run_id uuid,
  p_bundle_id text,
  p_bundle_sha256 text,
  p_preset_id text,
  p_provider text,
  p_model text,
  p_execution_class text,
  p_metadata jsonb,
  p_recorded_by text
)
returns public.season_entrant
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_existing public.season_entrant%rowtype;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_entrant_id is null or p_season_id is null
    or p_entrant_code is null
      or p_entrant_code !~ '^[a-z0-9][a-z0-9._-]{1,63}$'
    or p_run_id is null
    or p_bundle_id is null or btrim(p_bundle_id) = ''
    or p_bundle_sha256 is null or p_bundle_sha256 !~ '^[0-9a-f]{64}$'
    or p_preset_id is null or btrim(p_preset_id) = ''
    or p_provider is null or btrim(p_provider) = ''
    or p_model is null or btrim(p_model) = ''
    or p_execution_class not in (
      'ROOT_ONLY', 'ORCHESTRATED', 'DETERMINISTIC_BASELINE'
    )
    or (p_execution_class = 'DETERMINISTIC_BASELINE')
      is distinct from (p_provider = 'none' and p_model = 'none')
    or jsonb_typeof(p_metadata) is distinct from 'object'
    or public.jsonb_contains_number(p_metadata)
    or p_recorded_by is null or btrim(p_recorded_by) = ''
  then
    raise exception 'invalid immutable Season entrant'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.arena_season where season_id = p_season_id
  ) or not exists (
    select 1 from public.run_manifest where run_id = p_run_id
  ) then
    raise exception 'Season entrant requires its Season and Run manifest'
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('twofold-season-entrant', 0));
  select * into v_existing
    from public.season_entrant
   where idempotency_key = p_idempotency_key
      or entrant_id = p_entrant_id
      or run_id = p_run_id
      or (season_id = p_season_id and entrant_code = p_entrant_code)
   order by (idempotency_key = p_idempotency_key) desc
   limit 1;
  if found then
    if v_existing.entrant_id is distinct from p_entrant_id
      or v_existing.season_id is distinct from p_season_id
      or v_existing.entrant_code is distinct from p_entrant_code
      or v_existing.run_id is distinct from p_run_id
      or v_existing.bundle_id is distinct from p_bundle_id
      or v_existing.bundle_sha256 is distinct from p_bundle_sha256
      or v_existing.preset_id is distinct from p_preset_id
      or v_existing.provider is distinct from p_provider
      or v_existing.model is distinct from p_model
      or v_existing.execution_class is distinct from p_execution_class
      or v_existing.metadata is distinct from p_metadata
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'Season entrant identity was reused with different content'
        using errcode = '23505';
    end if;
    return v_existing;
  end if;

  insert into public.season_entrant (
    entrant_id, idempotency_key, season_id, entrant_code, run_id,
    bundle_id, bundle_sha256, preset_id, provider, model, execution_class,
    metadata, recorded_by
  ) values (
    p_entrant_id, p_idempotency_key, p_season_id, p_entrant_code, p_run_id,
    p_bundle_id, p_bundle_sha256, p_preset_id, p_provider, p_model,
    p_execution_class, p_metadata, p_recorded_by
  ) returning * into v_existing;
  return v_existing;
end;
$$;

revoke all on function public.register_season_entrant(
  text, uuid, uuid, text, uuid, text, text, text, text, text, text, jsonb, text
) from public, anon, authenticated;

grant execute on function public.register_season_entrant(
  text, uuid, uuid, text, uuid, text, text, text, text, text, text, jsonb, text
) to service_role;

revoke all on function public.derive_decision_kind()
  from public, anon, authenticated, service_role;
revoke all on function public.reject_baseline_model_usage()
  from public, anon, authenticated, service_role;

-- 5. Kind-aware decision inputs ------------------------------------------------
--
-- open_decision_invocation hard-coded the Agent artifact kinds and packet
-- schema, so a baseline could never open a decision at all. The entrant class
-- is read from the same immutable source the decision_kind trigger uses, and a
-- baseline is required to present its own kinds - it is never allowed to pass
-- a policy document off as a dsh_agent_bundle_manifest. Every other fence
-- (run/season scope, decisionId, snapshot id, and manifest SHA-256) is
-- unchanged and applies identically to both kinds.

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
  v_execution_class text;
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

  select entrant.execution_class into v_execution_class
    from public.season_entrant as entrant
   where entrant.run_id = p_run_id;

  if v_packet.artifact_kind is distinct from (case
       when v_execution_class = 'DETERMINISTIC_BASELINE'
         then 'baseline_decision_packet' else 'decision_packet' end)
    or v_packet.content_type <> 'application/json'
    or v_packet.run_id is distinct from p_run_id
    or v_packet.season_id is distinct from p_season_id
    or v_packet.metadata->>'schema' is distinct from (case
       when v_execution_class = 'DETERMINISTIC_BASELINE'
         then 'twofold.baseline_decision_packet/v1'
       else 'twofold.decision_packet/v1' end)
    or v_packet.metadata->>'decisionId' is distinct from p_decision_id::text
    or v_packet.metadata->>'marketSnapshotId' is distinct from p_market_snapshot_id::text
    or v_packet.metadata->>'marketManifestSha256' is distinct from v_snapshot.manifest_sha256
  then
    raise exception 'decision packet artifact does not match invocation scope or market snapshot'
      using errcode = '22023';
  end if;

  if v_bundle.artifact_kind is distinct from (case
       when v_execution_class = 'DETERMINISTIC_BASELINE'
         then 'deterministic_baseline_policy' else 'dsh_agent_bundle_manifest' end)
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

commit;
