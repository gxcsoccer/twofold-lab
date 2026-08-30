-- Durable, Round-aware S1 freeze. The generic kernel RPC predates deterministic
-- UUIDv8 Round decisions and uses a UTC-midnight admission fence. This Arena
-- boundary derives identity/timing from the exchange-calendar Round and stores
-- the Core S1 result together with its exact frozen plan and opening ledger CAS.

begin;

create table public.arena_cycle_stage_result (
  stage_result_id uuid primary key,
  idempotency_key text not null unique check (idempotency_key <> ''),
  round_entry_id uuid not null,
  round_id uuid not null,
  season_id uuid not null,
  entrant_id uuid not null,
  run_id uuid not null,
  decision_id uuid not null,
  phase text not null check (phase in (
    'PREPARE_S1_ORDERS',
    'SETTLE_S1_AND_PREPARE_S2'
  )),
  strategy_account_id uuid not null,
  accepted_submission_id uuid not null,
  opening_head_sequence bigint not null check (opening_head_sequence >= 0),
  opening_head_sha256 text not null check (
    opening_head_sha256 ~ '^[0-9a-f]{64}$'
  ),
  s1_frozen_order_plan_id uuid not null,
  s2_frozen_order_plan_id uuid,
  decision_snapshot_id uuid not null,
  s1_open_reference_snapshot_id uuid,
  s1_close_snapshot_id uuid,
  s1_tax_fx_reference_id uuid,
  artifact_schema text not null check (artifact_schema in (
    'twofold.accepted_target_cycle_s1_plan/v1',
    'twofold.accepted_target_cycle_s1_checkpoint/v1'
  )),
  artifact_canonical_json text not null check (artifact_canonical_json <> ''),
  artifact jsonb not null,
  artifact_sha256 text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint arena_cycle_stage_result_entry_fk foreign key (
    round_entry_id, round_id, season_id, entrant_id, run_id
  ) references public.arena_round_entry(
    round_entry_id, round_id, season_id, entrant_id, run_id
  ),
  constraint arena_cycle_stage_result_account_fk foreign key (
    strategy_account_id, run_id
  ) references public.strategy_account(strategy_account_id, run_id),
  constraint arena_cycle_stage_result_submission_fk foreign key (
    accepted_submission_id
  ) references public.accepted_target_submission(submission_id),
  constraint arena_cycle_stage_result_s1_plan_fk foreign key (
    s1_frozen_order_plan_id, strategy_account_id
  ) references public.frozen_order_plan(
    frozen_order_plan_id, strategy_account_id
  ),
  constraint arena_cycle_stage_result_s2_plan_fk foreign key (
    s2_frozen_order_plan_id, strategy_account_id
  ) references public.frozen_order_plan(
    frozen_order_plan_id, strategy_account_id
  ),
  constraint arena_cycle_stage_result_decision_snapshot_fk foreign key (
    decision_snapshot_id
  ) references public.market_snapshot(snapshot_id),
  constraint arena_cycle_stage_result_payload_object check (
    jsonb_typeof(artifact) = 'object'
  ),
  constraint arena_cycle_stage_result_payload_decimal_safe check (
    not public.jsonb_contains_number(artifact)
  ),
  constraint arena_cycle_stage_result_payload_exact check (
    artifact_canonical_json::jsonb = artifact
  ),
  constraint arena_cycle_stage_result_hash_exact check (
    artifact_sha256 = encode(
      extensions.digest(convert_to(artifact_canonical_json, 'UTF8'), 'sha256'),
      'hex'
    )
  ),
  constraint arena_cycle_stage_result_entry_phase_unique
    unique (round_entry_id, phase),
  constraint arena_cycle_stage_result_stage_shape check (
    (phase = 'PREPARE_S1_ORDERS'
      and artifact_schema = 'twofold.accepted_target_cycle_s1_plan/v1'
      and s2_frozen_order_plan_id is null
      and s1_open_reference_snapshot_id is null
      and s1_close_snapshot_id is null
      and s1_tax_fx_reference_id is null)
    or
    (phase = 'SETTLE_S1_AND_PREPARE_S2'
      and artifact_schema = 'twofold.accepted_target_cycle_s1_checkpoint/v1'
      and s2_frozen_order_plan_id is not null
      and s1_open_reference_snapshot_id is not null
      and s1_close_snapshot_id is not null
      and s1_tax_fx_reference_id is not null)
  )
);

comment on table public.arena_cycle_stage_result is
  'Immutable Core stage replay artifacts bound to one Round entry, ledger CAS, frozen plans, and only the evidence available at that stage.';

