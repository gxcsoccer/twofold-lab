-- Make an admitted corporate-action application a first-class replay source.
-- The existing aggregate-cycle reader remains the fallback whenever the most
-- recent ledger head is a normal cycle; an action artifact is used only when
-- its final head exactly equals the durable account head.

begin;

alter function public.get_strategy_portfolio_state(uuid)
  rename to strategy_portfolio_state_without_corporate_actions;

revoke all on function public.strategy_portfolio_state_without_corporate_actions(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_strategy_portfolio_state(
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_account public.strategy_account%rowtype;
  v_head public.strategy_ledger_head%rowtype;
  v_application public.corporate_action_account_application%rowtype;
  v_result jsonb;
  v_positions jsonb;
  v_physical_settlements bigint;
  v_aggregate_settlements bigint;
  v_action_mutations bigint;
  v_decimal_pattern text := '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$';
begin
  if p_run_id is null then
    raise exception 'Strategy Run is required' using errcode = '22023';
  end if;
  select * into v_account from public.strategy_account where run_id = p_run_id;
  if not found then
    raise exception 'Strategy Account is missing for Run' using errcode = 'P0002';
  end if;
  select * into v_head from public.strategy_ledger_head
   where strategy_account_id = v_account.strategy_account_id;
  if not found then
    raise exception 'Strategy Account ledger head is missing' using errcode = 'P0002';
  end if;
  select count(*) into v_physical_settlements
    from public.paper_fill_settlement
   where strategy_account_id = v_account.strategy_account_id;
  select coalesce(sum(
    jsonb_array_length(cycle#>'{s1,settlements}')
      + jsonb_array_length(cycle#>'{s2,settlements}')
  ),0) into v_aggregate_settlements
    from public.accepted_target_cycle
   where strategy_account_id = v_account.strategy_account_id;
  select count(*) into v_action_mutations
    from public.corporate_action_account_application
   where strategy_account_id = v_account.strategy_account_id
     and status = 'APPLIED';
  if v_physical_settlements + v_aggregate_settlements <> v_head.settlement_count
    or v_action_mutations <> v_head.corporate_action_mutation_count
    or v_head.head_sequence
       <> v_head.settlement_count + v_head.corporate_action_mutation_count
  then
    raise exception 'ledger integrity counters diverged from persisted mutations'
      using errcode = '55000';
  end if;

  select * into v_application
    from public.corporate_action_account_application
   where strategy_account_id = v_account.strategy_account_id
     and final_head_sequence = v_head.head_sequence
     and final_head_sha256 = v_head.head_sha256
   order by applied_at desc, source_stream_seq desc, application_id desc
   limit 1;

  if not found then
    v_result := public.strategy_portfolio_state_without_corporate_actions(p_run_id);
    v_result := jsonb_set(
      v_result,
      '{ledgerHead,corporateActionMutationCount}',
      to_jsonb(v_head.corporate_action_mutation_count::text),
      true
    );
    if public.jsonb_contains_number(v_result) then
      raise exception 'portfolio state crossed the string-decimal boundary'
        using errcode = '55000';
    end if;
    return v_result;
  end if;

  if v_application.application->>'schema'
       <> 'twofold.corporate_action_account_application/v1'
    or v_application.application#>>'{finalLedgerHead,sequence}'
       <> v_head.head_sequence::text
    or v_application.application#>>'{finalLedgerHead,sha256}'
       <> v_head.head_sha256
    or jsonb_typeof(v_application.application->'positions') <> 'array'
    or jsonb_typeof(v_application.application->'ledger') <> 'object'
    or jsonb_typeof(v_application.application->'cash') <> 'object'
    or v_application.application#>>'{cash,settled}' !~ v_decimal_pattern
    or v_application.application#>>'{cash,taxReserve}' !~ v_decimal_pattern
    or v_application.application#>>'{cash,buyingPower}' !~ v_decimal_pattern
  then
    raise exception 'latest corporate-action application has no replayable portfolio'
      using errcode = '55000';
  end if;
  if (v_application.application#>>'{cash,settled}')::numeric
       - (v_application.application#>>'{cash,taxReserve}')::numeric
       <> (v_application.application#>>'{cash,buyingPower}')::numeric
  then
    raise exception 'latest corporate-action cash does not reconcile'
      using errcode = '55000';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(v_application.application->'positions') as item(value)
     where jsonb_typeof(item.value) <> 'object'
        or not (item.value ?& array[
          'instrumentId','symbol','quantity','grossCost','lots',
          'acquisitionFxBindings'
        ]::text[])
        or item.value->>'instrumentId'
           !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or item.value->>'symbol' !~ '^[A-Z][A-Z0-9.-]{0,14}$'
        or item.value->>'quantity' !~ '^(0|[1-9][0-9]*)$'
        or item.value->>'grossCost' !~ v_decimal_pattern
        or jsonb_typeof(item.value->'lots') <> 'array'
        or jsonb_typeof(item.value->'acquisitionFxBindings') <> 'array'
        or jsonb_array_length(item.value->'lots')
           <> jsonb_array_length(item.value->'acquisitionFxBindings')
  ) then
    raise exception 'latest corporate-action positions are invalid'
      using errcode = '55000';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'instrumentId',item.value->>'instrumentId',
    'symbol',item.value->>'symbol',
    'quantity',item.value->>'quantity',
    'grossCost',item.value->>'grossCost',
    'taxBasis',public.accounting_decimal_text(coalesce((
      select sum(
        (lot.value->>'grossPurchasePrice')::numeric
          + (lot.value->>'buyFees')::numeric
      ) from jsonb_array_elements(item.value->'lots') as lot(value)
    ),0)),
    'currency',v_account.base_currency,
    'lotCount',jsonb_array_length(item.value->'lots')::text
  ) order by item.value->>'symbol',item.value->>'instrumentId'),'[]'::jsonb)
    into v_positions
    from jsonb_array_elements(v_application.application->'positions') as item(value)
   where (item.value->>'quantity')::numeric > 0;

  v_result := jsonb_build_object(
    'schema','twofold.strategy_portfolio_state/v1',
    'strategyAccountId',v_account.strategy_account_id::text,
    'runId',v_account.run_id::text,
    'asOf',to_char(v_application.applied_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'account',jsonb_build_object(
      'accountCode',v_account.account_code,
      'broker',v_account.broker,
      'brokerRegion',v_account.broker_region,
      'baseCurrency',v_account.base_currency,
      'liveTrading',false
    ),
    'ledgerHead',jsonb_build_object(
      'sequence',v_head.head_sequence::text,
      'sha256',v_head.head_sha256,
      'accountingTransactionCount',v_head.accounting_transaction_count::text,
      'lotOriginCount',v_head.lot_origin_count::text,
      'acquisitionFxBindingCount',v_head.acquisition_fx_binding_count::text,
      'settlementCount',v_head.settlement_count::text,
      'corporateActionMutationCount',v_head.corporate_action_mutation_count::text
    ),
    'cash',v_application.application->'cash',
    'positions',v_positions
  );
  if public.jsonb_contains_number(v_result) then
    raise exception 'portfolio state crossed the string-decimal boundary'
      using errcode = '55000';
  end if;
  return v_result;
end;
$$;

revoke all on function public.get_strategy_portfolio_state(uuid)
  from public, anon, authenticated;
grant execute on function public.get_strategy_portfolio_state(uuid)
  to service_role;

alter function public.get_arena_cycle_material(uuid,text)
  rename to arena_cycle_material_without_corporate_actions;
revoke all on function public.arena_cycle_material_without_corporate_actions(uuid,text)
  from public, anon, authenticated, service_role;

create or replace function public.get_arena_cycle_material(
  p_round_entry_id uuid,
  p_stage text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_result jsonb;
  v_account_id uuid;
  v_actions jsonb;
begin
  v_result := public.arena_cycle_material_without_corporate_actions(
    p_round_entry_id,p_stage
  );
  v_account_id := (v_result->'portfolio'->>'strategyAccountId')::uuid;
  select coalesce(jsonb_agg(jsonb_build_object(
    'applicationId',action.application_id::text,
    'contentSha256',action.content_sha256,
    'appliedAt',to_char(action.applied_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'openingHeadSequence',action.opening_head_sequence::text,
    'finalHeadSequence',action.final_head_sequence::text,
    'application',action.application
  ) order by action.applied_at,action.source_stream_seq,action.application_id),
    '[]'::jsonb) into v_actions
    from public.corporate_action_account_application as action
   where action.strategy_account_id = v_account_id;
  v_result := jsonb_set(v_result,'{priorCorporateActions}',v_actions,true);
  if public.jsonb_contains_number(v_result) then
    raise exception 'Arena cycle material crossed the string-decimal boundary'
      using errcode = '55000';
  end if;
  return v_result;
end;
$$;

revoke all on function public.get_arena_cycle_material(uuid,text)
  from public, anon, authenticated;
grant execute on function public.get_arena_cycle_material(uuid,text)
  to service_role;

comment on function public.get_strategy_portfolio_state(uuid) is
  'Returns the exact durable account state from the latest head-binding cycle or corporate-action artifact and exposes each mutation class separately.';
comment on function public.get_arena_cycle_material(uuid,text) is
  'Returns stage-gated cycle inputs plus every prior account corporate-action artifact required for deterministic ledger replay.';

commit;
