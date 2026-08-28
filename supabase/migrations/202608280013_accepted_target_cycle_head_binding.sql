-- Strengthen the accepted-target cycle admission boundary. Migration 011 is
-- already applied to the linked project, so this file replaces the function
-- instead of rewriting applied history (same convention as migration 010).
--
-- Financial derivation still stays in the versioned Core. What changes is how
-- much of the artifact Postgres is willing to take on the Worker's word:
--
--   1. `{s1,plan,orders}` / `{s2,plan,orders}` were never required to be arrays.
--      `jsonb_array_length` is strict and `#>` yields SQL NULL for a missing
--      path, so a plan object without an `orders` key made the stage/order
--      conservation comparison evaluate to NULL and the `if` never fired.
--   2. Only the artifact's self-reported `planFingerprint` string was compared
--      with the admitted plan. `engine_plan_fingerprint` is the complete
--      canonical plan JSON, not a digest, so the remaining plan bytes are now
--      bound to it and cannot diverge from the frozen plan.
--   3. `strategy_ledger_head` was neither read nor advanced. Two decisions in
--      one run could each derive a cycle from the same head and spend the same
--      cash; the run-stream CAS only orders events, not balance derivation. The
--      head is now locked, matched against the artifact's opening head, checked
--      to advance exactly once per settlement, and moved to `finalLedgerHead`
--      inside the same transaction.
--   4. An exact idempotent replay from a fresh process reloads a run-stream head
--      that the first attempt already advanced, so `source_stream_seq` no longer
--      participates in the stored-identity comparison.
--
-- The cycle path and the per-fill `settle_paper_fill` path now take the same
-- `twofold-ledger:<account>` advisory lock before the head row lock, so they are
-- mutually exclusive per account and cannot deadlock against each other.

begin;

