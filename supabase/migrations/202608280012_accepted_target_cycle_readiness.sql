-- One causal, read-only handoff contract between an accepted target and the
-- deterministic cycle input builder. This reports durable coordination facts;
-- it does not derive orders, fills, tax, fees, or NAV.

begin;

create or replace function public.get_accepted_target_cycle_readiness(
  p_decision_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_run_id uuid;
  v_submission_id uuid;
  v_strategy_account_id uuid;
  v_ledger_head_sha256 text;
  v_cycle_id uuid;
  v_status text;
  v_blockers jsonb;
begin
  if p_decision_id is null then
    raise exception 'decision_id is required' using errcode = '22023';
  end if;

  select decision.run_id
    into v_run_id
    from public.decision_invocation as decision
   where decision.decision_id = p_decision_id;

  if v_run_id is not null then
    select submission.submission_id
      into v_submission_id
      from public.accepted_target_submission as submission
     where submission.decision_id = p_decision_id;

    select account.strategy_account_id
      into v_strategy_account_id
      from public.strategy_account as account
     where account.run_id = v_run_id;
  end if;

  if v_strategy_account_id is not null then
    select head.head_sha256
      into v_ledger_head_sha256
      from public.strategy_ledger_head as head
     where head.strategy_account_id = v_strategy_account_id;
  end if;

  select cycle.cycle_id
    into v_cycle_id
    from public.accepted_target_cycle as cycle
   where cycle.decision_id = p_decision_id;

  if v_cycle_id is not null then
    v_status := 'COMPLETED';
    v_blockers := '[]'::jsonb;
  elsif v_run_id is null then
    v_status := 'BLOCKED';
    v_blockers := jsonb_build_array('DECISION_NOT_FOUND');
  elsif v_submission_id is null then
    v_status := 'BLOCKED';
    v_blockers := jsonb_build_array('ACCEPTED_SUBMISSION_MISSING');
  elsif v_strategy_account_id is null then
    v_status := 'BLOCKED';
    v_blockers := jsonb_build_array('STRATEGY_ACCOUNT_MISSING');
  elsif v_ledger_head_sha256 is null then
    v_status := 'BLOCKED';
    v_blockers := jsonb_build_array('LEDGER_HEAD_MISSING');
  else
    v_status := 'READY_FOR_INPUT_BUILD';
    v_blockers := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'schema', 'twofold.accepted_target_cycle_readiness/v1',
    'status', v_status,
    'decisionId', p_decision_id::text,
    'runId', v_run_id::text,
    'acceptedSubmissionId', v_submission_id::text,
    'strategyAccountId', v_strategy_account_id::text,
    'ledgerHeadSha256', v_ledger_head_sha256,
    'cycleId', v_cycle_id::text,
    'blockers', v_blockers
  );
end;
$$;

comment on function public.get_accepted_target_cycle_readiness(uuid) is
  'Returns the first causal durable blocker, the input-build handoff, or the exact completed cycle for one accepted-target decision. Market/execution evidence is evaluated only after deterministic input construction.';

revoke all on function public.get_accepted_target_cycle_readiness(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_accepted_target_cycle_readiness(uuid)
  to service_role;

commit;
