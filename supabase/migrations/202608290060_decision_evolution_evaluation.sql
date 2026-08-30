-- Bind same-snapshot portfolio decision diffs to deterministic replay outcomes
-- and an evolution recommendation. This is evidence for a human promotion
-- decision; it never mutates an official entrant, account, Round, or ranking.

begin;

create table public.decision_evolution_evaluation (
  evaluation_sha256 text primary key check (evaluation_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_sha256 text not null unique check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  comparison_sha256 text not null unique
    references public.decision_comparison_artifact(comparison_sha256),
  experiment_id uuid not null references public.evolution_experiment(experiment_id),
  trial_id uuid not null unique references public.evolution_trial(trial_id),
  evidence_snapshot_id uuid not null references public.market_snapshot(snapshot_id),
  official_outcome_sha256 text not null unique
    check (official_outcome_sha256 ~ '^[0-9a-f]{64}$'),
  candidate_outcome_sha256 text not null unique
    check (candidate_outcome_sha256 ~ '^[0-9a-f]{64}$'),
  result_sha256 text not null unique check (result_sha256 ~ '^[0-9a-f]{64}$'),
  evaluation_canonical_json text not null check (evaluation_canonical_json <> ''),
  evaluation jsonb not null,
  recorded_by text not null check (recorded_by <> '' and recorded_by = btrim(recorded_by)),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint decision_evolution_evaluation_document check (
    jsonb_typeof(evaluation) = 'object'
    and evaluation->>'schema' = 'twofold.portfolio_decision_evolution_evaluation/v1'
    and evaluation->>'evaluationSha256' = evaluation_sha256
    and evaluation->>'comparisonSha256' = comparison_sha256
    and evaluation->>'experimentId' = experiment_id::text
    and evaluation->>'evidenceSnapshotId' = evidence_snapshot_id::text
    and evaluation->'officialOutcome'->>'outcomeSha256' = official_outcome_sha256
    and evaluation->'candidateOutcome'->>'outcomeSha256' = candidate_outcome_sha256
    and evaluation->'result'->>'resultSha256' = result_sha256
    and not public.jsonb_contains_number(evaluation)
  ),
  constraint decision_evolution_evaluation_exact_bytes check (
    evaluation = evaluation_canonical_json::jsonb
    and artifact_sha256 = encode(
      extensions.digest(convert_to(evaluation_canonical_json, 'UTF8'), 'sha256'),
      'hex'
    )
  )
);

comment on table public.decision_evolution_evaluation is
  'Immutable same-snapshot official/candidate replay evaluation covering constraints, turnover, simulated slippage/fees/tax, terminal NAV, drawdown, and terminal failures. A PROMOTE_CANDIDATE value is recommendation evidence only.';

create trigger decision_evolution_evaluation_is_immutable
before update or delete on public.decision_evolution_evaluation
for each row execute function public.reject_immutable_mutation();
create trigger decision_evolution_evaluation_rejects_truncate
before truncate on public.decision_evolution_evaluation
for each statement execute function public.reject_immutable_mutation();

create or replace function public.register_decision_evolution_evaluation(
  p_evaluation_sha256 text,
  p_artifact_sha256 text,
  p_comparison_sha256 text,
  p_experiment_id uuid,
  p_trial_id uuid,
  p_evidence_snapshot_id uuid,
  p_official_outcome_sha256 text,
  p_candidate_outcome_sha256 text,
  p_result_sha256 text,
  p_evaluation jsonb,
  p_evaluation_canonical_json text,
  p_recorded_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_existing public.decision_evolution_evaluation%rowtype;
  v_comparison public.decision_comparison_artifact%rowtype;
  v_experiment public.evolution_experiment%rowtype;
  v_trial public.evolution_trial%rowtype;
  v_official jsonb;
  v_candidate jsonb;
  v_official_metrics jsonb;
  v_candidate_metrics jsonb;
  v_result jsonb;
  v_expected_recommendation text;
begin
  if p_evaluation_sha256 !~ '^[0-9a-f]{64}$'
    or p_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_comparison_sha256 !~ '^[0-9a-f]{64}$'
    or p_official_outcome_sha256 !~ '^[0-9a-f]{64}$'
    or p_candidate_outcome_sha256 !~ '^[0-9a-f]{64}$'
    or p_result_sha256 !~ '^[0-9a-f]{64}$'
    or p_experiment_id is null or p_trial_id is null or p_evidence_snapshot_id is null
    or coalesce(btrim(p_recorded_by), '') = ''
    or jsonb_typeof(p_evaluation) is distinct from 'object'
    or p_evaluation->>'schema'
      is distinct from 'twofold.portfolio_decision_evolution_evaluation/v1'
    or p_evaluation->>'evaluationSha256' is distinct from p_evaluation_sha256
    or public.jsonb_contains_number(p_evaluation)
  then
    raise exception 'invalid decision evolution evaluation' using errcode = '22023';
  end if;
  begin
    if p_evaluation_canonical_json::jsonb is distinct from p_evaluation
      or encode(
        extensions.digest(convert_to(p_evaluation_canonical_json, 'UTF8'), 'sha256'),
        'hex'
      ) is distinct from p_artifact_sha256
    then
      raise exception 'decision evolution canonical bytes or SHA-256 differ'
        using errcode = '22023';
    end if;
  exception when invalid_text_representation then
    raise exception 'decision evolution canonical bytes are not JSON'
      using errcode = '22023';
  end;

  if p_evaluation - array[
      'schema','experimentId','evidenceSnapshotId','comparisonSha256',
      'decisionDeltaTurnoverBps','officialOutcome','candidateOutcome','result',
      'evaluationSha256'
    ]::text[] <> '{}'::jsonb
    or p_evaluation->>'experimentId' is distinct from p_experiment_id::text
    or p_evaluation->>'evidenceSnapshotId' is distinct from p_evidence_snapshot_id::text
    or p_evaluation->>'comparisonSha256' is distinct from p_comparison_sha256
    or p_evaluation->>'decisionDeltaTurnoverBps' !~ '^(0|[1-9][0-9]{0,3}|10000)$'
    or jsonb_typeof(p_evaluation->'officialOutcome') is distinct from 'object'
    or jsonb_typeof(p_evaluation->'candidateOutcome') is distinct from 'object'
    or jsonb_typeof(p_evaluation->'result') is distinct from 'object'
  then
    raise exception 'decision evolution evaluation has an unexpected shape'
      using errcode = '22023';
  end if;

  v_official := p_evaluation->'officialOutcome';
  v_candidate := p_evaluation->'candidateOutcome';
  v_official_metrics := v_official->'metrics';
  v_candidate_metrics := v_candidate->'metrics';
  v_result := p_evaluation->'result';
  if v_official - array[
      'schema','evidenceSnapshotId','decisionSha256','replayPolicyRef','replayInputSha256',
      'navCurrency','metrics','outcomeSha256'
    ]::text[] <> '{}'::jsonb
    or v_candidate - array[
      'schema','evidenceSnapshotId','decisionSha256','replayPolicyRef','replayInputSha256',
      'navCurrency','metrics','outcomeSha256'
    ]::text[] <> '{}'::jsonb
    or v_official->>'schema' is distinct from 'twofold.portfolio_replay_outcome/v1'
    or v_candidate->>'schema' is distinct from 'twofold.portfolio_replay_outcome/v1'
    or v_official->>'outcomeSha256' is distinct from p_official_outcome_sha256
    or v_candidate->>'outcomeSha256' is distinct from p_candidate_outcome_sha256
    or v_official->>'evidenceSnapshotId' is distinct from p_evidence_snapshot_id::text
    or v_candidate->>'evidenceSnapshotId' is distinct from p_evidence_snapshot_id::text
    or v_official->>'replayPolicyRef' is distinct from v_candidate->>'replayPolicyRef'
    or coalesce(v_official->>'replayPolicyRef','') = ''
    or v_official->>'replayInputSha256'
      is distinct from v_candidate->>'replayInputSha256'
    or v_official->>'replayInputSha256' !~ '^[0-9a-f]{64}$'
    or v_official->>'navCurrency' is distinct from v_candidate->>'navCurrency'
    or v_official->>'navCurrency' !~ '^[A-Z]{3}$'
    or v_official->>'decisionSha256' !~ '^[0-9a-f]{64}$'
    or v_candidate->>'decisionSha256' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(v_official_metrics) is distinct from 'object'
    or jsonb_typeof(v_candidate_metrics) is distinct from 'object'
    or v_official_metrics - array[
      'constraintViolationCount','turnoverBps','simulatedSlippageNavCost',
      'simulatedFeeNavCost','simulatedTaxNavCost','terminalNav',
      'maxDrawdownBps','terminalFailureCount'
    ]::text[] <> '{}'::jsonb
    or v_candidate_metrics - array[
      'constraintViolationCount','turnoverBps','simulatedSlippageNavCost',
      'simulatedFeeNavCost','simulatedTaxNavCost','terminalNav',
      'maxDrawdownBps','terminalFailureCount'
    ]::text[] <> '{}'::jsonb
  then
    raise exception 'decision evolution replay outcomes are invalid'
      using errcode = '22023';
  end if;
  if exists (
    select 1
      from (
        select * from jsonb_each_text(v_official_metrics)
        union all
        select * from jsonb_each_text(v_candidate_metrics)
      ) metric(key, value)
     where (metric.key in ('constraintViolationCount','terminalFailureCount')
              and metric.value !~ '^(0|[1-9][0-9]*)$')
        or (metric.key not in ('constraintViolationCount','terminalFailureCount')
              and metric.value !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$')
  ) then
    raise exception 'decision evolution replay metrics are not canonical non-negative decimals'
      using errcode = '22023';
  end if;

  select * into v_comparison from public.decision_comparison_artifact
   where comparison_sha256 = p_comparison_sha256;
  select * into v_experiment from public.evolution_experiment
   where experiment_id = p_experiment_id;
  select * into v_trial from public.evolution_trial where trial_id = p_trial_id;
  if v_comparison.comparison_sha256 is null
    or v_experiment.experiment_id is null
    or v_trial.trial_id is null
    or v_comparison.experiment_id is distinct from p_experiment_id
    or v_comparison.trial_id is distinct from p_trial_id
    or v_comparison.evidence_snapshot_id is distinct from p_evidence_snapshot_id
    or v_comparison.official_decision_sha256
      is distinct from v_official->>'decisionSha256'
    or v_comparison.candidate_decision_sha256
      is distinct from v_candidate->>'decisionSha256'
    or v_comparison.comparison->>'turnoverBps'
      is distinct from p_evaluation->>'decisionDeltaTurnoverBps'
    or v_trial.experiment_id is distinct from p_experiment_id
    or v_experiment.status is distinct from 'RUNNING'
    or v_experiment.mode is distinct from 'LOCAL_REPLAY'
    or v_trial.mode is distinct from 'LOCAL_REPLAY'
    or v_trial.ranking_scope is distinct from 'LOCAL'
  then
    raise exception 'decision evolution crossed its comparison, trial, or snapshot fence'
      using errcode = '23503';
  end if;

  if v_experiment.spec->'primaryMetric'->>'metricKey'
      is distinct from 'portfolio.terminal_nav'
    or v_experiment.spec->'primaryMetric'->>'direction'
      is distinct from 'HIGHER_IS_BETTER'
    or jsonb_array_length(v_experiment.spec->'guardrails') <> 7
    or not (
      select count(distinct guardrail->>'metricKey') = 7
        from jsonb_array_elements(v_experiment.spec->'guardrails') guardrail
       where guardrail->>'metricKey' in (
         'portfolio.constraint_violation_count','portfolio.turnover_bps',
         'portfolio.simulated_slippage_nav_cost','portfolio.simulated_fee_nav_cost',
         'portfolio.simulated_tax_nav_cost','portfolio.max_drawdown_bps',
         'portfolio.terminal_failure_count'
       )
         and guardrail->>'direction' = 'LOWER_IS_BETTER'
    )
    or exists (
      select 1 from jsonb_array_elements(v_experiment.spec->'guardrails') guardrail
       where guardrail->>'metricKey' in (
         'portfolio.constraint_violation_count','portfolio.terminal_failure_count'
       ) and guardrail->>'candidateMaximum' is distinct from '0'
    )
  then
    raise exception 'decision evolution experiment was not preregistered with every P1 metric'
      using errcode = '22023';
  end if;

  if v_result->>'schema' is distinct from 'twofold.evolution_experiment_result/v1'
    or v_result->>'resultSha256' is distinct from p_result_sha256
    or v_result->>'recommendation' not in ('PROMOTE_CANDIDATE','REJECT','INCONCLUSIVE')
    or v_result->>'baselineValue' is distinct from v_official_metrics->>'terminalNav'
    or v_result->>'treatmentValue' is distinct from v_candidate_metrics->>'terminalNav'
    or (v_result->>'primaryImprovement')::numeric
      is distinct from (
        (v_candidate_metrics->>'terminalNav')::numeric
        - (v_official_metrics->>'terminalNav')::numeric
      )
    or v_result->>'minimumAbsoluteImprovement'
      is distinct from v_experiment.spec->'primaryMetric'->>'minimumAbsoluteImprovement'
    or jsonb_typeof(v_result->'guardrails') is distinct from 'array'
    or jsonb_array_length(v_result->'guardrails') <> 7
  then
    raise exception 'decision evolution result is not bound to replay NAV'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from (values
        ('portfolio.constraint_violation_count','constraintViolationCount'),
        ('portfolio.turnover_bps','turnoverBps'),
        ('portfolio.simulated_slippage_nav_cost','simulatedSlippageNavCost'),
        ('portfolio.simulated_fee_nav_cost','simulatedFeeNavCost'),
        ('portfolio.simulated_tax_nav_cost','simulatedTaxNavCost'),
        ('portfolio.max_drawdown_bps','maxDrawdownBps'),
        ('portfolio.terminal_failure_count','terminalFailureCount')
      ) as required(metric_key, outcome_key)
     where not exists (
       select 1
         from jsonb_array_elements(v_result->'guardrails') result_guardrail
         join lateral (
           select spec_guardrail
             from jsonb_array_elements(v_experiment.spec->'guardrails') spec_guardrail
            where spec_guardrail->>'metricKey' = required.metric_key
         ) preregistered on true
        where result_guardrail->>'metricKey' = required.metric_key
          and result_guardrail->>'baselineValue'
            = v_official_metrics->>required.outcome_key
          and result_guardrail->>'treatmentValue'
            = v_candidate_metrics->>required.outcome_key
          and result_guardrail->>'maximumRegression'
            = preregistered.spec_guardrail->>'maximumRegression'
          and (result_guardrail->>'regression')::numeric = greatest(
            (v_candidate_metrics->>required.outcome_key)::numeric
              - (v_official_metrics->>required.outcome_key)::numeric,
            0
          )
          and (result_guardrail->>'passed')::boolean = (
            (result_guardrail->>'regression')::numeric
              <= (preregistered.spec_guardrail->>'maximumRegression')::numeric
            and (
              not (preregistered.spec_guardrail ? 'candidateMaximum')
              or (v_candidate_metrics->>required.outcome_key)::numeric
                <= (preregistered.spec_guardrail->>'candidateMaximum')::numeric
            )
          )
     )
  ) then
    raise exception 'decision evolution guardrails are not bound to replay metrics'
      using errcode = '22023';
  end if;

  v_expected_recommendation := case
    when exists (
      select 1 from jsonb_array_elements(v_result->'guardrails') guardrail
       where (guardrail->>'passed')::boolean is not true
    ) then 'REJECT'
    when (v_result->>'primaryImprovement')::numeric
      >= (v_result->>'minimumAbsoluteImprovement')::numeric
    then 'PROMOTE_CANDIDATE'
    else 'INCONCLUSIVE'
  end;
  if v_result->>'recommendation' is distinct from v_expected_recommendation then
    raise exception 'decision evolution recommendation contradicts its metrics'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('decision-evolution:' || p_evaluation_sha256, 0)
  );
  select * into v_existing from public.decision_evolution_evaluation
   where evaluation_sha256 = p_evaluation_sha256
      or artifact_sha256 = p_artifact_sha256
      or comparison_sha256 = p_comparison_sha256
      or trial_id = p_trial_id
   limit 1;
  if found then
    if v_existing.evaluation_sha256 is distinct from p_evaluation_sha256
      or v_existing.artifact_sha256 is distinct from p_artifact_sha256
      or v_existing.comparison_sha256 is distinct from p_comparison_sha256
      or v_existing.experiment_id is distinct from p_experiment_id
      or v_existing.trial_id is distinct from p_trial_id
      or v_existing.evidence_snapshot_id is distinct from p_evidence_snapshot_id
      or v_existing.official_outcome_sha256 is distinct from p_official_outcome_sha256
      or v_existing.candidate_outcome_sha256 is distinct from p_candidate_outcome_sha256
      or v_existing.result_sha256 is distinct from p_result_sha256
      or v_existing.evaluation_canonical_json is distinct from p_evaluation_canonical_json
      or v_existing.evaluation is distinct from p_evaluation
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'decision evolution evaluation identity was reused'
        using errcode = '23505';
    end if;
  else
    insert into public.decision_evolution_evaluation (
      evaluation_sha256, artifact_sha256, comparison_sha256,
      experiment_id, trial_id, evidence_snapshot_id,
      official_outcome_sha256, candidate_outcome_sha256, result_sha256,
      evaluation_canonical_json, evaluation, recorded_by
    ) values (
      p_evaluation_sha256, p_artifact_sha256, p_comparison_sha256,
      p_experiment_id, p_trial_id, p_evidence_snapshot_id,
      p_official_outcome_sha256, p_candidate_outcome_sha256, p_result_sha256,
      p_evaluation_canonical_json, p_evaluation, p_recorded_by
    ) returning * into v_existing;
  end if;
  return jsonb_build_object(
    'evaluationSha256', v_existing.evaluation_sha256,
    'artifactSha256', v_existing.artifact_sha256,
    'comparisonSha256', v_existing.comparison_sha256,
    'resultSha256', v_existing.result_sha256
  );
end;
$$;

alter table public.decision_evolution_evaluation enable row level security;
revoke all on table public.decision_evolution_evaluation
  from public, anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.decision_evolution_evaluation from service_role;
grant select on table public.decision_evolution_evaluation to service_role;

revoke all on function public.register_decision_evolution_evaluation(
  text, text, text, uuid, uuid, uuid, text, text, text, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.register_decision_evolution_evaluation(
  text, text, text, uuid, uuid, uuid, text, text, text, jsonb, text, text
) to service_role;

commit;
