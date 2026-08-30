-- Final Arena boundary: verify the full Core replay against the stored S1
-- checkpoint and shared S2 evidence, then publish the accounting cycle and
-- S2-close ranking valuation in one database transaction.

begin;

create or replace function public.finalize_arena_accepted_target_cycle(
  p_idempotency_key text,
  p_round_entry_id uuid,
  p_cycle_id uuid,
  p_cycle_canonical_json text,
  p_cycle_sha256 text,
  p_completed_at timestamptz,
  p_event_id uuid,
  p_valuation_canonical_json text,
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
  v_account public.strategy_account%rowtype;
  v_checkpoint public.arena_cycle_stage_result%rowtype;
  v_open public.arena_round_open_reference%rowtype;
  v_close public.arena_round_close_snapshot%rowtype;
  v_close_snapshot public.market_snapshot%rowtype;
  v_fx public.arena_round_tax_fx_reference%rowtype;
  v_cycle jsonb;
  v_valuation jsonb;
  v_commit jsonb;
  v_registered_valuation jsonb;
  v_run_stream_seq bigint;
  v_projection_stream_seq bigint;
  v_expected_completed_at timestamptz;
  v_position_market_value numeric;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_round_entry_id is null or p_cycle_id is null
    or p_cycle_canonical_json is null or p_cycle_canonical_json = ''
    or p_cycle_canonical_json is distinct from btrim(p_cycle_canonical_json)
    or p_cycle_sha256 is null or p_cycle_sha256 !~ '^[0-9a-f]{64}$'
    or p_completed_at is null or p_event_id is null
    or p_valuation_canonical_json is null or p_valuation_canonical_json = ''
    or p_valuation_canonical_json
      is distinct from btrim(p_valuation_canonical_json)
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid Arena finalization header' using errcode = '22023';
  end if;
  if encode(extensions.digest(
       convert_to(p_cycle_canonical_json, 'UTF8'), 'sha256'
     ), 'hex') <> p_cycle_sha256
    or p_cycle_id <> public.deterministic_uuid_from_sha256(
      'twofold.accepted_target_cycle/v1', p_cycle_sha256
    )
    or p_event_id <> public.deterministic_uuid_from_sha256(
      'twofold.event.accepted_target_cycle/v1', p_cycle_id::text
    )
  then
    raise exception 'Arena final cycle content identity is invalid'
      using errcode = '22023';
  end if;
  begin
    v_cycle := p_cycle_canonical_json::jsonb;
    v_valuation := p_valuation_canonical_json::jsonb;
  exception when others then
    raise exception 'Arena finalization contains invalid JSON bytes'
      using errcode = '22023';
  end;
  if public.jsonb_contains_number(v_cycle)
    or public.jsonb_contains_number(v_valuation)
    or jsonb_typeof(v_cycle) <> 'object'
    or v_cycle->>'schema' <> 'twofold.accepted_target_cycle/v1'
    or jsonb_typeof(v_cycle->'s1') <> 'object'
    or jsonb_typeof(v_cycle->'s2') <> 'object'
    or jsonb_typeof(v_cycle#>'{s2,settlements}') <> 'array'
    or jsonb_typeof(v_cycle->'positions') <> 'array'
    or jsonb_typeof(v_cycle->'nav') <> 'object'
    or jsonb_typeof(v_cycle->'finalLedgerHead') <> 'object'
    or jsonb_typeof(v_valuation) <> 'object'
    or v_valuation->>'schema' <> 'twofold.arena_valuation/v1'
  then
    raise exception 'Arena finalization has an invalid exact envelope'
      using errcode = '22023';
  end if;

  select * into v_entry from public.arena_round_entry
   where round_entry_id = p_round_entry_id;
  select * into v_round from public.arena_round
   where round_id = v_entry.round_id and season_id = v_entry.season_id;
  select * into v_account from public.strategy_account
   where run_id = v_entry.run_id and live_trading is false;
  select * into v_checkpoint from public.arena_cycle_stage_result
   where round_entry_id = p_round_entry_id
     and phase = 'SETTLE_S1_AND_PREPARE_S2';
  select * into v_open from public.arena_round_open_reference
   where round_id = v_entry.round_id and stage = 'S2_OPEN_REFERENCE';
  select * into v_close from public.arena_round_close_snapshot
   where round_id = v_entry.round_id and stage = 'S2_CLOSE';
  select * into v_close_snapshot from public.market_snapshot
   where snapshot_id = v_close.snapshot_id;
  select * into v_fx from public.arena_round_tax_fx_reference
   where round_id = v_entry.round_id and stage = 'S2_ACQUISITION';
  if v_entry.round_entry_id is null or v_round.round_id is null
    or v_account.strategy_account_id is null
    or v_checkpoint.stage_result_id is null
    or v_open.reference_snapshot_id is null or v_close.snapshot_id is null
    or v_close_snapshot.snapshot_id is null or v_fx.fx_reference_id is null
  then
    raise exception 'Arena finalization provenance is incomplete'
      using errcode = '23503';
  end if;
  v_expected_completed_at := greatest(
    v_close_snapshot.sealed_at,
    v_fx.available_at
  );
  if p_completed_at <> v_expected_completed_at
    or p_completed_at < v_round.s2_close_at
    or v_cycle->>'submissionId'
      <> v_checkpoint.accepted_submission_id::text
    or v_cycle->>'decisionId' <> v_entry.decision_id::text
    or v_cycle->'s1' <> v_checkpoint.artifact->'s1'
    or v_cycle#>'{s2,plan}' <> v_checkpoint.artifact->'s2Plan'
    or v_checkpoint.s2_frozen_order_plan_id is null
  then
    raise exception 'Arena final cycle differs from its Round checkpoint'
      using errcode = '40001';
  end if;

  if jsonb_array_length(v_cycle#>'{s2,settlements}')
      <> jsonb_array_length(v_cycle#>'{s2,plan,orders}')
    or (select count(distinct item.value#>>'{intent,orderId}')
          from jsonb_array_elements(v_cycle#>'{s2,settlements}')
            as item(value))
      <> jsonb_array_length(v_cycle#>'{s2,plan,orders}')
    or exists (
      select 1 from jsonb_array_elements(v_cycle#>'{s2,settlements}')
        as item(value)
       where item.value->>'status' <> 'READY'
          or item.value#>>'{intent,decisionId}' <> v_entry.decision_id::text
          or item.value#>>'{intent,stage}' <> 'S2'
          or item.value#>>'{intent,side}' <> 'BUY'
          or item.value#>>'{intent,tradeDate}' <> v_round.s2_session_date::text
          or (item.value#>>'{intent,settledAt}')::timestamptz
               <> p_completed_at
          or item.value#>>'{intent,frozenOrder,planFingerprint}'
               <> v_checkpoint.artifact#>>'{s2Plan,planFingerprint}'
          or not exists (
            select 1 from jsonb_array_elements(
              v_checkpoint.artifact#>'{s2Plan,orders}'
            ) as o(value)
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
                     <> v_round.s2_session_date::text
          )
          or (
            item.value#>'{intent,lotTransition,createdLot}' <> 'null'::jsonb
            and item.value#>>'{intent,lotTransition,createdLot,acquisitionFxEvidence,fxRateId}'
              <> v_fx.fx_reference_id::text
          )
    )
  then
    raise exception 'Arena S2 settlements do not bind the frozen plan and evidence'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_cycle->'positions') as item(value)
     where item.value->>'quantity' !~ '^(0|[1-9][0-9]*)$'
        or not exists (
          select 1
            from public.market_snapshot_member as member
            join public.market_bar_fact as fact on fact.fact_id = member.fact_id
            join public.instrument_symbol_version as version
              on version.symbol = member.symbol
             and version.effective_from <= v_round.s2_session_date
             and (version.effective_to is null
                  or version.effective_to > v_round.s2_session_date)
           where member.snapshot_id = v_close.snapshot_id
             and member.symbol = item.value->>'symbol'
             and version.instrument_id = (item.value->>'instrumentId')::uuid
        )
  ) then
    raise exception 'Arena final positions are outside shared S2 close evidence'
      using errcode = '22023';
  end if;
  select coalesce(sum(
    (position.value->>'quantity')::numeric * fact.close_price::numeric
  ), 0)
    into v_position_market_value
    from jsonb_array_elements(v_cycle->'positions') as position(value)
    join public.instrument_symbol_version as version
      on version.instrument_id = (position.value->>'instrumentId')::uuid
     and version.symbol = position.value->>'symbol'
     and version.effective_from <= v_round.s2_session_date
     and (version.effective_to is null
          or version.effective_to > v_round.s2_session_date)
    join public.market_snapshot_member as member
      on member.snapshot_id = v_close.snapshot_id
     and member.symbol = version.symbol
    join public.market_bar_fact as fact on fact.fact_id = member.fact_id;
  if public.accounting_decimal_text(v_position_market_value)
       <> v_cycle#>>'{nav,positionMarketValue}'
  then
    raise exception 'Arena final NAV is not marked by the shared S2 close'
      using errcode = '22023';
  end if;

  if v_valuation->>'ledgerSequence'
      <> v_cycle#>>'{finalLedgerHead,sequence}'
    or v_valuation->>'ledgerSha256'
      <> v_cycle#>>'{finalLedgerHead,sha256}'
    or v_valuation->>'positionMarketValue'
      <> v_cycle#>>'{nav,positionMarketValue}'
    or v_valuation->>'brokerNav' <> v_cycle#>>'{nav,brokerNav}'
    or v_valuation->>'taxReserve'
      <> v_cycle#>>'{nav,taxReserveDeductions}'
    or v_valuation->>'taxReservedNav'
      <> v_cycle#>>'{nav,taxReservedNav}'
    or v_valuation->>'liquidationNav'
      <> v_cycle#>>'{nav,liquidationNav}'
    or (v_valuation->>'estimatedCloseFees')::numeric
       + (v_valuation->>'estimatedUnrealizedLiquidationTax')::numeric
      <> (v_cycle#>>'{nav,liquidationDeductions}')::numeric
    or v_valuation->>'reportingCurrency' <> v_account.base_currency
    or (v_valuation->>'valuationAt')::timestamptz <> p_completed_at
    or (v_valuation->>'portfolioAsOf')::timestamptz <> p_completed_at
    or (v_valuation->>'valuationDate')::date <> v_round.s2_session_date
  then
    raise exception 'Arena S2 valuation diverges from the final Core cycle'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'arena-finalize:' || p_round_entry_id::text, 0
  ));
  select coalesce(max(stream_seq), 0) into v_run_stream_seq
    from public.event_stream where stream_id = v_entry.run_id;
  select coalesce(max(last_stream_seq), 0) into v_projection_stream_seq
    from public.projection
   where projection_name = 'dashboard.accepted_target_cycle'
     and entity_id = v_entry.decision_id;

  v_commit := public.commit_accepted_target_cycle(
    p_idempotency_key || ':cycle', p_cycle_id,
    v_account.strategy_account_id, v_entry.run_id, v_entry.decision_id,
    v_checkpoint.accepted_submission_id,
    v_checkpoint.s1_frozen_order_plan_id,
    v_checkpoint.s2_frozen_order_plan_id,
    p_cycle_canonical_json, p_cycle_sha256, p_completed_at,
    v_run_stream_seq, v_projection_stream_seq, p_event_id, p_recorded_by
  );
  v_registered_valuation := public.register_arena_valuation(
    p_idempotency_key || ':valuation', p_round_entry_id, 'S2_CLOSE',
    v_close.snapshot_id, p_valuation_canonical_json, p_recorded_by
  );
  return jsonb_build_object(
    'schema', 'twofold.arena_cycle_finalization_result/v1',
    'cycle', v_commit,
    'valuation', v_registered_valuation
  );
end;
$$;

revoke all on function public.finalize_arena_accepted_target_cycle(
  text, uuid, uuid, text, text, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.finalize_arena_accepted_target_cycle(
  text, uuid, uuid, text, text, timestamptz, uuid, text, text
) to service_role;

commit;
