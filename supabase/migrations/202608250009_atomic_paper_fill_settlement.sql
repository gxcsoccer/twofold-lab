-- Atomic paper-fill settlement, v1.
--
-- This first settlement slice deliberately supports S2 BUY orders only.  It
-- consumes a trusted, immutable official-auction-open price, derives the
-- simulated price, quantity, fees, journal, and lot inside one transaction,
-- and advances a per-account hash-chain head.  S1 remains fail closed until a
-- separately trusted acquisition/disposition CNY-FX evidence chain and FIFO
-- tax settlement are available.  Alpaca daily bars are never execution-price
-- evidence for this boundary.

begin;

alter table public.artifact_metadata
  add constraint artifact_metadata_id_sha256_unique
  unique (artifact_id, sha256);

create table public.official_execution_price_evidence (
  execution_price_evidence_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key <> ''),
  run_id uuid not null references public.run_manifest(run_id),
  instrument_id uuid not null references public.instrument(instrument_id),
  evidence_kind text not null check (evidence_kind = 'OFFICIAL_AUCTION_OPEN'),
  session_date date not null,
  currency text not null check (currency = 'USD'),
  official_open_price text not null check (
    official_open_price
      ~ '^(0|[1-9][0-9]{0,25})(\.[0-9]{0,11}[1-9])?$'
    and official_open_price::numeric > 0
  ),
  authority text not null check (authority in (
    'PRIMARY_EXCHANGE_OFFICIAL',
    'REGULATED_BROKER_EXECUTION'
  )),
  observed_at timestamptz not null,
  available_at timestamptz not null,
  source_artifact_id uuid not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_canonical_json text not null check (evidence_canonical_json <> ''),
  evidence jsonb not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint official_execution_price_artifact_fk foreign key (
    source_artifact_id,
    source_sha256
  ) references public.artifact_metadata(artifact_id, sha256),
  constraint official_execution_price_observation_order check (
    observed_at <= available_at
  ),
  constraint official_execution_price_session_date_binding check (
    (observed_at at time zone 'UTC')::date = session_date
    and (available_at at time zone 'UTC')::date = session_date
  ),
  constraint official_execution_price_payload_object check (
    jsonb_typeof(evidence) = 'object'
  ),
  constraint official_execution_price_payload_decimal_safe check (
    not public.jsonb_contains_number(evidence)
  ),
  constraint official_execution_price_payload_self_binding check (
    evidence ?& array[
      'kind',
      'instrumentId',
      'sessionDate',
      'officialOpenPrice',
      'currency',
      'authority'
    ]::text[]
    and evidence - array[
      'kind', 'instrumentId', 'sessionDate', 'officialOpenPrice',
      'currency', 'authority'
    ]::text[] = '{}'::jsonb
    and jsonb_typeof(evidence->'kind') = 'string'
    and evidence->>'kind' = evidence_kind
    and jsonb_typeof(evidence->'instrumentId') = 'string'
    and evidence->>'instrumentId' = instrument_id::text
    and jsonb_typeof(evidence->'sessionDate') = 'string'
    and evidence->>'sessionDate' = session_date::text
    and jsonb_typeof(evidence->'officialOpenPrice') = 'string'
    and evidence->>'officialOpenPrice' = official_open_price
    and jsonb_typeof(evidence->'currency') = 'string'
    and evidence->>'currency' = currency
    and jsonb_typeof(evidence->'authority') = 'string'
    and evidence->>'authority' = authority
  ),
  constraint official_execution_price_payload_exact check (
    evidence_canonical_json::jsonb = evidence
  ),
  constraint official_execution_price_hash_exact check (
    evidence_sha256 = encode(
      extensions.digest(
        convert_to(evidence_canonical_json, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  ),
  constraint official_execution_price_logical_unique unique (
    run_id,
    instrument_id,
    session_date,
    evidence_kind
  )
);

comment on table public.official_execution_price_evidence is
  'Owner/trusted-ingestion-only immutable official auction evidence. The service role can consume but cannot create it; Alpaca daily bars are not admissible here.';

create index official_execution_price_lookup_idx
  on public.official_execution_price_evidence (
    run_id,
    instrument_id,
    session_date,
    available_at,
    execution_price_evidence_id
  );

create table public.tax_fx_rate_evidence (
  tax_fx_rate_evidence_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key <> ''),
  run_id uuid not null references public.run_manifest(run_id),
  rate_kind text not null check (
    rate_kind = 'ACQUISITION_TAX_BASIS_USD_CNY'
  ),
  effective_date date not null,
  base_currency text not null check (base_currency = 'USD'),
  quote_currency text not null check (quote_currency = 'CNY'),
  cny_per_usd text not null check (
    cny_per_usd ~ '^(0|[1-9][0-9]{0,25})(\.[0-9]{0,11}[1-9])?$'
    and cny_per_usd::numeric > 0
  ),
  authority text not null check (authority <> ''),
  observed_at timestamptz not null,
  available_at timestamptz not null,
  source_artifact_id uuid not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_canonical_json text not null check (evidence_canonical_json <> ''),
  evidence jsonb not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint tax_fx_rate_evidence_artifact_fk foreign key (
    source_artifact_id,
    source_sha256
  ) references public.artifact_metadata(artifact_id, sha256),
  constraint tax_fx_rate_observation_order check (observed_at <= available_at),
  constraint tax_fx_rate_payload_object check (
    jsonb_typeof(evidence) = 'object'
  ),
  constraint tax_fx_rate_payload_decimal_safe check (
    not public.jsonb_contains_number(evidence)
  ),
  constraint tax_fx_rate_payload_self_binding check (
    evidence ?& array[
      'kind',
      'effectiveDate',
      'baseCurrency',
      'quoteCurrency',
      'cnyPerUsd',
      'authority'
    ]::text[]
    and evidence - array[
      'kind', 'effectiveDate', 'baseCurrency', 'quoteCurrency',
      'cnyPerUsd', 'authority'
    ]::text[] = '{}'::jsonb
    and jsonb_typeof(evidence->'kind') = 'string'
    and evidence->>'kind' = rate_kind
    and jsonb_typeof(evidence->'effectiveDate') = 'string'
    and evidence->>'effectiveDate' = effective_date::text
    and jsonb_typeof(evidence->'baseCurrency') = 'string'
    and evidence->>'baseCurrency' = base_currency
    and jsonb_typeof(evidence->'quoteCurrency') = 'string'
    and evidence->>'quoteCurrency' = quote_currency
    and jsonb_typeof(evidence->'cnyPerUsd') = 'string'
    and evidence->>'cnyPerUsd' = cny_per_usd
    and jsonb_typeof(evidence->'authority') = 'string'
    and evidence->>'authority' = authority
  ),
  constraint tax_fx_rate_payload_exact check (
    evidence_canonical_json::jsonb = evidence
  ),
  constraint tax_fx_rate_hash_exact check (
    evidence_sha256 = encode(
      extensions.digest(
        convert_to(evidence_canonical_json, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  ),
  constraint tax_fx_rate_logical_unique unique (
    run_id,
    effective_date,
    rate_kind
  )
);

comment on table public.tax_fx_rate_evidence is
  'Owner/trusted-ingestion-only immutable USD/CNY evidence frozen at BUY acquisition so later strict FIFO tax basis remains replayable.';

create table public.position_lot_acquisition_fx (
  lot_origin_id uuid primary key,
  strategy_account_id uuid not null,
  instrument_id uuid not null,
  tax_fx_rate_evidence_id uuid not null references
    public.tax_fx_rate_evidence(tax_fx_rate_evidence_id),
  cny_per_usd numeric(38, 12) not null check (cny_per_usd > 0),
  acquisition_tax_basis_cny numeric not null check (
    acquisition_tax_basis_cny > 0
  ),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint position_lot_acquisition_fx_lot_fk foreign key (
    lot_origin_id,
    strategy_account_id,
    instrument_id
  ) references public.position_lot_origin(
    lot_origin_id,
    strategy_account_id,
    instrument_id
  )
);

create table public.strategy_ledger_head (
  strategy_account_id uuid primary key
    references public.strategy_account(strategy_account_id),
  head_sequence bigint not null default 0 check (head_sequence >= 0),
  head_sha256 text not null check (head_sha256 ~ '^[0-9a-f]{64}$'),
  last_settlement_id uuid,
  accounting_transaction_count bigint not null check (
    accounting_transaction_count >= 1
  ),
  lot_origin_count bigint not null check (lot_origin_count >= 0),
  acquisition_fx_binding_count bigint not null check (
    acquisition_fx_binding_count >= 0
  ),
  settlement_count bigint not null check (settlement_count >= 0),
  genesis_manifest jsonb not null,
  genesis_manifest_sha256 text not null check (
    genesis_manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  initialized_by text not null check (initialized_by <> ''),
  initialized_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint strategy_ledger_head_genesis_object check (
    jsonb_typeof(genesis_manifest) = 'object'
  ),
  constraint strategy_ledger_head_genesis_decimal_safe check (
    not public.jsonb_contains_number(genesis_manifest)
  ),
  constraint strategy_ledger_head_sequence_matches_settlements check (
    head_sequence = settlement_count
  )
);

comment on table public.strategy_ledger_head is
  'Last-confirmed append-only settlement pointer and integrity counters per strategy account; it is not itself a balance.';

create table public.paper_fill_settlement (
  settlement_id uuid primary key,
  idempotency_key text not null unique check (idempotency_key <> ''),
  strategy_account_id uuid not null
    references public.strategy_account(strategy_account_id),
  frozen_order_plan_id uuid not null,
  order_id text not null check (order_id <> ''),
  instrument_id uuid not null references public.instrument(instrument_id),
  stage text not null check (stage = 'S2'),
  side text not null check (side = 'BUY'),
  outcome text not null check (outcome in (
    'FILLED',
    'PARTIALLY_FILLED_CASH_LIMIT',
    'CANCELED_CASH_LIMIT'
  )),
  execution_price_evidence_id uuid not null references
    public.official_execution_price_evidence(execution_price_evidence_id),
  executed_at timestamptz not null,
  settlement_date date not null,
  order_quantity numeric(38, 12) not null check (order_quantity > 0),
  fill_quantity numeric(38, 12) not null check (fill_quantity >= 0),
  canceled_quantity numeric(38, 12) not null check (canceled_quantity >= 0),
  official_open_price numeric(38, 12) not null check (
    official_open_price > 0
  ),
  fill_price numeric(38, 12) not null check (fill_price > 0),
  gross_notional numeric(38, 12) not null check (gross_notional >= 0),
  total_fees numeric(38, 12) not null check (total_fees >= 0),
  cash_effect numeric(38, 12) not null check (cash_effect >= 0),
  tax_reserve_effect numeric(38, 12) not null default 0 check (
    tax_reserve_effect = 0
  ),
  buying_power_before numeric(38, 12) not null check (
    buying_power_before >= 0
  ),
  frozen_buying_power_remaining_before numeric(38, 12) not null check (
    frozen_buying_power_remaining_before >= 0
  ),
  effective_buying_power_limit numeric(38, 12) not null check (
    effective_buying_power_limit >= 0
  ),
  buying_power_after numeric(38, 12) not null check (
    buying_power_after >= 0
  ),
  accounting_transaction_id uuid,
  created_lot_origin_id uuid,
  requested_expected_head_sequence bigint not null check (
    requested_expected_head_sequence >= 0
  ),
  requested_expected_head_sha256 text not null check (
    requested_expected_head_sha256 ~ '^[0-9a-f]{64}$'
  ),
  requested_tax_fx_rate_evidence_id uuid references
    public.tax_fx_rate_evidence(tax_fx_rate_evidence_id),
  pre_head_sequence bigint not null check (pre_head_sequence >= 0),
  pre_head_sha256 text not null check (pre_head_sha256 ~ '^[0-9a-f]{64}$'),
  post_head_sequence bigint not null check (post_head_sequence > 0),
  post_head_sha256 text not null check (
    post_head_sha256 ~ '^[0-9a-f]{64}$'
  ),
  request_manifest jsonb not null,
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  settlement_manifest jsonb not null,
  settlement_sha256 text not null check (
    settlement_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint paper_fill_plan_account_fk foreign key (
    frozen_order_plan_id,
    strategy_account_id
  ) references public.frozen_order_plan(
    frozen_order_plan_id,
    strategy_account_id
  ),
  constraint paper_fill_transaction_account_fk foreign key (
    accounting_transaction_id,
    strategy_account_id
  ) references public.accounting_transaction(
    accounting_transaction_id,
    strategy_account_id
  ),
  constraint paper_fill_lot_account_instrument_fk foreign key (
    created_lot_origin_id,
    strategy_account_id,
    instrument_id
  ) references public.position_lot_origin(
    lot_origin_id,
    strategy_account_id,
    instrument_id
  ),
  constraint paper_fill_order_once unique (frozen_order_plan_id, order_id),
  constraint paper_fill_head_once unique (
    strategy_account_id,
    post_head_sequence
  ),
  constraint paper_fill_quantity_conservation check (
    fill_quantity + canceled_quantity = order_quantity
  ),
  constraint paper_fill_integer_quantities check (
    trunc(order_quantity) = order_quantity
    and trunc(fill_quantity) = fill_quantity
    and trunc(canceled_quantity) = canceled_quantity
  ),
  constraint paper_fill_head_progression check (
    post_head_sequence = pre_head_sequence + 1
  ),
  constraint paper_fill_cash_math check (
    cash_effect = gross_notional + total_fees
    and buying_power_after = buying_power_before - cash_effect
    and effective_buying_power_limit <= buying_power_before
    and effective_buying_power_limit <= frozen_buying_power_remaining_before
    and cash_effect <= effective_buying_power_limit
  ),
  constraint paper_fill_outcome_shape check (
    (
      outcome = 'CANCELED_CASH_LIMIT'
      and fill_quantity = 0
      and canceled_quantity = order_quantity
      and gross_notional = 0
      and total_fees = 0
      and cash_effect = 0
      and accounting_transaction_id is null
      and created_lot_origin_id is null
    ) or (
      outcome = 'FILLED'
      and fill_quantity = order_quantity
      and canceled_quantity = 0
      and gross_notional > 0
      and cash_effect > 0
      and accounting_transaction_id is not null
      and created_lot_origin_id is not null
      and requested_tax_fx_rate_evidence_id is not null
    ) or (
      outcome = 'PARTIALLY_FILLED_CASH_LIMIT'
      and fill_quantity > 0
      and fill_quantity < order_quantity
      and canceled_quantity > 0
      and gross_notional > 0
      and cash_effect > 0
      and accounting_transaction_id is not null
      and created_lot_origin_id is not null
      and requested_tax_fx_rate_evidence_id is not null
    )
  ),
  constraint paper_fill_request_object check (
    jsonb_typeof(request_manifest) = 'object'
  ),
  constraint paper_fill_request_decimal_safe check (
    not public.jsonb_contains_number(request_manifest)
  ),
  constraint paper_fill_settlement_object check (
    jsonb_typeof(settlement_manifest) = 'object'
  ),
  constraint paper_fill_settlement_decimal_safe check (
    not public.jsonb_contains_number(settlement_manifest)
  )
);

comment on table public.paper_fill_settlement is
  'One immutable deterministic outcome per frozen S2 order. A zero-affordable outcome is a cancellation, never a fabricated fill, and still advances the ledger head.';

alter table public.strategy_ledger_head
  add constraint strategy_ledger_head_last_settlement_fk
  foreign key (last_settlement_id)
  references public.paper_fill_settlement(settlement_id);

create table public.paper_fill_fee_component (
  settlement_id uuid not null
    references public.paper_fill_settlement(settlement_id),
  component text not null check (component in (
    'commission',
    'platform',
    'settlement',
    'sec_regulatory',
    'finra_taf',
    'cat'
  )),
  amount numeric(38, 12) not null check (amount >= 0),
  currency text not null check (currency = 'USD'),
  primary key (settlement_id, component)
);

comment on table public.paper_fill_fee_component is
  'Immutable per-order fee derivation. All six components are frozen even when zero; order minima apply exactly once.';

create or replace function public.enforce_execution_evidence_source_mapping()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_artifact public.artifact_metadata%rowtype;
begin
  select * into v_artifact
    from public.artifact_metadata
   where artifact_id = new.source_artifact_id
     and sha256 = new.source_sha256;

  if not found
    or v_artifact.run_id is distinct from new.run_id
    or not (
      (
        new.authority = 'PRIMARY_EXCHANGE_OFFICIAL'
        and v_artifact.artifact_kind = 'official_exchange_auction_print'
      )
      or (
        new.authority = 'REGULATED_BROKER_EXECUTION'
        and v_artifact.artifact_kind =
          'regulated_broker_auction_execution'
      )
    )
  then
    raise exception 'execution evidence authority does not match its source artifact kind'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

create or replace function public.enforce_s1_decision_evidence_cutoff()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_decision_at timestamptz;
begin
  if new.stage = 'S2' then
    if jsonb_typeof(new.plan->'fillPriceScale') is distinct from 'string'
      or (new.plan->>'fillPriceScale') !~ '^(0|[1-9]|1[0-2])$'
    then
      raise exception 'S2 settlement v1 requires fillPriceScale between 0 and 12'
        using errcode = '22023';
    end if;

    if jsonb_typeof(new.plan->'initialBuyingPower') is distinct from 'string'
      or jsonb_typeof(new.plan->'reservedBuyingPower')
        is distinct from 'string'
      or jsonb_typeof(new.plan->'remainingUnreservedBuyingPower')
        is distinct from 'string'
      or (new.plan->>'initialBuyingPower')
        !~ '^(0|[1-9][0-9]{0,25})(\.[0-9]{0,11}[1-9])?$'
      or (new.plan->>'reservedBuyingPower')
        !~ '^(0|[1-9][0-9]{0,25})(\.[0-9]{0,11}[1-9])?$'
      or (new.plan->>'remainingUnreservedBuyingPower')
        !~ '^(0|[1-9][0-9]{0,25})(\.[0-9]{0,11}[1-9])?$'
      or exists (
        select 1
          from jsonb_array_elements(new.plan->'orders') as orders(item)
         where jsonb_typeof(orders.item->'quantity') is distinct from 'string'
            or (orders.item->>'quantity') !~ '^[1-9][0-9]{0,25}$'
      )
    then
      raise exception 'S2 plan amounts exceed exact numeric(38,12) settlement precision'
        using errcode = '22023';
    end if;

    if exists (
      select 1
        from jsonb_array_elements(new.plan->'orders') as orders(item)
       where jsonb_typeof(orders.item->'priority') is distinct from 'string'
          or (orders.item->>'priority') !~ '^[1-9][0-9]*$'
    ) or exists (
      select 1
        from jsonb_array_elements(new.plan->'orders') with ordinality
          as current_order(item, ordinality)
        join jsonb_array_elements(new.plan->'orders') with ordinality
          as prior_order(item, ordinality)
          on prior_order.ordinality < current_order.ordinality
       where (prior_order.item->>'priority')::numeric
          >= (current_order.item->>'priority')::numeric
    ) then
      raise exception 'S2 order priorities must be unique and strictly increase with array order'
        using errcode = '22023';
    end if;
    return new;
  end if;

  select decision_at into strict v_decision_at
    from public.decision_invocation
   where decision_id = new.decision_id;

  if exists (
    select 1
      from jsonb_array_elements(new.plan->'orders') as orders(item)
     where jsonb_typeof(
       orders.item->'referencePriceEvidence'->'visibleAt'
     ) is distinct from 'string'
        or (orders.item->'referencePriceEvidence'->>'visibleAt') !~ (
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:'
          || '[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        )
        or (orders.item->'referencePriceEvidence'->>'visibleAt')::timestamptz
          > v_decision_at
  ) then
    raise exception 'S1 close-price evidence was not visible by the trusted decision cutoff'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

do $$
begin
  if exists (
    select 1
      from public.frozen_order_plan as plan
      join public.decision_invocation as decision
        on decision.decision_id = plan.decision_id
      cross join lateral jsonb_array_elements(plan.plan->'orders')
        as orders(item)
     where plan.stage = 'S1'
       and (
         jsonb_typeof(
           orders.item->'referencePriceEvidence'->'visibleAt'
         ) is distinct from 'string'
         or (orders.item->'referencePriceEvidence'->>'visibleAt') !~ (
           '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:'
           || '[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
         )
         or (orders.item->'referencePriceEvidence'->>'visibleAt')::timestamptz
           > decision.decision_at
       )
  ) then
    raise exception 'existing S1 plan violates trusted decision evidence cutoff'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.frozen_order_plan as plan
      cross join lateral jsonb_array_elements(plan.plan->'orders')
        as orders(item)
     where plan.stage = 'S2'
       and (
         jsonb_typeof(orders.item->'priority') is distinct from 'string'
         or (orders.item->>'priority') !~ '^[1-9][0-9]*$'
       )
  ) or exists (
    select 1
      from public.frozen_order_plan as plan
      cross join lateral jsonb_array_elements(plan.plan->'orders')
        with ordinality as current_order(item, ordinality)
      join lateral jsonb_array_elements(plan.plan->'orders')
        with ordinality as prior_order(item, ordinality)
        on prior_order.ordinality < current_order.ordinality
     where plan.stage = 'S2'
       and (prior_order.item->>'priority')::numeric
         >= (current_order.item->>'priority')::numeric
  ) then
    raise exception 'existing S2 plan violates strict array priority order'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.frozen_order_plan as plan
     where plan.stage = 'S2'
       and (
         jsonb_typeof(plan.plan->'fillPriceScale') is distinct from 'string'
         or (plan.plan->>'fillPriceScale') !~ '^(0|[1-9]|1[0-2])$'
       )
  ) then
    raise exception 'existing S2 plan exceeds settlement price precision'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.frozen_order_plan as plan
     where plan.stage = 'S2'
       and (
         jsonb_typeof(plan.plan->'initialBuyingPower')
           is distinct from 'string'
         or jsonb_typeof(plan.plan->'reservedBuyingPower')
           is distinct from 'string'
         or jsonb_typeof(plan.plan->'remainingUnreservedBuyingPower')
           is distinct from 'string'
         or (plan.plan->>'initialBuyingPower')
           !~ '^(0|[1-9][0-9]{0,25})(\.[0-9]{0,11}[1-9])?$'
         or (plan.plan->>'reservedBuyingPower')
           !~ '^(0|[1-9][0-9]{0,25})(\.[0-9]{0,11}[1-9])?$'
         or (plan.plan->>'remainingUnreservedBuyingPower')
           !~ '^(0|[1-9][0-9]{0,25})(\.[0-9]{0,11}[1-9])?$'
       )
  ) or exists (
    select 1
      from public.frozen_order_plan as plan
      cross join lateral jsonb_array_elements(plan.plan->'orders')
        as orders(item)
     where plan.stage = 'S2'
       and (
         jsonb_typeof(orders.item->'quantity') is distinct from 'string'
         or (orders.item->>'quantity') !~ '^[1-9][0-9]{0,25}$'
       )
  ) then
    raise exception 'existing S2 plan exceeds exact settlement numeric precision'
      using errcode = '22023';
  end if;
end;
$$;

create trigger frozen_order_plan_s1_decision_evidence_cutoff
before insert on public.frozen_order_plan
for each row execute function public.enforce_s1_decision_evidence_cutoff();

create trigger official_execution_price_source_mapping
before insert on public.official_execution_price_evidence
for each row execute function public.enforce_execution_evidence_source_mapping();

create trigger official_execution_price_evidence_is_immutable
before update or delete on public.official_execution_price_evidence
for each row execute function public.reject_immutable_mutation();
create trigger official_execution_price_evidence_rejects_truncate
before truncate on public.official_execution_price_evidence
for each statement execute function public.reject_immutable_mutation();

create trigger tax_fx_rate_evidence_is_immutable
before update or delete on public.tax_fx_rate_evidence
for each row execute function public.reject_immutable_mutation();
create trigger tax_fx_rate_evidence_rejects_truncate
before truncate on public.tax_fx_rate_evidence
for each statement execute function public.reject_immutable_mutation();

create trigger position_lot_acquisition_fx_is_immutable
before update or delete on public.position_lot_acquisition_fx
for each row execute function public.reject_immutable_mutation();
create trigger position_lot_acquisition_fx_rejects_truncate
before truncate on public.position_lot_acquisition_fx
for each statement execute function public.reject_immutable_mutation();

create trigger paper_fill_settlement_is_immutable
before update or delete on public.paper_fill_settlement
for each row execute function public.reject_immutable_mutation();
create trigger paper_fill_settlement_rejects_truncate
before truncate on public.paper_fill_settlement
for each statement execute function public.reject_immutable_mutation();

create trigger paper_fill_fee_component_is_immutable
before update or delete on public.paper_fill_fee_component
for each row execute function public.reject_immutable_mutation();
create trigger paper_fill_fee_component_rejects_truncate
before truncate on public.paper_fill_fee_component
for each statement execute function public.reject_immutable_mutation();

create or replace function public.guard_strategy_ledger_head_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'strategy_ledger_head cannot be deleted'
      using errcode = '55000';
  end if;

  if current_setting('twofold.atomic_settlement', true) is distinct from 'on'
  then
    raise exception 'strategy_ledger_head may change only inside atomic settlement'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger strategy_ledger_head_guarded
before update or delete on public.strategy_ledger_head
for each row execute function public.guard_strategy_ledger_head_mutation();
create trigger strategy_ledger_head_rejects_truncate
before truncate on public.strategy_ledger_head
for each statement execute function public.reject_immutable_mutation();

create or replace function public.accounting_decimal_text(p_value numeric)
returns text
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select case
    when p_value = 0 then '0'
    when position('.' in p_value::text) > 0
      then rtrim(rtrim(p_value::text, '0'), '.')
    else p_value::text
  end
$$;

create or replace function public.deterministic_uuid_from_sha256(
  p_namespace text,
  p_stable_key text
)
returns uuid
language plpgsql
immutable
strict
set search_path = public, extensions, pg_temp
as $$
declare
  v_digest text;
begin
  if btrim(p_namespace) = '' or btrim(p_stable_key) = '' then
    raise exception 'deterministic UUID namespace and stable key are required'
      using errcode = '22023';
  end if;

  v_digest := encode(
    extensions.digest(
      convert_to(
        octet_length(convert_to(p_namespace, 'UTF8'))::text
          || ':' || p_namespace
          || ':' || octet_length(convert_to(p_stable_key, 'UTF8'))::text
          || ':' || p_stable_key,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  -- RFC 9562 UUIDv8 layout: SHA256 supplies 120 bits while the version and
  -- variant nibbles are fixed. Namespace/version strings prevent cross-type
  -- collisions and make clean-database replay byte deterministic.
  return (
    substr(v_digest, 1, 8) || '-'
      || substr(v_digest, 9, 4) || '-'
      || '8' || substr(v_digest, 14, 3) || '-'
      || '8' || substr(v_digest, 18, 3) || '-'
      || substr(v_digest, 21, 12)
  )::uuid;
end;
$$;

alter table public.paper_fill_settlement
  add constraint paper_fill_deterministic_internal_ids check (
    settlement_id = public.deterministic_uuid_from_sha256(
      'twofold.paper_fill_settlement/v1',
      request_sha256
    )
    and (
      accounting_transaction_id is null
      or accounting_transaction_id = public.deterministic_uuid_from_sha256(
        'twofold.accounting_transaction.paper_fill/v1',
        settlement_id::text
      )
    )
    and (
      created_lot_origin_id is null
      or created_lot_origin_id = public.deterministic_uuid_from_sha256(
        'twofold.position_lot_origin.paper_fill/v1',
        settlement_id::text
      )
    )
  );

create or replace function public.strategy_ledger_head_result(
  p_head public.strategy_ledger_head
)
returns jsonb
language sql
stable
strict
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'twofold.strategy_ledger_head_result/v1',
    'strategyAccountId', p_head.strategy_account_id::text,
    'headSequence', p_head.head_sequence::text,
    'headSha256', p_head.head_sha256,
    'lastSettlementId', case
      when p_head.last_settlement_id is null then null
      else to_jsonb(p_head.last_settlement_id::text)
    end,
    'accountingTransactionCount', p_head.accounting_transaction_count::text,
    'lotOriginCount', p_head.lot_origin_count::text,
    'acquisitionFxBindingCount',
      p_head.acquisition_fx_binding_count::text,
    'settlementCount', p_head.settlement_count::text,
    'initializedBy', p_head.initialized_by,
    'initializedAt', to_char(
      p_head.initialized_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'updatedAt', to_char(
      p_head.updated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  )
$$;

create or replace function public.paper_fill_settlement_result(
  p_settlement public.paper_fill_settlement
)
returns jsonb
language sql
stable
strict
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'twofold.paper_fill_settlement_result/v1',
    'settlement_id', p_settlement.settlement_id::text,
    'idempotency_key', p_settlement.idempotency_key,
    'strategy_account_id', p_settlement.strategy_account_id::text,
    'frozen_order_plan_id', p_settlement.frozen_order_plan_id::text,
    'order_id', p_settlement.order_id,
    'stage', p_settlement.stage,
    'side', p_settlement.side,
    'outcome', p_settlement.outcome,
    'execution_price_evidence_id',
      p_settlement.execution_price_evidence_id::text,
    'tax_fx_rate_evidence_id', case
      when p_settlement.fill_quantity = 0 then null
      else to_jsonb(p_settlement.requested_tax_fx_rate_evidence_id::text)
    end,
    'executed_at', to_char(
      p_settlement.executed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'settlement_date', p_settlement.settlement_date::text,
    'order_quantity', public.accounting_decimal_text(
      p_settlement.order_quantity
    ),
    'fill_quantity', public.accounting_decimal_text(
      p_settlement.fill_quantity
    ),
    'canceled_quantity', public.accounting_decimal_text(
      p_settlement.canceled_quantity
    ),
    'official_open_price', public.accounting_decimal_text(
      p_settlement.official_open_price
    ),
    'fill_price', public.accounting_decimal_text(p_settlement.fill_price),
    'gross_notional', public.accounting_decimal_text(
      p_settlement.gross_notional
    ),
    'total_fees', public.accounting_decimal_text(p_settlement.total_fees),
    'cash_effect', public.accounting_decimal_text(p_settlement.cash_effect),
    'tax_reserve_effect', public.accounting_decimal_text(
      p_settlement.tax_reserve_effect
    ),
    'buying_power_before', public.accounting_decimal_text(
      p_settlement.buying_power_before
    ),
    'frozen_buying_power_remaining_before',
      public.accounting_decimal_text(
        p_settlement.frozen_buying_power_remaining_before
      ),
    'effective_buying_power_limit', public.accounting_decimal_text(
      p_settlement.effective_buying_power_limit
    ),
    'buying_power_after', public.accounting_decimal_text(
      p_settlement.buying_power_after
    ),
    'accounting_transaction_id', case
      when p_settlement.accounting_transaction_id is null then null
      else to_jsonb(p_settlement.accounting_transaction_id::text)
    end,
    'created_lot_origin_id', case
      when p_settlement.created_lot_origin_id is null then null
      else to_jsonb(p_settlement.created_lot_origin_id::text)
    end,
    'pre_head_sequence', p_settlement.pre_head_sequence::text,
    'pre_head_sha256', p_settlement.pre_head_sha256,
    'post_head_sequence', p_settlement.post_head_sequence::text,
    'post_head_sha256', p_settlement.post_head_sha256,
    'request_sha256', p_settlement.request_sha256,
    'recorded_by', p_settlement.recorded_by,
    'recorded_at', to_char(
      p_settlement.recorded_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  )
$$;

create or replace function public.initialize_strategy_ledger_head(
  p_strategy_account_id uuid,
  p_recorded_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account public.strategy_account%rowtype;
  v_run public.run_manifest%rowtype;
  v_existing public.strategy_ledger_head%rowtype;
  v_opening public.accounting_transaction%rowtype;
  v_artifact public.artifact_metadata%rowtype;
  v_cash numeric;
  v_genesis jsonb;
  v_genesis_sha text;
  v_head_sha text;
begin
  if p_strategy_account_id is null
    or p_recorded_by is null
    or btrim(p_recorded_by) = ''
  then
    raise exception 'strategy account and recorded_by are required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('twofold-ledger:' || p_strategy_account_id::text, 0)
  );

  select * into v_existing
    from public.strategy_ledger_head
   where strategy_account_id = p_strategy_account_id;

  if found then
    if v_existing.initialized_by is distinct from p_recorded_by then
      raise exception 'ledger head identity was reused with a different recorder'
        using errcode = '23505';
    end if;
    return public.strategy_ledger_head_result(v_existing);
  end if;

  select * into v_account
    from public.strategy_account
   where strategy_account_id = p_strategy_account_id;

  if not found
    or v_account.live_trading
    or v_account.base_currency <> 'USD'
  then
    raise exception 'ledger head requires an existing paper-only USD account'
      using errcode = '22023';
  end if;

  select * into v_run
    from public.run_manifest
   where run_id = v_account.run_id;

  if not found then
    raise exception 'ledger genesis requires an immutable run manifest'
      using errcode = '55000';
  end if;

  if (select count(*) from public.accounting_transaction
       where strategy_account_id = p_strategy_account_id) <> 1
  then
    raise exception 'ledger genesis requires exactly one opening transaction'
      using errcode = '55000';
  end if;

  select * into strict v_opening
    from public.accounting_transaction
   where strategy_account_id = p_strategy_account_id;

  if v_opening.transaction_type <> 'opening_balance'
    or v_opening.metadata->>'openingStateSchema'
      is distinct from 'twofold.paper_opening_state/v1'
    or jsonb_typeof(v_opening.metadata->'openingStateArtifactId')
      is distinct from 'string'
    or (v_opening.metadata->>'openingStateArtifactId') !~* (
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-'
      || '[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    or jsonb_typeof(v_opening.metadata->'openingStateSha256')
      is distinct from 'string'
    or (v_opening.metadata->>'openingStateSha256') !~ '^[0-9a-f]{64}$'
  then
    raise exception 'opening transaction lacks immutable opening-state evidence'
      using errcode = '55000';
  end if;

  select * into v_artifact
    from public.artifact_metadata
   where artifact_id =
      (v_opening.metadata->>'openingStateArtifactId')::uuid
     and sha256 = v_opening.metadata->>'openingStateSha256'
     and run_id = v_account.run_id
     and artifact_kind = 'paper_account_opening_state';

  if not found then
    raise exception 'opening-state artifact/hash/run binding is invalid'
      using errcode = '55000';
  end if;

  if (select count(*) from public.accounting_posting
       where accounting_transaction_id = v_opening.accounting_transaction_id)
       <> 2
    or (select count(*) from public.accounting_posting
         where accounting_transaction_id = v_opening.accounting_transaction_id
           and account_code = 'asset.cash'
           and side = 'debit'
           and currency = 'USD'
           and instrument_id is null
           and lot_origin_id is null) <> 1
    or (select count(*) from public.accounting_posting
         where accounting_transaction_id = v_opening.accounting_transaction_id
           and account_code = 'equity.opening_balance'
           and side = 'credit'
           and currency = 'USD'
           and instrument_id is null
           and lot_origin_id is null) <> 1
  then
    raise exception 'opening journal must be one positive USD cash/equity pair'
      using errcode = '55000';
  end if;

  select amount into strict v_cash
    from public.accounting_posting
   where accounting_transaction_id = v_opening.accounting_transaction_id
     and account_code = 'asset.cash'
     and side = 'debit';

  if v_cash <= 0
    or v_cash is distinct from (
      select amount
        from public.accounting_posting
       where accounting_transaction_id = v_opening.accounting_transaction_id
         and account_code = 'equity.opening_balance'
         and side = 'credit'
    )
    or exists (
      select 1 from public.position_lot_origin
       where strategy_account_id = p_strategy_account_id
    )
    or exists (
      select 1 from public.accounting_posting
       where strategy_account_id = p_strategy_account_id
         and account_code = 'securities.inventory'
    )
    or exists (
      select 1 from public.paper_fill_settlement
       where strategy_account_id = p_strategy_account_id
    )
  then
    raise exception 'v1 genesis must be a reconciled positive all-cash account'
      using errcode = '55000';
  end if;

  v_genesis := jsonb_build_object(
    'schema', 'twofold.strategy_ledger_genesis/v1',
    'strategyAccountIdempotencyKey', v_account.idempotency_key,
    'runManifestIdempotencyKey', v_run.idempotency_key,
    'runManifestSha256', v_run.manifest_sha256,
    'openingTransactionIdempotencyKey', v_opening.idempotency_key,
    'openingSourceEventKey', v_opening.source_event_key,
    'openingPostingManifestSha256', v_opening.posting_manifest_sha256,
    'openingCash', public.accounting_decimal_text(v_cash),
    'openingStateArtifactIdempotencyKey', v_artifact.idempotency_key,
    'openingStateSha256', v_artifact.sha256,
    'initializedBy', p_recorded_by,
    'accountingTransactionCount', '1',
    'lotOriginCount', '0',
    'acquisitionFxBindingCount', '0',
    'settlementCount', '0'
  );
  v_genesis_sha := encode(
    extensions.digest(convert_to(v_genesis::text, 'UTF8'), 'sha256'),
    'hex'
  );
  v_head_sha := encode(
    extensions.digest(
      convert_to(
        'twofold.strategy_ledger_head/v1' || chr(10) || v_genesis_sha,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  insert into public.strategy_ledger_head (
    strategy_account_id,
    head_sequence,
    head_sha256,
    accounting_transaction_count,
    lot_origin_count,
    acquisition_fx_binding_count,
    settlement_count,
    genesis_manifest,
    genesis_manifest_sha256,
    initialized_by
  ) values (
    p_strategy_account_id,
    0,
    v_head_sha,
    1,
    0,
    0,
    0,
    v_genesis,
    v_genesis_sha,
    p_recorded_by
  ) returning * into v_existing;

  return public.strategy_ledger_head_result(v_existing);
end;
$$;

create or replace function public.get_strategy_ledger_head(
  p_strategy_account_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_head public.strategy_ledger_head%rowtype;
begin
  if p_strategy_account_id is null then
    raise exception 'strategy account is required' using errcode = '22023';
  end if;

  select * into v_head
    from public.strategy_ledger_head
   where strategy_account_id = p_strategy_account_id;

  if not found then
    raise exception 'strategy ledger head is not initialized'
      using errcode = 'P0002';
  end if;

  return public.strategy_ledger_head_result(v_head);
end;
$$;

create or replace function public.settle_paper_fill(
  p_idempotency_key text,
  p_strategy_account_id uuid,
  p_frozen_order_plan_id uuid,
  p_order_id text,
  p_execution_price_evidence_id uuid,
  p_tax_fx_rate_evidence_id uuid,
  p_executed_at timestamptz,
  p_settlement_date date,
  p_expected_head_sequence bigint,
  p_expected_head_sha256 text,
  p_recorded_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_existing public.paper_fill_settlement%rowtype;
  v_head public.strategy_ledger_head%rowtype;
  v_account public.strategy_account%rowtype;
  v_plan public.frozen_order_plan%rowtype;
  v_evidence public.official_execution_price_evidence%rowtype;
  v_tax_fx public.tax_fx_rate_evidence%rowtype;
  v_artifact public.artifact_metadata%rowtype;
  v_order jsonb;
  v_order_index bigint;
  v_terms jsonb;
  v_rates jsonb;
  v_order_quantity numeric;
  v_open_price numeric;
  v_fill_price numeric;
  v_fill_scale integer;
  v_slippage_bps integer;
  v_initial_buying_power numeric;
  v_prior_plan_spend numeric;
  v_frozen_remaining numeric;
  v_cash_before numeric;
  v_effective_limit numeric;
  v_low numeric;
  v_high numeric;
  v_mid numeric;
  v_candidate_gross numeric;
  v_candidate_fees numeric;
  v_fill_quantity numeric := 0;
  v_canceled_quantity numeric;
  v_gross numeric := 0;
  v_commission numeric := 0;
  v_platform numeric := 0;
  v_settlement_fee numeric := 0;
  v_sec numeric := 0;
  v_finra numeric := 0;
  v_cat numeric := 0;
  v_total_fees numeric := 0;
  v_acquisition_tax_basis_cny numeric;
  v_cash_effect numeric := 0;
  v_cash_after numeric;
  v_outcome text;
  v_commission_rate numeric;
  v_commission_min numeric;
  v_platform_rate numeric;
  v_platform_min numeric;
  v_settlement_rate numeric;
  v_cat_rate numeric;
  v_request jsonb;
  v_request_sha text;
  v_settlement_manifest jsonb;
  v_settlement_sha text;
  v_post_head_sha text;
  v_settlement_id uuid;
  v_lot_id uuid;
  v_transaction_id uuid;
  v_posting_manifest jsonb;
  v_posting_sha text;
  v_actual_transaction_count bigint;
  v_actual_lot_count bigint;
  v_actual_acquisition_fx_count bigint;
  v_actual_settlement_count bigint;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_strategy_account_id is null
    or p_frozen_order_plan_id is null
    or p_order_id is null or btrim(p_order_id) = ''
    or p_execution_price_evidence_id is null
    or p_executed_at is null
    or p_settlement_date is null
    or p_expected_head_sequence is null or p_expected_head_sequence < 0
    or p_expected_head_sha256 is null
    or p_expected_head_sha256 !~ '^[0-9a-f]{64}$'
    or p_recorded_by is null or btrim(p_recorded_by) = ''
  then
    raise exception 'settlement request contains a missing or invalid field'
      using errcode = '22023';
  end if;

  if p_executed_at is distinct from date_trunc(
    'millisecond',
    p_executed_at
  ) then
    raise exception 'settlement executed_at must be exact to milliseconds'
      using errcode = '22023';
  end if;

  -- A stable global idempotency lock plus the account lock serialize both
  -- retry aliases without relying on an HTTP transaction.
  perform pg_advisory_xact_lock(
    hashtextextended('twofold-settlement-idem:' || p_idempotency_key, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('twofold-ledger:' || p_strategy_account_id::text, 0)
  );

  -- Exact recovery deliberately precedes head CAS, time, priority, and
  -- evidence-availability checks. A lost response remains retryable forever.
  select * into v_existing
    from public.paper_fill_settlement
   where idempotency_key = p_idempotency_key
      or (
        frozen_order_plan_id = p_frozen_order_plan_id
        and order_id = p_order_id
      )
   order by case when idempotency_key = p_idempotency_key then 0 else 1 end
   limit 1;

  if found then
    if v_existing.idempotency_key is distinct from p_idempotency_key
      or v_existing.strategy_account_id is distinct from p_strategy_account_id
      or v_existing.frozen_order_plan_id
        is distinct from p_frozen_order_plan_id
      or v_existing.order_id is distinct from p_order_id
      or v_existing.execution_price_evidence_id
        is distinct from p_execution_price_evidence_id
      or v_existing.requested_tax_fx_rate_evidence_id
        is distinct from p_tax_fx_rate_evidence_id
      or v_existing.executed_at is distinct from p_executed_at
      or v_existing.settlement_date is distinct from p_settlement_date
      or v_existing.requested_expected_head_sequence
        is distinct from p_expected_head_sequence
      or v_existing.requested_expected_head_sha256
        is distinct from p_expected_head_sha256
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'settlement idempotency or plan/order conflict'
        using errcode = '23505';
    end if;

    return public.paper_fill_settlement_result(v_existing);
  end if;

  select * into v_head
    from public.strategy_ledger_head
   where strategy_account_id = p_strategy_account_id
   for update;

  if not found then
    raise exception 'strategy ledger head is not initialized'
      using errcode = '55000';
  end if;

  if v_head.head_sequence is distinct from p_expected_head_sequence
    or v_head.head_sha256 is distinct from p_expected_head_sha256
  then
    raise exception 'strategy ledger head compare-and-swap failed'
      using errcode = '40001';
  end if;

  select count(*) into v_actual_transaction_count
    from public.accounting_transaction
   where strategy_account_id = p_strategy_account_id;
  select count(*) into v_actual_lot_count
    from public.position_lot_origin
   where strategy_account_id = p_strategy_account_id;
  select count(*) into v_actual_acquisition_fx_count
    from public.position_lot_acquisition_fx
   where strategy_account_id = p_strategy_account_id;
  select count(*) into v_actual_settlement_count
    from public.paper_fill_settlement
   where strategy_account_id = p_strategy_account_id;

  if v_actual_transaction_count <> v_head.accounting_transaction_count
    or v_actual_lot_count <> v_head.lot_origin_count
    or v_actual_acquisition_fx_count
      <> v_head.acquisition_fx_binding_count
    or v_actual_settlement_count <> v_head.settlement_count
  then
    raise exception 'ledger integrity counters diverged from persisted state'
      using errcode = '55000';
  end if;

  select * into v_plan
    from public.frozen_order_plan
   where frozen_order_plan_id = p_frozen_order_plan_id
     and strategy_account_id = p_strategy_account_id;

  if not found then
    raise exception 'frozen plan does not belong to this account'
      using errcode = '22023';
  end if;

  if v_plan.stage <> 'S2' then
    raise exception 'S1 settlement is fail closed until trusted CNY FX/FIFO tax settlement exists'
      using errcode = '0A000';
  end if;

  select * into v_account
    from public.strategy_account
   where strategy_account_id = p_strategy_account_id
     and run_id = v_plan.run_id;

  if not found then
    raise exception 'settlement account/run binding is invalid'
      using errcode = '55000';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(v_plan.plan->'orders') as orders(item)
     where jsonb_typeof(orders.item->'priority') is distinct from 'string'
        or (orders.item->>'priority') !~ '^[1-9][0-9]*$'
  ) or exists (
    select 1
      from jsonb_array_elements(v_plan.plan->'orders') with ordinality
        as current_order(item, ordinality)
      join jsonb_array_elements(v_plan.plan->'orders') with ordinality
        as prior_order(item, ordinality)
        on prior_order.ordinality < current_order.ordinality
     where (prior_order.item->>'priority')::numeric
       >= (current_order.item->>'priority')::numeric
  ) then
    raise exception 'S2 order priorities must be unique and strictly increase with array order'
      using errcode = '22023';
  end if;

  select item, ordinality into v_order, v_order_index
    from jsonb_array_elements(v_plan.plan->'orders') with ordinality
      as orders(item, ordinality)
   where item->>'orderId' = p_order_id;

  if not found then
    raise exception 'order is not present in the frozen plan'
      using errcode = '22023';
  end if;

  if v_order->>'side' <> 'BUY'
    or v_order->>'executionModel' <> 'SIMULATED_SLIPPAGE'
    or v_order->>'feeCurrency' <> 'USD'
  then
    raise exception 'v1 settlement accepts only simulated USD S2 BUY orders'
      using errcode = '0A000';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(v_plan.plan->'orders') with ordinality
        as earlier(item, ordinality)
     where earlier.ordinality < v_order_index
       and not exists (
         select 1
           from public.paper_fill_settlement as prior
          where prior.frozen_order_plan_id = p_frozen_order_plan_id
            and prior.order_id = earlier.item->>'orderId'
       )
  ) then
    raise exception 'frozen S2 order priority would be bypassed'
      using errcode = '55000';
  end if;

  if p_executed_at > clock_timestamp()
    or (p_executed_at at time zone 'UTC')::date
      is distinct from v_plan.planned_trade_date
    or p_settlement_date < v_plan.planned_trade_date
  then
    raise exception 'execution/settlement time is inconsistent with the frozen trade date'
      using errcode = '22023';
  end if;

  select * into v_evidence
    from public.official_execution_price_evidence
   where execution_price_evidence_id = p_execution_price_evidence_id;

  if not found
    or v_evidence.run_id is distinct from v_plan.run_id
    or v_evidence.instrument_id is distinct from
      (v_order->>'instrumentId')::uuid
    or v_evidence.session_date is distinct from v_plan.planned_trade_date
    or v_evidence.currency <> 'USD'
    or v_evidence.evidence_kind <> 'OFFICIAL_AUCTION_OPEN'
    or (v_evidence.observed_at at time zone 'UTC')::date
      is distinct from v_evidence.session_date
    or (v_evidence.available_at at time zone 'UTC')::date
      is distinct from v_evidence.session_date
    or v_evidence.available_at > p_executed_at
  then
    raise exception 'official auction execution evidence is missing, late, or mismatched'
      using errcode = '22023';
  end if;

  select * into v_artifact
    from public.artifact_metadata
   where artifact_id = v_evidence.source_artifact_id
     and sha256 = v_evidence.source_sha256
     and run_id = v_plan.run_id
     and (
       (
         v_evidence.authority = 'PRIMARY_EXCHANGE_OFFICIAL'
         and artifact_kind = 'official_exchange_auction_print'
       )
       or (
         v_evidence.authority = 'REGULATED_BROKER_EXECUTION'
         and artifact_kind = 'regulated_broker_auction_execution'
       )
     );

  if not found then
    raise exception 'execution evidence source artifact binding is invalid'
      using errcode = '55000';
  end if;

  v_order_quantity := (v_order->>'quantity')::numeric;
  if v_order_quantity > 99999999999999999999999999::numeric then
    raise exception 'order quantity exceeds accounting storage precision'
      using errcode = '22003';
  end if;

  v_fill_scale := (v_plan.plan->>'fillPriceScale')::integer;
  if v_fill_scale not between 0 and 12 then
    raise exception 'v1 settlement requires fillPriceScale between 0 and 12'
      using errcode = '22023';
  end if;
  v_slippage_bps := (v_plan.plan->>'slippageBps')::integer;
  v_open_price := v_evidence.official_open_price::numeric;
  v_fill_price := round(
    v_open_price * (10000 + v_slippage_bps)::numeric / 10000,
    v_fill_scale
  );
  if v_fill_price <= 0
    or v_fill_price >= 100000000000000000000000000::numeric
  then
    raise exception 'derived simulated fill price is outside accounting precision'
      using errcode = '22003';
  end if;

  begin
    v_terms := (v_order->>'feeScheduleTerms')::jsonb;
  exception when others then
    raise exception 'frozen fee schedule terms are not valid JSON'
      using errcode = '22023';
  end;

  if jsonb_typeof(v_terms) <> 'object'
    or public.jsonb_contains_number(v_terms)
    or (select count(*) from jsonb_object_keys(v_terms)) <> 12
    or not (v_terms ?& array[
      'feeScheduleId', 'brokerLegalEntity', 'accountRegion', 'market',
      'product', 'accountTier', 'effectiveFrom', 'effectiveTo', 'currency',
      'roundingPolicy', 'aggregationPolicy', 'rates'
    ]::text[])
    or v_terms->>'feeScheduleId' is distinct from v_order->>'feeScheduleId'
    or v_terms->>'currency' <> 'USD'
    or v_terms->>'market' <> 'US'
    or v_terms->>'product' <> 'US_EQUITY_ETF'
    or v_terms->>'roundingPolicy' <> 'ROUND_HALF_UP_TO_CENT'
    or v_terms->>'aggregationPolicy' <> 'PER_ORDER'
    or (v_terms->>'effectiveFrom') !~ '^\d{4}-\d{2}-\d{2}$'
    or (v_terms->>'effectiveFrom')::date > v_plan.planned_trade_date
    or (
      jsonb_typeof(v_terms->'effectiveTo') <> 'null'
      and (
        jsonb_typeof(v_terms->'effectiveTo') <> 'string'
        or (v_terms->>'effectiveTo') !~ '^\d{4}-\d{2}-\d{2}$'
        or (v_terms->>'effectiveTo')::date <= v_plan.planned_trade_date
      )
    )
    or jsonb_typeof(v_terms->'rates') <> 'object'
  then
    raise exception 'frozen fee schedule is not an admissible per-order USD schedule'
      using errcode = '22023';
  end if;

  v_rates := v_terms->'rates';
  if (select count(*) from jsonb_object_keys(v_rates)) <> 11
    or not (v_rates ?& array[
      'commissionPerShare', 'commissionMinimumPerOrder',
      'platformPerShare', 'platformMinimumPerOrder', 'settlementPerShare',
      'secRateOfGrossNotional', 'secMinimumPerOrder', 'finraTafPerShare',
      'finraTafMinimumPerOrder', 'finraTafMaximumPerOrder', 'catPerShare'
    ]::text[])
  then
    raise exception 'frozen fee rates do not contain the exact v1 components'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_each(v_rates) as rate(name, value)
     where jsonb_typeof(rate.value) <> 'string'
       or (rate.value #>> '{}')
         !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
       or (rate.value #>> '{}')::numeric < 0
  ) then
    raise exception 'frozen fee rates must be nonnegative decimal strings'
      using errcode = '22023';
  end if;

  v_commission_rate := (v_rates->>'commissionPerShare')::numeric;
  v_commission_min := (v_rates->>'commissionMinimumPerOrder')::numeric;
  v_platform_rate := (v_rates->>'platformPerShare')::numeric;
  v_platform_min := (v_rates->>'platformMinimumPerOrder')::numeric;
  v_settlement_rate := (v_rates->>'settlementPerShare')::numeric;
  v_cat_rate := (v_rates->>'catPerShare')::numeric;

  select coalesce(sum(
    case posting.side when 'debit' then posting.amount else -posting.amount end
  ), 0) into v_cash_before
    from public.accounting_posting as posting
   where posting.strategy_account_id = p_strategy_account_id
     and posting.account_code = 'asset.cash'
     and posting.currency = 'USD';

  if v_cash_before < 0 then
    raise exception 'current ledger buying power cannot be negative'
      using errcode = '55000';
  end if;

  v_initial_buying_power := (v_plan.plan->>'initialBuyingPower')::numeric;
  select coalesce(sum(cash_effect), 0) into v_prior_plan_spend
    from public.paper_fill_settlement
   where frozen_order_plan_id = p_frozen_order_plan_id;
  v_frozen_remaining := greatest(
    v_initial_buying_power - v_prior_plan_spend,
    0
  );
  v_effective_limit := least(v_cash_before, v_frozen_remaining);

  -- Integer binary search derives the largest all-in affordable quantity.
  v_low := 1;
  v_high := v_order_quantity;
  while v_low <= v_high loop
    v_mid := floor((v_low + v_high) / 2);
    v_candidate_gross := v_fill_price * v_mid;
    v_candidate_fees :=
      round(greatest(v_commission_rate * v_mid, v_commission_min), 2)
      + round(greatest(v_platform_rate * v_mid, v_platform_min), 2)
      + round(v_settlement_rate * v_mid, 2)
      + round(v_cat_rate * v_mid, 2);

    if v_candidate_gross + v_candidate_fees <= v_effective_limit then
      v_fill_quantity := v_mid;
      v_low := v_mid + 1;
    else
      v_high := v_mid - 1;
    end if;
  end loop;

  v_canceled_quantity := v_order_quantity - v_fill_quantity;
  if v_fill_quantity = 0 then
    v_outcome := 'CANCELED_CASH_LIMIT';
  else
    v_gross := v_fill_price * v_fill_quantity;
    v_commission := round(
      greatest(v_commission_rate * v_fill_quantity, v_commission_min),
      2
    );
    v_platform := round(
      greatest(v_platform_rate * v_fill_quantity, v_platform_min),
      2
    );
    v_settlement_fee := round(
      v_settlement_rate * v_fill_quantity,
      2
    );
    v_cat := round(v_cat_rate * v_fill_quantity, 2);
    v_total_fees := v_commission + v_platform + v_settlement_fee + v_cat;
    if v_total_fees <= 0 then
      raise exception 'a filled v1 Futu order must derive a positive fee total'
        using errcode = '22023';
    end if;
    v_cash_effect := v_gross + v_total_fees;
    v_outcome := case
      when v_fill_quantity = v_order_quantity then 'FILLED'
      else 'PARTIALLY_FILLED_CASH_LIMIT'
    end;
  end if;
  v_cash_after := v_cash_before - v_cash_effect;

  if v_fill_quantity > 0 then
    if p_tax_fx_rate_evidence_id is null then
      raise exception 'a positive BUY fill requires acquisition USD/CNY tax FX evidence'
        using errcode = '22023';
    end if;

    select * into v_tax_fx
      from public.tax_fx_rate_evidence
     where tax_fx_rate_evidence_id = p_tax_fx_rate_evidence_id;

    if not found
      or v_tax_fx.run_id is distinct from v_plan.run_id
      or v_tax_fx.rate_kind <> 'ACQUISITION_TAX_BASIS_USD_CNY'
      or v_tax_fx.effective_date is distinct from v_plan.planned_trade_date
      or v_tax_fx.base_currency <> 'USD'
      or v_tax_fx.quote_currency <> 'CNY'
      or v_tax_fx.available_at > clock_timestamp()
      or not exists (
        select 1
          from public.artifact_metadata as fx_artifact
         where fx_artifact.artifact_id = v_tax_fx.source_artifact_id
           and fx_artifact.sha256 = v_tax_fx.source_sha256
           and fx_artifact.run_id = v_plan.run_id
           and fx_artifact.artifact_kind = 'official_tax_fx_rate'
      )
    then
      raise exception 'acquisition USD/CNY tax FX evidence is missing, late, or mismatched'
        using errcode = '22023';
    end if;

    v_acquisition_tax_basis_cny :=
      (v_gross + v_total_fees) * v_tax_fx.cny_per_usd::numeric;
  end if;

  if v_gross >= 100000000000000000000000000::numeric
    or v_total_fees >= 100000000000000000000000000::numeric
    or v_cash_effect > v_effective_limit
    or v_cash_after < 0
  then
    raise exception 'derived fill exceeds precision or buying-power limits'
      using errcode = '22003';
  end if;

  v_request := jsonb_build_object(
    'schema', 'twofold.settle_paper_fill_request/v1',
    'idempotencyKey', p_idempotency_key,
    'strategyAccountIdempotencyKey', v_account.idempotency_key,
    'frozenOrderPlanIdempotencyKey', v_plan.idempotency_key,
    'frozenOrderPlanSha256', v_plan.plan_sha256,
    'orderId', p_order_id,
    'executionPriceEvidenceIdempotencyKey', v_evidence.idempotency_key,
    'executionPriceEvidenceSha256', v_evidence.evidence_sha256,
    'taxFxEvidenceIdempotencyKey', case
      when v_fill_quantity = 0 then null
      else to_jsonb(v_tax_fx.idempotency_key)
    end,
    'taxFxEvidenceSha256', case
      when v_fill_quantity = 0 then null
      else to_jsonb(v_tax_fx.evidence_sha256)
    end,
    'executedAt', to_char(
      p_executed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'settlementDate', p_settlement_date::text,
    'expectedHeadSequence', p_expected_head_sequence::text,
    'expectedHeadSha256', p_expected_head_sha256,
    'recordedBy', p_recorded_by
  );
  v_request_sha := encode(
    extensions.digest(convert_to(v_request::text, 'UTF8'), 'sha256'),
    'hex'
  );
  v_settlement_id := public.deterministic_uuid_from_sha256(
    'twofold.paper_fill_settlement/v1',
    v_request_sha
  );

  if v_fill_quantity > 0 then
    v_lot_id := public.deterministic_uuid_from_sha256(
      'twofold.position_lot_origin.paper_fill/v1',
      v_settlement_id::text
    );
    insert into public.position_lot_origin (
      lot_origin_id,
      idempotency_key,
      strategy_account_id,
      instrument_id,
      origin_kind,
      origin_reference,
      acquired_at,
      effective_date,
      original_quantity,
      unit_purchase_price,
      allocated_buy_fees,
      currency,
      lot_method,
      source_sha256,
      source_artifact_id,
      metadata,
      recorded_by
    ) values (
      v_lot_id,
      'paper-fill-lot:' || v_settlement_id::text,
      p_strategy_account_id,
      (v_order->>'instrumentId')::uuid,
      'buy_fill',
      p_order_id,
      p_executed_at,
      v_plan.planned_trade_date,
      v_fill_quantity,
      v_fill_price,
      v_total_fees,
      'USD',
      'FIFO',
      v_evidence.source_sha256,
      v_evidence.source_artifact_id,
      jsonb_build_object(
        'schema', 'twofold.paper_fill_lot/v1',
        'settlementId', v_settlement_id::text,
        'frozenOrderPlanIdempotencyKey', v_plan.idempotency_key,
        'frozenOrderPlanSha256', v_plan.plan_sha256,
        'orderId', p_order_id,
        'executionPriceEvidenceIdempotencyKey', v_evidence.idempotency_key,
        'executionPriceEvidenceSha256', v_evidence.evidence_sha256
      ),
      p_recorded_by
    );

    insert into public.position_lot_acquisition_fx (
      lot_origin_id,
      strategy_account_id,
      instrument_id,
      tax_fx_rate_evidence_id,
      cny_per_usd,
      acquisition_tax_basis_cny,
      source_sha256,
      recorded_by
    ) values (
      v_lot_id,
      p_strategy_account_id,
      (v_order->>'instrumentId')::uuid,
      p_tax_fx_rate_evidence_id,
      v_tax_fx.cny_per_usd::numeric,
      v_acquisition_tax_basis_cny,
      v_tax_fx.source_sha256,
      p_recorded_by
    );

    v_transaction_id := public.deterministic_uuid_from_sha256(
      'twofold.accounting_transaction.paper_fill/v1',
      v_settlement_id::text
    );
    v_posting_manifest := jsonb_build_array(
      jsonb_build_object(
        'account_code', 'securities.inventory',
        'side', 'debit',
        'amount', public.accounting_decimal_text(v_gross),
        'currency', 'USD',
        'instrument_id', (v_order->>'instrumentId'),
        'lot_origin_id', v_lot_id::text
      ),
      jsonb_build_object(
        'account_code', 'expense.broker_fee',
        'side', 'debit',
        'amount', public.accounting_decimal_text(v_total_fees),
        'currency', 'USD'
      ),
      jsonb_build_object(
        'account_code', 'asset.cash',
        'side', 'credit',
        'amount', public.accounting_decimal_text(v_cash_effect),
        'currency', 'USD'
      )
    );
    v_posting_sha := encode(
      extensions.digest(
        convert_to(v_posting_manifest::text, 'UTF8'),
        'sha256'
      ),
      'hex'
    );

    insert into public.accounting_transaction (
      accounting_transaction_id,
      idempotency_key,
      strategy_account_id,
      transaction_type,
      source_event_key,
      event_time,
      effective_date,
      settlement_date,
      description,
      posting_manifest,
      posting_manifest_sha256,
      metadata,
      recorded_by
    ) values (
      v_transaction_id,
      'paper-fill-journal:' || v_settlement_id::text,
      p_strategy_account_id,
      'buy_fill',
      'paper-fill:' || v_plan.idempotency_key || ':' || p_order_id,
      p_executed_at,
      v_plan.planned_trade_date,
      p_settlement_date,
      'Atomic S2 paper BUY settlement',
      v_posting_manifest,
      v_posting_sha,
      jsonb_build_object(
        'schema', 'twofold.paper_fill_journal/v1',
        'settlementId', v_settlement_id::text,
        'requestSha256', v_request_sha
      ),
      p_recorded_by
    );

    insert into public.accounting_posting (
      accounting_transaction_id,
      strategy_account_id,
      posting_index,
      account_code,
      side,
      amount,
      currency,
      instrument_id,
      lot_origin_id,
      memo
    ) values
      (
        v_transaction_id, p_strategy_account_id, 0,
        'securities.inventory', 'debit', v_gross, 'USD',
        (v_order->>'instrumentId')::uuid, v_lot_id,
        'Gross security cost'
      ),
      (
        v_transaction_id, p_strategy_account_id, 1,
        'expense.broker_fee', 'debit', v_total_fees, 'USD',
        null, null, 'Per-order broker and market fees'
      ),
      (
        v_transaction_id, p_strategy_account_id, 2,
        'asset.cash', 'credit', v_cash_effect, 'USD',
        null, null, 'Cash paid for purchase and fees'
      );
  end if;

  v_settlement_manifest := jsonb_build_object(
    'schema', 'twofold.paper_fill_settlement/v1',
    'settlementId', v_settlement_id::text,
    'requestSha256', v_request_sha,
    'strategyAccountIdempotencyKey', v_account.idempotency_key,
    'frozenOrderPlanIdempotencyKey', v_plan.idempotency_key,
    'frozenOrderPlanSha256', v_plan.plan_sha256,
    'orderId', p_order_id,
    'instrumentId', v_order->>'instrumentId',
    'stage', 'S2',
    'side', 'BUY',
    'outcome', v_outcome,
    'orderQuantity', public.accounting_decimal_text(v_order_quantity),
    'fillQuantity', public.accounting_decimal_text(v_fill_quantity),
    'canceledQuantity', public.accounting_decimal_text(v_canceled_quantity),
    'officialOpenPrice', public.accounting_decimal_text(v_open_price),
    'fillPrice', public.accounting_decimal_text(v_fill_price),
    'grossNotional', public.accounting_decimal_text(v_gross),
    'totalFees', public.accounting_decimal_text(v_total_fees),
    'cashEffect', public.accounting_decimal_text(v_cash_effect),
    'buyingPowerBefore', public.accounting_decimal_text(v_cash_before),
    'frozenBuyingPowerRemainingBefore',
      public.accounting_decimal_text(v_frozen_remaining),
    'effectiveBuyingPowerLimit',
      public.accounting_decimal_text(v_effective_limit),
    'buyingPowerAfter', public.accounting_decimal_text(v_cash_after),
    'accountingTransactionId', case
      when v_transaction_id is null then null
      else to_jsonb(v_transaction_id::text)
    end,
    'createdLotOriginId', case
      when v_lot_id is null then null
      else to_jsonb(v_lot_id::text)
    end,
    'postingManifestSha256', case
      when v_posting_sha is null then null
      else to_jsonb(v_posting_sha)
    end,
    'feeComponents', jsonb_build_object(
      'commission', public.accounting_decimal_text(v_commission),
      'platform', public.accounting_decimal_text(v_platform),
      'settlement', public.accounting_decimal_text(v_settlement_fee),
      'secRegulatory', public.accounting_decimal_text(v_sec),
      'finraTaf', public.accounting_decimal_text(v_finra),
      'cat', public.accounting_decimal_text(v_cat)
    ),
    'acquisitionTaxBasisCny', case
      when v_acquisition_tax_basis_cny is null then null
      else to_jsonb(
        public.accounting_decimal_text(v_acquisition_tax_basis_cny)
      )
    end,
    'preHeadSequence', v_head.head_sequence::text,
    'preHeadSha256', v_head.head_sha256,
    'postHeadSequence', (v_head.head_sequence + 1)::text,
    'executionPriceEvidenceIdempotencyKey', v_evidence.idempotency_key,
    'executionPriceEvidenceSha256', v_evidence.evidence_sha256,
    'sourceArtifactSha256', v_evidence.source_sha256,
    'taxFxEvidenceIdempotencyKey', case
      when v_fill_quantity = 0 then null
      else to_jsonb(v_tax_fx.idempotency_key)
    end,
    'acquisitionCnyPerUsd', case
      when v_fill_quantity = 0 then null
      else to_jsonb(v_tax_fx.cny_per_usd)
    end,
    'taxFxEvidenceSha256', case
      when v_fill_quantity = 0 then null
      else to_jsonb(v_tax_fx.evidence_sha256)
    end
  );
  v_settlement_sha := encode(
    extensions.digest(
      convert_to(v_settlement_manifest::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  v_post_head_sha := encode(
    extensions.digest(
      convert_to(
        v_head.head_sha256 || chr(10) || v_settlement_sha,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  insert into public.paper_fill_settlement (
    settlement_id,
    idempotency_key,
    strategy_account_id,
    frozen_order_plan_id,
    order_id,
    instrument_id,
    stage,
    side,
    outcome,
    execution_price_evidence_id,
    executed_at,
    settlement_date,
    order_quantity,
    fill_quantity,
    canceled_quantity,
    official_open_price,
    fill_price,
    gross_notional,
    total_fees,
    cash_effect,
    tax_reserve_effect,
    buying_power_before,
    frozen_buying_power_remaining_before,
    effective_buying_power_limit,
    buying_power_after,
    accounting_transaction_id,
    created_lot_origin_id,
    requested_expected_head_sequence,
    requested_expected_head_sha256,
    requested_tax_fx_rate_evidence_id,
    pre_head_sequence,
    pre_head_sha256,
    post_head_sequence,
    post_head_sha256,
    request_manifest,
    request_sha256,
    settlement_manifest,
    settlement_sha256,
    recorded_by
  ) values (
    v_settlement_id,
    p_idempotency_key,
    p_strategy_account_id,
    p_frozen_order_plan_id,
    p_order_id,
    (v_order->>'instrumentId')::uuid,
    'S2',
    'BUY',
    v_outcome,
    p_execution_price_evidence_id,
    p_executed_at,
    p_settlement_date,
    v_order_quantity,
    v_fill_quantity,
    v_canceled_quantity,
    v_open_price,
    v_fill_price,
    v_gross,
    v_total_fees,
    v_cash_effect,
    0,
    v_cash_before,
    v_frozen_remaining,
    v_effective_limit,
    v_cash_after,
    v_transaction_id,
    v_lot_id,
    p_expected_head_sequence,
    p_expected_head_sha256,
    p_tax_fx_rate_evidence_id,
    v_head.head_sequence,
    v_head.head_sha256,
    v_head.head_sequence + 1,
    v_post_head_sha,
    v_request,
    v_request_sha,
    v_settlement_manifest,
    v_settlement_sha,
    p_recorded_by
  ) returning * into v_existing;

  insert into public.paper_fill_fee_component (
    settlement_id,
    component,
    amount,
    currency
  ) values
    (v_settlement_id, 'commission', v_commission, 'USD'),
    (v_settlement_id, 'platform', v_platform, 'USD'),
    (v_settlement_id, 'settlement', v_settlement_fee, 'USD'),
    (v_settlement_id, 'sec_regulatory', v_sec, 'USD'),
    (v_settlement_id, 'finra_taf', v_finra, 'USD'),
    (v_settlement_id, 'cat', v_cat, 'USD');

  perform set_config('twofold.atomic_settlement', 'on', true);
  update public.strategy_ledger_head
     set head_sequence = head_sequence + 1,
         head_sha256 = v_post_head_sha,
         last_settlement_id = v_settlement_id,
         accounting_transaction_count = accounting_transaction_count
           + case when v_transaction_id is null then 0 else 1 end,
         lot_origin_count = lot_origin_count
           + case when v_lot_id is null then 0 else 1 end,
         acquisition_fx_binding_count = acquisition_fx_binding_count
           + case when v_lot_id is null then 0 else 1 end,
         settlement_count = settlement_count + 1,
         updated_at = clock_timestamp()
   where strategy_account_id = p_strategy_account_id;
  perform set_config('twofold.atomic_settlement', 'off', true);

  -- Verify the ledger-derived cash after all writes, still under the row lock.
  if v_cash_after is distinct from (
    select coalesce(sum(
      case posting.side when 'debit' then posting.amount else -posting.amount end
    ), 0)
      from public.accounting_posting as posting
     where posting.strategy_account_id = p_strategy_account_id
       and posting.account_code = 'asset.cash'
       and posting.currency = 'USD'
  ) then
    raise exception 'post-settlement cash reconciliation failed'
      using errcode = '55000';
  end if;

  return public.paper_fill_settlement_result(v_existing);
end;
$$;

comment on function public.initialize_strategy_ledger_head(uuid, text) is
  'Initializes v1 only from one artifact-bound, reconciled, positive all-cash USD opening journal; empty or pre-positioned accounts fail closed.';

comment on function public.get_strategy_ledger_head(uuid) is
  'Returns the per-account settlement pointer with every scalar encoded as a JSON string or null.';

comment on function public.settle_paper_fill(
  text, uuid, uuid, text, uuid, uuid, timestamptz, date, bigint, text, text
) is
  'Atomically settles one frozen S2 BUY order from trusted official-open evidence, current/frozen buying power, exact per-order fees, journal, lot, and hash-chain head. S1 is intentionally unsupported.';

alter table public.official_execution_price_evidence enable row level security;
alter table public.tax_fx_rate_evidence enable row level security;
alter table public.position_lot_acquisition_fx enable row level security;
alter table public.strategy_ledger_head enable row level security;
alter table public.paper_fill_settlement enable row level security;
alter table public.paper_fill_fee_component enable row level security;

revoke all on table public.official_execution_price_evidence
  from public, anon, authenticated, service_role;
revoke all on table public.tax_fx_rate_evidence
  from public, anon, authenticated, service_role;
revoke all on table public.position_lot_acquisition_fx
  from public, anon, authenticated, service_role;
revoke all on table public.strategy_ledger_head
  from public, anon, authenticated, service_role;
revoke all on table public.paper_fill_settlement
  from public, anon, authenticated, service_role;
revoke all on table public.paper_fill_fee_component
  from public, anon, authenticated, service_role;

-- Evidence has no service-role write RPC. A future trusted-ingestion role may
-- receive a dedicated exact-byte admission function without widening this
-- worker-facing settlement boundary.
grant select on table public.official_execution_price_evidence to service_role;
grant select on table public.tax_fx_rate_evidence to service_role;

revoke all on function public.guard_strategy_ledger_head_mutation()
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_s1_decision_evidence_cutoff()
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_execution_evidence_source_mapping()
  from public, anon, authenticated, service_role;
revoke all on function public.accounting_decimal_text(numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.deterministic_uuid_from_sha256(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.strategy_ledger_head_result(
  public.strategy_ledger_head
) from public, anon, authenticated, service_role;
revoke all on function public.paper_fill_settlement_result(
  public.paper_fill_settlement
) from public, anon, authenticated, service_role;
revoke all on function public.initialize_strategy_ledger_head(uuid, text)
  from public, anon, authenticated;
revoke all on function public.get_strategy_ledger_head(uuid)
  from public, anon, authenticated;
revoke all on function public.settle_paper_fill(
  text, uuid, uuid, text, uuid, uuid, timestamptz, date, bigint, text, text
) from public, anon, authenticated;

-- 008 exposed initial-lot registration before a ledger head existed. Once 009
-- is present, any standalone lot insertion would poison the head counters and
-- bypass atomic acquisition-FX binding, so the worker loses that capability.
revoke all on function public.register_position_lot_origin(
  text, uuid, uuid, text, text, timestamptz, date,
  numeric, numeric, numeric, text, text, jsonb, text, text, uuid
) from service_role;

grant execute on function public.initialize_strategy_ledger_head(uuid, text)
  to service_role;
grant execute on function public.get_strategy_ledger_head(uuid)
  to service_role;
grant execute on function public.settle_paper_fill(
  text, uuid, uuid, text, uuid, uuid, timestamptz, date, bigint, text, text
) to service_role;

commit;
