-- Agent-facing portfolio state contract. Every fixture rolls back.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(15);

select has_function(
  'public', 'get_strategy_portfolio_state', array['uuid'],
  'one statement-level Strategy portfolio reader exists'
);
select is(
  (select prosecdef from pg_proc
    where oid = 'public.get_strategy_portfolio_state(uuid)'::regprocedure),
  true,
  'portfolio reader owns the private-table read boundary'
);
select ok(
  has_function_privilege(
    'service_role', 'public.get_strategy_portfolio_state(uuid)', 'EXECUTE'
  ),
  'service worker may read a Strategy portfolio'
);
select ok(
  not has_function_privilege(
    'anon', 'public.get_strategy_portfolio_state(uuid)', 'EXECUTE'
  ),
  'anonymous callers cannot read a private Strategy portfolio'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.get_strategy_portfolio_state(uuid)', 'EXECUTE'
  ),
  'authenticated clients cannot bypass the private worker'
);

select public.register_run_manifest(
  'portfolio-state-contract:run',
  'b1000000-0000-4000-8000-000000000001',
  'twofold.run_manifest/v1',
  '{"engine_version":"portfolio-state-contract-v1","lot_method":"FIFO"}',
  'portfolio-state-contract', repeat('1', 64)
);

insert into public.strategy_account (
  strategy_account_id, idempotency_key, run_id, account_code, broker,
  broker_region, base_currency, live_trading, metadata, recorded_by
) values (
  'b2000000-0000-4000-8000-000000000001',
  'portfolio-state-contract:account',
  'b1000000-0000-4000-8000-000000000001',
  'portfolio-state-contract', 'TWOFOLD_PAPER', 'US', 'USD', false,
  '{"fixture":"cash-only"}', 'portfolio-state-contract'
);

insert into public.accounting_transaction (
  accounting_transaction_id, idempotency_key, strategy_account_id,
  transaction_type, source_event_key, event_time, effective_date,
  settlement_date, description, posting_manifest, posting_manifest_sha256,
  metadata, recorded_by
) values (
  'b3000000-0000-4000-8000-000000000001',
  'portfolio-state-contract:opening',
  'b2000000-0000-4000-8000-000000000001',
  'opening_balance', 'portfolio-state-contract:opening',
  '2026-08-28T20:00:00.000Z', '2026-08-28', '2026-08-28',
  'Contract opening cash',
  '[{"account_code":"asset.cash","amount":"1000","side":"debit"},{"account_code":"equity.opening_balance","amount":"1000","side":"credit"}]',
  repeat('2', 64), '{}', 'portfolio-state-contract'
);
insert into public.accounting_posting (
  accounting_transaction_id, strategy_account_id, posting_index,
  account_code, side, amount, currency
) values
  (
    'b3000000-0000-4000-8000-000000000001',
    'b2000000-0000-4000-8000-000000000001', 0,
    'asset.cash', 'debit', 1000, 'USD'
  ),
  (
    'b3000000-0000-4000-8000-000000000001',
    'b2000000-0000-4000-8000-000000000001', 1,
    'equity.opening_balance', 'credit', 1000, 'USD'
  );
insert into public.strategy_ledger_head (
  strategy_account_id, head_sequence, head_sha256,
  accounting_transaction_count, lot_origin_count,
  acquisition_fx_binding_count, settlement_count, genesis_manifest,
  genesis_manifest_sha256, initialized_by, initialized_at, updated_at
) values (
  'b2000000-0000-4000-8000-000000000001', 0, repeat('3', 64),
  1, 0, 0, 0, '{"schema":"portfolio-state-contract/v1"}',
  repeat('4', 64), 'portfolio-state-contract',
  '2026-08-28T20:00:00.000Z', '2026-08-28T20:00:00.000Z'
);

set local role service_role;
create temporary table portfolio_state_result on commit drop as
select public.get_strategy_portfolio_state(
  'b1000000-0000-4000-8000-000000000001'
) as value;
reset role;

select is(
  (select value->>'schema' from portfolio_state_result),
  'twofold.strategy_portfolio_state/v1',
  'portfolio schema is explicit and versioned'
);
select is(
  (select value->>'runId' from portfolio_state_result),
  'b1000000-0000-4000-8000-000000000001',
  'portfolio remains bound to the requested stable Run'
);
select is(
  (select value#>>'{ledgerHead,sequence}' from portfolio_state_result),
  '0',
  'portfolio is bound to the exact ledger sequence'
);
select is(
  (select value#>>'{ledgerHead,corporateActionMutationCount}'
     from portfolio_state_result),
  '0',
  'portfolio exposes corporate-action mutations separately from settlements'
);
select is(
  (select value#>>'{cash,settled}' from portfolio_state_result),
  '1000',
  'settled cash crosses PostgREST as a decimal string'
);
select is(
  (select value#>>'{cash,buyingPower}' from portfolio_state_result),
  '1000',
  'buying power reconciles to cash less reserve'
);
select is(
  (select jsonb_array_length(value->'positions') from portfolio_state_result),
  0,
  'a valid cash-only account has an explicit empty position list'
);
select ok(
  not public.jsonb_contains_number(
    (select value from portfolio_state_result)
  ),
  'portfolio output contains no JSON number tokens'
);

set local role anon;
select throws_ok(
  $$select public.get_strategy_portfolio_state(
    'b1000000-0000-4000-8000-000000000001'
  )$$,
  '42501', null,
  'anonymous callers cannot invoke the portfolio reader'
);
reset role;

set local role service_role;
select throws_ok(
  $$select public.get_strategy_portfolio_state(
    'b1000000-0000-4000-8000-000000000099'
  )$$,
  'P0002', 'Strategy Account is missing for Run',
  'a missing stable Run fails closed'
);
reset role;

select * from finish();
rollback;
