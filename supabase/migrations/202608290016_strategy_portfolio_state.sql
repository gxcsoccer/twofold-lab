-- One statement-level, string-decimal view of the durable Strategy Account.
-- The Agent must never receive a hand-built or floating-point portfolio. The
-- ledger head, balances, lots, symbols, and integrity counters are read under
-- one PostgreSQL statement snapshot and emitted without JSON number tokens.

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
  v_cash numeric;
  v_transactions bigint;
  v_lots bigint;
  v_fx_bindings bigint;
  v_settlements bigint;
  v_positions jsonb;
  v_result jsonb;
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
  select count(*) into v_settlements
    from public.paper_fill_settlement
   where strategy_account_id = v_account.strategy_account_id;

  if v_transactions <> v_head.accounting_transaction_count
    or v_lots <> v_head.lot_origin_count
    or v_fx_bindings <> v_head.acquisition_fx_binding_count
    or v_settlements <> v_head.settlement_count
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

  -- Migration 009 deliberately persists only BUY settlements. Until the
  -- general S1 SELL/FIFO settlement lands, refusing quantity-changing journal
  -- types is safer than presenting original lot quantities as current ones.
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

  v_result := jsonb_build_object(
    'schema', 'twofold.strategy_portfolio_state/v1',
    'strategyAccountId', v_account.strategy_account_id::text,
    'runId', v_account.run_id::text,
    'asOf', to_char(
      v_head.updated_at at time zone 'UTC',
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
      'taxReserve', '0',
      'buyingPower', public.accounting_decimal_text(v_cash)
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
  'Returns one ledger-head-bound paper portfolio without JSON numeric tokens; v1 fails closed before projecting persisted dispositions.';

revoke all on function public.get_strategy_portfolio_state(uuid)
  from public, anon, authenticated;
grant execute on function public.get_strategy_portfolio_state(uuid)
  to service_role;

commit;
