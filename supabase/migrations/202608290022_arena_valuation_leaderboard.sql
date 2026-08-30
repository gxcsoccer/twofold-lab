-- Competition ranking has one economic truth: the cash that would remain if
-- every position were closed now, after simulated broker fees and China tax.
-- The Core calculation is stored as immutable canonical bytes, while exact
-- NUMERIC columns make ranking independent of UI or JavaScript arithmetic.

begin;

create table public.arena_valuation (
  valuation_id uuid primary key,
  idempotency_key text not null unique check (idempotency_key <> ''),
  round_entry_id uuid not null,
  round_id uuid not null,
  season_id uuid not null,
  entrant_id uuid not null,
  run_id uuid not null,
  stage text not null check (stage in ('OPENING', 'S1_CLOSE', 'S2_CLOSE')),
  snapshot_id uuid not null references public.market_snapshot(snapshot_id),
  valuation_at timestamptz not null,
  valuation_date date not null,
  portfolio_as_of timestamptz not null,
  ledger_sequence bigint not null check (ledger_sequence >= 0),
  ledger_sha256 text not null check (ledger_sha256 ~ '^[0-9a-f]{64}$'),
  reporting_currency text not null check (reporting_currency ~ '^[A-Z]{3}$'),
  position_market_value numeric(38, 12) not null
    check (position_market_value >= 0),
  settled_cash numeric(38, 12) not null check (settled_cash >= 0),
  tax_reserve numeric(38, 12) not null check (
    tax_reserve >= 0 and tax_reserve <= settled_cash
  ),
  estimated_close_fees numeric(38, 12) not null
    check (estimated_close_fees >= 0),
  estimated_unrealized_liquidation_tax numeric(38, 12) not null
    check (estimated_unrealized_liquidation_tax >= 0),
  broker_nav numeric(38, 12) not null check (broker_nav >= 0),
  tax_reserved_nav numeric(38, 12) not null check (tax_reserved_nav >= 0),
  liquidation_nav numeric(38, 12) not null,
  score_base_liquidation_nav numeric(38, 12) not null
    check (score_base_liquidation_nav > 0),
  fee_schedule_ids text[] not null check (cardinality(fee_schedule_ids) > 0),
  canonical_json text not null check (canonical_json <> ''),
  valuation jsonb not null,
  valuation_sha256 text not null check (valuation_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint arena_valuation_round_entry_stage_unique
    unique (round_entry_id, stage),
  constraint arena_valuation_entry_fk foreign key (
    round_entry_id, round_id, season_id, entrant_id, run_id
  ) references public.arena_round_entry(
    round_entry_id, round_id, season_id, entrant_id, run_id
  ),
  constraint arena_valuation_id_deterministic check (
    valuation_id = public.deterministic_uuid_from_sha256(
      'twofold.arena_valuation/v1', round_entry_id::text || ':' || stage
    )
  ),
  constraint arena_valuation_nav_reconciles check (
    broker_nav = settled_cash + position_market_value
    and tax_reserved_nav = broker_nav - tax_reserve
    and liquidation_nav = tax_reserved_nav
      - estimated_close_fees
      - estimated_unrealized_liquidation_tax
  ),
  constraint arena_valuation_payload_object check (
    jsonb_typeof(valuation) = 'object'
  ),
  constraint arena_valuation_payload_decimal_safe check (
    not public.jsonb_contains_number(valuation)
  ),
  constraint arena_valuation_canonical_bytes_bind_sha check (
    valuation = canonical_json::jsonb
    and valuation_sha256 = encode(
      extensions.digest(convert_to(canonical_json, 'UTF8'), 'sha256'),
      'hex'
    )
  )
);

comment on table public.arena_valuation is
  'Immutable exact-string valuation evidence and reconciled Liquidation NAV used by the private competition leaderboard.';

create index arena_valuation_latest_score_idx on public.arena_valuation (
  season_id, entrant_id, valuation_at desc, stage desc
);

create trigger arena_valuation_is_immutable
before update or delete on public.arena_valuation
for each row execute function public.reject_immutable_mutation();
create trigger arena_valuation_rejects_truncate
before truncate on public.arena_valuation
for each statement execute function public.reject_immutable_mutation();

create or replace function public.arena_valuation_result(
  p_value public.arena_valuation
)
returns jsonb
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'twofold.arena_valuation_result/v1',
    'valuationId', p_value.valuation_id::text,
    'roundEntryId', p_value.round_entry_id::text,
    'roundId', p_value.round_id::text,
    'seasonId', p_value.season_id::text,
    'entrantId', p_value.entrant_id::text,
    'runId', p_value.run_id::text,
    'stage', p_value.stage,
    'snapshotId', p_value.snapshot_id::text,
    'valuationAt', to_char(
      p_value.valuation_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'valuationDate', p_value.valuation_date::text,
    'ledgerSequence', p_value.ledger_sequence::text,
    'ledgerSha256', p_value.ledger_sha256,
    'brokerNav', public.accounting_decimal_text(p_value.broker_nav),
    'taxReservedNav', public.accounting_decimal_text(p_value.tax_reserved_nav),
    'liquidationNav', public.accounting_decimal_text(p_value.liquidation_nav),
    'scoreBaseLiquidationNav',
      public.accounting_decimal_text(p_value.score_base_liquidation_nav),
    'valuationSha256', p_value.valuation_sha256,
    'recordedBy', p_value.recorded_by,
    'recordedAt', to_char(
      p_value.recorded_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  )
$$;

create or replace function public.register_arena_valuation(
  p_idempotency_key text,
  p_round_entry_id uuid,
  p_stage text,
  p_snapshot_id uuid,
  p_canonical_json text,
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
  v_snapshot public.market_snapshot%rowtype;
  v_account public.strategy_account%rowtype;
  v_head public.strategy_ledger_head%rowtype;
  v_existing public.arena_valuation%rowtype;
  v_inserted public.arena_valuation%rowtype;
  v_payload jsonb;
  v_valuation_id uuid;
  v_valuation_at timestamptz;
  v_valuation_date date;
  v_portfolio_as_of timestamptz;
  v_ledger_sequence bigint;
  v_position_market_value numeric(38, 12);
  v_settled_cash numeric(38, 12);
  v_tax_reserve numeric(38, 12);
  v_estimated_close_fees numeric(38, 12);
  v_estimated_unrealized_tax numeric(38, 12);
  v_broker_nav numeric(38, 12);
  v_tax_reserved_nav numeric(38, 12);
  v_liquidation_nav numeric(38, 12);
  v_score_base numeric(38, 12);
  v_fee_schedule_ids text[];
  v_prior_score_base numeric(38, 12);
  v_season_score_base numeric(38, 12);
  v_valuation_sha256 text;
  v_text_fields text[] := array[
    'brokerNav', 'estimatedCloseFees',
    'estimatedUnrealizedLiquidationTax', 'ledgerSequence', 'ledgerSha256',
    'liquidationNav', 'portfolioAsOf', 'positionMarketValue',
    'reportingCurrency', 'schema', 'scoreBaseLiquidationNav', 'settledCash',
    'taxReserve', 'taxReservedNav', 'valuationAt', 'valuationDate'
  ];
  v_all_fields text[] := array[
    'brokerNav', 'estimatedCloseFees',
    'estimatedUnrealizedLiquidationTax', 'feeScheduleIds', 'ledgerSequence',
    'ledgerSha256', 'liquidationNav', 'portfolioAsOf',
    'positionMarketValue', 'reportingCurrency', 'schema',
    'scoreBaseLiquidationNav', 'settledCash', 'taxReserve',
    'taxReservedNav', 'valuationAt', 'valuationDate'
  ];
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_round_entry_id is null
    or p_stage not in ('OPENING', 'S1_CLOSE', 'S2_CLOSE')
    or p_snapshot_id is null
    or p_canonical_json is null or p_canonical_json = ''
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid immutable Arena valuation'
      using errcode = '22023';
  end if;

  begin
    v_payload := p_canonical_json::jsonb;
  exception when others then
    raise exception 'Arena valuation is not valid canonical JSON'
      using errcode = '22023';
  end;
  if jsonb_typeof(v_payload) <> 'object'
    or public.jsonb_contains_number(v_payload)
    or not (v_payload ?& v_all_fields)
    or v_payload - v_all_fields <> '{}'::jsonb
    or exists (
      select 1 from unnest(v_text_fields) as field(name)
       where jsonb_typeof(v_payload->field.name) <> 'string'
    )
    or jsonb_typeof(v_payload->'feeScheduleIds') <> 'array'
    or v_payload->>'schema' <> 'twofold.arena_valuation/v1'
    or v_payload->>'reportingCurrency' !~ '^[A-Z]{3}$'
    or v_payload->>'ledgerSha256' !~ '^[0-9a-f]{64}$'
  then
    raise exception 'Arena valuation payload has an invalid exact shape'
      using errcode = '22023';
  end if;

  begin
    v_valuation_at := (v_payload->>'valuationAt')::timestamptz;
    v_valuation_date := (v_payload->>'valuationDate')::date;
    v_portfolio_as_of := (v_payload->>'portfolioAsOf')::timestamptz;
    v_ledger_sequence := (v_payload->>'ledgerSequence')::bigint;
    v_position_market_value := (v_payload->>'positionMarketValue')::numeric;
    v_settled_cash := (v_payload->>'settledCash')::numeric;
    v_tax_reserve := (v_payload->>'taxReserve')::numeric;
    v_estimated_close_fees := (v_payload->>'estimatedCloseFees')::numeric;
    v_estimated_unrealized_tax :=
      (v_payload->>'estimatedUnrealizedLiquidationTax')::numeric;
    v_broker_nav := (v_payload->>'brokerNav')::numeric;
    v_tax_reserved_nav := (v_payload->>'taxReservedNav')::numeric;
    v_liquidation_nav := (v_payload->>'liquidationNav')::numeric;
    v_score_base := (v_payload->>'scoreBaseLiquidationNav')::numeric;
  exception when others then
    raise exception 'Arena valuation contains an invalid exact scalar'
      using errcode = '22023';
  end;

  if v_ledger_sequence < 0
    or v_position_market_value < 0
    or v_settled_cash < 0
    or v_tax_reserve < 0 or v_tax_reserve > v_settled_cash
    or v_estimated_close_fees < 0
    or v_estimated_unrealized_tax < 0
    or v_broker_nav < 0 or v_tax_reserved_nav < 0
    or v_score_base <= 0
    or v_broker_nav <> v_settled_cash + v_position_market_value
    or v_tax_reserved_nav <> v_broker_nav - v_tax_reserve
    or v_liquidation_nav <> v_tax_reserved_nav
      - v_estimated_close_fees - v_estimated_unrealized_tax
    or public.accounting_decimal_text(v_position_market_value)
      <> v_payload->>'positionMarketValue'
    or public.accounting_decimal_text(v_settled_cash)
      <> v_payload->>'settledCash'
    or public.accounting_decimal_text(v_tax_reserve)
      <> v_payload->>'taxReserve'
    or public.accounting_decimal_text(v_estimated_close_fees)
      <> v_payload->>'estimatedCloseFees'
    or public.accounting_decimal_text(v_estimated_unrealized_tax)
      <> v_payload->>'estimatedUnrealizedLiquidationTax'
    or public.accounting_decimal_text(v_broker_nav)
      <> v_payload->>'brokerNav'
    or public.accounting_decimal_text(v_tax_reserved_nav)
      <> v_payload->>'taxReservedNav'
    or public.accounting_decimal_text(v_liquidation_nav)
      <> v_payload->>'liquidationNav'
    or public.accounting_decimal_text(v_score_base)
      <> v_payload->>'scoreBaseLiquidationNav'
    or v_ledger_sequence::text <> v_payload->>'ledgerSequence'
    or to_char(v_valuation_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> v_payload->>'valuationAt'
    or v_valuation_date::text <> v_payload->>'valuationDate'
    or to_char(v_portfolio_as_of at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> v_payload->>'portfolioAsOf'
  then
    raise exception 'Arena valuation does not reconcile or is not canonical'
      using errcode = '22023';
  end if;

  select coalesce(array_agg(value order by value), '{}'::text[])
    into v_fee_schedule_ids
    from jsonb_array_elements_text(v_payload->'feeScheduleIds') as fee(value);
  if cardinality(v_fee_schedule_ids) = 0
    or exists (
      select 1 from unnest(v_fee_schedule_ids) as fee(value)
       where btrim(fee.value) = ''
    )
    or cardinality(v_fee_schedule_ids)
      <> cardinality(array(select distinct unnest(v_fee_schedule_ids)))
    or to_jsonb(v_fee_schedule_ids) <> v_payload->'feeScheduleIds'
  then
    raise exception 'Arena valuation fee schedules must be sorted and unique'
      using errcode = '22023';
  end if;

  v_valuation_id := public.deterministic_uuid_from_sha256(
    'twofold.arena_valuation/v1', p_round_entry_id::text || ':' || p_stage
  );
  v_valuation_sha256 := encode(
    extensions.digest(convert_to(p_canonical_json, 'UTF8'), 'sha256'), 'hex'
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'arena-valuation:' || p_round_entry_id::text || ':' || p_stage, 0
  ));
  select * into v_existing from public.arena_valuation
   where idempotency_key = p_idempotency_key
      or valuation_id = v_valuation_id
      or (round_entry_id = p_round_entry_id and stage = p_stage)
   order by (idempotency_key = p_idempotency_key) desc
   limit 1;
  if found then
    if v_existing.idempotency_key is distinct from p_idempotency_key
      or v_existing.round_entry_id is distinct from p_round_entry_id
      or v_existing.stage is distinct from p_stage
      or v_existing.snapshot_id is distinct from p_snapshot_id
      or v_existing.canonical_json is distinct from p_canonical_json
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'Arena valuation identity was reused with different content'
        using errcode = '23505';
    end if;
    return public.arena_valuation_result(v_existing);
  end if;

  select * into v_entry from public.arena_round_entry
   where round_entry_id = p_round_entry_id;
  select * into v_round from public.arena_round
   where round_id = v_entry.round_id;
  select * into v_snapshot from public.market_snapshot
   where snapshot_id = p_snapshot_id;
  select * into v_account from public.strategy_account
   where run_id = v_entry.run_id;
  select * into v_head from public.strategy_ledger_head
   where strategy_account_id = v_account.strategy_account_id;
  if v_entry.round_entry_id is null or v_round.round_id is null
    or v_snapshot.snapshot_id is null or v_account.strategy_account_id is null
    or v_head.strategy_account_id is null
  then
    raise exception 'Arena valuation provenance is incomplete'
      using errcode = '23503';
  end if;
  if v_payload->>'reportingCurrency' <> v_account.base_currency
    or v_head.head_sequence <> v_ledger_sequence
    or v_head.head_sha256 <> v_payload->>'ledgerSha256'
    or v_portfolio_as_of > v_valuation_at
    or v_snapshot.target_session_date <> v_valuation_date
    or v_valuation_at < v_snapshot.sealed_at
    or (
      p_stage = 'OPENING' and (
        v_round.round_index <> 1
        or p_snapshot_id <> v_round.decision_snapshot_id
        or v_valuation_date <> v_round.decision_session_date
      )
    )
    or (
      p_stage = 'S1_CLOSE'
      and v_valuation_date <> v_round.s1_session_date
    )
    or (
      p_stage = 'S2_CLOSE'
      and v_valuation_date <> v_round.s2_session_date
    )
  then
    raise exception 'Arena valuation does not match current ledger or Round evidence'
      using errcode = '22023';
  end if;

  select score_base_liquidation_nav into v_prior_score_base
    from public.arena_valuation
   where season_id = v_entry.season_id and entrant_id = v_entry.entrant_id
   order by valuation_at, valuation_id
   limit 1;
  if v_prior_score_base is null then
    if p_stage <> 'OPENING' or v_score_base <> v_liquidation_nav then
      raise exception 'first entrant valuation must establish its opening base'
        using errcode = '22023';
    end if;
  elsif v_prior_score_base <> v_score_base then
    raise exception 'entrant score base changed after opening'
      using errcode = '22023';
  end if;

  select score_base_liquidation_nav into v_season_score_base
    from public.arena_valuation
   where season_id = v_entry.season_id and stage = 'OPENING'
   order by recorded_at, valuation_id
   limit 1;
  if v_season_score_base is not null and v_season_score_base <> v_score_base then
    raise exception 'Season entrants must begin from equal liquidation value'
      using errcode = '22023';
  end if;

  insert into public.arena_valuation (
    valuation_id, idempotency_key,
    round_entry_id, round_id, season_id, entrant_id, run_id,
    stage, snapshot_id, valuation_at, valuation_date, portfolio_as_of,
    ledger_sequence, ledger_sha256, reporting_currency,
    position_market_value, settled_cash, tax_reserve,
    estimated_close_fees, estimated_unrealized_liquidation_tax,
    broker_nav, tax_reserved_nav, liquidation_nav,
    score_base_liquidation_nav, fee_schedule_ids,
    canonical_json, valuation, valuation_sha256, recorded_by
  ) values (
    v_valuation_id, p_idempotency_key,
    v_entry.round_entry_id, v_entry.round_id, v_entry.season_id,
    v_entry.entrant_id, v_entry.run_id,
    p_stage, p_snapshot_id, v_valuation_at, v_valuation_date, v_portfolio_as_of,
    v_ledger_sequence, v_payload->>'ledgerSha256',
    v_payload->>'reportingCurrency',
    v_position_market_value, v_settled_cash, v_tax_reserve,
    v_estimated_close_fees, v_estimated_unrealized_tax,
    v_broker_nav, v_tax_reserved_nav, v_liquidation_nav,
    v_score_base, v_fee_schedule_ids,
    p_canonical_json, v_payload, v_valuation_sha256, p_recorded_by
  ) returning * into v_inserted;

  return public.arena_valuation_result(v_inserted);
end;
$$;

create or replace function public.get_arena_leaderboard(p_season_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
set row_security = off
as $$
  with latest as (
    select distinct on (valuation.entrant_id)
      valuation.*,
      entrant.entrant_code,
      entrant.preset_id,
      round.round_index
    from public.arena_valuation as valuation
    join public.season_entrant as entrant
      on entrant.entrant_id = valuation.entrant_id
    join public.arena_round as round on round.round_id = valuation.round_id
    where valuation.season_id = p_season_id
    order by valuation.entrant_id, round.round_index desc,
      case valuation.stage
        when 'S2_CLOSE' then 3 when 'S1_CLOSE' then 2 else 1
      end desc,
      valuation.valuation_at desc,
      valuation.valuation_id
  ), ranked as (
    select latest.*,
      rank() over (order by liquidation_nav desc) as competition_rank,
      round(liquidation_nav / score_base_liquidation_nav, 12)
        as return_multiple
    from latest
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'schema', 'twofold.arena_leaderboard_entry/v1',
    'rank', competition_rank::text,
    'entrantId', entrant_id::text,
    'entrantCode', entrant_code,
    'presetId', preset_id,
    'runId', run_id::text,
    'roundId', round_id::text,
    'roundIndex', round_index::text,
    'stage', stage,
    'snapshotId', snapshot_id::text,
    'valuationAt', to_char(
      valuation_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'brokerNav', public.accounting_decimal_text(broker_nav),
    'taxReservedNav', public.accounting_decimal_text(tax_reserved_nav),
    'liquidationNav', public.accounting_decimal_text(liquidation_nav),
    'scoreBaseLiquidationNav',
      public.accounting_decimal_text(score_base_liquidation_nav),
    'returnMultiple', public.accounting_decimal_text(return_multiple),
    'valuationSha256', valuation_sha256
  ) order by competition_rank, entrant_code), '[]'::jsonb)
  from ranked
$$;

alter table public.arena_valuation enable row level security;
revoke all on table public.arena_valuation
  from public, anon, authenticated, service_role;
grant select on table public.arena_valuation to service_role;

revoke all on function public.arena_valuation_result(public.arena_valuation)
  from public, anon, authenticated;
revoke all on function public.register_arena_valuation(
  text, uuid, text, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.register_arena_valuation(
  text, uuid, text, uuid, text, text
) to service_role;
revoke all on function public.get_arena_leaderboard(uuid)
  from public, anon, authenticated;
grant execute on function public.get_arena_leaderboard(uuid)
  to service_role;

commit;
