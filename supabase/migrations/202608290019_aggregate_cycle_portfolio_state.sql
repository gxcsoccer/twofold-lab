-- Migration 013 advances the durable ledger head for a complete Core-derived
-- S1/S2 cycle without duplicating every simulated fill into the older physical
-- paper_fill tables.  The original portfolio reader compared the head only to
-- physical rows, so it became unusable immediately after the first accepted
-- cycle.  This replacement treats accepted_target_cycle as the aggregate
-- settlement journal while retaining exact reconciliation for the physical
-- accounting kernel.

begin;

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
  v_latest_cycle public.accepted_target_cycle%rowtype;
  v_last_settlement jsonb;
  v_cash numeric := 0;
  v_tax_reserve numeric := 0;
  v_buying_power numeric := 0;
  v_transactions bigint;
  v_lots bigint;
  v_fx_bindings bigint;
  v_physical_settlements bigint;
  v_aggregate_settlements bigint;
  v_positions jsonb;
  v_result jsonb;
  v_as_of timestamptz;
  v_decimal_pattern text := '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$';
begin
  if p_run_id is null then
    raise exception 'Strategy Run is required' using errcode = '22023';
  end if;

  select * into v_account
    from public.strategy_account
   where run_id = p_run_id;
  if not found then
    raise exception 'Strategy Account is missing for Run'
      using errcode = 'P0002';
  end if;
  if v_account.live_trading or v_account.base_currency <> 'USD' then
    raise exception 'portfolio state requires a paper-only USD account'
      using errcode = '55000';
  end if;

  select * into v_head
    from public.strategy_ledger_head
   where strategy_account_id = v_account.strategy_account_id;
  if not found then
    raise exception 'Strategy Account ledger head is missing'
      using errcode = 'P0002';
  end if;

  select count(*) into v_transactions
    from public.accounting_transaction
   where strategy_account_id = v_account.strategy_account_id;
  select count(*) into v_lots
    from public.position_lot_origin
   where strategy_account_id = v_account.strategy_account_id;
  select count(*) into v_fx_bindings
    from public.position_lot_acquisition_fx
   where strategy_account_id = v_account.strategy_account_id;
  select count(*) into v_physical_settlements
    from public.paper_fill_settlement
   where strategy_account_id = v_account.strategy_account_id;
  select coalesce(sum(
    jsonb_array_length(cycle#>'{s1,settlements}')
      + jsonb_array_length(cycle#>'{s2,settlements}')
  ), 0) into v_aggregate_settlements
    from public.accepted_target_cycle
   where strategy_account_id = v_account.strategy_account_id;

  if v_transactions <> v_head.accounting_transaction_count
    or v_lots <> v_head.lot_origin_count
    or v_fx_bindings <> v_head.acquisition_fx_binding_count
    or v_physical_settlements + v_aggregate_settlements
      <> v_head.settlement_count
  then
    raise exception 'ledger integrity counters diverged from persisted state'
      using errcode = '55000';
  end if;
  if v_lots <> v_fx_bindings or exists (
    select 1
      from public.position_lot_origin as lot
     where lot.strategy_account_id = v_account.strategy_account_id
       and not exists (
         select 1
           from public.position_lot_acquisition_fx as binding
          where binding.lot_origin_id = lot.lot_origin_id
            and binding.strategy_account_id = lot.strategy_account_id
            and binding.instrument_id = lot.instrument_id
       )
  ) then
    raise exception 'portfolio contains a lot without acquisition FX evidence'
      using errcode = '55000';
  end if;

  select * into v_latest_cycle
    from public.accepted_target_cycle
   where strategy_account_id = v_account.strategy_account_id
   order by completed_at desc, source_stream_seq desc, cycle_id desc
   limit 1;

  if found then
    -- A later physical or aggregate mutation that is not represented by this
    -- artifact must never be hidden behind an older portfolio projection.
    if v_latest_cycle.cycle#>>'{finalLedgerHead,sequence}'
         is distinct from v_head.head_sequence::text
      or v_latest_cycle.cycle#>>'{finalLedgerHead,sha256}'
         is distinct from v_head.head_sha256
    then
      raise exception 'latest accepted cycle does not bind the durable head'
        using errcode = '55000';
    end if;
    if jsonb_typeof(v_latest_cycle.cycle->'positions') <> 'array'
      or jsonb_typeof(v_latest_cycle.cycle#>'{ledger,balances}') <> 'array'
      or jsonb_typeof(v_latest_cycle.cycle#>'{ledger,positions}') <> 'array'
    then
      raise exception 'latest accepted cycle has no replayable portfolio'
        using errcode = '55000';
    end if;

    -- Validate string scalars before any cast.  The accepted-cycle table
    -- already forbids JSON numbers; this adds the portfolio conservation fence.
    if exists (
      select 1
        from jsonb_array_elements(v_latest_cycle.cycle->'positions') as item(value)
       where jsonb_typeof(item.value) <> 'object'
          or not (item.value ?& array[
            'instrumentId', 'symbol', 'quantity', 'grossCost', 'lots',
            'acquisitionFxBindings'
          ]::text[])
          or (select count(*) from jsonb_object_keys(item.value)) <> 6
          or item.value->>'instrumentId'
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          or item.value->>'symbol' !~ '^[A-Z][A-Z0-9.-]{0,14}$'
          or item.value->>'quantity' !~ '^(0|[1-9][0-9]*)$'
          or item.value->>'grossCost' !~ v_decimal_pattern
          or jsonb_typeof(item.value->'lots') <> 'array'
          or jsonb_typeof(item.value->'acquisitionFxBindings') <> 'array'
    ) or exists (
      select 1
        from jsonb_array_elements(v_latest_cycle.cycle#>'{ledger,balances}') as item(value)
       where jsonb_typeof(item.value) <> 'object'
          or not (item.value ?& array[
            'accountId', 'accountKind', 'currency', 'amount'
          ]::text[])
          or item.value->>'amount' !~ '^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    ) or exists (
      select 1
        from jsonb_array_elements(v_latest_cycle.cycle#>'{ledger,positions}') as item(value)
       where jsonb_typeof(item.value) <> 'object'
          or not (item.value ?& array['accountId', 'instrumentId', 'quantity']::text[])
          or item.value->>'quantity' !~ '^(0|[1-9][0-9]*)$'
    ) then
      raise exception 'latest accepted cycle portfolio has invalid scalar state'
        using errcode = '55000';
    end if;

    if exists (
      select 1
        from jsonb_array_elements(v_latest_cycle.cycle->'positions') as item(value)
       where jsonb_array_length(item.value->'lots')
             <> jsonb_array_length(item.value->'acquisitionFxBindings')
          or exists (
            select 1
              from jsonb_array_elements(item.value->'lots') as lot(value)
             where jsonb_typeof(lot.value) <> 'object'
                or not (lot.value ?& array[
                  'lotId', 'instrumentId', 'acquisitionSequence', 'quantity',
                  'grossPurchasePrice', 'buyFees'
                ]::text[])
                or lot.value->>'instrumentId'
                   is distinct from item.value->>'instrumentId'
                or lot.value->>'quantity' !~ v_decimal_pattern
                or lot.value->>'grossPurchasePrice' !~ v_decimal_pattern
                or lot.value->>'buyFees' !~ v_decimal_pattern
          )
          or coalesce((
            select sum((lot.value->>'quantity')::numeric)
              from jsonb_array_elements(item.value->'lots') as lot(value)
          ), 0) <> (item.value->>'quantity')::numeric
          or coalesce((
            select sum((lot.value->>'grossPurchasePrice')::numeric)
              from jsonb_array_elements(item.value->'lots') as lot(value)
          ), 0) <> (item.value->>'grossCost')::numeric
          or coalesce((
            select sum((entry.value->>'quantity')::numeric)
              from jsonb_array_elements(
                v_latest_cycle.cycle#>'{ledger,positions}'
              ) as entry(value)
             where entry.value->>'accountId' = 'securities.inventory'
               and entry.value->>'instrumentId' = item.value->>'instrumentId'
          ), 0) <> (item.value->>'quantity')::numeric
    ) or exists (
      select 1
        from jsonb_array_elements(
          v_latest_cycle.cycle#>'{ledger,positions}'
        ) as entry(value)
       where entry.value->>'accountId' = 'securities.inventory'
         and (entry.value->>'quantity')::numeric > 0
         and not exists (
           select 1
             from jsonb_array_elements(
               v_latest_cycle.cycle->'positions'
             ) as item(value)
            where item.value->>'instrumentId'
              = entry.value->>'instrumentId'
              and item.value->>'quantity' = entry.value->>'quantity'
         )
    ) then
      raise exception 'latest accepted cycle positions do not reconcile'
        using errcode = '55000';
    end if;

    if (
      select count(*)
        from jsonb_array_elements(v_latest_cycle.cycle#>'{ledger,balances}') as item(value)
       where item.value->>'accountId' = 'asset.cash'
         and item.value->>'currency' = v_account.base_currency
    ) > 1 then
      raise exception 'latest accepted cycle has duplicate cash balances'
        using errcode = '55000';
    end if;
    select coalesce((item.value->>'amount')::numeric, 0) into v_cash
      from jsonb_array_elements(v_latest_cycle.cycle#>'{ledger,balances}') as item(value)
     where item.value->>'accountId' = 'asset.cash'
       and item.value->>'currency' = v_account.base_currency;
    v_cash := coalesce(v_cash, 0);

    -- Find the last actual settlement even when the most recent decision was a
    -- no-op HOLD cycle.  This preserves the reserved-tax buying-power fence.
    select settlement.value into v_last_settlement
      from public.accepted_target_cycle as cycle
      cross join lateral (
        select staged.value
          from (
            select item.value, 2 as stage_order, item.ordinality
              from jsonb_array_elements(cycle.cycle#>'{s2,settlements}')
                with ordinality as item(value, ordinality)
            union all
            select item.value, 1 as stage_order, item.ordinality
              from jsonb_array_elements(cycle.cycle#>'{s1,settlements}')
                with ordinality as item(value, ordinality)
          ) as staged
         order by staged.stage_order desc, staged.ordinality desc
         limit 1
      ) as settlement
     where cycle.strategy_account_id = v_account.strategy_account_id
     order by cycle.completed_at desc, cycle.source_stream_seq desc, cycle.cycle_id desc
     limit 1;
    if v_last_settlement is not null then
      if jsonb_typeof(v_last_settlement#>'{intent,balanceTransition}') <> 'object'
        or v_last_settlement#>>'{intent,balanceTransition,cashAssetBalanceAfter}'
          !~ v_decimal_pattern
        or v_last_settlement#>>'{intent,balanceTransition,taxReserveAfter}'
          !~ v_decimal_pattern
        or v_last_settlement#>>'{intent,balanceTransition,buyingPowerAfter}'
          !~ v_decimal_pattern
      then
        raise exception 'accepted cycle has no replayable balance transition'
          using errcode = '55000';
      end if;
      v_tax_reserve := (
        v_last_settlement#>>'{intent,balanceTransition,taxReserveAfter}'
      )::numeric;
      v_buying_power := (
        v_last_settlement#>>'{intent,balanceTransition,buyingPowerAfter}'
      )::numeric;
      if v_cash is distinct from (
          v_last_settlement#>>'{intent,balanceTransition,cashAssetBalanceAfter}'
        )::numeric
        or v_buying_power is distinct from v_cash - v_tax_reserve
      then
        raise exception 'accepted cycle cash and reserve do not reconcile'
          using errcode = '55000';
      end if;
    else
      v_tax_reserve := 0;
      v_buying_power := v_cash;
    end if;

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'instrumentId', position.instrument_id,
        'symbol', position.symbol,
        'quantity', public.accounting_decimal_text(position.quantity),
        'grossCost', public.accounting_decimal_text(position.gross_cost),
        'taxBasis', public.accounting_decimal_text(position.tax_basis),
        'currency', v_account.base_currency,
        'lotCount', position.lot_count::text
      ) order by position.symbol, position.instrument_id
    ), '[]'::jsonb) into v_positions
      from (
        select
          item.value->>'instrumentId' as instrument_id,
          item.value->>'symbol' as symbol,
          (item.value->>'quantity')::numeric as quantity,
          (item.value->>'grossCost')::numeric as gross_cost,
          coalesce((
            select sum(
              (lot.value->>'grossPurchasePrice')::numeric
                + (lot.value->>'buyFees')::numeric
            )
              from jsonb_array_elements(item.value->'lots') as lot(value)
          ), 0) as tax_basis,
          jsonb_array_length(item.value->'lots') as lot_count
        from jsonb_array_elements(v_latest_cycle.cycle->'positions') as item(value)
        where (item.value->>'quantity')::numeric > 0
      ) as position;
    v_as_of := v_latest_cycle.completed_at;
  else
    -- Before the first aggregate cycle, physical kernel rows are the complete
    -- state.  S1 dispositions/tax postings remain unsupported on this legacy
    -- path because original-lot quantities are immutable origins, not balances.
    if exists (
      select 1
        from public.accounting_transaction
       where strategy_account_id = v_account.strategy_account_id
         and transaction_type in ('sell_fill', 'corporate_action', 'adjustment')
    ) then
      raise exception 'current portfolio reader cannot project lot dispositions'
        using errcode = '0A000';
    end if;
    if exists (
      select 1
        from public.accounting_posting
       where strategy_account_id = v_account.strategy_account_id
         and account_code = 'liability.china_tax_accrual'
    ) then
      raise exception 'current portfolio reader cannot project a trading-currency tax reserve'
        using errcode = '0A000';
    end if;

    select coalesce(sum(
      case posting.side when 'debit' then posting.amount else -posting.amount end
    ), 0) into v_cash
      from public.accounting_posting as posting
     where posting.strategy_account_id = v_account.strategy_account_id
       and posting.account_code = 'asset.cash'
       and posting.currency = v_account.base_currency;
    if v_cash < 0 then
      raise exception 'portfolio ledger has negative settled cash'
        using errcode = '55000';
    end if;
    v_tax_reserve := 0;
    v_buying_power := v_cash;

    if exists (
      select 1
        from public.position_lot_origin as lot
       where lot.strategy_account_id = v_account.strategy_account_id
         and not exists (
           select 1
             from public.instrument_symbol_version as symbol
            where symbol.instrument_id = lot.instrument_id
              and symbol.effective_from <= (v_head.updated_at at time zone 'UTC')::date
              and (
                symbol.effective_to is null
                or symbol.effective_to > (v_head.updated_at at time zone 'UTC')::date
              )
         )
    ) then
      raise exception 'portfolio instrument has no effective symbol at ledger head'
        using errcode = '55000';
    end if;

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'instrumentId', position.instrument_id::text,
        'symbol', position.symbol,
        'quantity', public.accounting_decimal_text(position.quantity),
        'grossCost', public.accounting_decimal_text(position.gross_cost),
        'taxBasis', public.accounting_decimal_text(position.tax_basis),
        'currency', position.currency,
        'lotCount', position.lot_count::text
      ) order by position.symbol, position.instrument_id::text
    ), '[]'::jsonb) into v_positions
      from (
        select
          lot.instrument_id,
          symbol.symbol,
          lot.currency,
          sum(lot.original_quantity) as quantity,
          sum(lot.purchase_price_total) as gross_cost,
          sum(lot.tax_basis) as tax_basis,
          count(*) as lot_count
        from public.position_lot_origin as lot
        join lateral (
          select version.symbol
            from public.instrument_symbol_version as version
           where version.instrument_id = lot.instrument_id
             and version.effective_from
               <= (v_head.updated_at at time zone 'UTC')::date
             and (
               version.effective_to is null
               or version.effective_to
                 > (v_head.updated_at at time zone 'UTC')::date
             )
           order by version.effective_from desc, version.symbol_version_id
           limit 1
        ) as symbol on true
       where lot.strategy_account_id = v_account.strategy_account_id
       group by lot.instrument_id, symbol.symbol, lot.currency
      ) as position;
    v_as_of := v_head.updated_at;
  end if;

  v_result := jsonb_build_object(
    'schema', 'twofold.strategy_portfolio_state/v1',
    'strategyAccountId', v_account.strategy_account_id::text,
    'runId', v_account.run_id::text,
    'asOf', to_char(
      v_as_of at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'account', jsonb_build_object(
      'accountCode', v_account.account_code,
      'broker', v_account.broker,
      'brokerRegion', v_account.broker_region,
      'baseCurrency', v_account.base_currency,
      'liveTrading', false
    ),
    'ledgerHead', jsonb_build_object(
      'sequence', v_head.head_sequence::text,
      'sha256', v_head.head_sha256,
      'accountingTransactionCount',
        v_head.accounting_transaction_count::text,
      'lotOriginCount', v_head.lot_origin_count::text,
      'acquisitionFxBindingCount',
        v_head.acquisition_fx_binding_count::text,
      'settlementCount', v_head.settlement_count::text
    ),
    'cash', jsonb_build_object(
      'settled', public.accounting_decimal_text(v_cash),
      'taxReserve', public.accounting_decimal_text(v_tax_reserve),
      'buyingPower', public.accounting_decimal_text(v_buying_power)
    ),
    'positions', v_positions
  );
  if public.jsonb_contains_number(v_result) then
    raise exception 'portfolio state crossed the string-decimal boundary'
      using errcode = '55000';
  end if;
  return v_result;
end;
$$;

comment on function public.get_strategy_portfolio_state(uuid) is
  'Returns one paper portfolio from the latest Core aggregate cycle or, before the first cycle, the physical accounting kernel; all values remain exact strings.';

revoke all on function public.get_strategy_portfolio_state(uuid)
  from public, anon, authenticated;
grant execute on function public.get_strategy_portfolio_state(uuid)
  to service_role;

commit;
