-- Minimal immutable accounting persistence boundary.  This migration freezes
-- run and instrument identity, records original FIFO lots, and admits balanced
-- journal entries through an internal primitive. Generic journal append stays
-- unexposed until atomic settlement can enforce cumulative no-margin balances.

begin;

create table public.run_manifest (
  run_manifest_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key <> ''),
  run_id uuid not null unique,
  manifest_schema text not null
    check (manifest_schema = 'twofold.run_manifest/v1'),
  manifest jsonb not null,
  manifest_sha256 text not null
    check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_artifact_id uuid references public.artifact_metadata(artifact_id),
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint run_manifest_payload_object
    check (jsonb_typeof(manifest) = 'object'),
  constraint run_manifest_payload_decimal_safe
    check (not public.jsonb_contains_number(manifest))
);

comment on table public.run_manifest is
  'Immutable, content-hashed versions and inputs for one reproducible Strategy Run.';

create table public.instrument (
  instrument_id uuid primary key,
  idempotency_key text not null unique check (idempotency_key <> ''),
  instrument_type text not null check (instrument_type in (
    'common_stock', 'adr', 'etf', 'cash'
  )),
  primary_exchange text not null check (primary_exchange <> ''),
  trading_currency text not null
    check (trading_currency ~ '^[A-Z]{3}$'),
  issuer_tax_residency text
    check (
      issuer_tax_residency is null
      or issuer_tax_residency ~ '^[A-Z]{2}$'
    ),
  metadata jsonb not null default '{}'::jsonb,
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint instrument_metadata_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint instrument_metadata_decimal_safe
    check (not public.jsonb_contains_number(metadata))
);

comment on table public.instrument is
  'Stable security identity. A ticker is a versioned alias, never the primary identity.';

create table public.instrument_symbol_version (
  symbol_version_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key <> ''),
  instrument_id uuid not null
    references public.instrument(instrument_id),
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.-]{0,14}$'),
  exchange text not null check (exchange <> ''),
  effective_from date not null,
  effective_to date,
  metadata jsonb not null default '{}'::jsonb,
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint instrument_symbol_effective_window check (
    effective_to is null or effective_to > effective_from
  ),
  constraint instrument_symbol_version_logical_unique
    unique (instrument_id, effective_from),
  constraint instrument_symbol_metadata_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint instrument_symbol_metadata_decimal_safe
    check (not public.jsonb_contains_number(metadata))
);

comment on table public.instrument_symbol_version is
  'Immutable effective-dated ticker history for a stable instrument. RPC validation rejects overlapping aliases and ticker reuse.';

create index instrument_symbol_lookup_idx
  on public.instrument_symbol_version (
    exchange,
    symbol,
    effective_from desc,
    effective_to,
    symbol_version_id
  );

create table public.strategy_account (
  strategy_account_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key <> ''),
  run_id uuid not null unique references public.run_manifest(run_id),
  account_code text not null check (account_code <> ''),
  broker text not null check (broker <> ''),
  broker_region text not null check (broker_region <> ''),
  base_currency text not null check (base_currency ~ '^[A-Z]{3}$'),
  live_trading boolean not null default false
    check (live_trading is false),
  metadata jsonb not null default '{}'::jsonb,
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint strategy_account_id_run_unique
    unique (strategy_account_id, run_id),
  constraint strategy_account_metadata_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint strategy_account_metadata_decimal_safe
    check (not public.jsonb_contains_number(metadata))
);

comment on table public.strategy_account is
  'One paper-only brokerage/accounting boundary per Strategy Run. live_trading is structurally forbidden.';

create table public.position_lot_origin (
  lot_origin_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key <> ''),
  strategy_account_id uuid not null
    references public.strategy_account(strategy_account_id),
  instrument_id uuid not null references public.instrument(instrument_id),
  origin_kind text not null check (origin_kind in (
    'initial_import',
    'buy_fill',
    'corporate_action_adjustment',
    'restatement'
  )),
  origin_reference text not null check (origin_reference <> ''),
  acquired_at timestamptz not null,
  effective_date date not null,
  original_quantity numeric(38, 12) not null
    check (original_quantity > 0),
  unit_purchase_price numeric(38, 12) not null
    check (unit_purchase_price > 0),
  allocated_buy_fees numeric(38, 12) not null
    check (allocated_buy_fees >= 0),
  purchase_price_total numeric
    generated always as (original_quantity * unit_purchase_price) stored,
  tax_basis numeric
    generated always as (
      original_quantity * unit_purchase_price + allocated_buy_fees
    ) stored,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  lot_method text not null default 'FIFO' check (lot_method = 'FIFO'),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_artifact_id uuid references public.artifact_metadata(artifact_id),
  metadata jsonb not null default '{}'::jsonb,
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint position_lot_origin_logical_unique
    unique (strategy_account_id, origin_kind, origin_reference),
  constraint position_lot_origin_account_instrument_unique
    unique (lot_origin_id, strategy_account_id, instrument_id),
  constraint position_lot_origin_metadata_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint position_lot_origin_metadata_decimal_safe
    check (not public.jsonb_contains_number(metadata))
);

comment on table public.position_lot_origin is
  'Immutable source lot bound to a source hash. FIFO ordering is effective_date/acquired_at/origin_reference; tax basis is generated without typmod rounding as purchase price plus allocated buy fees.';

create index position_lot_origin_fifo_idx
  on public.position_lot_origin (
    strategy_account_id,
    instrument_id,
    effective_date,
    acquired_at,
    origin_reference,
    lot_origin_id
  );

create table public.accounting_transaction (
  accounting_transaction_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key <> ''),
  strategy_account_id uuid not null
    references public.strategy_account(strategy_account_id),
  transaction_type text not null check (transaction_type in (
    'opening_balance',
    'buy_fill',
    'sell_fill',
    'fee',
    'tax_accrual',
    'tax_payment',
    'dividend',
    'corporate_action',
    'adjustment'
  )),
  source_event_key text not null check (source_event_key <> ''),
  event_time timestamptz not null,
  effective_date date not null,
  settlement_date date,
  description text not null check (description <> ''),
  posting_manifest jsonb not null,
  posting_manifest_sha256 text not null
    check (posting_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb,
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint accounting_transaction_source_unique
    unique (strategy_account_id, source_event_key),
  constraint accounting_transaction_account_unique
    unique (accounting_transaction_id, strategy_account_id),
  constraint accounting_transaction_postings_array
    check (
      jsonb_typeof(posting_manifest) = 'array'
      and jsonb_array_length(posting_manifest) >= 2
    ),
  constraint accounting_transaction_postings_decimal_safe
    check (not public.jsonb_contains_number(posting_manifest)),
  constraint accounting_transaction_metadata_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint accounting_transaction_metadata_decimal_safe
    check (not public.jsonb_contains_number(metadata))
);

comment on table public.accounting_transaction is
  'Immutable journal header plus the exact canonical string-valued posting request admitted by append_accounting_transaction.';

comment on column public.accounting_transaction.posting_manifest is
  'Canonical decimal strings only: callers normalize equivalent forms such as 1.00 to 1 before append/retry.';

create index accounting_transaction_time_idx
  on public.accounting_transaction (
    strategy_account_id,
    effective_date,
    event_time,
    accounting_transaction_id
  );