create or replace function public.commit_accepted_target_cycle(
  p_idempotency_key text,
  p_cycle_id uuid,
  p_strategy_account_id uuid,
  p_run_id uuid,
  p_decision_id uuid,
  p_accepted_submission_id uuid,
  p_s1_frozen_order_plan_id uuid,
  p_s2_frozen_order_plan_id uuid,
  p_cycle_canonical_json text,
  p_cycle_sha256 text,
  p_completed_at timestamptz,
  p_expected_run_stream_seq bigint,
  p_expected_projection_stream_seq bigint,
  p_event_id uuid,
  p_recorded_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_existing public.accepted_target_cycle%rowtype;
  v_submission public.accepted_target_submission%rowtype;
  v_decision public.decision_invocation%rowtype;
  v_account public.strategy_account%rowtype;
  v_s1_plan public.frozen_order_plan%rowtype;
  v_s2_plan public.frozen_order_plan%rowtype;
  v_head public.strategy_ledger_head%rowtype;
  v_s1_plan_bytes jsonb;
  v_s2_plan_bytes jsonb;
  v_cycle jsonb;
  v_computed_sha text;
  v_event public.event_stream%rowtype;
  v_projection_state jsonb;
  v_projection_sha text;
  v_s1_order_count bigint;
  v_s2_order_count bigint;
  v_s1_settlement_count bigint;
  v_s2_settlement_count bigint;
  v_settlement_total bigint;
  v_opening_head jsonb;
  v_nav jsonb;
  v_final_head jsonb;
  v_ledger jsonb;
  v_decimal_pattern text := '^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$';
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_cycle_id is null
    or p_strategy_account_id is null
    or p_run_id is null
    or p_decision_id is null
    or p_accepted_submission_id is null
    or p_s1_frozen_order_plan_id is null
    or p_s2_frozen_order_plan_id is null
    or p_cycle_canonical_json is null or p_cycle_canonical_json = ''
    or p_cycle_canonical_json is distinct from btrim(p_cycle_canonical_json)
    or p_cycle_sha256 is null or p_cycle_sha256 !~ '^[0-9a-f]{64}$'
    or p_completed_at is null
    or p_expected_run_stream_seq is null or p_expected_run_stream_seq < 0
    or p_expected_projection_stream_seq is null
      or p_expected_projection_stream_seq < 0
    or p_event_id is null
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid accepted target cycle header'
      using errcode = '22023';
  end if;

  begin
    v_cycle := p_cycle_canonical_json::jsonb;
  exception when others then
    raise exception 'accepted target cycle bytes are not valid JSON'
      using errcode = '22023';
  end;
  v_computed_sha := encode(
    extensions.digest(convert_to(p_cycle_canonical_json, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_computed_sha is distinct from p_cycle_sha256 then
    raise exception 'accepted target cycle SHA256 does not match exact bytes'
      using errcode = '22023';
  end if;
  if p_cycle_id is distinct from public.deterministic_uuid_from_sha256(
    'twofold.accepted_target_cycle/v1',
    p_cycle_sha256
  ) then
    raise exception 'accepted target cycle ID is not content deterministic'
      using errcode = '22023';
  end if;
  if p_event_id is distinct from public.deterministic_uuid_from_sha256(
    'twofold.event.accepted_target_cycle/v1',
    p_cycle_id::text
  ) then
    raise exception 'accepted target cycle event ID is not content deterministic'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('accepted-target-cycle:' || p_decision_id::text, 0)
  );
  select cycle.* into v_existing
    from public.accepted_target_cycle as cycle
   where cycle.idempotency_key = p_idempotency_key
      or cycle.cycle_id = p_cycle_id
      or cycle.decision_id = p_decision_id
   order by (cycle.idempotency_key = p_idempotency_key) desc,
            (cycle.cycle_id = p_cycle_id) desc
   limit 1;
  if found then
    -- source_stream_seq is deliberately excluded: it is a CAS hint, not part of
    -- the artifact identity. A byte-identical replay from a restarted Worker
    -- reloads an already-advanced run-stream head and would otherwise be
    -- rejected as a content conflict.
    if v_existing.idempotency_key is distinct from p_idempotency_key
      or v_existing.cycle_id is distinct from p_cycle_id
      or v_existing.strategy_account_id is distinct from p_strategy_account_id
      or v_existing.run_id is distinct from p_run_id
      or v_existing.decision_id is distinct from p_decision_id
      or v_existing.accepted_submission_id is distinct from p_accepted_submission_id
      or v_existing.s1_frozen_order_plan_id is distinct from p_s1_frozen_order_plan_id
      or v_existing.s2_frozen_order_plan_id is distinct from p_s2_frozen_order_plan_id
      or v_existing.cycle_canonical_json is distinct from p_cycle_canonical_json
      or v_existing.cycle_sha256 is distinct from p_cycle_sha256
      or v_existing.completed_at is distinct from p_completed_at
      or v_existing.source_event_id is distinct from p_event_id
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'accepted target cycle identity was reused with different content'
        using errcode = '23505';
    end if;
    return public.accepted_target_cycle_commit_result(v_existing);
  end if;

  select * into v_submission
    from public.accepted_target_submission
   where submission_id = p_accepted_submission_id;
  if not found or v_submission.decision_id is distinct from p_decision_id then
    raise exception 'accepted target submission does not belong to decision'
      using errcode = '23503';
  end if;
  select * into v_decision
    from public.decision_invocation
   where decision_id = p_decision_id
     and run_id = p_run_id;
  if not found then
    raise exception 'decision does not belong to run'
      using errcode = '23503';
  end if;
  select * into v_account
    from public.strategy_account
   where strategy_account_id = p_strategy_account_id
     and run_id = p_run_id;
  if not found then
    raise exception 'strategy account does not belong to run'
      using errcode = '23503';
  end if;
  select * into v_s1_plan
    from public.frozen_order_plan
   where frozen_order_plan_id = p_s1_frozen_order_plan_id
     and strategy_account_id = p_strategy_account_id
     and run_id = p_run_id
     and decision_id = p_decision_id
     and accepted_submission_id = p_accepted_submission_id
     and stage = 'S1';
  if not found then
    raise exception 'S1 frozen plan binding is invalid'
      using errcode = '23503';
  end if;
  select * into v_s2_plan
    from public.frozen_order_plan
   where frozen_order_plan_id = p_s2_frozen_order_plan_id
     and strategy_account_id = p_strategy_account_id
     and run_id = p_run_id
     and decision_id = p_decision_id
     and accepted_submission_id = p_accepted_submission_id
     and stage = 'S2';
  if not found then
    raise exception 'S2 frozen plan binding is invalid'
      using errcode = '23503';
  end if;

  -- Same account lock the per-fill settlement boundary takes, in the same order,
  -- so a cycle commit and a paper fill can never interleave on one account.
  perform pg_advisory_xact_lock(
    hashtextextended('twofold-ledger:' || p_strategy_account_id::text, 0)
  );
  select * into v_head
    from public.strategy_ledger_head
   where strategy_account_id = p_strategy_account_id
   for update;
  if not found then
    raise exception 'strategy ledger head is not initialized'
      using errcode = '55000';
  end if;

  if jsonb_typeof(v_cycle) is distinct from 'object'
    or public.jsonb_contains_number(v_cycle)
    or not (v_cycle ?& array[
      'schema', 'submissionId', 'decisionId', 's1', 's2', 'positions',
      'ledger', 'nav', 'finalLedgerHead'
    ]::text[])
    or (select count(*) from jsonb_object_keys(v_cycle)) <> 9
    or v_cycle->>'schema' is distinct from 'twofold.accepted_target_cycle/v1'
    or v_cycle->>'submissionId' is distinct from p_accepted_submission_id::text
    or v_cycle->>'decisionId' is distinct from p_decision_id::text
    or jsonb_typeof(v_cycle->'s1') is distinct from 'object'
    or jsonb_typeof(v_cycle->'s2') is distinct from 'object'
    or jsonb_typeof(v_cycle->'positions') is distinct from 'array'
    or jsonb_typeof(v_cycle->'ledger') is distinct from 'object'
    or jsonb_typeof(v_cycle->'nav') is distinct from 'object'
    or jsonb_typeof(v_cycle->'finalLedgerHead') is distinct from 'object'
  then
    raise exception 'accepted target cycle has an invalid v1 envelope'
      using errcode = '22023';
  end if;

  -- `orders` must exist and be an array before any arithmetic reads it: a
  -- missing path would make jsonb_array_length return NULL and silently disable
  -- the conservation comparison below.
  if jsonb_typeof(v_cycle#>'{s1,plan}') is distinct from 'object'
    or jsonb_typeof(v_cycle#>'{s1,plan,orders}') is distinct from 'array'
    or jsonb_typeof(v_cycle#>'{s1,settlements}') is distinct from 'array'
    or jsonb_typeof(v_cycle#>'{s1,nav}') is distinct from 'object'
    or jsonb_typeof(v_cycle#>'{s2,plan}') is distinct from 'object'
    or jsonb_typeof(v_cycle#>'{s2,plan,orders}') is distinct from 'array'
    or jsonb_typeof(v_cycle#>'{s2,settlements}') is distinct from 'array'
    or v_cycle#>>'{s1,plan,stage}' is distinct from 'S1'
    or v_cycle#>>'{s2,plan,stage}' is distinct from 'S2'
  then
    raise exception 'cycle stage payload must carry both order arrays and settlements'
      using errcode = '22023';
  end if;

  if v_cycle#>>'{s1,plan,planFingerprint}'
      is distinct from v_s1_plan.engine_plan_fingerprint
    or v_cycle#>>'{s2,plan,planFingerprint}'
      is distinct from v_s2_plan.engine_plan_fingerprint
  then
    raise exception 'cycle plans do not match the admitted Core plan fingerprints'
      using errcode = '22023';
  end if;

  -- The Core fingerprint is the complete canonical plan JSON, so the artifact's
  -- plan is bound byte-for-byte to the admitted frozen plan rather than to a
  -- self-reported label.
  begin
    v_s1_plan_bytes := v_s1_plan.engine_plan_fingerprint::jsonb;
    v_s2_plan_bytes := v_s2_plan.engine_plan_fingerprint::jsonb;
  exception when others then
    raise exception 'admitted frozen plan fingerprint is not canonical JSON'
      using errcode = '22023';
  end;
  if (v_cycle#>'{s1,plan}') - 'planFingerprint' is distinct from v_s1_plan_bytes
    or (v_cycle#>'{s2,plan}') - 'planFingerprint' is distinct from v_s2_plan_bytes
  then
    raise exception 'cycle plan content diverges from the admitted frozen plan bytes'
      using errcode = '22023';
  end if;

  v_s1_order_count := jsonb_array_length(v_cycle#>'{s1,plan,orders}');
  v_s2_order_count := jsonb_array_length(v_cycle#>'{s2,plan,orders}');
  v_s1_settlement_count := jsonb_array_length(v_cycle#>'{s1,settlements}');
  v_s2_settlement_count := jsonb_array_length(v_cycle#>'{s2,settlements}');
  if v_s1_order_count <> v_s1_settlement_count
    or v_s2_order_count <> v_s2_settlement_count
    or exists (
      select 1 from jsonb_array_elements(v_cycle#>'{s1,settlements}') as item(value)
       where item.value->>'status' is distinct from 'READY'
          or item.value#>>'{intent,stage}' is distinct from 'S1'
          or item.value#>>'{intent,side}' is distinct from 'SELL'
    )
    or exists (
      select 1 from jsonb_array_elements(v_cycle#>'{s2,settlements}') as item(value)
       where item.value->>'status' is distinct from 'READY'
          or item.value#>>'{intent,stage}' is distinct from 'S2'
          or item.value#>>'{intent,side}' is distinct from 'BUY'
    )
  then
    raise exception 'cycle orders and READY settlement intents do not conserve'
      using errcode = '22023';
  end if;

  -- Every settlement intent must be derived against this account and run, not
  -- merely filed under them.
  if exists (
    select 1
      from jsonb_array_elements(
        (v_cycle#>'{s1,settlements}') || (v_cycle#>'{s2,settlements}')
      ) as item(value)
     where item.value#>>'{intent,ledgerHead,strategyAccountId}'
             is distinct from p_strategy_account_id::text
        or item.value#>>'{intent,ledgerHead,runId}' is distinct from p_run_id::text
  ) then
    raise exception 'cycle settlement intents are not bound to this account and run'
      using errcode = '22023';
  end if;

  v_ledger := v_cycle->'ledger';
  v_nav := v_cycle->'nav';
  v_final_head := v_cycle->'finalLedgerHead';
  if jsonb_typeof(v_ledger->'transactionCount') is distinct from 'string'
    or (v_ledger->>'transactionCount') !~ '^(0|[1-9][0-9]*)$'
    or jsonb_typeof(v_ledger->'balances') is distinct from 'array'
    or jsonb_typeof(v_ledger->'positions') is distinct from 'array'
    or not (v_nav ?& array[
      'currency', 'positionMarketValue', 'brokerNav', 'taxReserveDeductions',
      'taxReservedNav', 'liquidationDeductions', 'liquidationNav'
    ]::text[])
    or (select count(*) from jsonb_object_keys(v_nav)) <> 7
    or v_nav->>'currency' is distinct from v_account.base_currency
    or (v_nav->>'positionMarketValue') !~ v_decimal_pattern
    or (v_nav->>'brokerNav') !~ v_decimal_pattern
    or (v_nav->>'taxReserveDeductions') !~ v_decimal_pattern
    or (v_nav->>'taxReservedNav') !~ v_decimal_pattern
    or (v_nav->>'liquidationDeductions') !~ v_decimal_pattern
    or (v_nav->>'liquidationNav') !~ v_decimal_pattern
    or (v_nav->>'brokerNav')::numeric - (v_nav->>'taxReserveDeductions')::numeric
      <> (v_nav->>'taxReservedNav')::numeric
    or (v_nav->>'taxReservedNav')::numeric
      - (v_nav->>'liquidationDeductions')::numeric
      <> (v_nav->>'liquidationNav')::numeric
    or not (v_final_head ?& array['sequence', 'sha256']::text[])
    or (select count(*) from jsonb_object_keys(v_final_head)) <> 2
    or (v_final_head->>'sequence') !~ '^(0|[1-9][0-9]*)$'
    or (v_final_head->>'sha256') !~ '^[0-9a-f]{64}$'
  then
    raise exception 'cycle ledger, final head, or NAV invariants are invalid'
      using errcode = '22023';
  end if;

  -- The first settlement in causal order observes the durable head. A stale
  -- opening head is a CAS conflict, not a content error: the Worker must reload
  -- the head and re-derive, and the exact-RPC helper deliberately never retries
  -- 40001.
  v_opening_head := coalesce(
    v_cycle#>'{s1,settlements,0,intent,ledgerHead}',
    v_cycle#>'{s2,settlements,0,intent,ledgerHead}'
  );
  if v_opening_head is not null and (
    jsonb_typeof(v_opening_head) is distinct from 'object'
    or v_opening_head->>'headSequence' is distinct from v_head.head_sequence::text
    or v_opening_head->>'headHash' is distinct from v_head.head_sha256
  ) then
    raise exception 'cycle opening ledger head does not match the durable head'
      using
        errcode = '40001',
        detail = format(
          'durable head is sequence %s, artifact opened at sequence %s',
          v_head.head_sequence,
          coalesce(v_opening_head->>'headSequence', 'null')
        ),
        hint = 'Reload the strategy ledger head and re-derive the cycle.';
  end if;

  v_settlement_total := v_s1_settlement_count + v_s2_settlement_count;
  if (v_final_head->>'sequence')::bigint
       is distinct from v_head.head_sequence + v_settlement_total
  then
    raise exception 'cycle final ledger head must advance exactly once per settlement'
      using errcode = '22023';
  end if;

  v_event := public.append_event(
    p_run_id,
    'run',
    p_expected_run_stream_seq,
    'decision.accepted_target_cycle_completed',
    '1',
    'accepted-target-cycle:' || p_idempotency_key,
    'worker',
    p_recorded_by,
    p_completed_at,
    jsonb_build_object(
      'cycleId', p_cycle_id::text,
      'decisionId', p_decision_id::text,
      'acceptedSubmissionId', p_accepted_submission_id::text,
      'cycleSha256', p_cycle_sha256,
      'finalLedgerHead', v_final_head,
      'nav', v_nav
    ),
    jsonb_build_object(
      'artifactSchema', 'twofold.accepted_target_cycle/v1'
    ),
    p_event_id,
    p_decision_id,
    v_submission.source_event_id,
    p_completed_at::date,
    p_completed_at::date
  );

  insert into public.accepted_target_cycle (
    cycle_id, idempotency_key, strategy_account_id, run_id, decision_id,
    accepted_submission_id, s1_frozen_order_plan_id,
    s2_frozen_order_plan_id, artifact_schema, cycle_canonical_json, cycle,
    cycle_sha256, completed_at, source_event_id, source_stream_seq, recorded_by
  ) values (
    p_cycle_id, p_idempotency_key, p_strategy_account_id, p_run_id,
    p_decision_id, p_accepted_submission_id, p_s1_frozen_order_plan_id,
    p_s2_frozen_order_plan_id, 'twofold.accepted_target_cycle/v1',
    p_cycle_canonical_json, v_cycle, p_cycle_sha256, p_completed_at,
    v_event.event_id, v_event.stream_seq, p_recorded_by
  ) returning * into v_existing;

  -- Advance the durable head under the row lock so no second decision can start
  -- from the same balances. Kernel row counters are deliberately untouched: this
  -- boundary publishes one Core-derived artifact, not per-fill posting rows, and
  -- last_settlement_id may only reference a paper_fill_settlement.
  if v_settlement_total > 0 then
    perform set_config('twofold.atomic_settlement', 'on', true);
    update public.strategy_ledger_head
       set head_sequence = (v_final_head->>'sequence')::bigint,
           head_sha256 = v_final_head->>'sha256',
           settlement_count = settlement_count + v_settlement_total,
           updated_at = clock_timestamp()
     where strategy_account_id = p_strategy_account_id;
    perform set_config('twofold.atomic_settlement', 'off', true);
  end if;

  v_projection_state := jsonb_build_object(
    'schema', 'twofold.dashboard.accepted_target_cycle/v1',
    'status', 'COMPLETED',
    'cycleId', p_cycle_id::text,
    'decisionId', p_decision_id::text,
    'acceptedSubmissionId', p_accepted_submission_id::text,
    's1', jsonb_build_object(
      'status', 'COMPLETED',
      'orderCount', v_s1_order_count::text,
      'settlementCount', v_s1_settlement_count::text
    ),
    's2', jsonb_build_object(
      'status', 'COMPLETED',
      'orderCount', v_s2_order_count::text,
      'settlementCount', v_s2_settlement_count::text
    ),
    'ledger', jsonb_build_object(
      'transactionCount', v_ledger->>'transactionCount',
      'headSequence', v_final_head->>'sequence',
      'headSha256', v_final_head->>'sha256'
    ),
    'nav', v_nav,
    'artifactSha256', p_cycle_sha256,
    'completedAt', to_char(
      p_completed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
  v_projection_sha := encode(
    extensions.digest(convert_to(v_projection_state::text, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.put_projection(
    'dashboard.accepted_target_cycle',
    p_decision_id,
    p_run_id,
    p_expected_projection_stream_seq,
    v_event.stream_seq,
    v_event.event_id,
    v_projection_state,
    v_projection_sha
  );

  return public.accepted_target_cycle_commit_result(v_existing);
end;
$$;

comment on function public.commit_accepted_target_cycle(
  text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, timestamptz,
  bigint, bigint, uuid, text
) is
  'Atomically admits a content-addressed Core cycle after both frozen plans exist. Binds the artifact plan bytes to the admitted frozen plans and its opening ledger head to the locked durable head, advances that head to finalLedgerHead, appends the run event under CAS, and publishes its decision-scoped NAV projection.';

commit;
