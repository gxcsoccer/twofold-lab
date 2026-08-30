-- Make decision admission explainable and same-snapshot policy comparisons
-- content-addressed. The service role can no longer use the legacy target
-- acceptance RPC without an immutable ALLOW receipt.

begin;

create table public.decision_admission_evidence (
  submission_id uuid primary key
    references public.accepted_target_submission(submission_id),
  decision_id uuid not null unique
    references public.decision_invocation(decision_id),
  evidence_snapshot_id uuid not null
    references public.market_snapshot(snapshot_id),
  portfolio_decision_sha256 text not null
    check (portfolio_decision_sha256 ~ '^[0-9a-f]{64}$'),
  policy_ref text not null check (policy_ref <> '' and policy_ref = btrim(policy_ref)),
  guard_action text not null check (guard_action = 'ALLOW'),
  evidence_sha256 text not null unique check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_sha256 text not null unique check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_canonical_json text not null check (evidence_canonical_json <> ''),
  evidence jsonb not null,
  recorded_by text not null check (recorded_by <> '' and recorded_by = btrim(recorded_by)),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint decision_admission_evidence_document check (
    jsonb_typeof(evidence) = 'object'
    and evidence->>'schema' = 'twofold.decision_admission_evidence/v1'
    and evidence->>'evidenceSha256' = evidence_sha256
    and evidence->>'evidenceSnapshotId' = evidence_snapshot_id::text
    and evidence->>'guardAction' = guard_action
    and evidence->'decision'->>'decisionSha256' = portfolio_decision_sha256
    and evidence->'policy'->>'policyRef' = policy_ref
    and not public.jsonb_contains_number(evidence)
  ),
  constraint decision_admission_evidence_exact_bytes check (
    evidence = evidence_canonical_json::jsonb
    and artifact_sha256 = encode(
      extensions.digest(convert_to(evidence_canonical_json, 'UTF8'), 'sha256'),
      'hex'
    )
  )
);

comment on table public.decision_admission_evidence is
  'Immutable, packet-bound ALLOW receipt containing freshness, jump, stability, target-delta and cooldown observations for one accepted portfolio decision.';

create trigger decision_admission_evidence_is_immutable
before update or delete on public.decision_admission_evidence
for each row execute function public.reject_immutable_mutation();
create trigger decision_admission_evidence_rejects_truncate
before truncate on public.decision_admission_evidence
for each statement execute function public.reject_immutable_mutation();