create table public.accounting_posting (
  accounting_transaction_id uuid not null,
  strategy_account_id uuid not null,
  posting_index integer not null check (posting_index >= 0),
  account_code text not null
    check (account_code ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  side text not null check (side in ('debit', 'credit')),
  amount numeric(38, 12) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  instrument_id uuid references public.instrument(instrument_id),
  lot_origin_id uuid,
  memo text,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (accounting_transaction_id, posting_index),
  constraint accounting_posting_transaction_account_fk
    foreign key (accounting_transaction_id, strategy_account_id)
    references public.accounting_transaction(
      accounting_transaction_id,
      strategy_account_id
    ),
  constraint accounting_posting_lot_instrument_pair check (
    lot_origin_id is null or instrument_id is not null
  ),
  constraint accounting_posting_lot_account_instrument_fk
    foreign key (lot_origin_id, strategy_account_id, instrument_id)
    references public.position_lot_origin(
      lot_origin_id,
      strategy_account_id,
      instrument_id
    )
);

comment on table public.accounting_posting is
  'Immutable positive debit/credit posting. Every currency balances inside its accounting transaction.';

create index accounting_posting_account_code_idx
  on public.accounting_posting (
    strategy_account_id,
    account_code,
    currency,
    accounting_transaction_id,
    posting_index
  );

create index accounting_posting_lot_idx
  on public.accounting_posting (lot_origin_id, accounting_transaction_id)
  where lot_origin_id is not null;

create table public.frozen_order_plan (
  frozen_order_plan_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key <> ''),
  strategy_account_id uuid not null,
  run_id uuid not null references public.run_manifest(run_id),
  decision_id uuid not null references public.decision_invocation(decision_id),
  accepted_submission_id uuid not null
    references public.accepted_target_submission(submission_id),
  stage text not null check (stage in ('S1', 'S2')),
  planned_at timestamptz not null,
  planned_trade_date date not null,
  manifest_schema text not null
    check (manifest_schema = 'twofold.frozen_order_plan/v1'),
  plan_canonical_json text not null check (plan_canonical_json <> ''),
  plan jsonb not null,
  plan_sha256 text not null check (plan_sha256 ~ '^[0-9a-f]{64}$'),
  engine_plan_fingerprint text not null
    check (engine_plan_fingerprint <> ''),
  engine_plan_fingerprint_sha256 text not null
    check (engine_plan_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint frozen_order_plan_account_run_fk
    foreign key (strategy_account_id, run_id)
    references public.strategy_account(strategy_account_id, run_id),
  constraint frozen_order_plan_decision_stage_unique
    unique (decision_id, stage),
  constraint frozen_order_plan_id_account_unique
    unique (frozen_order_plan_id, strategy_account_id),
  constraint frozen_order_plan_payload_object
    check (jsonb_typeof(plan) = 'object'),
  constraint frozen_order_plan_payload_decimal_safe
    check (not public.jsonb_contains_number(plan))
);

comment on table public.frozen_order_plan is
  'Immutable exact-byte order plan admitted after an accepted target submission. One plan is frozen per decision stage.';

create index frozen_order_plan_run_date_idx
  on public.frozen_order_plan (
    run_id,
    planned_trade_date,
    stage,
    frozen_order_plan_id
  );

-- Deliberately no paper_fill table/RPC in this milestone. A completed fill
-- must be settled by a future single atomic boundary that derives and appends
-- cash, fee, security-quantity, lot/disposition, and tax postings together.
-- The standalone RPCs below therefore reserve buy_fill/sell_fill values for
-- that future internal boundary and reject them from direct service calls.

create trigger run_manifest_is_immutable
before update or delete on public.run_manifest
for each row execute function public.reject_immutable_mutation();

create trigger instrument_is_immutable
before update or delete on public.instrument
for each row execute function public.reject_immutable_mutation();

create trigger instrument_symbol_version_is_immutable
before update or delete on public.instrument_symbol_version
for each row execute function public.reject_immutable_mutation();

create trigger strategy_account_is_immutable
before update or delete on public.strategy_account
for each row execute function public.reject_immutable_mutation();

create trigger position_lot_origin_is_immutable
before update or delete on public.position_lot_origin
for each row execute function public.reject_immutable_mutation();

create trigger accounting_transaction_is_immutable
before update or delete on public.accounting_transaction
for each row execute function public.reject_immutable_mutation();

create trigger accounting_posting_is_immutable
before update or delete on public.accounting_posting
for each row execute function public.reject_immutable_mutation();

create trigger frozen_order_plan_is_immutable
before update or delete on public.frozen_order_plan
for each row execute function public.reject_immutable_mutation();

create trigger run_manifest_reject_truncate
before truncate on public.run_manifest
for each statement execute function public.reject_immutable_mutation();

create trigger instrument_reject_truncate
before truncate on public.instrument
for each statement execute function public.reject_immutable_mutation();

create trigger instrument_symbol_version_reject_truncate
before truncate on public.instrument_symbol_version
for each statement execute function public.reject_immutable_mutation();

create trigger strategy_account_reject_truncate
before truncate on public.strategy_account
for each statement execute function public.reject_immutable_mutation();

create trigger position_lot_origin_reject_truncate
before truncate on public.position_lot_origin
for each statement execute function public.reject_immutable_mutation();

create trigger accounting_transaction_reject_truncate
before truncate on public.accounting_transaction
for each statement execute function public.reject_immutable_mutation();

create trigger accounting_posting_reject_truncate
before truncate on public.accounting_posting
for each statement execute function public.reject_immutable_mutation();

create trigger frozen_order_plan_reject_truncate
before truncate on public.frozen_order_plan
for each statement execute function public.reject_immutable_mutation();

create or replace function public.register_run_manifest(
  p_idempotency_key text,
  p_run_id uuid,
  p_manifest_schema text,
  p_manifest jsonb,
  p_recorded_by text,
  p_source_sha256 text,
  p_source_artifact_id uuid default null
)
returns public.run_manifest
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_existing public.run_manifest%rowtype;
  v_inserted public.run_manifest%rowtype;
  v_manifest_sha256 text;
begin
  if p_idempotency_key is null or p_idempotency_key = ''
    or p_run_id is null
    or p_manifest_schema is distinct from 'twofold.run_manifest/v1'
    or p_recorded_by is null or p_recorded_by = ''
    or p_source_sha256 is null
    or p_source_sha256 !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_manifest) is distinct from 'object'
    or public.jsonb_contains_number(p_manifest)
  then
    raise exception
      'run manifest requires an idempotency key, run ID, v1 object payload without JSON numbers, and recorder'
      using errcode = '22023';
  end if;

  v_manifest_sha256 := encode(
    extensions.digest(convert_to(p_manifest::text, 'UTF8'), 'sha256'),
    'hex'
  );

  if p_source_artifact_id is not null and not exists (
    select 1
      from public.artifact_metadata as artifact
     where artifact.artifact_id = p_source_artifact_id
       and artifact.sha256 = p_source_sha256
  ) then
    raise exception 'run-manifest source artifact and hash do not match'
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('accounting-kernel:run-manifest', 0)
  );

  select manifest.*
    into v_existing
    from public.run_manifest as manifest
   where manifest.idempotency_key = p_idempotency_key
      or manifest.run_id = p_run_id
   order by (manifest.idempotency_key = p_idempotency_key) desc
   limit 1;

  if found then
    if v_existing.run_id is distinct from p_run_id
      or v_existing.manifest_schema is distinct from p_manifest_schema
      or v_existing.manifest is distinct from p_manifest
      or v_existing.manifest_sha256 is distinct from v_manifest_sha256
      or v_existing.source_sha256 is distinct from p_source_sha256
      or v_existing.source_artifact_id is distinct from p_source_artifact_id
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'run manifest identity was reused with different content'
        using errcode = '23505';
    end if;

    return v_existing;
  end if;

  insert into public.run_manifest (
    idempotency_key,
    run_id,
    manifest_schema,
    manifest,
    manifest_sha256,
    source_sha256,
    source_artifact_id,
    recorded_by
  ) values (
    p_idempotency_key,
    p_run_id,
    p_manifest_schema,
    p_manifest,
    v_manifest_sha256,
    p_source_sha256,
    p_source_artifact_id,
    p_recorded_by
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

comment on function public.register_run_manifest(
  text, uuid, text, jsonb, text, text, uuid
) is
  'Registers one immutable content-hashed run manifest. Exact retries return the original row; identity/content conflicts fail closed.';

create or replace function public.register_instrument(
  p_idempotency_key text,
  p_instrument_id uuid,
  p_instrument_type text,
  p_primary_exchange text,
  p_trading_currency text,
  p_issuer_tax_residency text,
  p_metadata jsonb,
  p_recorded_by text
)
returns public.instrument
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_existing public.instrument%rowtype;
  v_inserted public.instrument%rowtype;
begin
  if p_idempotency_key is null or p_idempotency_key = ''
    or p_instrument_id is null
    or p_instrument_type not in ('common_stock', 'adr', 'etf', 'cash')
    or p_primary_exchange is null or p_primary_exchange = ''
    or p_trading_currency is null
    or p_trading_currency !~ '^[A-Z]{3}$'
    or (
      p_issuer_tax_residency is not null
      and p_issuer_tax_residency !~ '^[A-Z]{2}$'
    )
    or jsonb_typeof(p_metadata) is distinct from 'object'
    or public.jsonb_contains_number(p_metadata)
    or p_recorded_by is null or p_recorded_by = ''
  then
    raise exception 'invalid stable instrument registration'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('accounting-kernel:instrument', 0)
  );

  select stable.*
    into v_existing
    from public.instrument as stable
   where stable.idempotency_key = p_idempotency_key
      or stable.instrument_id = p_instrument_id
   order by (stable.idempotency_key = p_idempotency_key) desc
   limit 1;

  if found then
    if v_existing.instrument_id is distinct from p_instrument_id
      or v_existing.instrument_type is distinct from p_instrument_type
      or v_existing.primary_exchange is distinct from p_primary_exchange
      or v_existing.trading_currency is distinct from p_trading_currency
      or v_existing.issuer_tax_residency
        is distinct from p_issuer_tax_residency
      or v_existing.metadata is distinct from p_metadata
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'instrument identity was reused with different content'
        using errcode = '23505';
    end if;

    return v_existing;
  end if;

  insert into public.instrument (
    instrument_id,
    idempotency_key,
    instrument_type,
    primary_exchange,
    trading_currency,
    issuer_tax_residency,
    metadata,
    recorded_by
  ) values (
    p_instrument_id,
    p_idempotency_key,
    p_instrument_type,
    p_primary_exchange,
    p_trading_currency,
    p_issuer_tax_residency,
    p_metadata,
    p_recorded_by
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

create or replace function public.register_instrument_symbol_version(
  p_idempotency_key text,
  p_instrument_id uuid,
  p_symbol text,
  p_exchange text,
  p_effective_from date,
  p_effective_to date,
  p_metadata jsonb,
  p_recorded_by text
)
returns public.instrument_symbol_version
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_existing public.instrument_symbol_version%rowtype;
  v_inserted public.instrument_symbol_version%rowtype;
begin
  if p_idempotency_key is null or p_idempotency_key = ''
    or p_instrument_id is null
    or p_symbol is null or p_symbol !~ '^[A-Z][A-Z0-9.-]{0,14}$'
    or p_exchange is null or p_exchange = ''
    or p_effective_from is null
    or (p_effective_to is not null and p_effective_to <= p_effective_from)
    or jsonb_typeof(p_metadata) is distinct from 'object'
    or public.jsonb_contains_number(p_metadata)
    or p_recorded_by is null or p_recorded_by = ''
  then
    raise exception 'invalid instrument symbol version'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('accounting-kernel:instrument-symbol-version', 0)
  );

  select version.*
    into v_existing
    from public.instrument_symbol_version as version
   where version.idempotency_key = p_idempotency_key
      or (
        version.instrument_id = p_instrument_id
        and version.effective_from = p_effective_from
      )
   order by (version.idempotency_key = p_idempotency_key) desc
   limit 1;

  if found then
    if v_existing.instrument_id is distinct from p_instrument_id
      or v_existing.symbol is distinct from p_symbol
      or v_existing.exchange is distinct from p_exchange
      or v_existing.effective_from is distinct from p_effective_from
      or v_existing.effective_to is distinct from p_effective_to
      or v_existing.metadata is distinct from p_metadata
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'instrument symbol identity was reused with different content'
        using errcode = '23505';
    end if;

    return v_existing;
  end if;

  if not exists (
    select 1
      from public.instrument as stable
     where stable.instrument_id = p_instrument_id
  ) then
    raise exception 'instrument does not exist'
      using errcode = '23503';
  end if;

  if exists (
    select 1
      from public.instrument_symbol_version as version
     where (
       version.instrument_id = p_instrument_id
       or (
         version.symbol = p_symbol
         and version.exchange = p_exchange
       )
     )
       and daterange(
         version.effective_from,
         version.effective_to,
         '[)'
       ) && daterange(p_effective_from, p_effective_to, '[)')
  ) then
    raise exception 'instrument symbol effective window overlaps an existing version'
      using errcode = '23P01';
  end if;

  insert into public.instrument_symbol_version (
    idempotency_key,
    instrument_id,
    symbol,
    exchange,
    effective_from,
    effective_to,
    metadata,
    recorded_by
  ) values (
    p_idempotency_key,
    p_instrument_id,
    p_symbol,
    p_exchange,
    p_effective_from,
    p_effective_to,
    p_metadata,
    p_recorded_by
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

create or replace function public.register_strategy_account(
  p_idempotency_key text,
  p_run_id uuid,
  p_account_code text,
  p_broker text,
  p_broker_region text,
  p_base_currency text,
  p_live_trading boolean,
  p_metadata jsonb,
  p_recorded_by text
)
returns public.strategy_account
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_existing public.strategy_account%rowtype;
  v_inserted public.strategy_account%rowtype;
begin
  if p_idempotency_key is null or p_idempotency_key = ''
    or p_run_id is null
    or p_account_code is null or p_account_code = ''
    or p_broker is null or p_broker = ''
    or p_broker_region is null or p_broker_region = ''
    or p_base_currency is null or p_base_currency !~ '^[A-Z]{3}$'
    or p_live_trading is distinct from false
    or jsonb_typeof(p_metadata) is distinct from 'object'
    or public.jsonb_contains_number(p_metadata)
    or p_recorded_by is null or p_recorded_by = ''
  then
    raise exception 'strategy account must be a valid paper-only account'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('accounting-kernel:strategy-account', 0)
  );

  select account.*
    into v_existing
    from public.strategy_account as account
   where account.idempotency_key = p_idempotency_key
      or account.run_id = p_run_id
   order by (account.idempotency_key = p_idempotency_key) desc
   limit 1;

  if found then
    if v_existing.run_id is distinct from p_run_id
      or v_existing.account_code is distinct from p_account_code
      or v_existing.broker is distinct from p_broker
      or v_existing.broker_region is distinct from p_broker_region
      or v_existing.base_currency is distinct from p_base_currency
      or v_existing.live_trading is distinct from p_live_trading
      or v_existing.metadata is distinct from p_metadata
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'strategy account identity was reused with different content'
        using errcode = '23505';
    end if;

    return v_existing;
  end if;

  insert into public.strategy_account (
    idempotency_key,
    run_id,
    account_code,
    broker,
    broker_region,
    base_currency,
    live_trading,
    metadata,
    recorded_by
  ) values (
    p_idempotency_key,
    p_run_id,
    p_account_code,
    p_broker,
    p_broker_region,
    p_base_currency,
    p_live_trading,
    p_metadata,
    p_recorded_by
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

create or replace function public.register_position_lot_origin(
  p_idempotency_key text,
  p_strategy_account_id uuid,
  p_instrument_id uuid,
  p_origin_kind text,
  p_origin_reference text,
  p_acquired_at timestamptz,
  p_effective_date date,
  p_original_quantity numeric,
  p_unit_purchase_price numeric,
  p_allocated_buy_fees numeric,
  p_currency text,
  p_lot_method text,
  p_metadata jsonb,
  p_recorded_by text,
  p_source_sha256 text,
  p_source_artifact_id uuid default null
)
returns public.position_lot_origin
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_existing public.position_lot_origin%rowtype;
  v_inserted public.position_lot_origin%rowtype;
begin
  if p_origin_kind = 'buy_fill' then
    raise exception
      'buy_fill lot origins require the future atomic settle_paper_fill boundary'
      using errcode = '0A000';
  end if;

  if p_idempotency_key is null or p_idempotency_key = ''
    or p_strategy_account_id is null
    or p_instrument_id is null
    or p_origin_kind not in (
      'initial_import',
      'corporate_action_adjustment',
      'restatement'
    )
    or p_origin_reference is null or p_origin_reference = ''
    or p_acquired_at is null
    or p_effective_date is null
    or p_original_quantity is null or p_original_quantity <= 0
    or p_unit_purchase_price is null or p_unit_purchase_price <= 0
    or p_allocated_buy_fees is null or p_allocated_buy_fees < 0
    or scale(p_original_quantity) > 12
    or scale(p_unit_purchase_price) > 12
    or scale(p_allocated_buy_fees) > 12
    or p_currency is null or p_currency !~ '^[A-Z]{3}$'
    or p_lot_method is distinct from 'FIFO'
    or p_source_sha256 is null
    or p_source_sha256 !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_metadata) is distinct from 'object'
    or public.jsonb_contains_number(p_metadata)
    or p_recorded_by is null or p_recorded_by = ''
  then
    raise exception 'invalid FIFO position lot origin'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('accounting-kernel:position-lot-origin', 0)
  );

  select lot.*
    into v_existing
    from public.position_lot_origin as lot
   where lot.idempotency_key = p_idempotency_key
      or (
        lot.strategy_account_id = p_strategy_account_id
        and lot.origin_kind = p_origin_kind
        and lot.origin_reference = p_origin_reference
      )
   order by (lot.idempotency_key = p_idempotency_key) desc
   limit 1;

  if found then
    if v_existing.strategy_account_id
        is distinct from p_strategy_account_id
      or v_existing.instrument_id is distinct from p_instrument_id
      or v_existing.origin_kind is distinct from p_origin_kind
      or v_existing.origin_reference is distinct from p_origin_reference
      or v_existing.acquired_at is distinct from p_acquired_at
      or v_existing.effective_date is distinct from p_effective_date
      or v_existing.original_quantity is distinct from p_original_quantity
      or v_existing.unit_purchase_price
        is distinct from p_unit_purchase_price
      or v_existing.allocated_buy_fees
        is distinct from p_allocated_buy_fees
      or v_existing.currency is distinct from p_currency
      or v_existing.lot_method is distinct from p_lot_method
      or v_existing.source_sha256 is distinct from p_source_sha256
      or v_existing.source_artifact_id is distinct from p_source_artifact_id
      or v_existing.metadata is distinct from p_metadata
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'position lot origin identity was reused with different content'
        using errcode = '23505';
    end if;

    return v_existing;
  end if;

  if not exists (
    select 1
      from public.strategy_account as account
     where account.strategy_account_id = p_strategy_account_id
  ) then
    raise exception 'strategy account does not exist'
      using errcode = '23503';
  end if;

  if not exists (
    select 1
      from public.instrument as stable
     where stable.instrument_id = p_instrument_id
       and stable.trading_currency = p_currency
  ) then
    raise exception 'instrument does not exist or lot currency does not match'
      using errcode = '23503';
  end if;

  if p_source_artifact_id is not null and not exists (
    select 1
      from public.artifact_metadata as artifact
     where artifact.artifact_id = p_source_artifact_id
       and artifact.sha256 = p_source_sha256
  ) then
    raise exception 'lot source artifact and hash do not match'
      using errcode = '23503';
  end if;

  insert into public.position_lot_origin (
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
    p_idempotency_key,
    p_strategy_account_id,
    p_instrument_id,
    p_origin_kind,
    p_origin_reference,
    p_acquired_at,
    p_effective_date,
    p_original_quantity,
    p_unit_purchase_price,
    p_allocated_buy_fees,
    p_currency,
    p_lot_method,
    p_source_sha256,
    p_source_artifact_id,
    p_metadata,
    p_recorded_by
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

create or replace function public.append_accounting_transaction(
  p_idempotency_key text,
  p_strategy_account_id uuid,
  p_transaction_type text,
  p_source_event_key text,
  p_event_time timestamptz,
  p_effective_date date,
  p_settlement_date date,
  p_description text,
  p_postings jsonb,
  p_metadata jsonb,
  p_recorded_by text
)
returns public.accounting_transaction
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_existing public.accounting_transaction%rowtype;
  v_inserted public.accounting_transaction%rowtype;
  v_manifest_sha256 text;
  v_unbalanced_currency text;
begin
  if p_transaction_type in ('buy_fill', 'sell_fill') then
    raise exception
      'fill accounting requires the future atomic settle_paper_fill boundary'
      using errcode = '0A000';
  end if;

  if p_idempotency_key is null or p_idempotency_key = ''
    or p_strategy_account_id is null
    or p_transaction_type not in (
      'opening_balance',
      'fee',
      'tax_accrual',
      'tax_payment',
      'dividend',
      'corporate_action',
      'adjustment'
    )
    or p_source_event_key is null or p_source_event_key = ''
    or p_event_time is null
    or p_effective_date is null
    or p_description is null or p_description = ''
    or jsonb_typeof(p_metadata) is distinct from 'object'
    or public.jsonb_contains_number(p_metadata)
    or p_recorded_by is null or p_recorded_by = ''
  then
    raise exception 'invalid accounting transaction header or metadata'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_postings) is distinct from 'array'
    or jsonb_array_length(p_postings) < 2
    or public.jsonb_contains_number(p_postings)
  then
    raise exception
      'postings must be an array of at least two entries without JSON number tokens'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_postings) as postings(item)
     where jsonb_typeof(postings.item) is distinct from 'object'
        or (postings.item - array[
          'account_code',
          'side',
          'amount',
          'currency',
          'instrument_id',
          'lot_origin_id',
          'memo'
        ]::text[]) <> '{}'::jsonb
        or not (
          postings.item ?& array[
            'account_code', 'side', 'amount', 'currency'
          ]::text[]
        )
        or jsonb_typeof(postings.item->'account_code')
          is distinct from 'string'
        or (postings.item->>'account_code')
          !~ '^[a-z][a-z0-9_.-]{1,63}$'
        or jsonb_typeof(postings.item->'side') is distinct from 'string'
        or (postings.item->>'side') not in ('debit', 'credit')
        or jsonb_typeof(postings.item->'amount') is distinct from 'string'
        or (postings.item->>'amount')
          !~ '^(0|[1-9][0-9]*)(\.[0-9]{0,11}[1-9])?$'
        or (postings.item->>'amount')::numeric <= 0
        or jsonb_typeof(postings.item->'currency') is distinct from 'string'
        or (postings.item->>'currency') !~ '^[A-Z]{3}$'
        or (
          postings.item ? 'instrument_id'
          and (
            jsonb_typeof(postings.item->'instrument_id')
              is distinct from 'string'
            or (postings.item->>'instrument_id') !~* (
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-'
              || '[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            )
          )
        )
        or (
          postings.item ? 'lot_origin_id'
          and (
            jsonb_typeof(postings.item->'lot_origin_id')
              is distinct from 'string'
            or (postings.item->>'lot_origin_id') !~* (
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-'
              || '[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            )
            or not (postings.item ? 'instrument_id')
          )
        )
        or (
          postings.item ? 'memo'
          and jsonb_typeof(postings.item->'memo') is distinct from 'string'
        )
  ) then
    raise exception 'posting entries do not match the canonical posting schema'
      using errcode = '22023';
  end if;

  select balances.currency
    into v_unbalanced_currency
    from (
      select
        postings.item->>'currency' as currency,
        sum(
          case when postings.item->>'side' = 'debit'
            then (postings.item->>'amount')::numeric
            else 0
          end
        ) as debit_total,
        sum(
          case when postings.item->>'side' = 'credit'
            then (postings.item->>'amount')::numeric
            else 0
          end
        ) as credit_total
      from jsonb_array_elements(p_postings) as postings(item)
      group by postings.item->>'currency'
    ) as balances
   where balances.debit_total <> balances.credit_total
   order by balances.currency collate "C"
   limit 1;

  if v_unbalanced_currency is not null then
    raise exception 'postings are not balanced for currency %',
      v_unbalanced_currency
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_postings) as postings(item)
      left join public.position_lot_origin as lot
        on lot.lot_origin_id =
          (postings.item->>'lot_origin_id')::uuid
       and lot.strategy_account_id = p_strategy_account_id
       and lot.instrument_id =
          (postings.item->>'instrument_id')::uuid
     where postings.item ? 'lot_origin_id'
       and lot.lot_origin_id is null
  ) then
    raise exception 'posting lot does not belong to the account and instrument'
      using errcode = '23503';
  end if;

  v_manifest_sha256 := encode(
    extensions.digest(convert_to(p_postings::text, 'UTF8'), 'sha256'),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended('accounting-kernel:accounting-transaction', 0)
  );

  select journal.*
    into v_existing
    from public.accounting_transaction as journal
   where journal.idempotency_key = p_idempotency_key
      or (
        journal.strategy_account_id = p_strategy_account_id
        and journal.source_event_key = p_source_event_key
      )
   order by (journal.idempotency_key = p_idempotency_key) desc
   limit 1;

  if found then
    if v_existing.strategy_account_id
        is distinct from p_strategy_account_id
      or v_existing.transaction_type is distinct from p_transaction_type
      or v_existing.source_event_key is distinct from p_source_event_key
      or v_existing.event_time is distinct from p_event_time
      or v_existing.effective_date is distinct from p_effective_date
      or v_existing.settlement_date is distinct from p_settlement_date
      or v_existing.description is distinct from p_description
      or v_existing.posting_manifest is distinct from p_postings
      or v_existing.posting_manifest_sha256 is distinct from v_manifest_sha256
      or v_existing.metadata is distinct from p_metadata
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception
        'accounting transaction identity was reused with different content'
        using errcode = '23505';
    end if;

    return v_existing;
  end if;

  if not exists (
    select 1
      from public.strategy_account as account
     where account.strategy_account_id = p_strategy_account_id
       and account.live_trading is false
  ) then
    raise exception 'paper-only strategy account does not exist'
      using errcode = '23503';
  end if;

  insert into public.accounting_transaction (
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
    p_idempotency_key,
    p_strategy_account_id,
    p_transaction_type,
    p_source_event_key,
    p_event_time,
    p_effective_date,
    p_settlement_date,
    p_description,
    p_postings,
    v_manifest_sha256,
    p_metadata,
    p_recorded_by
  )
  returning * into v_inserted;

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
  )
  select
    v_inserted.accounting_transaction_id,
    p_strategy_account_id,
    postings.item_index::integer - 1,
    postings.item->>'account_code',
    postings.item->>'side',
    (postings.item->>'amount')::numeric,
    postings.item->>'currency',
    case when postings.item ? 'instrument_id'
      then (postings.item->>'instrument_id')::uuid
      else null
    end,
    case when postings.item ? 'lot_origin_id'
      then (postings.item->>'lot_origin_id')::uuid
      else null
    end,
    case when postings.item ? 'memo'
      then postings.item->>'memo'
      else null
    end
  from jsonb_array_elements(p_postings) with ordinality
    as postings(item, item_index);

  return v_inserted;