create trigger arena_cycle_stage_result_is_immutable
before update or delete on public.arena_cycle_stage_result
for each row execute function public.reject_immutable_mutation();
create trigger arena_cycle_stage_result_rejects_truncate
before truncate on public.arena_cycle_stage_result
for each statement execute function public.reject_immutable_mutation();

create or replace function public.arena_cycle_stage_result_json(
  p_value public.arena_cycle_stage_result
)
returns jsonb
language sql
stable
strict
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'twofold.arena_cycle_stage_result/v1',
    'stageResultId', p_value.stage_result_id::text,
    'roundEntryId', p_value.round_entry_id::text,
    'phase', p_value.phase,
    'strategyAccountId', p_value.strategy_account_id::text,
    'acceptedSubmissionId', p_value.accepted_submission_id::text,
    'openingHeadSequence', p_value.opening_head_sequence::text,
    'openingHeadSha256', p_value.opening_head_sha256,
    's1FrozenOrderPlanId', p_value.s1_frozen_order_plan_id::text,
    's2FrozenOrderPlanId', case when p_value.s2_frozen_order_plan_id is null
      then null else p_value.s2_frozen_order_plan_id::text end,
    'artifactSchema', p_value.artifact_schema,
    'artifactSha256', p_value.artifact_sha256,
    'recordedBy', p_value.recorded_by,
    'recordedAt', to_char(
      p_value.recorded_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  )
$$;

