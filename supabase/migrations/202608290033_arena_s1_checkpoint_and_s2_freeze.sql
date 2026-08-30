-- Atomically bind the Core S1 checkpoint to shared Round evidence and freeze
-- the derived S2 plan. This remains a replay boundary: the durable accounting
-- head is advanced only by the final authoritative cycle commit.

begin;

alter table public.arena_cycle_stage_result
  add constraint arena_cycle_stage_result_s1_open_reference_fk
    foreign key (s1_open_reference_snapshot_id)
    references public.market_open_reference_snapshot(reference_snapshot_id),
  add constraint arena_cycle_stage_result_s1_close_snapshot_fk
    foreign key (s1_close_snapshot_id)
    references public.market_snapshot(snapshot_id),
  add constraint arena_cycle_stage_result_s1_tax_fx_reference_fk
    foreign key (s1_tax_fx_reference_id)
    references public.arena_round_tax_fx_reference(fx_reference_id);

create or replace function public.register_arena_s1_checkpoint(
  p_idempotency_key text,
  p_round_entry_id uuid,
  p_expected_head_sequence bigint,
  p_expected_head_sha256 text,
  p_s2_plan_canonical_json text,
  p_s2_plan_sha256 text,
  p_checkpoint_canonical_json text,
  p_checkpoint_sha256 text,
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
  v_prepare public.arena_cycle_stage_result%rowtype;
  v_existing public.arena_cycle_stage_result%rowtype;
  v_frozen public.frozen_order_plan%rowtype;
  v_inserted public.arena_cycle_stage_result%rowtype;
  v_open public.arena_round_open_reference%rowtype;
  v_close public.arena_round_close_snapshot%rowtype;
  v_close_snapshot public.market_snapshot%rowtype;
  v_fx public.arena_round_tax_fx_reference%rowtype;
  v_wrapper jsonb;
  v_checkpoint jsonb;
  v_engine jsonb;
  v_s1_engine jsonb;
  v_s2_plan_id uuid;
  v_stage_result_id uuid;
  v_engine_sha text;
  v_planned_at timestamptz;
  v_arrival_at timestamptz := clock_timestamp();
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_round_entry_id is null
    or p_expected_head_sequence is null or p_expected_head_sequence < 0
    or p_expected_head_sha256 is null
      or p_expected_head_sha256 !~ '^[0-9a-f]{64}$'
    or p_s2_plan_canonical_json is null or p_s2_plan_canonical_json = ''
    or p_s2_plan_canonical_json is distinct from btrim(p_s2_plan_canonical_json)
    or p_s2_plan_sha256 is null or p_s2_plan_sha256 !~ '^[0-9a-f]{64}$'
    or p_checkpoint_canonical_json is null or p_checkpoint_canonical_json = ''
    or p_checkpoint_canonical_json
      is distinct from btrim(p_checkpoint_canonical_json)
    or p_checkpoint_sha256 is null or p_checkpoint_sha256 !~ '^[0-9a-f]{64}$'
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid Arena S1 checkpoint header' using errcode = '22023';
  end if;
  if encode(extensions.digest(
       convert_to(p_s2_plan_canonical_json, 'UTF8'), 'sha256'
     ), 'hex') is distinct from p_s2_plan_sha256
    or encode(extensions.digest(
       convert_to(p_checkpoint_canonical_json, 'UTF8'), 'sha256'
     ), 'hex') is distinct from p_checkpoint_sha256
  then
    raise exception 'Arena checkpoint or S2 plan SHA256 does not match exact bytes'
      using errcode = '22023';
  end if;
  begin
    v_wrapper := p_s2_plan_canonical_json::jsonb;
    v_checkpoint := p_checkpoint_canonical_json::jsonb;
    v_engine := (v_wrapper->>'enginePlanFingerprint')::jsonb;
  exception when others then
    raise exception 'Arena S1 checkpoint contains invalid JSON bytes'
      using errcode = '22023';
  end;

  if public.jsonb_contains_number(v_wrapper)
    or public.jsonb_contains_number(v_checkpoint)
    or jsonb_typeof(v_wrapper) <> 'object'
    or not (v_wrapper ?& array[
      'manifestSchema', 'runId', 'decisionId', 'acceptedSubmissionId',
      'stage', 'plannedAt', 'plannedTradeDate', 'executionModel',
      'slippageBps', 'fillPriceScale', 'enginePlanFingerprint',
      'enginePlanFingerprintSha256', 'orders', 'buyingPowerEvidence',
      'initialBuyingPower', 'reservedBuyingPower',
      'remainingUnreservedBuyingPower'
    ]::text[])
    or (select count(*) from jsonb_object_keys(v_wrapper)) <> 17
    or jsonb_typeof(v_wrapper->'orders') <> 'array'
    or jsonb_typeof(v_checkpoint) <> 'object'
    or not (v_checkpoint ?& array[
      'schema', 'submissionId', 'decisionId', 's1', 's2Plan',
      'positions', 'ledger', 'account'
    ]::text[])
    or (select count(*) from jsonb_object_keys(v_checkpoint)) <> 8
    or v_checkpoint->>'schema'
      <> 'twofold.accepted_target_cycle_s1_checkpoint/v1'
    or jsonb_typeof(v_checkpoint->'s1') <> 'object'
    or not (v_checkpoint->'s1' ?& array['plan', 'settlements', 'nav']::text[])
    or (select count(*) from jsonb_object_keys(v_checkpoint->'s1')) <> 3
    or jsonb_typeof(v_checkpoint#>'{s1,settlements}') <> 'array'
    or jsonb_typeof(v_checkpoint->'s2Plan') <> 'object'
    or jsonb_typeof(v_checkpoint->'positions') <> 'array'
    or jsonb_typeof(v_checkpoint->'ledger') <> 'object'
    or jsonb_typeof(v_checkpoint->'account') <> 'object'
    or not (v_checkpoint->'account' ?& array[
      'cashAssetBalance', 'buyingPower', 'taxReserveBalance',
      'headSequence', 'headHash'
    ]::text[])
    or (select count(*) from jsonb_object_keys(v_checkpoint->'account')) <> 5
    or v_checkpoint#>>'{account,headSequence}' !~ '^(0|[1-9][0-9]*)$'
    or v_checkpoint#>>'{account,headHash}' !~ '^[0-9a-f]{64}$'
  then
    raise exception 'Arena S1 checkpoint has an invalid exact envelope'
      using errcode = '22023';
  end if;

  v_engine_sha := encode(extensions.digest(
    convert_to(v_wrapper->>'enginePlanFingerprint', 'UTF8'), 'sha256'
  ), 'hex');
  if v_wrapper->>'manifestSchema' <> 'twofold.frozen_order_plan/v1'
    or v_wrapper->>'stage' <> 'S2'
    or v_wrapper->>'executionModel' <> 'SIMULATED_SLIPPAGE'
    or v_wrapper->>'slippageBps' !~ '^(0|[1-9][0-9]{0,3}|10000)$'
    or v_wrapper->>'fillPriceScale' !~ '^(0|[1-9]|1[0-2])$'
    or v_wrapper->>'enginePlanFingerprintSha256' <> v_engine_sha
    or jsonb_typeof(v_engine) <> 'object'
    or public.jsonb_contains_number(v_engine)
    or not (v_engine ?& array[
      'schema', 'decisionId', 'stage', 'executionModel', 'slippageBps',
      'fillPriceScale', 'buyingPowerEvidence', 'orders',
      'initialBuyingPower', 'reservedBuyingPower',
      'remainingUnreservedBuyingPower'
    ]::text[])
    or (select count(*) from jsonb_object_keys(v_engine)) <> 11
    or jsonb_typeof(v_engine->'orders') <> 'array'
    or v_engine->>'schema' <> 'twofold.frozen_order_plan/v1'
    or v_engine->>'decisionId' <> v_wrapper->>'decisionId'
    or v_engine->>'stage' <> 'S2'
    or v_engine->>'executionModel' <> v_wrapper->>'executionModel'
    or v_engine->>'slippageBps' <> v_wrapper->>'slippageBps'
    or v_engine->>'fillPriceScale' <> v_wrapper->>'fillPriceScale'
    or v_engine->'buyingPowerEvidence' <> v_wrapper->'buyingPowerEvidence'
    or v_engine->>'initialBuyingPower' <> v_wrapper->>'initialBuyingPower'
    or v_engine->>'reservedBuyingPower' <> v_wrapper->>'reservedBuyingPower'
    or v_engine->>'remainingUnreservedBuyingPower'
      <> v_wrapper->>'remainingUnreservedBuyingPower'
    or v_checkpoint#>>'{s2Plan,planFingerprint}'
      <> v_wrapper->>'enginePlanFingerprint'
    or (v_checkpoint->'s2Plan') - 'planFingerprint' <> v_engine
    or (v_wrapper->>'initialBuyingPower')::numeric
      <> (v_wrapper->>'reservedBuyingPower')::numeric
       + (v_wrapper->>'remainingUnreservedBuyingPower')::numeric
  then
    raise exception 'Arena S2 Core plan fingerprint binding is invalid'
      using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(v_wrapper->'orders') with ordinality
        as wrapper(value, item_index)
      full join jsonb_array_elements(v_engine->'orders') with ordinality
        as engine(value, item_index) using (item_index)
     where wrapper.value is null or engine.value is null
        or wrapper.value - array[
          'executionModel', 'slippageBps', 'feeTermsSha256'
        ]::text[] <> engine.value
        or wrapper.value->>'executionModel' <> v_wrapper->>'executionModel'
        or wrapper.value->>'slippageBps' <> v_wrapper->>'slippageBps'
        or wrapper.value->>'feeTermsSha256' !~ '^[0-9a-f]{64}$'
        or wrapper.value->>'feeTermsSha256' <> encode(extensions.digest(
          convert_to(wrapper.value->>'feeScheduleTerms', 'UTF8'), 'sha256'
        ), 'hex')
  ) then
    raise exception 'Arena S2 wrapper orders diverge from Core plan bytes'
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
  select * into v_prepare from public.arena_cycle_stage_result
   where round_entry_id = p_round_entry_id and phase = 'PREPARE_S1_ORDERS';
  select * into v_open from public.arena_round_open_reference
   where round_id = v_entry.round_id and stage = 'S1_OPEN_REFERENCE';
  select * into v_close from public.arena_round_close_snapshot
   where round_id = v_entry.round_id and stage = 'S1_CLOSE';
  select * into v_close_snapshot from public.market_snapshot
   where snapshot_id = v_close.snapshot_id;
  select * into v_fx from public.arena_round_tax_fx_reference
   where round_id = v_entry.round_id and stage = 'S1_DISPOSITION';
  if v_entry.round_entry_id is null or v_round.round_id is null
    or v_submission.submission_id is null or v_account.strategy_account_id is null
    or v_head.strategy_account_id is null or v_rulebook.rulebook_id is null
    or v_prepare.stage_result_id is null or v_open.reference_snapshot_id is null
    or v_close.snapshot_id is null or v_close_snapshot.snapshot_id is null
    or v_fx.fx_reference_id is null
  then
    raise exception 'Arena S1 checkpoint provenance is incomplete'
      using errcode = '23503';
  end if;
  v_s1_engine := v_prepare.artifact#>'{plan}';
  v_planned_at := greatest(v_close_snapshot.sealed_at, v_fx.available_at);

  if v_prepare.opening_head_sequence <> p_expected_head_sequence
    or v_prepare.opening_head_sha256 <> p_expected_head_sha256
    or v_prepare.strategy_account_id <> v_account.strategy_account_id
    or v_prepare.accepted_submission_id <> v_submission.submission_id
    or v_head.head_sequence <> p_expected_head_sequence
    or v_head.head_sha256 <> p_expected_head_sha256
    or v_checkpoint->>'submissionId' <> v_submission.submission_id::text
    or v_checkpoint->>'decisionId' <> v_entry.decision_id::text
    or v_checkpoint#>'{s1,plan}' <> v_s1_engine
    or v_checkpoint#>>'{account,headSequence}' !~ '^(0|[1-9][0-9]*)$'
    or (v_checkpoint#>>'{account,headSequence}')::bigint
      < p_expected_head_sequence
    or (v_wrapper->>'runId')::uuid <> v_entry.run_id
    or (v_wrapper->>'decisionId')::uuid <> v_entry.decision_id
    or (v_wrapper->>'acceptedSubmissionId')::uuid <> v_submission.submission_id
    or (v_wrapper->>'plannedAt')::timestamptz <> v_planned_at
    or (v_wrapper->>'plannedTradeDate')::date <> v_round.s2_session_date
    or v_wrapper->>'slippageBps' <> v_rulebook.rulebook->>'slippageBps'
    or v_wrapper->>'fillPriceScale' <> v_rulebook.rulebook->>'fillPriceScale'
    or v_wrapper#>>'{buyingPowerEvidence,visibleAt}'
      <> to_char(v_planned_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    or v_wrapper#>>'{buyingPowerEvidence,snapshotId}'
      <> v_entry.decision_id::text || ':s1-close-ledger'
    or v_wrapper#>>'{buyingPowerEvidence,value}'
      <> v_wrapper->>'initialBuyingPower'
  then
    raise exception 'Arena checkpoint differs from Round, S1 plan, or ledger CAS'
      using errcode = '40001';
  end if;

  if jsonb_array_length(v_checkpoint#>'{s1,settlements}')
      <> jsonb_array_length(v_s1_engine->'orders')
    or (select count(distinct item.value#>>'{intent,orderId}')
          from jsonb_array_elements(v_checkpoint#>'{s1,settlements}')
            as item(value))
      <> jsonb_array_length(v_s1_engine->'orders')
    or exists (
      select 1
        from jsonb_array_elements(v_checkpoint#>'{s1,settlements}')
          as item(value)
       where item.value->>'status' <> 'READY'
          or item.value->>'contentSha256' !~ '^[0-9a-f]{64}$'
          or encode(extensions.digest(
               convert_to(item.value->>'canonicalJson', 'UTF8'), 'sha256'
             ), 'hex') <> item.value->>'contentSha256'
          or (item.value->>'canonicalJson')::jsonb <> item.value->'intent'
          or item.value#>>'{intent,decisionId}' <> v_entry.decision_id::text
          or item.value#>>'{intent,stage}' <> 'S1'
          or item.value#>>'{intent,side}' <> 'SELL'
          or item.value#>>'{intent,tradeDate}' <> v_round.s1_session_date::text
          or (item.value#>>'{intent,settledAt}')::timestamptz > v_planned_at
          or item.value#>>'{intent,frozenOrder,planFingerprint}'
             <> v_prepare.artifact#>>'{plan,planFingerprint}'
          or not exists (
            select 1 from jsonb_array_elements(v_s1_engine->'orders') as o(value)
             where o.value->>'orderId' = item.value#>>'{intent,orderId}'
               and o.value->>'instrumentId'
                 = item.value#>>'{intent,instrumentId}'
          )
          or exists (
            select 1
              from jsonb_array_elements(item.value#>'{intent,execution,fills}')
                as fill(value)
             where fill.value#>>'{priceEvidence,snapshotId}'
                     <> v_open.reference_snapshot_id::text
                or fill.value#>>'{priceEvidence,officialOpenSessionDate}'
                     <> v_round.s1_session_date::text
          )
          or (
            item.value#>>'{intent,tax,dispositionFxEvidence,fxRateId}' is not null
            and item.value#>>'{intent,tax,dispositionFxEvidence,fxRateId}'
              <> v_fx.fx_reference_id::text
          )
    )
  then
    raise exception 'Arena S1 settlements do not bind the frozen plan and evidence'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_engine->'orders') as item(value)
     where item.value->>'decisionId' <> v_entry.decision_id::text
        or item.value->>'stage' <> 'S2'
        or item.value->>'side' <> 'BUY'
        or item.value->>'plannedAt' <> v_wrapper->>'plannedAt'
        or item.value->>'plannedTradeDate' <> v_round.s2_session_date::text
        or not exists (
          select 1
            from public.market_snapshot_member as member
            join public.market_bar_fact as fact on fact.fact_id = member.fact_id
            join public.instrument_symbol_version as version
              on version.symbol = member.symbol
             and version.effective_from <= v_round.s1_session_date
             and (version.effective_to is null
                  or version.effective_to > v_round.s1_session_date)
           where member.snapshot_id = v_close.snapshot_id
             and member.symbol = item.value->>'symbol'
             and version.instrument_id = (item.value->>'instrumentId')::uuid
             and fact.fact_id::text
                   = item.value#>>'{referencePriceEvidence,factId}'
             and fact.close_price = item.value->>'referencePrice'
             and item.value#>>'{referencePriceEvidence,value}'
                   = item.value->>'referencePrice'
             and item.value#>>'{referencePriceEvidence,kind}' = 'OFFICIAL_CLOSE'
             and item.value#>>'{referencePriceEvidence,sessionDate}'
                   = v_round.s1_session_date::text
             and item.value#>>'{referencePriceEvidence,snapshotId}'
                   = v_close.snapshot_id::text
             and (item.value#>>'{referencePriceEvidence,visibleAt}')::timestamptz
                   <= v_planned_at
        )
  ) then
    raise exception 'Arena S2 order is outside shared S1 close evidence'
      using errcode = '22023';
  end if;

  v_s2_plan_id := public.deterministic_uuid_from_sha256(
    'twofold.arena_frozen_order_plan/v1',
    v_entry.decision_id::text || ':S2'
  );
  v_stage_result_id := public.deterministic_uuid_from_sha256(
    'twofold.arena_cycle_stage_result/v1',
    v_entry.round_entry_id::text || ':SETTLE_S1_AND_PREPARE_S2'
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'arena-s1-checkpoint:' || v_entry.round_entry_id::text, 0
  ));
  select * into v_existing from public.arena_cycle_stage_result
   where idempotency_key = p_idempotency_key
      or (round_entry_id = v_entry.round_entry_id
          and phase = 'SETTLE_S1_AND_PREPARE_S2')
   order by (idempotency_key = p_idempotency_key) desc limit 1;
  if found then
    if v_existing.stage_result_id <> v_stage_result_id
      or v_existing.opening_head_sequence <> p_expected_head_sequence
      or v_existing.opening_head_sha256 <> p_expected_head_sha256
      or v_existing.artifact_canonical_json <> p_checkpoint_canonical_json
      or v_existing.artifact_sha256 <> p_checkpoint_sha256
      or v_existing.s2_frozen_order_plan_id <> v_s2_plan_id
      or v_existing.recorded_by <> p_recorded_by
    then
      raise exception 'Arena S1 checkpoint identity was reused with different content'
        using errcode = '23505';
    end if;
    return public.arena_cycle_stage_result_json(v_existing);
  end if;
  if v_arrival_at >= v_round.s2_open_at then
    raise exception 'Arena S1 checkpoint reached the database after S2 open'
      using errcode = '22023';
  end if;

  select * into v_frozen from public.frozen_order_plan
   where frozen_order_plan_id = v_s2_plan_id
      or (decision_id = v_entry.decision_id and stage = 'S2')
   limit 1;
  if found then
    if v_frozen.frozen_order_plan_id <> v_s2_plan_id
      or v_frozen.strategy_account_id <> v_account.strategy_account_id
      or v_frozen.accepted_submission_id <> v_submission.submission_id
      or v_frozen.plan_canonical_json <> p_s2_plan_canonical_json
      or v_frozen.plan_sha256 <> p_s2_plan_sha256
      or v_frozen.recorded_by <> p_recorded_by
    then
      raise exception 'Arena S2 frozen plan conflicts with existing content'
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
      v_s2_plan_id, p_idempotency_key || ':frozen-plan',
      v_account.strategy_account_id, v_entry.run_id, v_entry.decision_id,
      v_submission.submission_id, 'S2', v_planned_at,
      v_round.s2_session_date, 'twofold.frozen_order_plan/v1',
      p_s2_plan_canonical_json, v_wrapper, p_s2_plan_sha256,
      v_wrapper->>'enginePlanFingerprint',
      v_wrapper->>'enginePlanFingerprintSha256', p_recorded_by
    ) returning * into v_frozen;
  end if;

  insert into public.arena_cycle_stage_result (
    stage_result_id, idempotency_key, round_entry_id, round_id, season_id,
    entrant_id, run_id, decision_id, phase, strategy_account_id,
    accepted_submission_id, opening_head_sequence, opening_head_sha256,
    s1_frozen_order_plan_id, s2_frozen_order_plan_id, decision_snapshot_id,
    s1_open_reference_snapshot_id, s1_close_snapshot_id,
    s1_tax_fx_reference_id, artifact_schema, artifact_canonical_json,
    artifact, artifact_sha256, recorded_by
  ) values (
    v_stage_result_id, p_idempotency_key, v_entry.round_entry_id,
    v_entry.round_id, v_entry.season_id, v_entry.entrant_id, v_entry.run_id,
    v_entry.decision_id, 'SETTLE_S1_AND_PREPARE_S2',
    v_account.strategy_account_id, v_submission.submission_id,
    p_expected_head_sequence, p_expected_head_sha256,
    v_prepare.s1_frozen_order_plan_id, v_frozen.frozen_order_plan_id,
    v_round.decision_snapshot_id, v_open.reference_snapshot_id,
    v_close.snapshot_id, v_fx.fx_reference_id,
    'twofold.accepted_target_cycle_s1_checkpoint/v1',
    p_checkpoint_canonical_json, v_checkpoint, p_checkpoint_sha256,
    p_recorded_by
  ) returning * into v_inserted;
  return public.arena_cycle_stage_result_json(v_inserted);
end;
$$;

revoke all on function public.register_arena_s1_checkpoint(
  text, uuid, bigint, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.register_arena_s1_checkpoint(
  text, uuid, bigint, text, text, text, text, text, text
) to service_role;

commit;
