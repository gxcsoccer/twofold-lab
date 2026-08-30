-- Evidence-bound, pre-positioned competition genesis.
--
-- One economic state is frozen per season/genesis key. Each Strategy Run gets
-- an independent account, FIFO lot, acquisition-FX binding, opening journal,
-- and ledger head in one transaction. The service role cannot invoke the
-- constituent lot/journal primitives directly.

begin;

create table public.competition_genesis (
  competition_genesis_id uuid primary key,
  idempotency_key text not null unique check (idempotency_key <> ''),
  season_id uuid not null,
  genesis_key text not null check (genesis_key <> ''),
  opening_state_artifact_id uuid not null,
  opening_state_sha256 text not null check (
    opening_state_sha256 ~ '^[0-9a-f]{64}$'
  ),
  economic_state_canonical_json text not null check (
    economic_state_canonical_json <> ''
  ),
  economic_state jsonb not null,
  economic_state_sha256 text not null check (
    economic_state_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint competition_genesis_season_key_unique
    unique (season_id, genesis_key),
  constraint competition_genesis_artifact_fk foreign key (
    opening_state_artifact_id,
    opening_state_sha256
  ) references public.artifact_metadata(artifact_id, sha256),
  constraint competition_genesis_payload_object check (
    jsonb_typeof(economic_state) = 'object'
  ),
  constraint competition_genesis_payload_decimal_safe check (
    not public.jsonb_contains_number(economic_state)
  ),
  constraint competition_genesis_payload_exact check (
    economic_state_canonical_json::jsonb = economic_state
  ),
  constraint competition_genesis_hash_exact check (
    economic_state_sha256 = encode(
      extensions.digest(
        convert_to(economic_state_canonical_json, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  )
);

comment on table public.competition_genesis is
  'Immutable season-scoped economic starting state shared by isolated Strategy Run ledgers.';

create trigger competition_genesis_is_immutable
before update or delete on public.competition_genesis
for each row execute function public.reject_immutable_mutation();

create trigger competition_genesis_rejects_truncate
before truncate on public.competition_genesis
for each statement execute function public.reject_immutable_mutation();

create or replace function public.initialize_competition_strategy_account(
  p_account_idempotency_key text,
  p_run_id uuid,
  p_account_code text,
  p_broker text,
  p_broker_region text,
  p_economic_state_canonical_json text,
  p_economic_state_sha256 text,
  p_recorded_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_state jsonb;
  v_snapshot jsonb;
  v_cash jsonb;
  v_lot jsonb;
  v_fx jsonb;
  v_evidence jsonb;
  v_evidence_text text;
  v_evidence_sha text;
  v_computed_sha text;
  v_season_id uuid;
  v_opening_artifact_id uuid;
  v_opening_artifact public.artifact_metadata%rowtype;
  v_genesis public.competition_genesis%rowtype;
  v_account public.strategy_account%rowtype;
  v_head public.strategy_ledger_head%rowtype;
  v_lot_id uuid;
  v_tax_fx_id uuid;
  v_transaction_id uuid;
  v_journal public.accounting_transaction%rowtype;
  v_postings jsonb;
  v_metadata jsonb;
  v_as_of timestamptz;
  v_as_of_date date;
  v_acquired_on date;
  v_quantity numeric;
  v_unit_price numeric;
  v_gross numeric;
  v_fees numeric;
  v_tax_basis numeric;
  v_fx_rate numeric;
  v_acquisition_tax_basis_cny numeric;
  v_transaction_count bigint := 0;
  v_lot_count bigint := 0;
  v_fx_count bigint := 0;
  v_settled_cash numeric := 0;
  v_unsettled_cash numeric := 0;
  v_genesis_manifest jsonb;
  v_genesis_manifest_sha text;
  v_head_sha text;
begin
  if p_account_idempotency_key is null
    or btrim(p_account_idempotency_key) = ''
    or p_run_id is null
    or p_account_code is null
    or btrim(p_account_code) = ''
    or p_broker is null
    or btrim(p_broker) = ''
    or p_broker_region is null
    or btrim(p_broker_region) = ''
    or p_economic_state_canonical_json is null
    or p_economic_state_canonical_json = ''
    or p_economic_state_sha256 is null
    or p_economic_state_sha256 !~ '^[0-9a-f]{64}$'
    or p_recorded_by is null
    or btrim(p_recorded_by) = ''
  then
    raise exception 'competition account genesis requires complete identities and exact economic bytes'
      using errcode = '22023';
  end if;

  v_computed_sha := encode(
    extensions.digest(
      convert_to(p_economic_state_canonical_json, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  if v_computed_sha is distinct from p_economic_state_sha256 then
    raise exception 'competition economic-state SHA256 does not match exact bytes'
      using errcode = '22023';
  end if;

  begin
    v_state := p_economic_state_canonical_json::jsonb;
  exception when others then
    raise exception 'competition economic-state bytes are not valid JSON'
      using errcode = '22023';
  end;

  if jsonb_typeof(v_state) is distinct from 'object'
    or public.jsonb_contains_number(v_state)
    or not (v_state ?& array[
      'schema', 'genesisId', 'seasonId', 'openingStateArtifactId',
      'snapshot', 'acquisitionFxBindings'
    ]::text[])
    or (select count(*) from jsonb_object_keys(v_state)) <> 6
    or v_state->>'schema'
      is distinct from 'twofold.competition_economic_state/v1'
    or jsonb_typeof(v_state->'genesisId') is distinct from 'string'
    or btrim(v_state->>'genesisId') = ''
    or jsonb_typeof(v_state->'seasonId') is distinct from 'string'
    or jsonb_typeof(v_state->'openingStateArtifactId')
      is distinct from 'string'
    or jsonb_typeof(v_state->'snapshot') is distinct from 'object'
    or jsonb_typeof(v_state->'acquisitionFxBindings')
      is distinct from 'array'
  then
    raise exception 'competition economic state has an invalid v1 envelope'
      using errcode = '22023';
  end if;

  begin
    v_season_id := (v_state->>'seasonId')::uuid;
    v_opening_artifact_id := (v_state->>'openingStateArtifactId')::uuid;
  exception when others then
    raise exception 'competition season and opening artifact identities must be UUIDs'
      using errcode = '22023';
  end;

  v_snapshot := v_state->'snapshot';
  if not (v_snapshot ?& array[
      'snapshotId', 'schema', 'asOf', 'brokerLegalEntity', 'accountRegion',
      'baseCurrency', 'sourceArtifactSha256', 'cashBalances', 'lots'
    ]::text[])
    or (select count(*) from jsonb_object_keys(v_snapshot)) <> 9
    or v_snapshot->>'schema' is distinct from 'twofold.initial_portfolio/v1'
    or v_snapshot->>'snapshotId' is distinct from v_state->>'genesisId'
    or v_snapshot->>'brokerLegalEntity' is distinct from p_broker
    or v_snapshot->>'accountRegion' is distinct from p_broker_region
    or v_snapshot->>'baseCurrency' is distinct from 'USD'
    or (v_snapshot->>'sourceArtifactSha256') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(v_snapshot->'cashBalances') is distinct from 'array'
    or jsonb_typeof(v_snapshot->'lots') is distinct from 'array'
    or jsonb_array_length(v_snapshot->'lots') = 0
  then
    raise exception 'competition snapshot must be a non-empty pre-positioned USD v1 portfolio'
      using errcode = '22023';
  end if;

  begin
    v_as_of := (v_snapshot->>'asOf')::timestamptz;
  exception when others then
    raise exception 'competition snapshot asOf must be an ISO timestamp'
      using errcode = '22023';
  end;
  if v_snapshot->>'asOf' !~ (
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:'
      || '[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    )
  then
    raise exception 'competition snapshot asOf must be canonical UTC milliseconds'
      using errcode = '22023';
  end if;
  v_as_of_date := (v_as_of at time zone 'UTC')::date;

  select * into v_opening_artifact
    from public.artifact_metadata
   where artifact_id = v_opening_artifact_id
     and sha256 = v_snapshot->>'sourceArtifactSha256'
     and season_id = v_season_id
     and artifact_kind = 'paper_account_opening_state';
  if not found then
    raise exception 'competition opening-state artifact/hash/season binding is invalid'
      using errcode = '23503';
  end if;

  if not exists (
    select 1 from public.run_manifest where run_id = p_run_id
  ) then
    raise exception 'competition Strategy Run manifest does not exist'
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('twofold-competition-genesis:' || p_run_id::text, 0)
  );

  select * into v_genesis
    from public.competition_genesis
   where (season_id = v_season_id and genesis_key = v_state->>'genesisId')
      or economic_state_sha256 = p_economic_state_sha256
   order by (
     season_id = v_season_id and genesis_key = v_state->>'genesisId'
   ) desc
   limit 1;

  if found then
    if v_genesis.season_id is distinct from v_season_id
      or v_genesis.genesis_key is distinct from v_state->>'genesisId'
      or v_genesis.opening_state_artifact_id
        is distinct from v_opening_artifact_id
      or v_genesis.opening_state_sha256
        is distinct from v_snapshot->>'sourceArtifactSha256'
      or v_genesis.economic_state_canonical_json
        is distinct from p_economic_state_canonical_json
      or v_genesis.economic_state is distinct from v_state
      or v_genesis.economic_state_sha256
        is distinct from p_economic_state_sha256
      or v_genesis.recorded_by is distinct from p_recorded_by
    then
      raise exception 'competition genesis identity was reused with different content'
        using errcode = '23505';
    end if;
  else
    insert into public.competition_genesis (
      competition_genesis_id,
      idempotency_key,
      season_id,
      genesis_key,
      opening_state_artifact_id,
      opening_state_sha256,
      economic_state_canonical_json,
      economic_state,
      economic_state_sha256,
      recorded_by
    ) values (
      public.deterministic_uuid_from_sha256(
        'twofold.competition_genesis/v1',
        p_economic_state_sha256
      ),
      'competition-genesis:' || v_season_id::text || ':'
        || (v_state->>'genesisId'),
      v_season_id,
      v_state->>'genesisId',
      v_opening_artifact_id,
      v_snapshot->>'sourceArtifactSha256',
      p_economic_state_canonical_json,
      v_state,
      p_economic_state_sha256,
      p_recorded_by
    ) returning * into v_genesis;
  end if;

  v_account := public.register_strategy_account(
    p_account_idempotency_key,
    p_run_id,
    p_account_code,
    p_broker,
    p_broker_region,
    'USD',
    false,
    jsonb_build_object(
      'schema', 'twofold.competition_strategy_account/v1',
      'competitionGenesisSha256', p_economic_state_sha256,
      'seasonId', v_season_id::text,
      'genesisId', v_state->>'genesisId'
    ),
    p_recorded_by
  );

  select * into v_head
    from public.strategy_ledger_head
   where strategy_account_id = v_account.strategy_account_id;
  if found then
    if v_head.initialized_by is distinct from p_recorded_by
      or v_head.genesis_manifest->>'competitionGenesisSha256'
        is distinct from p_economic_state_sha256
    then
      raise exception 'competition ledger head identity was reused with different genesis'
        using errcode = '23505';
    end if;
    return jsonb_build_object(
      'schema', 'twofold.competition_strategy_account_result/v1',
      'strategyAccountId', v_account.strategy_account_id::text,
      'runId', p_run_id::text,
      'competitionGenesisId', v_genesis.competition_genesis_id::text,
      'economicStateSha256', p_economic_state_sha256,
      'head', public.strategy_ledger_head_result(v_head)
    );
  end if;

  if exists (
      select 1 from public.accounting_transaction
       where strategy_account_id = v_account.strategy_account_id
    )
    or exists (
      select 1 from public.position_lot_origin
       where strategy_account_id = v_account.strategy_account_id
    )
    or exists (
      select 1 from public.position_lot_acquisition_fx
       where strategy_account_id = v_account.strategy_account_id
    )
    or exists (
      select 1 from public.paper_fill_settlement
       where strategy_account_id = v_account.strategy_account_id
    )
  then
    raise exception 'competition account has partial state without a ledger head'
      using errcode = '55000';
  end if;

  for v_cash in
    select item from jsonb_array_elements(v_snapshot->'cashBalances') as x(item)
  loop
    if jsonb_typeof(v_cash) is distinct from 'object'
      or not (v_cash ?& array[
        'currency', 'settledCash', 'unsettledCash'
      ]::text[])
      or (select count(*) from jsonb_object_keys(v_cash)) <> 3
      or v_cash->>'currency' is distinct from 'USD'
      or (v_cash->>'settledCash') !~ '^(0|[1-9][0-9]*)(\.[0-9]{0,11}[1-9])?$'
      or (v_cash->>'unsettledCash') !~ '^(0|[1-9][0-9]*)(\.[0-9]{0,11}[1-9])?$'
    then
      raise exception 'competition cash balances must be canonical non-negative USD strings'
        using errcode = '22023';
    end if;

    if (v_cash->>'settledCash')::numeric > 0 then
      v_postings := jsonb_build_array(
        jsonb_build_object(
          'account_code', 'asset.cash', 'side', 'debit',
          'amount', v_cash->>'settledCash', 'currency', 'USD'
        ),
        jsonb_build_object(
          'account_code', 'equity.opening_balance', 'side', 'credit',
          'amount', v_cash->>'settledCash', 'currency', 'USD'
        )
      );
      v_journal := public.append_accounting_transaction(
        p_account_idempotency_key || ':opening:cash:USD:settled',
        v_account.strategy_account_id,
        'opening_balance',
        p_account_idempotency_key || ':opening:cash:USD:settled',
        v_as_of, v_as_of_date, v_as_of_date,
        'Competition opening settled USD cash',
        v_postings,
        jsonb_build_object(
          'openingStateSchema', 'twofold.competition_economic_state/v1',
          'openingStateArtifactId', v_opening_artifact_id::text,
          'openingStateSha256', v_snapshot->>'sourceArtifactSha256',
          'competitionGenesisSha256', p_economic_state_sha256
        ),
        p_recorded_by
      );
      v_transaction_count := v_transaction_count + 1;
      v_settled_cash := v_settled_cash + (v_cash->>'settledCash')::numeric;
    end if;

    if (v_cash->>'unsettledCash')::numeric > 0 then
      v_postings := jsonb_build_array(
        jsonb_build_object(
          'account_code', 'asset.cash.unsettled', 'side', 'debit',
          'amount', v_cash->>'unsettledCash', 'currency', 'USD'
        ),
        jsonb_build_object(
          'account_code', 'equity.opening_balance', 'side', 'credit',
          'amount', v_cash->>'unsettledCash', 'currency', 'USD'
        )
      );
      v_journal := public.append_accounting_transaction(
        p_account_idempotency_key || ':opening:cash:USD:unsettled',
        v_account.strategy_account_id,
        'opening_balance',
        p_account_idempotency_key || ':opening:cash:USD:unsettled',
        v_as_of, v_as_of_date, v_as_of_date,
        'Competition opening unsettled USD cash',
        v_postings,
        jsonb_build_object(
          'openingStateSchema', 'twofold.competition_economic_state/v1',
          'openingStateArtifactId', v_opening_artifact_id::text,
          'openingStateSha256', v_snapshot->>'sourceArtifactSha256',
          'competitionGenesisSha256', p_economic_state_sha256
        ),
        p_recorded_by
      );
      v_transaction_count := v_transaction_count + 1;
      v_unsettled_cash := v_unsettled_cash
        + (v_cash->>'unsettledCash')::numeric;
    end if;
  end loop;

  for v_lot in
    select item
      from jsonb_array_elements(v_snapshot->'lots') with ordinality as x(item, n)
     order by n
  loop
    if jsonb_typeof(v_lot) is distinct from 'object'
      or not (v_lot ?& array[
        'lotId', 'instrumentId', 'symbol', 'acquiredOn',
        'acquisitionSequence', 'quantity', 'purchasePricePerShare',
        'grossPurchasePrice', 'buyFees', 'taxBasis', 'currency'
      ]::text[])
      or (select count(*) from jsonb_object_keys(v_lot)) <> 11
      or btrim(v_lot->>'lotId') = ''
      or btrim(v_lot->>'symbol') = ''
      or v_lot->>'currency' is distinct from 'USD'
      or (v_lot->>'acquiredOn') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or (v_lot->>'acquisitionSequence') !~ '^[1-9][0-9]*$'
      or (v_lot->>'quantity') !~ '^[1-9][0-9]*$'
      or (v_lot->>'purchasePricePerShare')
        !~ '^(0|[1-9][0-9]*)(\.[0-9]{0,11}[1-9])?$'
      or (v_lot->>'buyFees')
        !~ '^(0|[1-9][0-9]*)(\.[0-9]{0,11}[1-9])?$'
      or (v_lot->>'grossPurchasePrice')
        !~ '^(0|[1-9][0-9]*)(\.[0-9]{0,11}[1-9])?$'
      or (v_lot->>'taxBasis')
        !~ '^(0|[1-9][0-9]*)(\.[0-9]{0,11}[1-9])?$'
    then
      raise exception 'competition lot does not match canonical whole-share v1 shape'
        using errcode = '22023';
    end if;

    begin
      v_lot_id := public.deterministic_uuid_from_sha256(
        'twofold.position_lot_origin.competition_genesis/v1',
        p_run_id::text || chr(10) || (v_lot->>'lotId')
      );
      v_acquired_on := (v_lot->>'acquiredOn')::date;
      v_quantity := (v_lot->>'quantity')::numeric;
      v_unit_price := (v_lot->>'purchasePricePerShare')::numeric;
      v_gross := (v_lot->>'grossPurchasePrice')::numeric;
      v_fees := (v_lot->>'buyFees')::numeric;
      v_tax_basis := (v_lot->>'taxBasis')::numeric;
    exception when others then
      raise exception 'competition lot contains invalid identities, dates, or decimals'
        using errcode = '22023';
    end;

    if v_acquired_on > v_as_of_date
      or v_unit_price <= 0
      or scale(v_quantity) > 0
      or scale(v_unit_price) > 12
      or scale(v_gross) > 12
      or scale(v_fees) > 12
      or scale(v_tax_basis) > 12
      or v_gross is distinct from v_quantity * v_unit_price
      or v_tax_basis is distinct from v_gross + v_fees
      or not exists (
        select 1
          from public.instrument as instrument
         where instrument.instrument_id = (v_lot->>'instrumentId')::uuid
           and instrument.trading_currency = 'USD'
      )
      or not exists (
        select 1
          from public.instrument_symbol_version as symbol
         where symbol.instrument_id = (v_lot->>'instrumentId')::uuid
           and symbol.symbol = v_lot->>'symbol'
           and symbol.effective_from <= v_acquired_on
           and (symbol.effective_to is null or symbol.effective_to > v_acquired_on)
      )
    then
      raise exception 'competition lot economics or stable instrument binding is invalid'
        using errcode = '22023';
    end if;

    select item into v_fx
      from jsonb_array_elements(v_state->'acquisitionFxBindings') as x(item)
     where item->>'lotId' = v_lot->>'lotId';
    if not found
      or jsonb_typeof(v_fx) is distinct from 'object'
      or not (v_fx ?& array[
        'lotId', 'instrumentId', 'effectiveDate', 'cnyPerUsd',
        'acquisitionTaxBasisCny', 'authority', 'sourceArtifactId',
        'sourceSha256', 'observedAt', 'availableAt'
      ]::text[])
      or (select count(*) from jsonb_object_keys(v_fx)) <> 10
      or v_fx->>'instrumentId' is distinct from v_lot->>'instrumentId'
      or v_fx->>'effectiveDate' is distinct from v_lot->>'acquiredOn'
      or (v_fx->>'cnyPerUsd')
        !~ '^(0|[1-9][0-9]*)(\.[0-9]{0,11}[1-9])?$'
      or (v_fx->>'acquisitionTaxBasisCny')
        !~ '^(0|[1-9][0-9]*)(\.[0-9]{0,11}[1-9])?$'
      or btrim(v_fx->>'authority') = ''
      or (v_fx->>'sourceSha256') !~ '^[0-9a-f]{64}$'
    then
      raise exception 'competition lot requires one exact acquisition-FX binding'
        using errcode = '22023';
    end if;

    begin
      v_fx_rate := (v_fx->>'cnyPerUsd')::numeric;
      v_acquisition_tax_basis_cny :=
        (v_fx->>'acquisitionTaxBasisCny')::numeric;
      if (v_fx->>'observedAt')::timestamptz
          > (v_fx->>'availableAt')::timestamptz
        or (v_fx->>'availableAt')::timestamptz > v_as_of
      then
        raise exception 'invalid FX chronology';
      end if;
    exception when others then
      raise exception 'competition acquisition-FX chronology or decimal is invalid'
        using errcode = '22023';
    end;

    if v_fx_rate <= 0
      or scale(v_fx_rate) > 12
      or scale(v_acquisition_tax_basis_cny) > 12
      or v_acquisition_tax_basis_cny is distinct from v_tax_basis * v_fx_rate
      or not exists (
        select 1 from public.artifact_metadata as artifact
         where artifact.artifact_id = (v_fx->>'sourceArtifactId')::uuid
           and artifact.sha256 = v_fx->>'sourceSha256'
           and artifact.season_id = v_season_id
      )
    then
      raise exception 'competition acquisition-FX economics or source binding is invalid'
        using errcode = '22023';
    end if;

    insert into public.position_lot_origin (
      lot_origin_id, idempotency_key, strategy_account_id, instrument_id,
      origin_kind, origin_reference, acquired_at, effective_date,
      original_quantity, unit_purchase_price, allocated_buy_fees, currency,
      lot_method, source_sha256, source_artifact_id, metadata, recorded_by
    ) values (
      v_lot_id,
      p_account_idempotency_key || ':opening:lot:' || (v_lot->>'lotId'),
      v_account.strategy_account_id,
      (v_lot->>'instrumentId')::uuid,
      'initial_import',
      v_lot->>'lotId',
      (v_acquired_on::text || 'T00:00:00.000Z')::timestamptz,
      v_acquired_on,
      v_quantity,
      v_unit_price,
      v_fees,
      'USD',
      'FIFO',
      v_snapshot->>'sourceArtifactSha256',
      v_opening_artifact_id,
      jsonb_build_object(
        'schema', 'twofold.competition_opening_lot/v1',
        'competitionGenesisSha256', p_economic_state_sha256,
        'lotId', v_lot->>'lotId',
        'acquisitionSequence', v_lot->>'acquisitionSequence'
      ),
      p_recorded_by
    );
    v_lot_count := v_lot_count + 1;

    v_evidence := jsonb_build_object(
      'kind', 'ACQUISITION_TAX_BASIS_USD_CNY',
      'effectiveDate', v_fx->>'effectiveDate',
      'baseCurrency', 'USD',
      'quoteCurrency', 'CNY',
      'cnyPerUsd', v_fx->>'cnyPerUsd',
      'authority', v_fx->>'authority'
    );
    v_evidence_text := v_evidence::text;
    v_evidence_sha := encode(
      extensions.digest(convert_to(v_evidence_text, 'UTF8'), 'sha256'),
      'hex'
    );
    v_tax_fx_id := public.deterministic_uuid_from_sha256(
      'twofold.tax_fx_rate_evidence.competition_genesis/v1',
      p_run_id::text || chr(10) || (v_fx->>'effectiveDate')
        || chr(10) || v_evidence_sha
    );

    insert into public.tax_fx_rate_evidence (
      tax_fx_rate_evidence_id, idempotency_key, run_id, rate_kind,
      effective_date, base_currency, quote_currency, cny_per_usd, authority,
      observed_at, available_at, source_artifact_id, source_sha256,
      evidence_canonical_json, evidence, evidence_sha256, recorded_by
    ) values (
      v_tax_fx_id,
      p_account_idempotency_key || ':opening:fx:' || (v_fx->>'effectiveDate'),
      p_run_id,
      'ACQUISITION_TAX_BASIS_USD_CNY',
      (v_fx->>'effectiveDate')::date,
      'USD', 'CNY', v_fx->>'cnyPerUsd', v_fx->>'authority',
      (v_fx->>'observedAt')::timestamptz,
      (v_fx->>'availableAt')::timestamptz,
      (v_fx->>'sourceArtifactId')::uuid,
      v_fx->>'sourceSha256',
      v_evidence_text, v_evidence, v_evidence_sha, p_recorded_by
    ) on conflict (run_id, effective_date, rate_kind) do nothing;

    select tax_fx_rate_evidence_id into v_tax_fx_id
      from public.tax_fx_rate_evidence
     where run_id = p_run_id
       and effective_date = (v_fx->>'effectiveDate')::date
       and rate_kind = 'ACQUISITION_TAX_BASIS_USD_CNY'
       and cny_per_usd = v_fx->>'cnyPerUsd'
       and authority = v_fx->>'authority'
       and source_artifact_id = (v_fx->>'sourceArtifactId')::uuid
       and source_sha256 = v_fx->>'sourceSha256'
       and evidence_sha256 = v_evidence_sha;
    if not found then
      raise exception 'one run/date cannot bind conflicting acquisition-FX evidence'
        using errcode = '23505';
    end if;

    insert into public.position_lot_acquisition_fx (
      lot_origin_id, strategy_account_id, instrument_id,
      tax_fx_rate_evidence_id, cny_per_usd, acquisition_tax_basis_cny,
      source_sha256, recorded_by
    ) values (
      v_lot_id,
      v_account.strategy_account_id,
      (v_lot->>'instrumentId')::uuid,
      v_tax_fx_id,
      v_fx_rate,
      v_acquisition_tax_basis_cny,
      v_fx->>'sourceSha256',
      p_recorded_by
    );
    v_fx_count := v_fx_count + 1;

    v_postings := jsonb_build_array(
      jsonb_build_object(
        'account_code', 'securities.inventory', 'side', 'debit',
        'amount', public.accounting_decimal_text(v_gross), 'currency', 'USD',
        'instrument_id', v_lot->>'instrumentId',
        'lot_origin_id', v_lot_id::text
      )
    );
    if v_fees > 0 then
      v_postings := v_postings || jsonb_build_array(jsonb_build_object(
        'account_code', 'expense.broker_fee', 'side', 'debit',
        'amount', public.accounting_decimal_text(v_fees), 'currency', 'USD'
      ));
    end if;
    v_postings := v_postings || jsonb_build_array(jsonb_build_object(
      'account_code', 'equity.opening_balance', 'side', 'credit',
      'amount', public.accounting_decimal_text(v_tax_basis), 'currency', 'USD'
    ));
    v_metadata := jsonb_build_object(
      'openingStateSchema', 'twofold.competition_economic_state/v1',
      'openingStateArtifactId', v_opening_artifact_id::text,
      'openingStateSha256', v_snapshot->>'sourceArtifactSha256',
      'competitionGenesisSha256', p_economic_state_sha256,
      'lotId', v_lot->>'lotId'
    );
    -- append_accounting_transaction predates UUIDv8 and rejects a deterministic
    -- UUIDv8 lot_origin_id in its JSON schema. This trusted atomic boundary
    -- constructs the already-validated balanced posting set directly, keeping
    -- both the transaction and lot identities deterministic without widening
    -- the generic service-role primitive.
    v_transaction_id := public.deterministic_uuid_from_sha256(
      'twofold.accounting_transaction.competition_genesis/v1',
      p_run_id::text || chr(10) || (v_lot->>'lotId')
    );
    insert into public.accounting_transaction (
      accounting_transaction_id, idempotency_key, strategy_account_id,
      transaction_type, source_event_key, event_time, effective_date,
      settlement_date, description, posting_manifest,
      posting_manifest_sha256, metadata, recorded_by
    ) values (
      v_transaction_id,
      p_account_idempotency_key || ':opening:journal:lot:'
        || (v_lot->>'lotId'),
      v_account.strategy_account_id,
      'opening_balance',
      p_account_idempotency_key || ':opening:journal:lot:'
        || (v_lot->>'lotId'),
      v_as_of,
      v_as_of_date,
      v_as_of_date,
      'Competition opening ' || (v_lot->>'symbol') || ' lot '
        || (v_lot->>'lotId'),
      v_postings,
      encode(
        extensions.digest(convert_to(v_postings::text, 'UTF8'), 'sha256'),
        'hex'
      ),
      v_metadata,
      p_recorded_by
    );
    insert into public.accounting_posting (
      accounting_transaction_id, strategy_account_id, posting_index,
      account_code, side, amount, currency, instrument_id, lot_origin_id
    )
    select
      v_transaction_id,
      v_account.strategy_account_id,
      posting.ordinality::integer - 1,
      posting.item->>'account_code',
      posting.item->>'side',
      (posting.item->>'amount')::numeric,
      posting.item->>'currency',
      case when posting.item ? 'instrument_id'
        then (posting.item->>'instrument_id')::uuid else null end,
      case when posting.item ? 'lot_origin_id'
        then (posting.item->>'lot_origin_id')::uuid else null end
    from jsonb_array_elements(v_postings) with ordinality
      as posting(item, ordinality);
    v_transaction_count := v_transaction_count + 1;
  end loop;

  if v_lot_count <> jsonb_array_length(v_snapshot->'lots')
    or v_fx_count <> jsonb_array_length(v_state->'acquisitionFxBindings')
    or v_transaction_count < 1
  then
    raise exception 'competition genesis counts do not reconcile'
      using errcode = '55000';
  end if;

  v_genesis_manifest := jsonb_build_object(
    'schema', 'twofold.strategy_ledger_genesis/v2',
    'strategyAccountIdempotencyKey', v_account.idempotency_key,
    'runManifestIdempotencyKey', (
      select idempotency_key from public.run_manifest where run_id = p_run_id
    ),
    'runManifestSha256', (
      select manifest_sha256 from public.run_manifest where run_id = p_run_id
    ),
    'competitionGenesisIdempotencyKey', v_genesis.idempotency_key,
    'competitionGenesisSha256', p_economic_state_sha256,
    'openingStateArtifactIdempotencyKey', v_opening_artifact.idempotency_key,
    'openingStateSha256', v_opening_artifact.sha256,
    'openingSettledCash', public.accounting_decimal_text(v_settled_cash),
    'openingUnsettledCash', public.accounting_decimal_text(v_unsettled_cash),
    'initializedBy', p_recorded_by,
    'accountingTransactionCount', v_transaction_count::text,
    'lotOriginCount', v_lot_count::text,
    'acquisitionFxBindingCount', v_fx_count::text,
    'settlementCount', '0'
  );
  v_genesis_manifest_sha := encode(
    extensions.digest(convert_to(v_genesis_manifest::text, 'UTF8'), 'sha256'),
    'hex'
  );
  v_head_sha := encode(
    extensions.digest(
      convert_to(
        'twofold.strategy_ledger_head/v2' || chr(10)
          || v_genesis_manifest_sha,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  insert into public.strategy_ledger_head (
    strategy_account_id, head_sequence, head_sha256,
    accounting_transaction_count, lot_origin_count,
    acquisition_fx_binding_count, settlement_count, genesis_manifest,
    genesis_manifest_sha256, initialized_by
  ) values (
    v_account.strategy_account_id, 0, v_head_sha,
    v_transaction_count, v_lot_count, v_fx_count, 0,
    v_genesis_manifest, v_genesis_manifest_sha, p_recorded_by
  ) returning * into v_head;

  return jsonb_build_object(
    'schema', 'twofold.competition_strategy_account_result/v1',
    'strategyAccountId', v_account.strategy_account_id::text,
    'runId', p_run_id::text,
    'competitionGenesisId', v_genesis.competition_genesis_id::text,
    'economicStateSha256', p_economic_state_sha256,
    'head', public.strategy_ledger_head_result(v_head)
  );
end;
$$;

comment on function public.initialize_competition_strategy_account(
  text, uuid, text, text, text, text, text, text
) is
  'Atomically clones one evidence-bound pre-positioned economic state into an isolated paper Strategy Run account, FIFO lots, acquisition FX, journals, and ledger head.';

alter table public.competition_genesis enable row level security;

revoke all on table public.competition_genesis
  from public, anon, authenticated, service_role;
grant select on table public.competition_genesis to service_role;

revoke all on function public.initialize_competition_strategy_account(
  text, uuid, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.initialize_competition_strategy_account(
  text, uuid, text, text, text, text, text, text
) to service_role;

commit;
