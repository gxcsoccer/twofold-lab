-- Evidence-bound competition genesis contract. Every fixture rolls back.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(27);

create or replace function pg_temp.genesis_sha256(p_value text)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select encode(digest(convert_to(p_value, 'UTF8'), 'sha256'), 'hex')
$$;

create or replace function pg_temp.lulu_genesis_state()
returns jsonb
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'twofold.competition_economic_state/v1',
    'genesisId', 'season-one:lulu-150',
    'seasonId', '91000000-0000-4000-8000-000000000001',
    'openingStateArtifactId', '92000000-0000-4000-8000-000000000001',
    'snapshot', jsonb_build_object(
      'snapshotId', 'season-one:lulu-150',
      'schema', 'twofold.initial_portfolio/v1',
      'asOf', '2026-08-28T21:00:00.000Z',
      'brokerLegalEntity', 'FUTU_HK',
      'accountRegion', 'HK',
      'baseCurrency', 'USD',
      'sourceArtifactSha256', repeat('a', 64),
      'cashBalances', '[]'::jsonb,
      'lots', jsonb_build_array(jsonb_build_object(
        'lotId', 'lulu-genesis-lot',
        'instrumentId', '93000000-0000-4000-8000-000000000001',
        'symbol', 'TFGEN',
        'acquiredOn', '2026-08-28',
        'acquisitionSequence', '1',
        'quantity', '150',
        'purchasePricePerShare', '318.5',
        'grossPurchasePrice', '47775',
        'buyFees', '0',
        'taxBasis', '47775',
        'currency', 'USD'
      ))
    ),
    'acquisitionFxBindings', jsonb_build_array(jsonb_build_object(
      'lotId', 'lulu-genesis-lot',
      'instrumentId', '93000000-0000-4000-8000-000000000001',
      'effectiveDate', '2026-08-28',
      'cnyPerUsd', '7.1234',
      'acquisitionTaxBasisCny', '340320.435',
      'authority', 'ECB_REFERENCE_CROSS',
      'sourceArtifactId', '94000000-0000-4000-8000-000000000001',
      'sourceSha256', repeat('b', 64),
      'observedAt', '2026-08-28T15:59:00.000Z',
      'availableAt', '2026-08-28T16:00:00.000Z'
    ))
  )
$$;

select has_table(
  'public', 'competition_genesis',
  'season economic genesis is durable'
);
select has_function(
  'public', 'initialize_competition_strategy_account',
  array['text', 'uuid', 'text', 'text', 'text', 'text', 'text', 'text'],
  'one atomic pre-positioned account boundary exists'
);

select public.register_run_manifest(
  'competition-genesis-contract:run:one',
  '95000000-0000-4000-8000-000000000001',
  'twofold.run_manifest/v1',
  '{"engine_version":"competition-contract-v1","lot_method":"FIFO"}'::jsonb,
  'competition-genesis-contract',
  repeat('1', 64)
);
select public.register_run_manifest(
  'competition-genesis-contract:run:two',
  '95000000-0000-4000-8000-000000000002',
  'twofold.run_manifest/v1',
  '{"engine_version":"competition-contract-v1","lot_method":"FIFO"}'::jsonb,
  'competition-genesis-contract',
  repeat('2', 64)
);
select public.register_run_manifest(
  'competition-genesis-contract:run:bad',
  '95000000-0000-4000-8000-000000000003',
  'twofold.run_manifest/v1',
  '{"engine_version":"competition-contract-v1","lot_method":"FIFO"}'::jsonb,
  'competition-genesis-contract',
  repeat('3', 64)
);

select public.register_arena_season(
  'competition-genesis-contract:season',
  '91000000-0000-4000-8000-000000000001',
  'competition-genesis-contract',
  'Competition Genesis Contract',
  '2026-08-28T20:00:00.000Z',
  '2026-09-28T20:00:00.000Z',
  'US_EQUITY_DAILY_AFTER_CLOSE',
  'America/New_York',
  '{"fixture":"competition-genesis"}',
  'competition-genesis-contract'
);

select public.register_instrument(
  'competition-genesis-contract:instrument:lulu',
  '93000000-0000-4000-8000-000000000001',
  'common_stock', 'NASDAQ', 'USD', 'US',
  '{"issuer":"lululemon athletica inc."}'::jsonb,
  'competition-genesis-contract'
);
select public.register_instrument_symbol_version(
  'competition-genesis-contract:symbol:lulu',
  '93000000-0000-4000-8000-000000000001',
  'TFGEN', 'NASDAQ', '2026-01-01', null,
  '{"source":"competition-contract"}'::jsonb,
  'competition-genesis-contract'
);