end;
$$;

comment on function public.append_accounting_transaction(
  text, uuid, text, text, timestamptz, date, date, text, jsonb, jsonb, text
) is
  'Internal accounting primitive: atomically appends a canonical immutable journal transaction only when every currency balances. Not granted to service_role until atomic settlement can also enforce nonnegative asset balances.';

create or replace function public.register_frozen_order_plan(
  p_idempotency_key text,
  p_strategy_account_id uuid,
  p_run_id uuid,
  p_decision_id uuid,
  p_accepted_submission_id uuid,
  p_stage text,
  p_planned_at timestamptz,
  p_planned_trade_date date,
  p_manifest_schema text,
  p_plan_canonical_json text,
  p_plan_sha256 text,
  p_recorded_by text
)
returns public.frozen_order_plan
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_plan jsonb;
  v_engine_plan jsonb;
  v_computed_sha256 text;
  v_engine_plan_fingerprint text;
  v_engine_plan_fingerprint_sha256 text;
  v_computed_engine_sha256 text;
  v_existing public.frozen_order_plan%rowtype;
  v_inserted public.frozen_order_plan%rowtype;
  v_accepted_at timestamptz;
  v_decision_at timestamptz;
  v_arrival_at timestamptz := clock_timestamp();
begin
  if p_idempotency_key is null or p_idempotency_key = ''
    or p_strategy_account_id is null
    or p_run_id is null
    or p_decision_id is null
    or p_accepted_submission_id is null
    or p_stage not in ('S1', 'S2')
    or p_planned_at is null
    or p_planned_trade_date is null
    or p_manifest_schema is distinct from 'twofold.frozen_order_plan/v1'
    or p_plan_canonical_json is null or p_plan_canonical_json = ''
    or p_plan_canonical_json is distinct from btrim(p_plan_canonical_json)
    or p_plan_sha256 is null or p_plan_sha256 !~ '^[0-9a-f]{64}$'
    or p_recorded_by is null or p_recorded_by = ''
  then
    raise exception 'invalid frozen order plan header'
      using errcode = '22023';
  end if;

  begin
    v_plan := p_plan_canonical_json::jsonb;
  exception
    when others then
      raise exception 'frozen order plan canonical bytes are not valid JSON'
        using errcode = '22023';
  end;

  v_computed_sha256 := encode(
    extensions.digest(convert_to(p_plan_canonical_json, 'UTF8'), 'sha256'),
    'hex'
  );

  if v_computed_sha256 is distinct from p_plan_sha256 then
    raise exception 'frozen order plan SHA256 does not match canonical bytes'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_plan) is distinct from 'object'
    or public.jsonb_contains_number(v_plan)
    or jsonb_typeof(v_plan->'manifestSchema') is distinct from 'string'
    or jsonb_typeof(v_plan->'runId') is distinct from 'string'
    or jsonb_typeof(v_plan->'decisionId') is distinct from 'string'
    or jsonb_typeof(v_plan->'acceptedSubmissionId') is distinct from 'string'
    or jsonb_typeof(v_plan->'stage') is distinct from 'string'
    or jsonb_typeof(v_plan->'plannedAt') is distinct from 'string'
    or jsonb_typeof(v_plan->'plannedTradeDate') is distinct from 'string'
    or jsonb_typeof(v_plan->'executionModel') is distinct from 'string'
    or jsonb_typeof(v_plan->'slippageBps') is distinct from 'string'
    or jsonb_typeof(v_plan->'fillPriceScale') is distinct from 'string'
    or jsonb_typeof(v_plan->'enginePlanFingerprint')
      is distinct from 'string'
    or jsonb_typeof(v_plan->'enginePlanFingerprintSha256')
      is distinct from 'string'
    or jsonb_typeof(v_plan->'orders') is distinct from 'array'
  then
    raise exception
      'frozen order plan must contain the complete string-safe wrapper envelope and no JSON numbers'
      using errcode = '22023';
  end if;

  if p_stage = 'S1' then
    if not (
      v_plan ?& array[
        'manifestSchema',
        'runId',
        'decisionId',
        'acceptedSubmissionId',
        'stage',
        'plannedAt',
        'plannedTradeDate',
        'executionModel',
        'slippageBps',
        'fillPriceScale',
        'enginePlanFingerprint',
        'enginePlanFingerprintSha256',
        'orders',
        'taxRulesetId',
        'taxAllocationScale'
      ]::text[]
    ) or (
      select count(*)
        from jsonb_object_keys(v_plan)
    ) <> 15 then
      raise exception 'S1 frozen order plan wrapper has an incomplete shape'
        using errcode = '22023';
    end if;
  else
    if not (
      v_plan ?& array[
        'manifestSchema',
        'runId',
        'decisionId',
        'acceptedSubmissionId',
        'stage',
        'plannedAt',
        'plannedTradeDate',
        'executionModel',
        'slippageBps',
        'fillPriceScale',
        'enginePlanFingerprint',
        'enginePlanFingerprintSha256',
        'orders',
        'initialBuyingPower',
        'reservedBuyingPower',
        'remainingUnreservedBuyingPower',
        'buyingPowerEvidence'
      ]::text[]
    ) or (
      select count(*)
        from jsonb_object_keys(v_plan)
    ) <> 17 then
      raise exception 'S2 frozen order plan wrapper has an incomplete shape'
        using errcode = '22023';
    end if;
  end if;

  if v_plan->>'manifestSchema' is distinct from p_manifest_schema
    or (v_plan->>'runId') !~* (
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-'
      || '[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    or (v_plan->>'decisionId') !~* (
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-'
      || '[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    or (v_plan->>'acceptedSubmissionId') !~* (
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-'
      || '[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    or (v_plan->>'runId')::uuid is distinct from p_run_id
    or (v_plan->>'decisionId')::uuid is distinct from p_decision_id
    or (v_plan->>'acceptedSubmissionId')::uuid
      is distinct from p_accepted_submission_id
    or v_plan->>'stage' is distinct from p_stage
    or (v_plan->>'plannedAt') !~ (
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:'
      || '[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    )
    or (v_plan->>'plannedAt')::timestamptz is distinct from p_planned_at
    or (v_plan->>'plannedTradeDate')
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or (v_plan->>'plannedTradeDate')::date
      is distinct from p_planned_trade_date
    or v_plan->>'executionModel'
      is distinct from 'SIMULATED_SLIPPAGE'
    or (v_plan->>'slippageBps')
      !~ '^(0|[1-9][0-9]{0,3}|10000)$'
    or (v_plan->>'slippageBps')::integer not between 0 and 10000
    or (v_plan->>'fillPriceScale') !~ '^(0|[1-9][0-9]?|100)$'
    or (v_plan->>'fillPriceScale')::integer not between 0 and 100
  then
    raise exception
      'frozen order plan manifest identity, stage, or dates do not match RPC arguments'
      using errcode = '22023';
  end if;

  v_engine_plan_fingerprint := v_plan->>'enginePlanFingerprint';
  v_engine_plan_fingerprint_sha256 :=
    v_plan->>'enginePlanFingerprintSha256';

  if v_engine_plan_fingerprint = ''
    or v_engine_plan_fingerprint_sha256 !~ '^[0-9a-f]{64}$'
  then
    raise exception 'engine plan fingerprint binding is invalid'
      using errcode = '22023';
  end if;

  v_computed_engine_sha256 := encode(
    extensions.digest(
      convert_to(v_engine_plan_fingerprint, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if v_computed_engine_sha256
      is distinct from v_engine_plan_fingerprint_sha256
  then
    raise exception
      'engine plan fingerprint SHA256 does not match its exact UTF-8 bytes'
      using errcode = '22023';
  end if;

  begin
    v_engine_plan := v_engine_plan_fingerprint::jsonb;
  exception
    when others then
      raise exception 'engine plan fingerprint is not valid JSON'
        using errcode = '22023';
  end;

  if jsonb_typeof(v_engine_plan) is distinct from 'object'
    or public.jsonb_contains_number(v_engine_plan)
    or v_engine_plan ? 'planFingerprint'
    or jsonb_typeof(v_engine_plan->'schema') is distinct from 'string'
    or jsonb_typeof(v_engine_plan->'decisionId') is distinct from 'string'
    or jsonb_typeof(v_engine_plan->'stage') is distinct from 'string'
    or jsonb_typeof(v_engine_plan->'executionModel') is distinct from 'string'
    or jsonb_typeof(v_engine_plan->'slippageBps') is distinct from 'string'
    or jsonb_typeof(v_engine_plan->'fillPriceScale') is distinct from 'string'
    or jsonb_typeof(v_engine_plan->'orders') is distinct from 'array'
  then
    raise exception
      'engine plan fingerprint must be the complete number-free Core payload without planFingerprint'
      using errcode = '22023';
  end if;

  if v_engine_plan->>'schema' is distinct from v_plan->>'manifestSchema'
    or v_engine_plan->>'decisionId' is distinct from v_plan->>'decisionId'
    or v_engine_plan->>'stage' is distinct from v_plan->>'stage'
    or v_engine_plan->>'executionModel'
      is distinct from v_plan->>'executionModel'
    or v_engine_plan->>'slippageBps' is distinct from v_plan->>'slippageBps'
    or v_engine_plan->>'fillPriceScale'
      is distinct from v_plan->>'fillPriceScale'
  then
    raise exception
      'frozen wrapper identity or execution settings diverge from the Core engine fingerprint'
      using errcode = '22023';
  end if;

  if p_stage = 'S1' then
    if not (
      v_engine_plan ?& array[
        'schema',
        'decisionId',
        'stage',
        'executionModel',
        'slippageBps',
        'fillPriceScale',
        'taxRulesetId',
        'taxAllocationScale',
        'orders'
      ]::text[]
    ) or (
      select count(*)
        from jsonb_object_keys(v_engine_plan)
    ) <> 9
      or jsonb_typeof(v_plan->'taxRulesetId') is distinct from 'string'
      or jsonb_typeof(v_plan->'taxAllocationScale') is distinct from 'string'
      or v_plan->>'taxRulesetId' is distinct from
        'cn_resident_direct_foreign_securities_strict_v1'
      or (v_plan->>'taxAllocationScale') !~ '^(0|[1-9][0-9]?|100)$'
      or jsonb_typeof(v_engine_plan->'taxRulesetId')
        is distinct from 'string'
      or jsonb_typeof(v_engine_plan->'taxAllocationScale')
        is distinct from 'string'
      or v_engine_plan->>'taxRulesetId'
        is distinct from v_plan->>'taxRulesetId'
      or v_engine_plan->>'taxAllocationScale'
        is distinct from v_plan->>'taxAllocationScale'
    then
      raise exception
        'S1 wrapper and Core engine fingerprint have invalid or divergent tax rules'
        using errcode = '22023';
    end if;
  else
    if not (
      v_engine_plan ?& array[
        'schema',
        'decisionId',
        'stage',
        'executionModel',
        'slippageBps',
        'fillPriceScale',
        'orders',
        'initialBuyingPower',
        'reservedBuyingPower',
        'remainingUnreservedBuyingPower',
        'buyingPowerEvidence'
      ]::text[]
    ) or (
      select count(*)
        from jsonb_object_keys(v_engine_plan)
    ) <> 11
      or jsonb_typeof(v_plan->'initialBuyingPower')
        is distinct from 'string'
      or jsonb_typeof(v_plan->'reservedBuyingPower')
        is distinct from 'string'
      or jsonb_typeof(v_plan->'remainingUnreservedBuyingPower')
        is distinct from 'string'
      or (v_plan->>'initialBuyingPower')
        !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
      or (v_plan->>'reservedBuyingPower')
        !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
      or (v_plan->>'remainingUnreservedBuyingPower')
        !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
      or jsonb_typeof(v_plan->'buyingPowerEvidence')
        is distinct from 'object'
      or jsonb_typeof(v_engine_plan->'buyingPowerEvidence')
        is distinct from 'object'
      or v_engine_plan->>'initialBuyingPower'
        is distinct from v_plan->>'initialBuyingPower'
      or v_engine_plan->>'reservedBuyingPower'
        is distinct from v_plan->>'reservedBuyingPower'
      or v_engine_plan->>'remainingUnreservedBuyingPower'
        is distinct from v_plan->>'remainingUnreservedBuyingPower'
      or v_engine_plan->'buyingPowerEvidence'
        is distinct from v_plan->'buyingPowerEvidence'
    then
      raise exception
        'S2 wrapper and Core engine fingerprint have invalid or divergent buying power'
        using errcode = '22023';
    end if;

    if not (
      (v_plan->'buyingPowerEvidence') ?&
        array['value', 'snapshotId', 'visibleAt']::text[]
    ) or (
      select count(*)
        from jsonb_object_keys(v_plan->'buyingPowerEvidence')
    ) <> 3
      or jsonb_typeof(v_plan->'buyingPowerEvidence'->'value')
        is distinct from 'string'
      or jsonb_typeof(v_plan->'buyingPowerEvidence'->'snapshotId')
        is distinct from 'string'
      or jsonb_typeof(v_plan->'buyingPowerEvidence'->'visibleAt')
        is distinct from 'string'
      or v_plan->'buyingPowerEvidence'->>'value'
        is distinct from v_plan->>'initialBuyingPower'
      or v_plan->'buyingPowerEvidence'->>'snapshotId' = ''
      or (v_plan->'buyingPowerEvidence'->>'visibleAt') !~ (
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:'
        || '[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      )
    then
      raise exception
        'S2 buyingPowerEvidence must be an exact string-only value/snapshot/time binding'
        using errcode = '22023';
    end if;

    if (v_plan->'buyingPowerEvidence'->>'visibleAt')::timestamptz
        > p_planned_at
      or (v_plan->>'initialBuyingPower')::numeric is distinct from (
        (v_plan->>'reservedBuyingPower')::numeric
        + (v_plan->>'remainingUnreservedBuyingPower')::numeric
      )
    then
      raise exception
        'S2 buying power evidence must be visible by planning and its totals must reconcile'
        using errcode = '22023';
    end if;
  end if;

  if exists (
    select 1
      from jsonb_array_elements(v_plan->'orders') as orders(item)
     where jsonb_typeof(orders.item) is distinct from 'object'
  ) then
    raise exception 'frozen order plan contains a non-object order'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(v_engine_plan->'orders') as orders(item)
     where jsonb_typeof(orders.item) is distinct from 'object'
  ) then
    raise exception 'Core engine fingerprint contains a non-object order'
      using errcode = '22023';
  end if;

  if p_stage = 'S1' and exists (
    select 1
      from jsonb_array_elements(v_plan->'orders') as orders(item)
     where not (
       orders.item ?& array[
         'orderId',
         'decisionId',
         'stage',
         'side',
         'instrumentId',
         'symbol',
         'quantity',
         'referencePrice',
         'referencePriceEvidence',
         'plannedAt',
         'plannedTradeDate',
         'feeScheduleId',
         'feeCurrency',
         'feeScheduleTerms',
         'targetWeightBps',
         'executionModel',
         'slippageBps',
         'feeTermsSha256'
       ]::text[]
     ) or (
       select count(*)
         from jsonb_object_keys(orders.item)
     ) <> 18
  ) then
    raise exception 'S1 wrapper order does not contain exactly the Core fields plus three bindings'
      using errcode = '22023';
  end if;

  if p_stage = 'S2' and exists (
    select 1
      from jsonb_array_elements(v_plan->'orders') as orders(item)
     where not (
       orders.item ?& array[
         'orderId',
         'decisionId',
         'stage',
         'side',
         'instrumentId',
         'symbol',
         'quantity',
         'referencePrice',
         'referencePriceEvidence',
         'plannedAt',
         'plannedTradeDate',
         'feeScheduleId',
         'feeCurrency',
         'feeScheduleTerms',
         'targetWeightBps',
         'targetAmount',
         'currentMarketValue',
         'targetGap',
         'priority',
         'estimatedGrossNotional',
         'estimatedFees',
         'estimatedTotalFees',
         'reservedBuyingPower',
         'executionModel',
         'slippageBps',
         'feeTermsSha256'
       ]::text[]
     ) or (
       select count(*)
         from jsonb_object_keys(orders.item)
     ) <> 26
  ) then
    raise exception 'S2 wrapper order does not contain exactly the Core fields plus three bindings'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(v_plan->'orders') as orders(item)
     where jsonb_typeof(orders.item) is distinct from 'object'
        or jsonb_typeof(orders.item->'orderId') is distinct from 'string'
        or orders.item->>'orderId' = ''
        or jsonb_typeof(orders.item->'decisionId') is distinct from 'string'
        or orders.item->>'decisionId' is distinct from v_plan->>'decisionId'
        or jsonb_typeof(orders.item->'stage') is distinct from 'string'
        or orders.item->>'stage' is distinct from p_stage
        or jsonb_typeof(orders.item->'quantity') is distinct from 'string'
        or (orders.item->>'quantity') !~ '^[1-9][0-9]*$'
        or jsonb_typeof(orders.item->'side') is distinct from 'string'
        or orders.item->>'side' not in ('BUY', 'SELL')
        or (
          (p_stage = 'S1' and orders.item->>'side' <> 'SELL')
          or (p_stage = 'S2' and orders.item->>'side' <> 'BUY')
        )
        or jsonb_typeof(orders.item->'instrumentId')
          is distinct from 'string'
        or (orders.item->>'instrumentId') !~* (
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-'
          || '[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        )
        or not exists (
          select 1
            from public.instrument as stable
           where stable.instrument_id =
             (orders.item->>'instrumentId')::uuid
        )
        or jsonb_typeof(orders.item->'symbol') is distinct from 'string'
        or orders.item->>'symbol' = ''
        or jsonb_typeof(orders.item->'referencePrice')
          is distinct from 'string'
        or (orders.item->>'referencePrice')
          !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
        or (orders.item->>'referencePrice')::numeric <= 0
        or jsonb_typeof(orders.item->'referencePriceEvidence')
          is distinct from 'object'
        or jsonb_typeof(orders.item->'plannedAt') is distinct from 'string'
        or orders.item->>'plannedAt' is distinct from v_plan->>'plannedAt'
        or jsonb_typeof(orders.item->'plannedTradeDate')
          is distinct from 'string'
        or orders.item->>'plannedTradeDate'
          is distinct from p_planned_trade_date::text
        or jsonb_typeof(orders.item->'feeScheduleId')
          is distinct from 'string'
        or orders.item->>'feeScheduleId' = ''
        or jsonb_typeof(orders.item->'feeScheduleTerms')
          is distinct from 'string'
        or orders.item->>'feeScheduleTerms' = ''
        or jsonb_typeof(orders.item->'feeTermsSha256')
          is distinct from 'string'
        or (orders.item->>'feeTermsSha256') !~ '^[0-9a-f]{64}$'
        or encode(
          extensions.digest(
            convert_to(orders.item->>'feeScheduleTerms', 'UTF8'),
            'sha256'
          ),
          'hex'
        ) is distinct from orders.item->>'feeTermsSha256'
        or jsonb_typeof(orders.item->'feeCurrency')
          is distinct from 'string'
        or (orders.item->>'feeCurrency') !~ '^[A-Z]{3}$'
        or jsonb_typeof(orders.item->'executionModel')
          is distinct from 'string'
        or orders.item->>'executionModel'
          is distinct from v_plan->>'executionModel'
        or jsonb_typeof(orders.item->'slippageBps')
          is distinct from 'string'
        or orders.item->>'slippageBps'
          is distinct from v_plan->>'slippageBps'
        or jsonb_typeof(orders.item->'targetWeightBps')
          is distinct from 'string'
        or (orders.item->>'targetWeightBps')
          !~ '^(0|[1-9][0-9]{0,3}|10000)$'
  ) then
    raise exception
      'frozen order plan contains an invalid order or order inconsistent with its stage/date'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(v_plan->'orders') as orders(item)
     where not (
       (orders.item->'referencePriceEvidence') ?&
         array[
           'value',
           'kind',
           'sessionDate',
           'visibleAt',
           'snapshotId',
           'factId'
         ]::text[]
     ) or (
       select count(*)
         from jsonb_object_keys(orders.item->'referencePriceEvidence')
     ) <> 6
        or jsonb_typeof(orders.item->'referencePriceEvidence'->'value')
          is distinct from 'string'
        or orders.item->'referencePriceEvidence'->>'value'
          is distinct from orders.item->>'referencePrice'
        or jsonb_typeof(orders.item->'referencePriceEvidence'->'kind')
          is distinct from 'string'
        or orders.item->'referencePriceEvidence'->>'kind'
          is distinct from 'OFFICIAL_CLOSE'
        or jsonb_typeof(orders.item->'referencePriceEvidence'->'sessionDate')
          is distinct from 'string'
        or (orders.item->'referencePriceEvidence'->>'sessionDate')
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or (orders.item->'referencePriceEvidence'->>'sessionDate')::date
          >= p_planned_trade_date
        or jsonb_typeof(orders.item->'referencePriceEvidence'->'visibleAt')
          is distinct from 'string'
        or (orders.item->'referencePriceEvidence'->>'visibleAt') !~ (
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:'
          || '[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        )
        or (orders.item->'referencePriceEvidence'->>'visibleAt')::timestamptz
          > p_planned_at
        or jsonb_typeof(orders.item->'referencePriceEvidence'->'snapshotId')
          is distinct from 'string'
        or orders.item->'referencePriceEvidence'->>'snapshotId' = ''
        or jsonb_typeof(orders.item->'referencePriceEvidence'->'factId')
          is distinct from 'string'
        or orders.item->'referencePriceEvidence'->>'factId' = ''
  ) then
    raise exception 'frozen order plan contains invalid close-price evidence'
      using errcode = '22023';
  end if;

  if p_stage = 'S2' and exists (
    select 1
      from jsonb_array_elements(v_plan->'orders') as orders(item)
     where jsonb_typeof(orders.item->'targetAmount') is distinct from 'string'
        or jsonb_typeof(orders.item->'currentMarketValue')
          is distinct from 'string'
        or jsonb_typeof(orders.item->'targetGap') is distinct from 'string'
        or jsonb_typeof(orders.item->'priority') is distinct from 'string'
        or jsonb_typeof(orders.item->'estimatedGrossNotional')
          is distinct from 'string'
        or jsonb_typeof(orders.item->'estimatedFees')
          is distinct from 'object'
        or jsonb_typeof(orders.item->'estimatedTotalFees')
          is distinct from 'string'
        or jsonb_typeof(orders.item->'reservedBuyingPower')
          is distinct from 'string'
        or (orders.item->>'targetAmount')
          !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
        or (orders.item->>'currentMarketValue')
          !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
        or (orders.item->>'targetGap')
          !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
        or (orders.item->>'priority') !~ '^[1-9][0-9]*$'
        or (orders.item->>'estimatedGrossNotional')
          !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
        or (orders.item->>'estimatedTotalFees')
          !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
        or (orders.item->>'reservedBuyingPower')
          !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
  ) then
    raise exception 'S2 frozen order plan contains invalid buying-power fields'
      using errcode = '22023';
  end if;

  if p_stage = 'S2' and exists (
    select 1
      from jsonb_array_elements(v_plan->'orders') as orders(item)
     where not (
       (orders.item->'estimatedFees') ?&
         array[
           'commission',
           'platform',
           'settlement',
           'secRegulatory',
           'finraTaf',
           'cat'
         ]::text[]
     ) or (
       select count(*)
         from jsonb_object_keys(orders.item->'estimatedFees')
     ) <> 6
        or exists (
          select 1
            from jsonb_each(orders.item->'estimatedFees') as fee(name, value)
           where jsonb_typeof(fee.value) is distinct from 'string'
              or (fee.value #>> '{}')
                !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
        )
  ) then
    raise exception 'S2 frozen order plan contains invalid estimated fee components'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(v_plan->'orders') with ordinality
        as wrapper(item, item_index)
      full join jsonb_array_elements(v_engine_plan->'orders') with ordinality
        as engine(item, item_index)
        using (item_index)
     where wrapper.item is null
        or engine.item is null
        or (
          wrapper.item - array[
            'executionModel',
            'slippageBps',
            'feeTermsSha256'
          ]::text[]
        ) is distinct from engine.item
  ) then
    raise exception
      'wrapper orders diverge from the ordered Core engine payload'
      using errcode = '22023';
  end if;

  if (
    select count(*) <> count(distinct orders.item->>'orderId')
      from jsonb_array_elements(v_plan->'orders') as orders(item)
  ) then
    raise exception 'frozen order plan contains duplicate order IDs'
      using errcode = '22023';
  end if;

  select submission.accepted_at, invocation.decision_at
    into v_accepted_at, v_decision_at
    from public.strategy_account as account
    join public.decision_invocation as invocation
      on invocation.decision_id = p_decision_id
     and invocation.run_id = account.run_id
    join public.accepted_target_submission as submission
      on submission.submission_id = p_accepted_submission_id
     and submission.decision_id = invocation.decision_id
   where account.strategy_account_id = p_strategy_account_id
     and account.run_id = p_run_id
     and account.live_trading is false;

  if not found then
    raise exception
      'paper strategy account, run, decision, and accepted submission do not form one chain'
      using errcode = '23503';
  end if;

  if v_accepted_at < v_decision_at or p_planned_at < v_accepted_at then
    raise exception 'order plan cannot predate its accepted target submission'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('accounting-kernel:frozen-order-plan', 0)
  );

  select frozen.*
    into v_existing
    from public.frozen_order_plan as frozen
   where frozen.idempotency_key = p_idempotency_key
      or (
        frozen.decision_id = p_decision_id
        and frozen.stage = p_stage
      )
   order by (frozen.idempotency_key = p_idempotency_key) desc
   limit 1;

  if found then
    if v_existing.strategy_account_id
        is distinct from p_strategy_account_id
      or v_existing.run_id is distinct from p_run_id
      or v_existing.decision_id is distinct from p_decision_id
      or v_existing.accepted_submission_id
        is distinct from p_accepted_submission_id
      or v_existing.stage is distinct from p_stage
      or v_existing.planned_at is distinct from p_planned_at
      or v_existing.planned_trade_date is distinct from p_planned_trade_date
      or v_existing.manifest_schema is distinct from p_manifest_schema
      or v_existing.plan_canonical_json is distinct from p_plan_canonical_json
      or v_existing.plan is distinct from v_plan
      or v_existing.plan_sha256 is distinct from p_plan_sha256
      or v_existing.engine_plan_fingerprint
        is distinct from v_engine_plan_fingerprint
      or v_existing.engine_plan_fingerprint_sha256
        is distinct from v_engine_plan_fingerprint_sha256
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'frozen order plan identity was reused with different content'
        using errcode = '23505';
    end if;

    return v_existing;
  end if;

  -- Temporary fail-closed UTC boundary until an exchange calendar and market
  -- session cutoff are available. Apply it only to a genuinely new insert:
  -- a byte-identical retry must remain recoverable after trade day if the
  -- original successful response was lost.
  if v_arrival_at >= (
    p_planned_trade_date::timestamp without time zone at time zone 'UTC'
  ) then
    raise exception
      'frozen order plan admission has already entered its UTC trade date'
      using errcode = '22023';
  end if;

  if (p_planned_at at time zone 'UTC')::date >= p_planned_trade_date then
    raise exception
      'frozen order plan must be recorded before its planned trade date in UTC'
      using errcode = '22023';
  end if;

  if p_planned_at > v_arrival_at then
    raise exception
      'frozen order plan planned_at cannot be later than the database arrival time'
      using errcode = '22023';
  end if;

  insert into public.frozen_order_plan (
    idempotency_key,
    strategy_account_id,
    run_id,
    decision_id,
    accepted_submission_id,
    stage,
    planned_at,
    planned_trade_date,
    manifest_schema,
    plan_canonical_json,
    plan,
    plan_sha256,
    engine_plan_fingerprint,
    engine_plan_fingerprint_sha256,
    recorded_by
  ) values (
    p_idempotency_key,
    p_strategy_account_id,
    p_run_id,
    p_decision_id,
    p_accepted_submission_id,
    p_stage,
    p_planned_at,
    p_planned_trade_date,
    p_manifest_schema,
    p_plan_canonical_json,
    v_plan,
    p_plan_sha256,
    v_engine_plan_fingerprint,
    v_engine_plan_fingerprint_sha256,
    p_recorded_by
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

comment on function public.register_frozen_order_plan(
  text, uuid, uuid, uuid, uuid, text, timestamptz, date,
  text, text, text, text
) is
  'Freezes exact wrapper and Core fingerprint bytes after verifying SHA256, string-only payload equivalence, paper account, accepted decision chain, trusted pre-trade UTC admission, instruments, evidence, and fee-term bindings.';

alter table public.run_manifest enable row level security;
alter table public.instrument enable row level security;
alter table public.instrument_symbol_version enable row level security;
alter table public.strategy_account enable row level security;
alter table public.position_lot_origin enable row level security;
alter table public.accounting_transaction enable row level security;
alter table public.accounting_posting enable row level security;
alter table public.frozen_order_plan enable row level security;

revoke all on table public.run_manifest
  from public, anon, authenticated;
revoke all on table public.instrument
  from public, anon, authenticated;
revoke all on table public.instrument_symbol_version
  from public, anon, authenticated;
revoke all on table public.strategy_account
  from public, anon, authenticated;
revoke all on table public.position_lot_origin
  from public, anon, authenticated;
revoke all on table public.accounting_transaction
  from public, anon, authenticated;
revoke all on table public.accounting_posting
  from public, anon, authenticated;
revoke all on table public.frozen_order_plan
  from public, anon, authenticated;

revoke insert, update, delete, truncate, references, trigger
  on table public.run_manifest from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.instrument from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.instrument_symbol_version from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.strategy_account from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.position_lot_origin from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.accounting_transaction from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.accounting_posting from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.frozen_order_plan from service_role;

grant select on table public.run_manifest to service_role;
grant select on table public.instrument to service_role;
grant select on table public.instrument_symbol_version to service_role;
grant select on table public.strategy_account to service_role;
grant select on table public.position_lot_origin to service_role;
grant select on table public.accounting_transaction to service_role;
grant select on table public.accounting_posting to service_role;
grant select on table public.frozen_order_plan to service_role;

revoke all on function public.register_run_manifest(
  text, uuid, text, jsonb, text, text, uuid
) from public, anon, authenticated;
revoke all on function public.register_instrument(
  text, uuid, text, text, text, text, jsonb, text
) from public, anon, authenticated;
revoke all on function public.register_instrument_symbol_version(
  text, uuid, text, text, date, date, jsonb, text
) from public, anon, authenticated;
revoke all on function public.register_strategy_account(
  text, uuid, text, text, text, text, boolean, jsonb, text
) from public, anon, authenticated;
revoke all on function public.register_position_lot_origin(
  text, uuid, uuid, text, text, timestamptz, date,
  numeric, numeric, numeric, text, text, jsonb, text, text, uuid
) from public, anon, authenticated;
revoke all on function public.append_accounting_transaction(
  text, uuid, text, text, timestamptz, date, date, text, jsonb, jsonb, text
) from public, anon, authenticated, service_role;
revoke all on function public.register_frozen_order_plan(
  text, uuid, uuid, uuid, uuid, text, timestamptz, date,
  text, text, text, text
) from public, anon, authenticated;

grant execute on function public.register_run_manifest(
  text, uuid, text, jsonb, text, text, uuid
) to service_role;
grant execute on function public.register_instrument(
  text, uuid, text, text, text, text, jsonb, text
) to service_role;
grant execute on function public.register_instrument_symbol_version(
  text, uuid, text, text, date, date, jsonb, text
) to service_role;
grant execute on function public.register_strategy_account(
  text, uuid, text, text, text, text, boolean, jsonb, text
) to service_role;
grant execute on function public.register_position_lot_origin(
  text, uuid, uuid, text, text, timestamptz, date,
  numeric, numeric, numeric, text, text, jsonb, text, text, uuid
) to service_role;
-- Intentionally no service_role grant for the generic journal primitive.
-- Per-transaction balance is insufficient to prevent negative cash or
-- inventory. A future atomic settlement boundary will derive postings and
-- enforce cumulative no-margin asset balances before exposing a write RPC.
grant execute on function public.register_frozen_order_plan(
  text, uuid, uuid, uuid, uuid, text, timestamptz, date,
  text, text, text, text
) to service_role;

commit;