create or replace function public.register_arena_s1_plan(
  p_idempotency_key text,
  p_round_entry_id uuid,
  p_expected_head_sequence bigint,
  p_expected_head_sha256 text,
  p_plan_canonical_json text,
  p_plan_sha256 text,
  p_result_canonical_json text,
  p_result_sha256 text,
  p_recorded_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_entry public.arena_round_entry%rowtype;
  v_round public.arena_round%rowtype;
  v_submission public.accepted_target_submission%rowtype;
  v_account public.strategy_account%rowtype;
  v_head public.strategy_ledger_head%rowtype;
  v_rulebook public.arena_execution_rulebook%rowtype;
  v_existing public.arena_cycle_stage_result%rowtype;
  v_frozen public.frozen_order_plan%rowtype;
  v_inserted public.arena_cycle_stage_result%rowtype;
  v_plan jsonb;
  v_result jsonb;
  v_engine jsonb;
  v_plan_id uuid;
  v_stage_result_id uuid;
  v_engine_sha text;
  v_arrival_at timestamptz := clock_timestamp();
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_round_entry_id is null
    or p_expected_head_sequence is null or p_expected_head_sequence < 0
    or p_expected_head_sha256 is null
      or p_expected_head_sha256 !~ '^[0-9a-f]{64}$'
    or p_plan_canonical_json is null or p_plan_canonical_json = ''
    or p_plan_canonical_json is distinct from btrim(p_plan_canonical_json)
    or p_plan_sha256 is null or p_plan_sha256 !~ '^[0-9a-f]{64}$'
    or p_result_canonical_json is null or p_result_canonical_json = ''
    or p_result_canonical_json is distinct from btrim(p_result_canonical_json)
    or p_result_sha256 is null or p_result_sha256 !~ '^[0-9a-f]{64}$'
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid Arena S1 plan freeze header'
      using errcode = '22023';
  end if;
  if encode(extensions.digest(convert_to(p_plan_canonical_json, 'UTF8'), 'sha256'), 'hex')
       is distinct from p_plan_sha256
    or encode(extensions.digest(convert_to(p_result_canonical_json, 'UTF8'), 'sha256'), 'hex')
       is distinct from p_result_sha256
  then
    raise exception 'Arena S1 plan or result SHA256 does not match exact bytes'
      using errcode = '22023';
  end if;
  begin
    v_plan := p_plan_canonical_json::jsonb;
    v_result := p_result_canonical_json::jsonb;
    v_engine := (v_plan->>'enginePlanFingerprint')::jsonb;
  exception when others then
    raise exception 'Arena S1 plan freeze contains invalid JSON bytes'
      using errcode = '22023';
  end;

  if public.jsonb_contains_number(v_plan)
    or public.jsonb_contains_number(v_result)
    or jsonb_typeof(v_plan) <> 'object'
    or not (v_plan ?& array[
      'manifestSchema', 'runId', 'decisionId', 'acceptedSubmissionId',
      'stage', 'plannedAt', 'plannedTradeDate', 'executionModel',
      'slippageBps', 'fillPriceScale', 'enginePlanFingerprint',
      'enginePlanFingerprintSha256', 'orders', 'taxRulesetId',
      'taxAllocationScale'
    ]::text[])
    or (select count(*) from jsonb_object_keys(v_plan)) <> 15
    or jsonb_typeof(v_plan->'orders') <> 'array'
    or jsonb_typeof(v_result) <> 'object'
    or not (v_result ?& array[
      'schema', 'submissionId', 'decisionId', 'plan', 'decisionCloseNav'
    ]::text[])
    or (select count(*) from jsonb_object_keys(v_result)) <> 5
    or jsonb_typeof(v_result->'plan') <> 'object'
    or jsonb_typeof(v_result->'decisionCloseNav') <> 'object'
    or v_result->>'schema' <> 'twofold.accepted_target_cycle_s1_plan/v1'
    or v_plan->>'manifestSchema' <> 'twofold.frozen_order_plan/v1'
    or v_plan->>'stage' <> 'S1'
    or v_plan->>'executionModel' <> 'SIMULATED_SLIPPAGE'
    or v_plan->>'taxRulesetId'
      <> 'cn_resident_direct_foreign_securities_strict_v1'
    or v_plan->>'runId'
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or v_plan->>'decisionId'
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or v_plan->>'acceptedSubmissionId'
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or v_plan->>'plannedAt'
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    or v_plan->>'plannedTradeDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or v_plan->>'slippageBps' !~ '^(0|[1-9][0-9]{0,3}|10000)$'
    or v_plan->>'fillPriceScale' !~ '^(0|[1-9][0-9]?)$'
    or v_plan->>'taxAllocationScale' !~ '^(0|[1-9][0-9]?)$'
    or v_plan->>'enginePlanFingerprintSha256' !~ '^[0-9a-f]{64}$'
  then
    raise exception 'Arena S1 plan freeze has an invalid exact envelope'
      using errcode = '22023';
  end if;
  v_engine_sha := encode(extensions.digest(
    convert_to(v_plan->>'enginePlanFingerprint', 'UTF8'), 'sha256'
  ), 'hex');
  if v_engine_sha <> v_plan->>'enginePlanFingerprintSha256'
    or jsonb_typeof(v_engine) <> 'object'
    or public.jsonb_contains_number(v_engine)
    or not (v_engine ?& array[
      'schema', 'decisionId', 'stage', 'executionModel', 'slippageBps',
      'fillPriceScale', 'taxRulesetId', 'taxAllocationScale', 'orders'
    ]::text[])
    or (select count(*) from jsonb_object_keys(v_engine)) <> 9
    or jsonb_typeof(v_engine->'orders') <> 'array'
    or v_engine->>'schema' <> 'twofold.frozen_order_plan/v1'
    or v_engine->>'decisionId' <> v_plan->>'decisionId'
    or v_engine->>'stage' <> 'S1'
    or v_engine->>'executionModel' <> v_plan->>'executionModel'
    or v_engine->>'slippageBps' <> v_plan->>'slippageBps'
    or v_engine->>'fillPriceScale' <> v_plan->>'fillPriceScale'
    or v_engine->>'taxRulesetId' <> v_plan->>'taxRulesetId'
    or v_engine->>'taxAllocationScale' <> v_plan->>'taxAllocationScale'
    or v_result->'plan'->>'planFingerprint'
      <> v_plan->>'enginePlanFingerprint'
    or (v_result->'plan') - 'planFingerprint' <> v_engine
  then
    raise exception 'Arena S1 Core plan fingerprint binding is invalid'
      using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(v_plan->'orders') with ordinality
        as wrapper(value, item_index)
      full join jsonb_array_elements(v_engine->'orders') with ordinality
        as engine(value, item_index) using (item_index)
     where wrapper.value is null or engine.value is null
        or wrapper.value - array[
          'executionModel', 'slippageBps', 'feeTermsSha256'
        ]::text[] <> engine.value
        or wrapper.value->>'executionModel' <> v_plan->>'executionModel'
        or wrapper.value->>'slippageBps' <> v_plan->>'slippageBps'
        or wrapper.value->>'feeTermsSha256' !~ '^[0-9a-f]{64}$'
        or wrapper.value->>'feeTermsSha256' <> encode(extensions.digest(
          convert_to(wrapper.value->>'feeScheduleTerms', 'UTF8'), 'sha256'
        ), 'hex')
  ) then
    raise exception 'Arena S1 wrapper orders diverge from Core plan bytes'
      using errcode = '22023';
  end if;

  select * into v_entry from public.arena_round_entry
   where round_entry_id = p_round_entry_id;
  select * into v_round from public.arena_round
   where round_id = v_entry.round_id and season_id = v_entry.season_id;
  select * into v_submission from public.accepted_target_submission
   where decision_id = v_entry.decision_id;
  select * into v_account from public.strategy_account
   where run_id = v_entry.run_id and live_trading is false;
  select * into v_head from public.strategy_ledger_head
   where strategy_account_id = v_account.strategy_account_id;
  select * into v_rulebook from public.arena_execution_rulebook
   where season_id = v_entry.season_id;
  if v_entry.round_entry_id is null or v_round.round_id is null
    or v_submission.submission_id is null or v_account.strategy_account_id is null
    or v_head.strategy_account_id is null or v_rulebook.rulebook_id is null
    or public.arena_market_close_material(v_round.decision_snapshot_id) is null
  then
    raise exception 'Arena S1 plan freeze provenance is incomplete'
      using errcode = '23503';
  end if;
  if (v_plan->>'runId')::uuid <> v_entry.run_id
    or (v_plan->>'decisionId')::uuid <> v_entry.decision_id
    or (v_plan->>'acceptedSubmissionId')::uuid <> v_submission.submission_id
    or v_result->>'submissionId' <> v_submission.submission_id::text
    or v_result->>'decisionId' <> v_entry.decision_id::text
    or (v_plan->>'plannedAt')::timestamptz <> v_submission.accepted_at
    or (v_plan->>'plannedTradeDate')::date <> v_round.s1_session_date
    or v_plan->>'slippageBps' <> v_rulebook.rulebook->>'slippageBps'
    or v_plan->>'fillPriceScale' <> v_rulebook.rulebook->>'fillPriceScale'
    or v_plan->>'taxRulesetId' <> v_rulebook.rulebook->>'taxRulesetId'
    or v_plan->>'taxAllocationScale'
      <> v_rulebook.rulebook->>'taxAllocationScale'
    or v_head.head_sequence <> p_expected_head_sequence
    or v_head.head_sha256 <> p_expected_head_sha256
  then
    raise exception 'Arena S1 plan differs from Round, rulebook, or ledger CAS'
      using errcode = '40001';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_engine->'orders') as item(value)
     where item.value->>'decisionId' <> v_entry.decision_id::text
        or item.value->>'stage' <> 'S1'
        or item.value->>'side' <> 'SELL'
        or item.value->>'plannedAt' <> v_plan->>'plannedAt'
        or item.value->>'plannedTradeDate' <> v_round.s1_session_date::text
        or not exists (
          select 1
            from public.market_snapshot_member as member
            join public.market_bar_fact as fact on fact.fact_id = member.fact_id
            join public.instrument_symbol_version as version
              on version.symbol = member.symbol
             and version.effective_from <= v_round.decision_session_date
             and (version.effective_to is null
                  or version.effective_to > v_round.decision_session_date)
           where member.snapshot_id = v_round.decision_snapshot_id
             and member.symbol = item.value->>'symbol'
             and version.instrument_id = (item.value->>'instrumentId')::uuid
             and fact.fact_id::text
                   = item.value#>>'{referencePriceEvidence,factId}'
             and fact.close_price = item.value->>'referencePrice'
             and item.value#>>'{referencePriceEvidence,value}'
                   = item.value->>'referencePrice'
             and item.value#>>'{referencePriceEvidence,kind}' = 'OFFICIAL_CLOSE'
             and item.value#>>'{referencePriceEvidence,sessionDate}'
                   = v_round.decision_session_date::text
             and item.value#>>'{referencePriceEvidence,snapshotId}'
                   = v_round.decision_snapshot_id::text
             and (item.value#>>'{referencePriceEvidence,visibleAt}')::timestamptz
                   <= v_submission.accepted_at
        )
  ) then
    raise exception 'Arena S1 order is outside shared decision evidence'
      using errcode = '22023';
  end if;

  v_plan_id := public.deterministic_uuid_from_sha256(
    'twofold.arena_frozen_order_plan/v1',
    v_entry.decision_id::text || ':S1'
  );
  v_stage_result_id := public.deterministic_uuid_from_sha256(
    'twofold.arena_cycle_stage_result/v1',
    v_entry.round_entry_id::text || ':PREPARE_S1_ORDERS'
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'arena-s1-plan:' || v_entry.round_entry_id::text, 0
  ));
  select * into v_existing from public.arena_cycle_stage_result
   where idempotency_key = p_idempotency_key
      or (round_entry_id = v_entry.round_entry_id
          and phase = 'PREPARE_S1_ORDERS')
   order by (idempotency_key = p_idempotency_key) desc limit 1;
  if found then
    if v_existing.stage_result_id <> v_stage_result_id
      or v_existing.opening_head_sequence <> p_expected_head_sequence
      or v_existing.opening_head_sha256 <> p_expected_head_sha256
      or v_existing.artifact_canonical_json <> p_result_canonical_json
      or v_existing.artifact_sha256 <> p_result_sha256
      or v_existing.recorded_by <> p_recorded_by
    then
      raise exception 'Arena S1 plan identity was reused with different content'
        using errcode = '23505';
    end if;
    return public.arena_cycle_stage_result_json(v_existing);
  end if;
  if v_arrival_at >= v_round.s1_open_at then
    raise exception 'Arena S1 plan reached the database after exchange open'
      using errcode = '22023';
  end if;

  select * into v_frozen from public.frozen_order_plan
   where frozen_order_plan_id = v_plan_id
      or (decision_id = v_entry.decision_id and stage = 'S1')
   limit 1;
  if found then
    if v_frozen.frozen_order_plan_id <> v_plan_id
      or v_frozen.strategy_account_id <> v_account.strategy_account_id
      or v_frozen.accepted_submission_id <> v_submission.submission_id
      or v_frozen.plan_canonical_json <> p_plan_canonical_json
      or v_frozen.plan_sha256 <> p_plan_sha256
      or v_frozen.recorded_by <> p_recorded_by
    then
      raise exception 'Arena S1 frozen plan conflicts with existing content'
        using errcode = '23505';
    end if;
  else
    insert into public.frozen_order_plan (
      frozen_order_plan_id, idempotency_key, strategy_account_id, run_id,
      decision_id, accepted_submission_id, stage, planned_at,
      planned_trade_date, manifest_schema, plan_canonical_json, plan,
      plan_sha256, engine_plan_fingerprint,
      engine_plan_fingerprint_sha256, recorded_by
    ) values (
      v_plan_id, p_idempotency_key || ':frozen-plan',
      v_account.strategy_account_id, v_entry.run_id, v_entry.decision_id,
      v_submission.submission_id, 'S1', v_submission.accepted_at,
      v_round.s1_session_date, 'twofold.frozen_order_plan/v1',
      p_plan_canonical_json, v_plan, p_plan_sha256,
      v_plan->>'enginePlanFingerprint',
      v_plan->>'enginePlanFingerprintSha256', p_recorded_by
    ) returning * into v_frozen;
  end if;

  insert into public.arena_cycle_stage_result (
    stage_result_id, idempotency_key, round_entry_id, round_id, season_id,
    entrant_id, run_id, decision_id, phase, strategy_account_id,
    accepted_submission_id, opening_head_sequence, opening_head_sha256,
    s1_frozen_order_plan_id, decision_snapshot_id, artifact_schema,
    artifact_canonical_json, artifact, artifact_sha256, recorded_by
  ) values (
    v_stage_result_id, p_idempotency_key, v_entry.round_entry_id,
    v_entry.round_id, v_entry.season_id, v_entry.entrant_id, v_entry.run_id,
    v_entry.decision_id, 'PREPARE_S1_ORDERS',
    v_account.strategy_account_id, v_submission.submission_id,
    p_expected_head_sequence, p_expected_head_sha256,
    v_frozen.frozen_order_plan_id, v_round.decision_snapshot_id,
    'twofold.accepted_target_cycle_s1_plan/v1', p_result_canonical_json,
    v_result, p_result_sha256, p_recorded_by
  ) returning * into v_inserted;
  return public.arena_cycle_stage_result_json(v_inserted);
end;
$$;

alter table public.arena_cycle_stage_result enable row level security;
revoke all on table public.arena_cycle_stage_result
  from public, anon, authenticated, service_role;
grant select on table public.arena_cycle_stage_result to service_role;
revoke all on function public.arena_cycle_stage_result_json(
  public.arena_cycle_stage_result
) from public, anon, authenticated;
revoke all on function public.register_arena_s1_plan(
  text, uuid, bigint, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.register_arena_s1_plan(
  text, uuid, bigint, text, text, text, text, text, text
) to service_role;

comment on function public.register_arena_s1_plan(
  text, uuid, bigint, text, text, text, text, text, text
) is
  'Atomically freezes one Core S1 plan/result before the Round exchange open, bound to UUIDv8 decision identity, the accepted target, rulebook, decision evidence, and opening ledger CAS.';

commit;