insert into public.artifact_metadata (
  artifact_id, idempotency_key, season_id, artifact_kind, storage_bucket,
  object_path, content_type, byte_size, sha256, created_by, metadata
) values
  (
    '92000000-0000-4000-8000-000000000001',
    'competition-genesis-contract:opening-state',
    '91000000-0000-4000-8000-000000000001',
    'paper_account_opening_state', 'twofold-private-artifacts',
    'contract/competition/opening-state.json', 'application/json', 1,
    repeat('a', 64), 'competition-genesis-contract', '{}'
  ),
  (
    '94000000-0000-4000-8000-000000000001',
    'competition-genesis-contract:fx-source',
    '91000000-0000-4000-8000-000000000001',
    'official_tax_fx_rate', 'twofold-private-artifacts',
    'contract/competition/fx-source.json', 'application/json', 1,
    repeat('b', 64), 'competition-genesis-contract', '{}'
  );

create temporary table competition_genesis_fixture as
select
  pg_temp.lulu_genesis_state()::text as body,
  pg_temp.genesis_sha256(pg_temp.lulu_genesis_state()::text) as sha;
grant select on competition_genesis_fixture to service_role;

set local role service_role;
create temporary table competition_genesis_run_one as
select public.initialize_competition_strategy_account(
  'competition-genesis-contract:account:one',
  '95000000-0000-4000-8000-000000000001',
  'twofold', 'FUTU_HK', 'HK', body, sha,
  'competition-genesis-contract'
) as result
from competition_genesis_fixture;
create temporary table competition_genesis_run_two as
select public.initialize_competition_strategy_account(
  'competition-genesis-contract:account:two',
  '95000000-0000-4000-8000-000000000002',
  'twofold-orchestrator', 'FUTU_HK', 'HK', body, sha,
  'competition-genesis-contract'
) as result
from competition_genesis_fixture;
reset role;

select is(
  (select result->>'schema' from competition_genesis_run_one),
  'twofold.competition_strategy_account_result/v1',
  'atomic initializer returns the frozen result schema'
);
select is(
  (select result->>'economicStateSha256' from competition_genesis_run_one),
  (select sha from competition_genesis_fixture),
  'run one is bound to the exact economic bytes'
);
select is(
  (select result->>'economicStateSha256' from competition_genesis_run_two),
  (select sha from competition_genesis_fixture),
  'run two is bound to the same economic bytes'
);
select is(
  (select result->>'competitionGenesisId' from competition_genesis_run_one),
  (select result->>'competitionGenesisId' from competition_genesis_run_two),
  'all contestants share one immutable competition genesis'
);
select isnt(
  (select result->>'strategyAccountId' from competition_genesis_run_one),
  (select result->>'strategyAccountId' from competition_genesis_run_two),
  'each contestant receives an isolated Strategy Account'
);
select is(
  (select count(*) from public.competition_genesis
    where season_id = '91000000-0000-4000-8000-000000000001'),
  1::bigint,
  'two account initializations create one season genesis row'
);
select is(
  (select count(*) from public.position_lot_origin
    where origin_reference = 'lulu-genesis-lot'
      and original_quantity = 150
      and unit_purchase_price = 318.5),
  2::bigint,
  'each account starts with exactly 150 contract shares at one basis price'
);
select is(
  (select count(*) from public.accounting_posting
    where account_code = 'securities.inventory'
      and amount = 47775
      and instrument_id = '93000000-0000-4000-8000-000000000001'),
  2::bigint,
  'each isolated ledger debits the same opening contract position cost'
);
select is(
  (select count(*) from public.accounting_posting
    where strategy_account_id in (
      select strategy_account_id from public.strategy_account
       where idempotency_key like 'competition-genesis-contract:account:%'
    ) and account_code in ('asset.cash', 'asset.cash.unsettled')),
  0::bigint,
  'the agreed competition genesis has no opening cash'
);
select is(
  (select count(*) from public.position_lot_acquisition_fx
    where cny_per_usd = 7.1234
      and acquisition_tax_basis_cny = 340320.435),
  2::bigint,
  'each FIFO lot freezes the same acquisition CNY tax basis'
);
select is(
  (select count(*) from public.strategy_ledger_head
    where strategy_account_id in (
      select strategy_account_id from public.strategy_account
       where run_id in (
         '95000000-0000-4000-8000-000000000001',
         '95000000-0000-4000-8000-000000000002'
       )
    ) and accounting_transaction_count = 1
      and lot_origin_count = 1
      and acquisition_fx_binding_count = 1
      and settlement_count = 0
      and head_sequence = 0),
  2::bigint,
  'both ledger heads reconcile their opening transactions, lots, and FX'
);
select is(
  (select count(distinct head.genesis_manifest->>'competitionGenesisSha256')
    from public.strategy_ledger_head as head
    join public.strategy_account as account
      on account.strategy_account_id = head.strategy_account_id
   where account.run_id in (
     '95000000-0000-4000-8000-000000000001',
     '95000000-0000-4000-8000-000000000002'
   )),
  1::bigint,
  'isolated heads retain the same economic fairness fingerprint'
);
select ok(
  not public.jsonb_contains_number(
    (select result from competition_genesis_run_one)
  ),
  'the initializer response contains no JSON number tokens'
);
select is(
  (
    select public.initialize_competition_strategy_account(
      'competition-genesis-contract:account:one',
      '95000000-0000-4000-8000-000000000001',
      'twofold', 'FUTU_HK', 'HK', body, sha,
      'competition-genesis-contract'
    )->'head'->>'headSha256'
    from competition_genesis_fixture
  ),
  (select result->'head'->>'headSha256' from competition_genesis_run_one),
  'an exact retry returns the original ledger head'
);
select throws_ok(
  $$select public.initialize_competition_strategy_account(
      'competition-genesis-contract:account:one',
      '95000000-0000-4000-8000-000000000001',
      'twofold', 'FUTU_HK', 'HK', body, sha, 'different-recorder'
    ) from competition_genesis_fixture$$,
  '23505',
  'competition genesis identity was reused with different content',
  'retry identity cannot change the immutable recorder'
);
select throws_ok(
  $$select public.initialize_competition_strategy_account(
      'competition-genesis-contract:account:bad',
      '95000000-0000-4000-8000-000000000003',
      'bad', 'FUTU_HK', 'HK', body, repeat('0', 64),
      'competition-genesis-contract'
    ) from competition_genesis_fixture$$,
  '22023',
  'competition economic-state SHA256 does not match exact bytes',
  'a bad economic digest fails before any account state is written'
);
select is(
  (select count(*) from public.strategy_account
    where idempotency_key = 'competition-genesis-contract:account:bad'),
  0::bigint,
  'failed genesis leaves no partial Strategy Account'
);
select throws_ok(
  $$update public.competition_genesis set genesis_key = 'mutated'$$,
  '55000',
  'competition_genesis is append-only; append a compensating or superseding record instead',
  'competition genesis is immutable even for the owner'
);