create table public.decision_comparison_artifact (
  comparison_sha256 text primary key check (comparison_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_sha256 text not null unique check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_snapshot_id uuid not null references public.market_snapshot(snapshot_id),
  official_decision_sha256 text not null check (official_decision_sha256 ~ '^[0-9a-f]{64}$'),
  candidate_decision_sha256 text not null check (candidate_decision_sha256 ~ '^[0-9a-f]{64}$'),
  experiment_id uuid references public.evolution_experiment(experiment_id),
  trial_id uuid references public.evolution_trial(trial_id),
  comparison_canonical_json text not null check (comparison_canonical_json <> ''),
  comparison jsonb not null,
  recorded_by text not null check (recorded_by <> '' and recorded_by = btrim(recorded_by)),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint decision_comparison_artifact_document check (
    jsonb_typeof(comparison) = 'object'
    and comparison->>'schema' = 'twofold.portfolio_decision_comparison/v1'
    and comparison->>'comparisonSha256' = comparison_sha256
    and comparison->>'evidenceSnapshotId' = evidence_snapshot_id::text
    and comparison->'official'->>'decisionSha256' = official_decision_sha256
    and comparison->'candidate'->>'decisionSha256' = candidate_decision_sha256
    and comparison->'official'->>'evidenceSnapshotId' = evidence_snapshot_id::text
    and comparison->'candidate'->>'evidenceSnapshotId' = evidence_snapshot_id::text
    and not public.jsonb_contains_number(comparison)
  ),
  constraint decision_comparison_artifact_exact_bytes check (
    comparison = comparison_canonical_json::jsonb
    and artifact_sha256 = encode(
      extensions.digest(convert_to(comparison_canonical_json, 'UTF8'), 'sha256'),
      'hex'
    )
  ),
  constraint decision_comparison_trial_scope check (
    trial_id is null or experiment_id is not null
  )
);

comment on table public.decision_comparison_artifact is
  'Content-addressed official-versus-candidate portfolio diff; both decisions must bind the same immutable evidence snapshot.';

create index decision_comparison_experiment_idx
  on public.decision_comparison_artifact (
    experiment_id, trial_id, recorded_at, comparison_sha256
  ) where experiment_id is not null;

create trigger decision_comparison_artifact_is_immutable
before update or delete on public.decision_comparison_artifact
for each row execute function public.reject_immutable_mutation();
create trigger decision_comparison_artifact_rejects_truncate
before truncate on public.decision_comparison_artifact
for each statement execute function public.reject_immutable_mutation();

create or replace function public.accept_portfolio_targets_with_evidence(
  p_idempotency_key text,
  p_submission_id uuid,
  p_root_harness_session_id text,
  p_packet_artifact_id uuid,
  p_packet_sha256 text,
  p_targets jsonb,
  p_cash_weight_bps text,
  p_decision_summary text,
  p_accepted_at timestamptz,
  p_admission_evidence jsonb,
  p_admission_evidence_canonical_json text,
  p_admission_evidence_sha256 text,
  p_admission_artifact_sha256 text,
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
  v_snapshot public.market_snapshot%rowtype;
  v_submission public.accepted_target_submission%rowtype;
  v_existing public.decision_admission_evidence%rowtype;
  v_decision_targets jsonb;
  v_policy jsonb;
  v_metrics jsonb;
begin
  if jsonb_typeof(p_admission_evidence) is distinct from 'object'
    or p_admission_evidence->>'schema' is distinct from 'twofold.decision_admission_evidence/v1'
    or p_admission_evidence->>'guardAction' is distinct from 'ALLOW'
    or p_admission_evidence->>'evidenceSha256' is distinct from p_admission_evidence_sha256
    or p_admission_evidence_sha256 !~ '^[0-9a-f]{64}$'
    or p_admission_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_admission_evidence_canonical_json is null
    or p_admission_evidence_canonical_json = ''
    or public.jsonb_contains_number(p_admission_evidence)
  then
    raise exception 'invalid decision admission evidence' using errcode = '22023';
  end if;
  begin
    if p_admission_evidence_canonical_json::jsonb is distinct from p_admission_evidence
      or encode(
        extensions.digest(
          convert_to(p_admission_evidence_canonical_json, 'UTF8'),
          'sha256'
        ),
        'hex'
      ) is distinct from p_admission_artifact_sha256
    then
      raise exception 'decision admission canonical bytes or SHA-256 differ'
        using errcode = '22023';
    end if;
  exception when invalid_text_representation then
    raise exception 'decision admission canonical bytes are not JSON'
      using errcode = '22023';
  end;

  if p_admission_evidence - array[
      'schema','decision','evidenceSnapshotId','observedAt','dataCutoffAt',
      'evidenceSealedAt','policy','metrics','guardAction','reasons',
      'evidenceSha256'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(p_admission_evidence->'decision') is distinct from 'object'
    or (p_admission_evidence->'decision') - array[
      'schema','decisionRef','policyRef','evidenceSnapshotId','targets',
      'cashWeightBps','decisionSha256'
    ]::text[] <> '{}'::jsonb
    or p_admission_evidence->'decision'->>'schema'
      is distinct from 'twofold.portfolio_decision_evidence/v1'
    or jsonb_typeof(p_admission_evidence->'policy') is distinct from 'object'
    or (p_admission_evidence->'policy') - array[
      'policyRef','maxInputAgeMs','maxMarketJumpBps','minimumStableWindowMs',
      'maxTargetDeltaBps','maxCooldownRemainingMs'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(p_admission_evidence->'metrics') is distinct from 'object'
    or (p_admission_evidence->'metrics') - array[
      'inputAgeMs','marketJumpBps','stableWindowMs','maxTargetDeltaBps',
      'cooldownRemainingMs'
    ]::text[] <> '{}'::jsonb
    or p_admission_evidence->'reasons' is distinct from '["ALL_GUARDS_PASSED"]'::jsonb
  then
    raise exception 'decision admission evidence has an unexpected shape'
      using errcode = '22023';
  end if;

  v_policy := p_admission_evidence->'policy';
  v_metrics := p_admission_evidence->'metrics';
  if coalesce(v_policy->>'policyRef','') = ''
    or v_policy->>'maxInputAgeMs' !~ '^(0|[1-9][0-9]*)$'
    or v_policy->>'maxMarketJumpBps' !~ '^(0|[1-9][0-9]*)$'
    or v_policy->>'minimumStableWindowMs' !~ '^(0|[1-9][0-9]*)$'
    or v_policy->>'maxTargetDeltaBps' !~ '^(0|[1-9][0-9]{0,3}|10000)$'
    or v_policy->>'maxCooldownRemainingMs' !~ '^(0|[1-9][0-9]*)$'
    or v_metrics->>'inputAgeMs' !~ '^(0|[1-9][0-9]*)$'
    or v_metrics->>'marketJumpBps' !~ '^(0|[1-9][0-9]*)$'
    or v_metrics->>'stableWindowMs' !~ '^(0|[1-9][0-9]*)$'
    or v_metrics->>'maxTargetDeltaBps' !~ '^(0|[1-9][0-9]{0,3}|10000)$'
    or v_metrics->>'cooldownRemainingMs' !~ '^(0|[1-9][0-9]*)$'
    or (v_metrics->>'inputAgeMs')::numeric > (v_policy->>'maxInputAgeMs')::numeric
    or (v_metrics->>'marketJumpBps')::numeric > (v_policy->>'maxMarketJumpBps')::numeric
    or (v_metrics->>'stableWindowMs')::numeric < (v_policy->>'minimumStableWindowMs')::numeric
    or (v_metrics->>'maxTargetDeltaBps')::numeric > (v_policy->>'maxTargetDeltaBps')::numeric
    or (v_metrics->>'cooldownRemainingMs')::numeric > (v_policy->>'maxCooldownRemainingMs')::numeric
  then
    raise exception 'decision admission ALLOW contradicts its observations or policy'
      using errcode = '22023';
  end if;

  select * into v_invocation from public.decision_invocation
   where root_harness_session_id = p_root_harness_session_id;
  if not found then
    raise exception 'decision admission has no bound invocation' using errcode = 'P0002';
  end if;
  select * into strict v_snapshot from public.market_snapshot
   where snapshot_id = v_invocation.market_snapshot_id;
  if p_admission_evidence->>'evidenceSnapshotId'
      is distinct from v_invocation.market_snapshot_id::text
    or p_admission_evidence->'decision'->>'evidenceSnapshotId'
      is distinct from v_invocation.market_snapshot_id::text
    or p_admission_evidence->'decision'->>'decisionRef'
      is distinct from v_invocation.decision_id::text
    or p_admission_evidence->>'observedAt'
      is distinct from to_char(p_accepted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    or p_admission_evidence->>'dataCutoffAt'
      is distinct from to_char(v_invocation.data_cutoff_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    or p_admission_evidence->>'evidenceSealedAt'
      is distinct from to_char(v_snapshot.sealed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  then
    raise exception 'decision admission crossed its invocation or snapshot fence'
      using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'symbol', item->>'symbol',
    'targetWeightBps', item->>'target_weight_bps'
  ) order by (item->>'symbol') collate "C"), '[]'::jsonb)
    into v_decision_targets
    from jsonb_array_elements(p_targets) as target(item);
  if p_admission_evidence->'decision'->'targets' is distinct from v_decision_targets
    or p_admission_evidence->'decision'->>'cashWeightBps'
      is distinct from p_cash_weight_bps
  then
    raise exception 'decision admission does not describe the submitted portfolio'
      using errcode = '22023';
  end if;

  v_submission := public.accept_portfolio_targets(
    p_idempotency_key, p_submission_id, p_root_harness_session_id,
    p_packet_artifact_id, p_packet_sha256, p_targets, p_cash_weight_bps,
    p_decision_summary, p_accepted_at, p_expected_run_stream_seq, p_recorded_by
  );

  select * into v_existing from public.decision_admission_evidence
   where submission_id = v_submission.submission_id;
  if found then
    if v_existing.decision_id is distinct from v_submission.decision_id
      or v_existing.evidence_snapshot_id is distinct from v_invocation.market_snapshot_id
      or v_existing.evidence_sha256 is distinct from p_admission_evidence_sha256
      or v_existing.artifact_sha256 is distinct from p_admission_artifact_sha256
      or v_existing.evidence_canonical_json is distinct from p_admission_evidence_canonical_json
      or v_existing.evidence is distinct from p_admission_evidence
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'decision admission evidence identity was reused'
        using errcode = '23505';
    end if;
    return v_submission;
  end if;

  insert into public.decision_admission_evidence (
    submission_id, decision_id, evidence_snapshot_id,
    portfolio_decision_sha256, policy_ref, guard_action,
    evidence_sha256, artifact_sha256, evidence_canonical_json, evidence,
    recorded_by
  ) values (
    v_submission.submission_id, v_submission.decision_id,
    v_invocation.market_snapshot_id,
    p_admission_evidence->'decision'->>'decisionSha256',
    v_policy->>'policyRef', 'ALLOW', p_admission_evidence_sha256,
    p_admission_artifact_sha256, p_admission_evidence_canonical_json,
    p_admission_evidence, p_recorded_by
  );
  return v_submission;
end;
$$;

create or replace function public.register_decision_comparison_artifact(
  p_comparison_sha256 text,
  p_artifact_sha256 text,
  p_evidence_snapshot_id uuid,
  p_official_decision_sha256 text,
  p_candidate_decision_sha256 text,
  p_experiment_id uuid,
  p_trial_id uuid,
  p_comparison jsonb,
  p_comparison_canonical_json text,
  p_recorded_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_existing public.decision_comparison_artifact%rowtype;
  v_trial public.evolution_trial%rowtype;
begin
  if p_comparison_sha256 !~ '^[0-9a-f]{64}$'
    or p_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_official_decision_sha256 !~ '^[0-9a-f]{64}$'
    or p_candidate_decision_sha256 !~ '^[0-9a-f]{64}$'
    or p_evidence_snapshot_id is null
    or coalesce(btrim(p_recorded_by),'') = ''
    or jsonb_typeof(p_comparison) is distinct from 'object'
    or p_comparison->>'schema' is distinct from 'twofold.portfolio_decision_comparison/v1'
    or p_comparison->>'comparisonSha256' is distinct from p_comparison_sha256
    or public.jsonb_contains_number(p_comparison)
  then
    raise exception 'invalid decision comparison artifact' using errcode = '22023';
  end if;
  begin
    if p_comparison_canonical_json::jsonb is distinct from p_comparison
      or encode(
        extensions.digest(convert_to(p_comparison_canonical_json, 'UTF8'), 'sha256'),
        'hex'
      ) is distinct from p_artifact_sha256
    then
      raise exception 'decision comparison canonical bytes or SHA-256 differ'
        using errcode = '22023';
    end if;
  exception when invalid_text_representation then
    raise exception 'decision comparison canonical bytes are not JSON'
      using errcode = '22023';
  end;
  if p_comparison - array[
      'schema','evidenceSnapshotId','official','candidate','deltas',
      'cashDeltaBps','maxAbsoluteDeltaBps','turnoverBps','identical',
      'comparisonSha256'
    ]::text[] <> '{}'::jsonb
    or p_comparison->>'evidenceSnapshotId' is distinct from p_evidence_snapshot_id::text
    or p_comparison->'official'->>'evidenceSnapshotId' is distinct from p_evidence_snapshot_id::text
    or p_comparison->'candidate'->>'evidenceSnapshotId' is distinct from p_evidence_snapshot_id::text
    or p_comparison->'official'->>'decisionSha256' is distinct from p_official_decision_sha256
    or p_comparison->'candidate'->>'decisionSha256' is distinct from p_candidate_decision_sha256
    or jsonb_typeof(p_comparison->'deltas') is distinct from 'array'
    or p_comparison->>'cashDeltaBps' !~ '^-?(0|[1-9][0-9]{0,4})$'
    or p_comparison->>'maxAbsoluteDeltaBps' !~ '^(0|[1-9][0-9]{0,3}|10000)$'
    or p_comparison->>'turnoverBps' !~ '^(0|[1-9][0-9]{0,3}|10000)$'
    or jsonb_typeof(p_comparison->'identical') is distinct from 'boolean'
  then
    raise exception 'decision comparison crossed its same-snapshot identity'
      using errcode = '22023';
  end if;
  if p_trial_id is not null then
    if p_experiment_id is null then
      raise exception 'decision comparison trial requires an experiment'
        using errcode = '22023';
    end if;
    select * into v_trial from public.evolution_trial where trial_id = p_trial_id;
    if not found or v_trial.experiment_id is distinct from p_experiment_id then
      raise exception 'decision comparison trial is outside its experiment'
        using errcode = '23503';
    end if;
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('decision-comparison:' || p_comparison_sha256, 0)
  );
  select * into v_existing from public.decision_comparison_artifact
   where comparison_sha256 = p_comparison_sha256
      or artifact_sha256 = p_artifact_sha256
   limit 1;
  if found then
    if v_existing.comparison_sha256 is distinct from p_comparison_sha256
      or v_existing.artifact_sha256 is distinct from p_artifact_sha256
      or v_existing.evidence_snapshot_id is distinct from p_evidence_snapshot_id
      or v_existing.official_decision_sha256 is distinct from p_official_decision_sha256
      or v_existing.candidate_decision_sha256 is distinct from p_candidate_decision_sha256
      or v_existing.experiment_id is distinct from p_experiment_id
      or v_existing.trial_id is distinct from p_trial_id
      or v_existing.comparison_canonical_json is distinct from p_comparison_canonical_json
      or v_existing.comparison is distinct from p_comparison
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'decision comparison identity was reused'
        using errcode = '23505';
    end if;
  else
    insert into public.decision_comparison_artifact (
      comparison_sha256, artifact_sha256, evidence_snapshot_id,
      official_decision_sha256, candidate_decision_sha256,
      experiment_id, trial_id, comparison_canonical_json, comparison, recorded_by
    ) values (
      p_comparison_sha256, p_artifact_sha256, p_evidence_snapshot_id,
      p_official_decision_sha256, p_candidate_decision_sha256,
      p_experiment_id, p_trial_id, p_comparison_canonical_json,
      p_comparison, p_recorded_by
    ) returning * into v_existing;
  end if;
  return jsonb_build_object(
    'comparisonSha256', v_existing.comparison_sha256,
    'artifactSha256', v_existing.artifact_sha256,
    'evidenceSnapshotId', v_existing.evidence_snapshot_id::text
  );
end;
$$;

alter table public.decision_admission_evidence enable row level security;
alter table public.decision_comparison_artifact enable row level security;

revoke all on table public.decision_admission_evidence
  from public, anon, authenticated;
revoke all on table public.decision_comparison_artifact
  from public, anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.decision_admission_evidence from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.decision_comparison_artifact from service_role;
grant select on table public.decision_admission_evidence to service_role;
grant select on table public.decision_comparison_artifact to service_role;

-- The old function remains callable by the database owner for migration and
-- historical contract fixtures, but not by production service credentials.
revoke execute on function public.accept_portfolio_targets(
  text, uuid, text, uuid, text, jsonb, text, text, timestamptz, bigint, text
) from service_role;
revoke all on function public.accept_portfolio_targets_with_evidence(
  text, uuid, text, uuid, text, jsonb, text, text, timestamptz,
  jsonb, text, text, text, bigint, text
) from public, anon, authenticated;
revoke all on function public.register_decision_comparison_artifact(
  text, text, uuid, text, text, uuid, uuid, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.accept_portfolio_targets_with_evidence(
  text, uuid, text, uuid, text, jsonb, text, text, timestamptz,
  jsonb, text, text, text, bigint, text
) to service_role;
grant execute on function public.register_decision_comparison_artifact(
  text, text, uuid, text, text, uuid, uuid, jsonb, text, text
) to service_role;

commit;
