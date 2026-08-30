-- Self-evolution is an evidence loop, not an autonomous production editor.
-- Scheduled cycles harvest operational facts, immutable findings preserve what
-- was learned, and experiments may run locally or in an isolated shadow lane.
-- Only a human may admit an online experiment or promote any result.

begin;

create table public.evolution_cycle (
  cycle_id uuid primary key,
  idempotency_key text not null unique check (
    idempotency_key <> '' and idempotency_key = btrim(idempotency_key)
  ),
  window_started_at timestamptz not null,
  window_ended_at timestamptz not null,
  policy jsonb not null,
  policy_sha256 text not null check (policy_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'REQUESTED' check (
    status in ('REQUESTED', 'CLAIMED', 'SUCCEEDED', 'FAILED')
  ),
  claimed_by text,
  lease_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  observations jsonb,
  analysis_report jsonb,
  report_sha256 text check (report_sha256 ~ '^[0-9a-f]{64}$'),
  error_code text,
  error_message text,
  recorded_by text not null check (
    recorded_by <> '' and recorded_by = btrim(recorded_by)
  ),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint evolution_cycle_window check (window_ended_at > window_started_at),
  constraint evolution_cycle_policy_object check (
    jsonb_typeof(policy) = 'object' and not public.jsonb_contains_number(policy)
  ),
  constraint evolution_cycle_observations_array check (
    observations is null or (
      jsonb_typeof(observations) = 'array'
      and not public.jsonb_contains_number(observations)
    )
  ),
  constraint evolution_cycle_report_object check (
    analysis_report is null or (
      jsonb_typeof(analysis_report) = 'object'
      and not public.jsonb_contains_number(analysis_report)
    )
  ),
  constraint evolution_cycle_identity check (
    cycle_id = public.deterministic_uuid_from_sha256(
      'twofold.evolution_cycle/v1', idempotency_key
    )
  ),
  constraint evolution_cycle_lifecycle check (
    (status = 'REQUESTED'
      and claimed_by is null and lease_token is null and claimed_at is null
      and lease_expires_at is null and completed_at is null
      and observations is null and analysis_report is null
      and report_sha256 is null and error_code is null and error_message is null)
    or
    (status = 'CLAIMED'
      and claimed_by is not null and lease_token is not null
      and claimed_at is not null and lease_expires_at > claimed_at
      and completed_at is null and observations is null
      and analysis_report is null and report_sha256 is null
      and error_code is null and error_message is null)
    or
    (status = 'SUCCEEDED'
      and claimed_by is not null and lease_token is not null
      and claimed_at is not null and completed_at is not null
      and observations is not null and analysis_report is not null
      and report_sha256 is not null
      and error_code is null and error_message is null)
    or
    (status = 'FAILED'
      and claimed_by is not null and lease_token is not null
      and claimed_at is not null and completed_at is not null
      and observations is null and analysis_report is null
      and report_sha256 is null
      and error_code is not null and error_message is not null)
  )
);

comment on table public.evolution_cycle is
  'Lease-based scheduled observation and analysis window for the self-evolution loop.';

create index evolution_cycle_claim_idx on public.evolution_cycle (
  status, window_ended_at, recorded_at, cycle_id
);

create table public.evolution_finding (
  finding_sha256 text primary key check (finding_sha256 ~ '^[0-9a-f]{64}$'),
  cycle_id uuid not null references public.evolution_cycle(cycle_id),
  finding jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint evolution_finding_document check (
    jsonb_typeof(finding) = 'object'
    and finding->>'schema' = 'twofold.evolution_finding/v1'
    and finding->>'findingSha256' = finding_sha256
    and not public.jsonb_contains_number(finding)
  )
);

create table public.evolution_experience (
  experience_id uuid primary key,
  cycle_id uuid not null references public.evolution_cycle(cycle_id),
  finding_sha256 text not null references public.evolution_finding(finding_sha256),
  scope text not null check (scope in ('AGENT', 'PLATFORM', 'DATA', 'ACCOUNTING')),
  subject text not null check (subject <> '' and subject = btrim(subject)),
  lesson text not null check (lesson <> '' and lesson = btrim(lesson)),
  evidence_refs jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint evolution_experience_finding_unique unique (finding_sha256),
  constraint evolution_experience_identity check (
    experience_id = public.deterministic_uuid_from_sha256(
      'twofold.evolution_experience/v1', finding_sha256
    )
  ),
  constraint evolution_experience_evidence check (
    jsonb_typeof(evidence_refs) = 'array'
    and jsonb_array_length(evidence_refs) > 0
    and not public.jsonb_contains_number(evidence_refs)
  )
);

create table public.evolution_experiment (
  experiment_id uuid primary key,
  experiment_code text not null unique check (
    experiment_code ~ '^[a-z0-9][a-z0-9._-]{1,127}$'
  ),
  mode text not null check (mode in ('LOCAL_REPLAY', 'ONLINE_SHADOW')),
  spec jsonb not null,
  spec_sha256 text not null unique check (spec_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in (
    'PROPOSED', 'APPROVED', 'SCHEDULED', 'RUNNING', 'COMPLETED',
    'PROMOTED', 'CANCELED', 'FAILED'
  )),
  ranking_scope text check (ranking_scope is null or ranking_scope = 'SHADOW'),
  proposed_at timestamptz not null,
  human_approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  promoted_at timestamptz,
  result jsonb,
  result_sha256 text check (result_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null,
  constraint evolution_experiment_spec check (
    jsonb_typeof(spec) = 'object'
    and spec->>'schema' = 'twofold.evolution_experiment_spec/v1'
    and spec->>'experimentId' = experiment_id::text
    and spec->>'experimentCode' = experiment_code
    and spec->>'mode' = mode
    and not public.jsonb_contains_number(spec)
  ),
  constraint evolution_experiment_mode_scope check (
    (mode = 'LOCAL_REPLAY' and ranking_scope is null and spec->'onlineShadow' = 'null'::jsonb)
    or
    (mode = 'ONLINE_SHADOW' and ranking_scope = 'SHADOW'
      and spec->'onlineShadow'->>'rankingScope' = 'SHADOW')
  ),
  constraint evolution_experiment_result check (
    (result is null and result_sha256 is null)
    or
    (jsonb_typeof(result) = 'object'
      and result->>'schema' = 'twofold.evolution_experiment_result/v1'
      and result->>'resultSha256' = result_sha256
      and not public.jsonb_contains_number(result))
  ),
  constraint evolution_experiment_time_order check (
    updated_at >= proposed_at
    and (human_approved_at is null or human_approved_at >= proposed_at)
    and (started_at is null or started_at >= proposed_at)
    and (completed_at is null or completed_at >= coalesce(started_at, proposed_at))
    and (promoted_at is null or promoted_at >= coalesce(completed_at, proposed_at))
  )
);

comment on table public.evolution_experiment is
  'Audited experiment state. Online admission and all promotion are human gates.';

create table public.evolution_trial (
  trial_id uuid primary key,
  experiment_id uuid not null references public.evolution_experiment(experiment_id),
  trial_code text not null unique check (
    trial_code <> '' and trial_code = btrim(trial_code)
  ),
  mode text not null check (mode in ('LOCAL_REPLAY', 'ONLINE_SHADOW')),
  season_id uuid references public.arena_season(season_id),
  round_id uuid references public.arena_round(round_id),
  ranking_scope text not null check (ranking_scope in ('LOCAL', 'SHADOW')),
  baseline_ref text not null check (baseline_ref <> '' and baseline_ref = btrim(baseline_ref)),
  treatment_ref text not null check (treatment_ref <> '' and treatment_ref = btrim(treatment_ref)),
  input_evidence jsonb not null,
  scheduled_at timestamptz not null,
  expires_at timestamptz not null,
  recorded_by text not null check (recorded_by <> '' and recorded_by = btrim(recorded_by)),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint evolution_trial_identity check (
    trial_id = public.deterministic_uuid_from_sha256(
      'twofold.evolution_trial/v1', trial_code
    )
  ),
  constraint evolution_trial_mode_scope check (
    (mode = 'LOCAL_REPLAY' and ranking_scope = 'LOCAL'
      and season_id is null and round_id is null)
    or
    (mode = 'ONLINE_SHADOW' and ranking_scope = 'SHADOW'
      and season_id is not null and round_id is not null)
  ),
  constraint evolution_trial_evidence check (
    jsonb_typeof(input_evidence) = 'object'
    and not public.jsonb_contains_number(input_evidence)
  ),
  constraint evolution_trial_window check (expires_at > scheduled_at)
);

comment on table public.evolution_trial is
  'Isolated local or online-shadow trial. It has no official entrant or Round-entry identity.';

create table public.evolution_trial_result (
  trial_id uuid primary key references public.evolution_trial(trial_id),
  experiment_id uuid not null references public.evolution_experiment(experiment_id),
  result jsonb not null,
  result_sha256 text not null unique check (result_sha256 ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz not null,
  recorded_by text not null check (recorded_by <> '' and recorded_by = btrim(recorded_by)),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint evolution_trial_result_document check (
    jsonb_typeof(result) = 'object'
    and result->>'schema' = 'twofold.evolution_experiment_result/v1'
    and result->>'resultSha256' = result_sha256
    and not public.jsonb_contains_number(result)
  )
);

create table public.evolution_experiment_action (
  action_id uuid primary key,
  experiment_id uuid not null references public.evolution_experiment(experiment_id),
  idempotency_key text not null unique check (
    idempotency_key <> '' and idempotency_key = btrim(idempotency_key)
  ),
  action text not null check (action in (
    'PROPOSE', 'APPROVE', 'SCHEDULE', 'START', 'COMPLETE',
    'PROMOTE', 'CANCEL', 'FAIL'
  )),
  from_status text,
  to_status text not null,
  actor_kind text not null check (actor_kind in ('human', 'worker', 'model')),
  actor_id text not null check (actor_id <> '' and actor_id = btrim(actor_id)),
  action_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  constraint evolution_experiment_action_identity check (
    action_id = public.deterministic_uuid_from_sha256(
      'twofold.evolution_experiment_action/v1', idempotency_key
    )
  ),
  constraint evolution_experiment_action_payload check (
    jsonb_typeof(payload) = 'object' and not public.jsonb_contains_number(payload)
  )
);

alter table public.evolution_cycle enable row level security;
alter table public.evolution_finding enable row level security;
alter table public.evolution_experience enable row level security;
alter table public.evolution_experiment enable row level security;
alter table public.evolution_trial enable row level security;
alter table public.evolution_trial_result enable row level security;
alter table public.evolution_experiment_action enable row level security;

create trigger evolution_finding_is_immutable
before update or delete on public.evolution_finding
for each row execute function public.reject_immutable_mutation();
create trigger evolution_experience_is_immutable
before update or delete on public.evolution_experience
for each row execute function public.reject_immutable_mutation();
create trigger evolution_trial_is_immutable
before update or delete on public.evolution_trial
for each row execute function public.reject_immutable_mutation();
create trigger evolution_trial_result_is_immutable
before update or delete on public.evolution_trial_result
for each row execute function public.reject_immutable_mutation();
create trigger evolution_experiment_action_is_immutable
before update or delete on public.evolution_experiment_action
for each row execute function public.reject_immutable_mutation();

create or replace function public.guard_evolution_cycle_mutation()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'evolution_cycle cannot be deleted' using errcode = '55000';
  end if;
  if current_setting('twofold.evolution_cycle_mutation', true) is distinct from 'on' then
    raise exception 'evolution_cycle may change only through RPCs' using errcode = '55000';
  end if;
  if new.cycle_id is distinct from old.cycle_id
    or new.idempotency_key is distinct from old.idempotency_key
    or new.window_started_at is distinct from old.window_started_at
    or new.window_ended_at is distinct from old.window_ended_at
    or new.policy is distinct from old.policy
    or new.policy_sha256 is distinct from old.policy_sha256
    or new.recorded_by is distinct from old.recorded_by
    or new.recorded_at is distinct from old.recorded_at
  then
    raise exception 'evolution cycle identity is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger evolution_cycle_guarded before update or delete on public.evolution_cycle
for each row execute function public.guard_evolution_cycle_mutation();

create or replace function public.guard_evolution_experiment_mutation()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'evolution_experiment cannot be deleted' using errcode = '55000';
  end if;
  if current_setting('twofold.evolution_experiment_mutation', true) is distinct from 'on' then
    raise exception 'evolution_experiment may change only through RPCs' using errcode = '55000';
  end if;
  if new.experiment_id is distinct from old.experiment_id
    or new.experiment_code is distinct from old.experiment_code
    or new.mode is distinct from old.mode
    or new.spec is distinct from old.spec
    or new.spec_sha256 is distinct from old.spec_sha256
    or new.ranking_scope is distinct from old.ranking_scope
    or new.proposed_at is distinct from old.proposed_at
  then
    raise exception 'evolution experiment identity is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger evolution_experiment_guarded
before update or delete on public.evolution_experiment
for each row execute function public.guard_evolution_experiment_mutation();

create or replace function public.evolution_cycle_result(p_cycle public.evolution_cycle)
returns jsonb language sql stable strict set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'schema', 'twofold.evolution_cycle/v1',
    'cycleId', p_cycle.cycle_id::text,
    'windowStartedAt', to_char(p_cycle.window_started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'windowEndedAt', to_char(p_cycle.window_ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'policy', p_cycle.policy,
    'policySha256', p_cycle.policy_sha256,
    'status', p_cycle.status,
    'claimedBy', p_cycle.claimed_by,
    'leaseToken', p_cycle.lease_token::text,
    'leaseExpiresAt', case when p_cycle.lease_expires_at is null then null else
      to_char(p_cycle.lease_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'completedAt', case when p_cycle.completed_at is null then null else
      to_char(p_cycle.completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'observations', p_cycle.observations,
    'analysisReport', p_cycle.analysis_report,
    'reportSha256', p_cycle.report_sha256,
    'errorCode', p_cycle.error_code,
    'errorMessage', p_cycle.error_message
  )
$$;

create or replace function public.request_evolution_cycle(
  p_idempotency_key text,
  p_window_started_at timestamptz,
  p_window_ended_at timestamptz,
  p_policy jsonb,
  p_recorded_by text
)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp set row_security = off as $$
declare
  v_cycle public.evolution_cycle%rowtype;
  v_cycle_id uuid;
  v_policy_sha text;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_window_started_at is null or p_window_ended_at <= p_window_started_at
    or jsonb_typeof(p_policy) is distinct from 'object'
    or public.jsonb_contains_number(p_policy)
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid evolution cycle request' using errcode = '22023';
  end if;
  v_cycle_id := public.deterministic_uuid_from_sha256(
    'twofold.evolution_cycle/v1', p_idempotency_key
  );
  v_policy_sha := encode(extensions.digest(convert_to(p_policy::text, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended('evolution-cycle:' || p_idempotency_key, 0));
  select * into v_cycle from public.evolution_cycle
   where cycle_id = v_cycle_id or idempotency_key = p_idempotency_key limit 1;
  if found then
    if v_cycle.cycle_id is distinct from v_cycle_id
      or v_cycle.window_started_at is distinct from p_window_started_at
      or v_cycle.window_ended_at is distinct from p_window_ended_at
      or v_cycle.policy is distinct from p_policy
      or v_cycle.recorded_by is distinct from p_recorded_by
    then
      raise exception 'evolution cycle identity was reused' using errcode = '23505';
    end if;
    return public.evolution_cycle_result(v_cycle);
  end if;
  insert into public.evolution_cycle (
    cycle_id, idempotency_key, window_started_at, window_ended_at,
    policy, policy_sha256, recorded_by
  ) values (
    v_cycle_id, p_idempotency_key, p_window_started_at, p_window_ended_at,
    p_policy, v_policy_sha, p_recorded_by
  ) returning * into v_cycle;
  return public.evolution_cycle_result(v_cycle);
end;
$$;

create or replace function public.claim_evolution_cycle(
  p_worker_id text, p_lease_seconds integer
)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp set row_security = off as $$
declare
  v_cycle public.evolution_cycle%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
    or p_worker_id is distinct from btrim(p_worker_id)
    or p_lease_seconds < 5 or p_lease_seconds > 3600
  then raise exception 'invalid evolution cycle claim' using errcode = '22023'; end if;
  select * into v_cycle from public.evolution_cycle
   where window_ended_at <= v_now
     and (status = 'REQUESTED' or (status = 'CLAIMED' and lease_expires_at <= v_now))
   order by window_ended_at, recorded_at, cycle_id
   for update skip locked limit 1;
  if not found then return null; end if;
  perform set_config('twofold.evolution_cycle_mutation', 'on', true);
  update public.evolution_cycle set
    status = 'CLAIMED', claimed_by = p_worker_id, lease_token = gen_random_uuid(),
    claimed_at = v_now, lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
    completed_at = null, observations = null, analysis_report = null,
    report_sha256 = null, error_code = null, error_message = null
   where cycle_id = v_cycle.cycle_id returning * into v_cycle;
  perform set_config('twofold.evolution_cycle_mutation', 'off', true);
  return public.evolution_cycle_result(v_cycle);
end;
$$;

create or replace function public.complete_evolution_cycle(
  p_cycle_id uuid,
  p_lease_token uuid,
  p_observations jsonb,
  p_analysis_report jsonb,
  p_report_sha256 text,
  p_worker_id text
)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp set row_security = off as $$
declare
  v_cycle public.evolution_cycle%rowtype;
  v_finding jsonb;
  v_finding_sha text;
begin
  if p_cycle_id is null or p_lease_token is null
    or jsonb_typeof(p_observations) is distinct from 'array'
    or public.jsonb_contains_number(p_observations)
    or jsonb_typeof(p_analysis_report) is distinct from 'object'
    or p_analysis_report->>'schema' is distinct from 'twofold.evolution_analysis/v1'
    or public.jsonb_contains_number(p_analysis_report)
    or p_report_sha256 !~ '^[0-9a-f]{64}$'
    or p_analysis_report->>'reportSha256' is distinct from p_report_sha256
    or jsonb_typeof(p_analysis_report->'findings') is distinct from 'array'
    or p_worker_id is null or btrim(p_worker_id) = ''
    or p_worker_id is distinct from btrim(p_worker_id)
  then raise exception 'invalid evolution cycle completion' using errcode = '22023'; end if;
  select * into v_cycle from public.evolution_cycle
   where cycle_id = p_cycle_id for update;
  if not found then raise exception 'evolution cycle is missing' using errcode = '23503'; end if;
  if v_cycle.status = 'SUCCEEDED' then
    if v_cycle.lease_token is distinct from p_lease_token
      or v_cycle.claimed_by is distinct from p_worker_id
      or v_cycle.observations is distinct from p_observations
      or v_cycle.analysis_report is distinct from p_analysis_report
      or v_cycle.report_sha256 is distinct from p_report_sha256
    then raise exception 'evolution completion identity was reused' using errcode = '23505'; end if;
    return public.evolution_cycle_result(v_cycle);
  end if;
  if v_cycle.status <> 'CLAIMED'
    or v_cycle.lease_token is distinct from p_lease_token
    or v_cycle.claimed_by is distinct from p_worker_id
    or v_cycle.lease_expires_at <= clock_timestamp()
  then raise exception 'evolution cycle lease is not owned' using errcode = '55000'; end if;
  for v_finding in select value from jsonb_array_elements(p_analysis_report->'findings')
  loop
    v_finding_sha := v_finding->>'findingSha256';
    if v_finding->>'schema' is distinct from 'twofold.evolution_finding/v1'
      or v_finding_sha !~ '^[0-9a-f]{64}$'
      or coalesce(v_finding->>'scope', '') not in ('AGENT','PLATFORM','DATA','ACCOUNTING')
      or coalesce(v_finding->>'subject', '') = ''
      or coalesce(v_finding->>'lesson', '') = ''
      or jsonb_typeof(v_finding->'evidenceRefs') is distinct from 'array'
      or jsonb_array_length(v_finding->'evidenceRefs') = 0
    then raise exception 'invalid evolution finding' using errcode = '22023'; end if;
    insert into public.evolution_finding (finding_sha256, cycle_id, finding)
      values (v_finding_sha, p_cycle_id, v_finding)
      on conflict (finding_sha256) do nothing;
    if not exists (
      select 1 from public.evolution_finding
       where finding_sha256 = v_finding_sha and cycle_id = p_cycle_id and finding = v_finding
    ) then raise exception 'evolution finding hash was reused' using errcode = '23505'; end if;
    insert into public.evolution_experience (
      experience_id, cycle_id, finding_sha256, scope, subject, lesson, evidence_refs
    ) values (
      public.deterministic_uuid_from_sha256('twofold.evolution_experience/v1', v_finding_sha),
      p_cycle_id, v_finding_sha, v_finding->>'scope', v_finding->>'subject',
      v_finding->>'lesson', v_finding->'evidenceRefs'
    ) on conflict (finding_sha256) do nothing;
  end loop;
  perform set_config('twofold.evolution_cycle_mutation', 'on', true);
  update public.evolution_cycle set status = 'SUCCEEDED', completed_at = clock_timestamp(),
    observations = p_observations, analysis_report = p_analysis_report,
    report_sha256 = p_report_sha256, lease_expires_at = null
   where cycle_id = p_cycle_id returning * into v_cycle;
  perform set_config('twofold.evolution_cycle_mutation', 'off', true);
  return public.evolution_cycle_result(v_cycle);
end;
$$;

create or replace function public.fail_evolution_cycle(
  p_cycle_id uuid, p_lease_token uuid, p_worker_id text,
  p_error_code text, p_error_message text
)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp set row_security = off as $$
declare v_cycle public.evolution_cycle%rowtype;
begin
  if p_error_code is null or btrim(p_error_code) = ''
    or p_error_message is null or btrim(p_error_message) = ''
  then raise exception 'invalid evolution cycle failure' using errcode = '22023'; end if;
  select * into v_cycle from public.evolution_cycle where cycle_id = p_cycle_id for update;
  if v_cycle.status <> 'CLAIMED' or v_cycle.lease_token is distinct from p_lease_token
    or v_cycle.claimed_by is distinct from p_worker_id
  then raise exception 'evolution cycle lease is not owned' using errcode = '55000'; end if;
  perform set_config('twofold.evolution_cycle_mutation', 'on', true);
  update public.evolution_cycle set status = 'FAILED', completed_at = clock_timestamp(),
    lease_expires_at = null, error_code = p_error_code, error_message = p_error_message
   where cycle_id = p_cycle_id returning * into v_cycle;
  perform set_config('twofold.evolution_cycle_mutation', 'off', true);
  return public.evolution_cycle_result(v_cycle);
end;
$$;

create or replace function public.collect_evolution_metrics(
  p_window_started_at timestamptz, p_window_ended_at timestamptz
)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp set row_security = off as $$
declare v_metrics jsonb;
begin
  if p_window_started_at is null or p_window_ended_at <= p_window_started_at
  then raise exception 'invalid evolution metric window' using errcode = '22023'; end if;
  with observations as (
    select 'platform.tick.failure_rate'::text metric_key, 'PLATFORM'::text scope,
      worker_id subject,
      public.accounting_decimal_text(count(*) filter (where outcome = 'failed')::numeric / count(*)) value,
      'RATIO'::text unit, count(*)::text sample_count,
      jsonb_agg('arena_tick:' || tick_id::text order by finished_at, tick_id) evidence_refs
    from public.arena_tick_observation
    where finished_at > p_window_started_at and finished_at <= p_window_ended_at
    group by worker_id
    union all
    select 'agent.decision.terminal_failure_rate', 'AGENT', entrant.entrant_code,
      public.accounting_decimal_text(count(*) filter (where work.status = 'FAILED')::numeric / count(*)),
      'RATIO', count(*)::text,
      jsonb_agg('arena_work:' || work.work_item_id::text order by work.completed_at, work.work_item_id)
    from public.arena_work_item work
    join public.arena_round_entry entry on entry.round_entry_id = work.round_entry_id
    join public.season_entrant entrant on entrant.entrant_id = entry.entrant_id
    where work.phase = 'RUN_AGENT_DECISION' and work.status in ('SUCCEEDED','FAILED')
      and work.completed_at > p_window_started_at and work.completed_at <= p_window_ended_at
    group by entrant.entrant_code
    union all
    select 'platform.work.retry_rate', 'PLATFORM', 'arena-work-queue',
      public.accounting_decimal_text(count(*) filter (where attempt_count > 1)::numeric / count(*)),
      'RATIO', count(*)::text,
      jsonb_agg('arena_work:' || work_item_id::text order by completed_at, work_item_id)
    from public.arena_work_item
    where status in ('SUCCEEDED','FAILED')
      and completed_at > p_window_started_at and completed_at <= p_window_ended_at
    having count(*) > 0
    union all
    select 'platform.model.usage_unreported_rate', 'PLATFORM', provider || ':' || model,
      public.accounting_decimal_text(count(*) filter (where usage_status = 'provider_unreported')::numeric / count(*)),
      'RATIO', count(*)::text,
      jsonb_agg('model_usage:' || usage_id::text order by completed_at, usage_id)
    from public.model_usage_record
    where completed_at > p_window_started_at and completed_at <= p_window_ended_at
    group by provider, model
    union all
    select 'data.corporate_action.scan_count', 'DATA', 'us-corporate-actions',
      count(*)::text, 'COUNT', count(*)::text,
      jsonb_agg('corporate_action_scan:' || scan_id::text order by observed_at, scan_id)
    from public.corporate_action_scan
    where observed_at > p_window_started_at and observed_at <= p_window_ended_at
    having count(*) > 0
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'metricKey', metric_key, 'scope', scope, 'subject', subject,
    'value', value, 'unit', unit, 'sampleCount', sample_count,
    'evidenceRefs', evidence_refs
  ) order by metric_key, subject), '[]'::jsonb) into v_metrics from observations;
  return v_metrics;
end;
$$;

create or replace function public.evolution_experiment_result(p_value public.evolution_experiment)
returns jsonb language sql stable strict set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'schema', 'twofold.evolution_experiment_state/v1',
    'spec', p_value.spec, 'specSha256', p_value.spec_sha256,
    'status', p_value.status, 'rankingScope', p_value.ranking_scope,
    'proposedAt', to_char(p_value.proposed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'humanApprovedAt', case when p_value.human_approved_at is null then null else to_char(p_value.human_approved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'startedAt', case when p_value.started_at is null then null else to_char(p_value.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'completedAt', case when p_value.completed_at is null then null else to_char(p_value.completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'promotedAt', case when p_value.promoted_at is null then null else to_char(p_value.promoted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'result', p_value.result,
    'updatedAt', to_char(p_value.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
$$;

create or replace function public.propose_evolution_experiment(
  p_spec jsonb, p_spec_sha256 text, p_actor_kind text, p_actor_id text,
  p_proposed_at timestamptz, p_idempotency_key text
)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp set row_security = off as $$
declare
  v_experiment public.evolution_experiment%rowtype;
  v_experiment_id uuid;
  v_mode text;
  v_scope text;
  v_action_id uuid;
begin
  begin v_experiment_id := (p_spec->>'experimentId')::uuid;
  exception when others then raise exception 'invalid evolution experiment spec' using errcode = '22023'; end;
  v_mode := p_spec->>'mode';
  v_scope := p_spec->'onlineShadow'->>'rankingScope';
  if jsonb_typeof(p_spec) is distinct from 'object'
    or p_spec->>'schema' is distinct from 'twofold.evolution_experiment_spec/v1'
    or coalesce(p_spec->>'experimentCode','') !~ '^[a-z0-9][a-z0-9._-]{1,127}$'
    or v_mode not in ('LOCAL_REPLAY','ONLINE_SHADOW')
    or (v_mode = 'LOCAL_REPLAY' and p_spec->'onlineShadow' <> 'null'::jsonb)
    or (v_mode = 'ONLINE_SHADOW' and v_scope is distinct from 'SHADOW')
    or public.jsonb_contains_number(p_spec)
    or p_spec_sha256 !~ '^[0-9a-f]{64}$'
    or p_actor_kind not in ('human','worker','model')
    or p_actor_id is null or btrim(p_actor_id) = ''
    or p_idempotency_key is null or btrim(p_idempotency_key) = ''
  then raise exception 'invalid evolution experiment proposal' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('evolution-experiment:' || v_experiment_id::text, 0));
  select * into v_experiment from public.evolution_experiment where experiment_id = v_experiment_id;
  if found then
    if v_experiment.spec is distinct from p_spec or v_experiment.spec_sha256 is distinct from p_spec_sha256
    then raise exception 'evolution experiment identity was reused' using errcode = '23505'; end if;
    return public.evolution_experiment_result(v_experiment);
  end if;
  insert into public.evolution_experiment (
    experiment_id, experiment_code, mode, spec, spec_sha256, status,
    ranking_scope, proposed_at, updated_at
  ) values (
    v_experiment_id, p_spec->>'experimentCode', v_mode, p_spec, p_spec_sha256,
    'PROPOSED', case when v_mode = 'ONLINE_SHADOW' then 'SHADOW' else null end,
    p_proposed_at, p_proposed_at
  ) returning * into v_experiment;
  v_action_id := public.deterministic_uuid_from_sha256('twofold.evolution_experiment_action/v1', p_idempotency_key);
  insert into public.evolution_experiment_action (
    action_id, experiment_id, idempotency_key, action, from_status, to_status,
    actor_kind, actor_id, action_at, payload
  ) values (
    v_action_id, v_experiment_id, p_idempotency_key, 'PROPOSE', null, 'PROPOSED',
    p_actor_kind, p_actor_id, p_proposed_at, jsonb_build_object('specSha256', p_spec_sha256)
  );
  perform public.append_event(
    v_experiment_id, 'experiment', 0, 'evolution.experiment.proposed',
    'twofold.evolution_experiment_action/v1', p_idempotency_key,
    p_actor_kind, p_actor_id, p_proposed_at,
    jsonb_build_object('action','PROPOSE','status','PROPOSED','specSha256',p_spec_sha256)
  );
  return public.evolution_experiment_result(v_experiment);
end;
$$;

create or replace function public.transition_evolution_experiment(
  p_experiment_id uuid, p_action text, p_actor_kind text, p_actor_id text,
  p_action_at timestamptz, p_idempotency_key text, p_result jsonb default null
)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp set row_security = off as $$
declare
  v_experiment public.evolution_experiment%rowtype;
  v_existing public.evolution_experiment_action%rowtype;
  v_from text;
  v_to text;
  v_seq bigint;
  v_result_sha text;
begin
  if p_action not in ('APPROVE','SCHEDULE','START','COMPLETE','PROMOTE','CANCEL','FAIL')
    or p_actor_kind not in ('human','worker','model')
    or p_actor_id is null or btrim(p_actor_id) = ''
    or p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or (p_result is not null and public.jsonb_contains_number(p_result))
  then raise exception 'invalid evolution experiment transition' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('evolution-experiment:' || p_experiment_id::text, 0));
  select * into v_existing from public.evolution_experiment_action where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.experiment_id is distinct from p_experiment_id
      or v_existing.action is distinct from p_action
      or v_existing.actor_kind is distinct from p_actor_kind
      or v_existing.actor_id is distinct from p_actor_id
      or v_existing.action_at is distinct from p_action_at
      or v_existing.payload is distinct from coalesce(p_result, '{}'::jsonb)
    then raise exception 'evolution action identity was reused' using errcode = '23505'; end if;
    select * into strict v_experiment from public.evolution_experiment where experiment_id = p_experiment_id;
    return public.evolution_experiment_result(v_experiment);
  end if;
  select * into v_experiment from public.evolution_experiment where experiment_id = p_experiment_id for update;
  if not found then raise exception 'evolution experiment is missing' using errcode = '23503'; end if;
  if p_action_at < v_experiment.updated_at or p_action_at >= (v_experiment.spec->>'expiresAt')::timestamptz
  then raise exception 'evolution action is outside its time window' using errcode = '22023'; end if;
  v_from := v_experiment.status;
  if p_action = 'APPROVE' then
    if v_experiment.status <> 'PROPOSED' or p_actor_kind <> 'human'
    then raise exception 'online approval requires a human from PROPOSED' using errcode = '55000'; end if;
    v_to := 'APPROVED';
  elsif p_action = 'SCHEDULE' then
    if v_experiment.status not in ('PROPOSED','APPROVED')
      or (v_experiment.mode = 'ONLINE_SHADOW' and (v_experiment.human_approved_at is null or v_experiment.status <> 'APPROVED'))
    then raise exception 'online scheduling requires human approval' using errcode = '55000'; end if;
    v_to := 'SCHEDULED';
  elsif p_action = 'START' then
    if v_experiment.status <> 'SCHEDULED' then raise exception 'START requires SCHEDULED' using errcode = '55000'; end if;
    v_to := 'RUNNING';
  elsif p_action = 'COMPLETE' then
    if v_experiment.status <> 'RUNNING'
      or jsonb_typeof(p_result) is distinct from 'object'
      or p_result->>'schema' is distinct from 'twofold.evolution_experiment_result/v1'
      or (p_result->>'resultSha256') !~ '^[0-9a-f]{64}$'
    then raise exception 'COMPLETE requires a valid result' using errcode = '55000'; end if;
    v_to := 'COMPLETED'; v_result_sha := p_result->>'resultSha256';
  elsif p_action = 'PROMOTE' then
    if v_experiment.status <> 'COMPLETED' or p_actor_kind <> 'human'
      or v_experiment.result->>'recommendation' is distinct from 'PROMOTE_CANDIDATE'
    then raise exception 'promotion requires human approval and a promote candidate' using errcode = '55000'; end if;
    v_to := 'PROMOTED';
  elsif p_action = 'CANCEL' then
    if p_actor_kind <> 'human' or v_experiment.status in ('PROMOTED','CANCELED','FAILED')
    then raise exception 'cancellation requires a human and an active experiment' using errcode = '55000'; end if;
    v_to := 'CANCELED';
  else
    if v_experiment.status <> 'RUNNING' then raise exception 'FAIL requires RUNNING' using errcode = '55000'; end if;
    v_to := 'FAILED';
  end if;
  perform set_config('twofold.evolution_experiment_mutation', 'on', true);
  update public.evolution_experiment set status = v_to, updated_at = p_action_at,
    human_approved_at = case when p_action = 'APPROVE' then p_action_at else human_approved_at end,
    started_at = case when p_action = 'START' then p_action_at else started_at end,
    completed_at = case when p_action in ('COMPLETE','CANCEL','FAIL') then p_action_at else completed_at end,
    promoted_at = case when p_action = 'PROMOTE' then p_action_at else promoted_at end,
    result = case when p_action = 'COMPLETE' then p_result else result end,
    result_sha256 = case when p_action = 'COMPLETE' then v_result_sha else result_sha256 end
   where experiment_id = p_experiment_id returning * into v_experiment;
  perform set_config('twofold.evolution_experiment_mutation', 'off', true);
  insert into public.evolution_experiment_action (
    action_id, experiment_id, idempotency_key, action, from_status, to_status,
    actor_kind, actor_id, action_at, payload
  ) values (
    public.deterministic_uuid_from_sha256('twofold.evolution_experiment_action/v1', p_idempotency_key),
    p_experiment_id, p_idempotency_key, p_action, v_from, v_to,
    p_actor_kind, p_actor_id, p_action_at, coalesce(p_result, '{}'::jsonb)
  );
  select coalesce(max(stream_seq), 0) into v_seq from public.event_stream where stream_id = p_experiment_id;
  perform public.append_event(
    p_experiment_id, 'experiment', v_seq, 'evolution.experiment.' || lower(p_action),
    'twofold.evolution_experiment_action/v1', p_idempotency_key,
    p_actor_kind, p_actor_id, p_action_at,
    jsonb_build_object('action',p_action,'status',v_to,'result',p_result)
  );
  return public.evolution_experiment_result(v_experiment);
end;
$$;

create or replace function public.register_evolution_trial(
  p_trial_code text, p_experiment_id uuid, p_season_id uuid, p_round_id uuid,
  p_input_evidence jsonb, p_scheduled_at timestamptz, p_expires_at timestamptz,
  p_recorded_by text
)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp set row_security = off as $$
declare v_experiment public.evolution_experiment%rowtype; v_trial public.evolution_trial%rowtype; v_trial_id uuid;
begin
  select * into v_experiment from public.evolution_experiment where experiment_id = p_experiment_id;
  if not found or v_experiment.status <> 'SCHEDULED'
    or (v_experiment.mode = 'ONLINE_SHADOW' and v_experiment.human_approved_at is null)
    or (v_experiment.mode = 'LOCAL_REPLAY' and (p_season_id is not null or p_round_id is not null))
    or (v_experiment.mode = 'ONLINE_SHADOW' and (p_season_id is null or p_round_id is null))
    or jsonb_typeof(p_input_evidence) is distinct from 'object'
    or public.jsonb_contains_number(p_input_evidence)
    or p_expires_at <= p_scheduled_at
  then raise exception 'invalid isolated evolution trial' using errcode = '22023'; end if;
  if p_round_id is not null and not exists (
    select 1 from public.arena_round where round_id = p_round_id and season_id = p_season_id
  ) then raise exception 'shadow trial round is outside its season' using errcode = '23503'; end if;
  v_trial_id := public.deterministic_uuid_from_sha256('twofold.evolution_trial/v1', p_trial_code);
  select * into v_trial from public.evolution_trial where trial_id = v_trial_id or trial_code = p_trial_code limit 1;
  if found then return jsonb_build_object('schema','twofold.evolution_trial/v1','trialId',v_trial.trial_id::text,'rankingScope',v_trial.ranking_scope); end if;
  insert into public.evolution_trial (
    trial_id, experiment_id, trial_code, mode, season_id, round_id, ranking_scope,
    baseline_ref, treatment_ref, input_evidence, scheduled_at, expires_at, recorded_by
  ) values (
    v_trial_id, p_experiment_id, p_trial_code, v_experiment.mode, p_season_id, p_round_id,
    case when v_experiment.mode = 'ONLINE_SHADOW' then 'SHADOW' else 'LOCAL' end,
    v_experiment.spec->>'baselineRef', v_experiment.spec->>'treatmentRef',
    p_input_evidence, p_scheduled_at, p_expires_at, p_recorded_by
  ) returning * into v_trial;
  return jsonb_build_object('schema','twofold.evolution_trial/v1','trialId',v_trial.trial_id::text,'rankingScope',v_trial.ranking_scope);
end;
$$;

create or replace function public.complete_evolution_trial(
  p_trial_id uuid, p_result jsonb, p_completed_at timestamptz, p_recorded_by text
)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp set row_security = off as $$
declare v_trial public.evolution_trial%rowtype; v_existing public.evolution_trial_result%rowtype;
begin
  select * into v_trial from public.evolution_trial where trial_id = p_trial_id;
  if not found or p_completed_at < v_trial.scheduled_at
    or jsonb_typeof(p_result) is distinct from 'object'
    or p_result->>'schema' is distinct from 'twofold.evolution_experiment_result/v1'
    or (p_result->>'resultSha256') !~ '^[0-9a-f]{64}$'
    or public.jsonb_contains_number(p_result)
  then raise exception 'invalid evolution trial result' using errcode = '22023'; end if;
  select * into v_existing from public.evolution_trial_result where trial_id = p_trial_id;
  if found then
    if v_existing.result is distinct from p_result or v_existing.completed_at is distinct from p_completed_at
    then raise exception 'evolution trial result identity was reused' using errcode = '23505'; end if;
  else
    insert into public.evolution_trial_result (
      trial_id, experiment_id, result, result_sha256, completed_at, recorded_by
    ) values (
      p_trial_id, v_trial.experiment_id, p_result, p_result->>'resultSha256', p_completed_at, p_recorded_by
    ) returning * into v_existing;
  end if;
  return jsonb_build_object('schema','twofold.evolution_trial_result/v1','trialId',p_trial_id::text,'result',v_existing.result);
end;
$$;

-- Rolling deploy compatibility: old workers may still report the original
-- seven phases while new workers add the independent evolution phase.
create or replace function public.register_arena_tick_observation(
  p_worker_id text,
  p_started_at timestamptz,
  p_finished_at timestamptz,
  p_outcome text,
  p_capabilities jsonb,
  p_phase_outcomes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_tick_id uuid;
  v_expected_outcome text;
  v_existing public.arena_tick_observation%rowtype;
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
    or p_worker_id is distinct from btrim(p_worker_id)
    or p_started_at is null or p_finished_at is null
    or p_finished_at < p_started_at
    or p_outcome not in ('idle', 'completed', 'failed')
    or jsonb_typeof(p_capabilities) is distinct from 'array'
    or jsonb_array_length(p_capabilities) = 0
    or public.jsonb_contains_number(p_capabilities)
    or jsonb_typeof(p_phase_outcomes) is distinct from 'object'
    or public.jsonb_contains_number(p_phase_outcomes)
    or not (p_phase_outcomes ?& array[
      'agent', 'cycle', 'market', 'corporateActionScan',
      'corporateActionAccount', 'recovery', 'season'
    ]::text[])
    or p_phase_outcomes - array[
      'agent', 'cycle', 'market', 'corporateActionScan',
      'corporateActionAccount', 'recovery', 'season', 'evolution'
    ]::text[] <> '{}'::jsonb
    or exists (
      select 1 from jsonb_array_elements(p_capabilities) capability(value)
       where jsonb_typeof(capability.value) <> 'string'
          or capability.value #>> '{}' = ''
          or capability.value #>> '{}' <> btrim(capability.value #>> '{}')
    )
    or (
      select count(*) <> count(distinct capability.value #>> '{}')
        from jsonb_array_elements(p_capabilities) capability(value)
    )
    or exists (
      select 1 from jsonb_each_text(p_phase_outcomes) phase(key, value)
       where phase.value not in ('idle', 'completed', 'failed')
    )
  then
    raise exception 'invalid Arena tick observation' using errcode = '22023';
  end if;
  v_expected_outcome := case
    when exists (select 1 from jsonb_each_text(p_phase_outcomes) where value = 'failed')
      then 'failed'
    when exists (select 1 from jsonb_each_text(p_phase_outcomes) where value = 'completed')
      then 'completed'
    else 'idle'
  end;
  if p_outcome is distinct from v_expected_outcome then
    raise exception 'Arena tick outcome does not match its phase outcomes'
      using errcode = '22023';
  end if;
  v_tick_id := public.deterministic_uuid_from_sha256(
    'twofold.arena_tick_observation/v1',
    p_worker_id || ':' || to_char(
      p_started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
  perform pg_advisory_xact_lock(hashtextextended('arena-tick:' || v_tick_id::text, 0));
  select * into v_existing from public.arena_tick_observation
   where tick_id = v_tick_id or (worker_id = p_worker_id and started_at = p_started_at)
   limit 1;
  if found then
    if v_existing.tick_id is distinct from v_tick_id
      or v_existing.worker_id is distinct from p_worker_id
      or v_existing.started_at is distinct from p_started_at
      or v_existing.finished_at is distinct from p_finished_at
      or v_existing.outcome is distinct from p_outcome
      or v_existing.capabilities is distinct from p_capabilities
      or v_existing.phase_outcomes is distinct from p_phase_outcomes
    then raise exception 'Arena tick identity was reused with different content'
      using errcode = '23505'; end if;
    return public.arena_tick_observation_result(v_existing);
  end if;
  insert into public.arena_tick_observation (
    tick_id, worker_id, started_at, finished_at, outcome, capabilities, phase_outcomes
  ) values (
    v_tick_id, p_worker_id, p_started_at, p_finished_at, p_outcome,
    p_capabilities, p_phase_outcomes
  ) returning * into v_existing;
  return public.arena_tick_observation_result(v_existing);
end;
$$;

comment on table public.arena_tick_observation is
  'Immutable evidence that one serverless Arena pass completed all bounded phases, including self-evolution when deployed.';

revoke all on table public.evolution_cycle, public.evolution_finding,
  public.evolution_experience, public.evolution_experiment, public.evolution_trial,
  public.evolution_trial_result, public.evolution_experiment_action
  from public, anon, authenticated;
grant select on table public.evolution_cycle, public.evolution_finding,
  public.evolution_experience, public.evolution_experiment, public.evolution_trial,
  public.evolution_trial_result, public.evolution_experiment_action to service_role;

revoke all on function public.request_evolution_cycle(text,timestamptz,timestamptz,jsonb,text),
  public.claim_evolution_cycle(text,integer),
  public.complete_evolution_cycle(uuid,uuid,jsonb,jsonb,text,text),
  public.fail_evolution_cycle(uuid,uuid,text,text,text),
  public.collect_evolution_metrics(timestamptz,timestamptz),
  public.propose_evolution_experiment(jsonb,text,text,text,timestamptz,text),
  public.transition_evolution_experiment(uuid,text,text,text,timestamptz,text,jsonb),
  public.register_evolution_trial(text,uuid,uuid,uuid,jsonb,timestamptz,timestamptz,text),
  public.complete_evolution_trial(uuid,jsonb,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.request_evolution_cycle(text,timestamptz,timestamptz,jsonb,text),
  public.claim_evolution_cycle(text,integer),
  public.complete_evolution_cycle(uuid,uuid,jsonb,jsonb,text,text),
  public.fail_evolution_cycle(uuid,uuid,text,text,text),
  public.collect_evolution_metrics(timestamptz,timestamptz),
  public.propose_evolution_experiment(jsonb,text,text,text,timestamptz,text),
  public.transition_evolution_experiment(uuid,text,text,text,timestamptz,text,jsonb),
  public.register_evolution_trial(text,uuid,uuid,uuid,jsonb,timestamptz,timestamptz,text),
  public.complete_evolution_trial(uuid,jsonb,timestamptz,text)
  to service_role;

commit;