set local role anon;
select throws_ok(
  $$select public.initialize_competition_strategy_account(
      'anon', '95000000-0000-4000-8000-000000000003', 'anon',
      'FUTU_HK', 'HK', '{}', repeat('0', 64), 'anon'
    )$$,
  '42501', null,
  'anonymous callers cannot initialize competition accounts'
);
select throws_ok(
  $$select * from public.competition_genesis$$,
  '42501', null,
  'anonymous callers cannot read private competition genesis state'
);
reset role;

set local role service_role;
select throws_ok(
  $$select public.register_position_lot_origin(
    'competition-genesis-contract:orphan-lot',
    (select strategy_account_id from public.strategy_account
      where idempotency_key = 'competition-genesis-contract:account:one'),
    '93000000-0000-4000-8000-000000000001',
    'initial_import', 'orphan-lot', now(), current_date,
    1, 1, 0, 'USD', 'FIFO', '{}', 'service', repeat('0', 64), null
  )$$,
  '42501', null,
  'service role still cannot bypass atomic genesis with a standalone lot'
);
select is(
  (select count(*) from public.competition_genesis
    where season_id = '91000000-0000-4000-8000-000000000001'),
  1::bigint,
  'service role receives read-only access to the private genesis row'
);
reset role;

select is(
  (
    select economic_state_sha256 = pg_temp.genesis_sha256(
      economic_state_canonical_json
    )
    from public.competition_genesis
    where season_id = '91000000-0000-4000-8000-000000000001'
  ),
  true,
  'durable economic bytes retain their exact SHA-256 identity'
);
select is(
  (select count(*) from public.tax_fx_rate_evidence
    where run_id in (
      '95000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000002'
    ) and authority = 'ECB_REFERENCE_CROSS'),
  2::bigint,
  'tax FX evidence is cloned per run while preserving the authority'
);
select is(
  (select count(*) from public.strategy_account
    where idempotency_key like 'competition-genesis-contract:account:%'),
  2::bigint,
  'only the two successful contestant accounts exist'
);

select * from finish();
rollback;
