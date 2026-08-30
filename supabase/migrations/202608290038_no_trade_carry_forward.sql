-- A contestant-local terminal failure is an economic no-trade outcome, not a
-- fabricated successful strategy and not a reason to stop every other Run.
-- Recover only after shared S2-close evidence exists, preserve the ledger head,
-- register an exact close valuation, and make the next Round depend on one
-- terminal S2 valuation per entrant.

begin;

create table public.arena_no_trade_recovery (
  recovery_id uuid primary key,
  round_entry_id uuid not null unique,
  round_id uuid not null,
  season_id uuid not null,
  entrant_id uuid not null,
  run_id uuid not null,
  source_work_item_id uuid not null unique
    references public.arena_work_item(work_item_id),
  reason_code text not null check (reason_code in (
    'DECISION_UNAVAILABLE', 'S1_PLAN_UNAVAILABLE',
    'S1_CHECKPOINT_UNAVAILABLE', 'FINALIZATION_UNAVAILABLE'
  )),
  scheduled_at timestamptz not null,
  recorded_by text not null check (recorded_by <> ''),
  status text not null default 'REQUESTED' check (status in (
    'REQUESTED', 'CLAIMED', 'SUCCEEDED', 'FAILED'
  )),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null,
  claimed_by text,
  lease_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  completion_fingerprint_sha256 text check (
    completion_fingerprint_sha256 is null
      or completion_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
  ),
  valuation_id uuid references public.arena_valuation(valuation_id),
  result jsonb,
  error_code text,
  error_message text,
  retryable boolean,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint arena_no_trade_recovery_entry_fk foreign key (
    round_entry_id, round_id, season_id, entrant_id, run_id
  ) references public.arena_round_entry(
    round_entry_id, round_id, season_id, entrant_id, run_id
  ),
  constraint arena_no_trade_recovery_id_deterministic check (
    recovery_id = public.deterministic_uuid_from_sha256(
      'twofold.arena_no_trade_recovery/v1', round_entry_id::text
    )
  ),
  constraint arena_no_trade_recovery_result_object check (
    result is null or jsonb_typeof(result) = 'object'
  ),
  constraint arena_no_trade_recovery_result_decimal_safe check (
    result is null or not public.jsonb_contains_number(result)
  ),
  constraint arena_no_trade_recovery_claim_shape check (
    (status = 'CLAIMED'
      and claimed_by is not null and lease_token is not null
      and claimed_at is not null and lease_expires_at > claimed_at
      and completed_at is null)
    or
    (status <> 'CLAIMED'
      and claimed_by is null and lease_token is null
      and claimed_at is null and lease_expires_at is null)
  ),
  constraint arena_no_trade_recovery_terminal_shape check (
    (status in ('SUCCEEDED', 'FAILED') and completed_at is not null)
    or (status in ('REQUESTED', 'CLAIMED') and completed_at is null)
  ),
  constraint arena_no_trade_recovery_success_shape check (
    (status = 'SUCCEEDED' and valuation_id is not null and result is not null)
    or status <> 'SUCCEEDED'
  )
);

comment on table public.arena_no_trade_recovery is
  'Durable carry-forward of an unchanged ledger after one contestant-local terminal failure.';

create index arena_no_trade_recovery_claim_idx
  on public.arena_no_trade_recovery(status, next_attempt_at, scheduled_at);

create or replace function public.guard_arena_no_trade_recovery_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Arena no-trade recovery cannot be deleted'
      using errcode = '55000';
  end if;
  if current_setting('twofold.arena_no_trade_recovery_mutation', true)
       is distinct from 'on'
  then
    raise exception 'Arena no-trade recovery may change only through queue RPCs'
      using errcode = '55000';
  end if;
  if new.recovery_id is distinct from old.recovery_id
    or new.round_entry_id is distinct from old.round_entry_id
    or new.round_id is distinct from old.round_id
    or new.season_id is distinct from old.season_id
    or new.entrant_id is distinct from old.entrant_id
    or new.run_id is distinct from old.run_id
    or new.source_work_item_id is distinct from old.source_work_item_id
    or new.reason_code is distinct from old.reason_code
    or new.scheduled_at is distinct from old.scheduled_at
    or new.recorded_by is distinct from old.recorded_by
    or new.recorded_at is distinct from old.recorded_at
  then
    raise exception 'Arena no-trade recovery identity is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger arena_no_trade_recovery_guarded
before update or delete on public.arena_no_trade_recovery
for each row execute function public.guard_arena_no_trade_recovery_mutation();
create trigger arena_no_trade_recovery_rejects_truncate
before truncate on public.arena_no_trade_recovery
for each statement execute function public.reject_immutable_mutation();

create or replace function public.arena_no_trade_recovery_result(
  p_value public.arena_no_trade_recovery
)
returns jsonb
language sql
stable
strict
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'twofold.arena_no_trade_recovery/v1',
    'recoveryId', p_value.recovery_id::text,
    'roundEntryId', p_value.round_entry_id::text,
    'roundId', p_value.round_id::text,
    'seasonId', p_value.season_id::text,
    'entrantId', p_value.entrant_id::text,
    'runId', p_value.run_id::text,
    'sourceWorkItemId', p_value.source_work_item_id::text,
    'reasonCode', p_value.reason_code,
    'scheduledAt', to_char(p_value.scheduled_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'recordedBy', p_value.recorded_by,
    'status', p_value.status,
    'attemptCount', p_value.attempt_count::text,
    'nextAttemptAt', to_char(p_value.next_attempt_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'claimedBy', p_value.claimed_by,
    'leaseToken', p_value.lease_token::text,
    'leaseExpiresAt', case when p_value.lease_expires_at is null then null else
      to_char(p_value.lease_expires_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'completedAt', case when p_value.completed_at is null then null else
      to_char(p_value.completed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'valuationId', p_value.valuation_id::text,
    'result', p_value.result,
    'errorCode', p_value.error_code,
    'errorMessage', p_value.error_message,
    'retryable', p_value.retryable
  )
$$;

create or replace function public.enqueue_arena_no_trade_recovery()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_entry public.arena_round_entry%rowtype;
  v_round public.arena_round%rowtype;
  v_reason text;
begin
  if new.status not in ('FAILED', 'CANCELED')
    or old.status in ('FAILED', 'CANCELED')
    or new.phase not in (
      'RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS',
      'SETTLE_S1_AND_PREPARE_S2', 'FINALIZE_ACCEPTED_TARGET_CYCLE'
    )
  then
    return new;
  end if;
  select * into v_entry from public.arena_round_entry
   where round_entry_id = new.round_entry_id;
  select * into v_round from public.arena_round
   where round_id = new.round_id and season_id = new.season_id;
  if v_entry.round_entry_id is null or v_round.round_id is null then
    raise exception 'terminal Arena work has no Round entry'
      using errcode = '23503';
  end if;
  v_reason := case new.phase
    when 'RUN_AGENT_DECISION' then 'DECISION_UNAVAILABLE'
    when 'PREPARE_S1_ORDERS' then 'S1_PLAN_UNAVAILABLE'
    when 'SETTLE_S1_AND_PREPARE_S2' then 'S1_CHECKPOINT_UNAVAILABLE'
    else 'FINALIZATION_UNAVAILABLE'
  end;
  insert into public.arena_no_trade_recovery (
    recovery_id, round_entry_id, round_id, season_id, entrant_id, run_id,
    source_work_item_id, reason_code, scheduled_at, next_attempt_at, recorded_by
  ) values (
    public.deterministic_uuid_from_sha256(
      'twofold.arena_no_trade_recovery/v1', new.round_entry_id::text
    ),
    new.round_entry_id, new.round_id, new.season_id, new.entrant_id, new.run_id,
    new.work_item_id, v_reason, v_round.cycle_ready_at,
    v_round.cycle_ready_at, coalesce(old.claimed_by, new.recorded_by)
  ) on conflict (round_entry_id) do nothing;
  return new;
end;
$$;

create trigger arena_work_item_enqueue_no_trade_recovery
after update on public.arena_work_item
for each row execute function public.enqueue_arena_no_trade_recovery();

create or replace function public.claim_arena_no_trade_recovery(
  p_worker_id text,
  p_lease_seconds integer,
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_request public.arena_no_trade_recovery%rowtype;
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
    or p_worker_id is distinct from btrim(p_worker_id)
    or p_lease_seconds is null or p_lease_seconds < 5 or p_lease_seconds > 3600
    or p_now is null
  then
    raise exception 'invalid Arena no-trade recovery claim'
      using errcode = '22023';
  end if;
  perform set_config('twofold.arena_no_trade_recovery_mutation', 'on', true);
  update public.arena_no_trade_recovery
     set status = 'REQUESTED', claimed_by = null, lease_token = null,
         claimed_at = null, lease_expires_at = null, next_attempt_at = p_now
   where status = 'CLAIMED' and lease_expires_at <= p_now;
  select request.* into v_request
    from public.arena_no_trade_recovery as request
   where request.status = 'REQUESTED'
     and request.next_attempt_at <= p_now
     and request.scheduled_at <= p_now
   order by request.scheduled_at, request.season_id, request.round_id,
     request.entrant_id
   for update skip locked limit 1;
  if not found then
    perform set_config('twofold.arena_no_trade_recovery_mutation', 'off', true);
    return null;
  end if;
  update public.arena_no_trade_recovery
     set status = 'CLAIMED', attempt_count = attempt_count + 1,
         claimed_by = p_worker_id, lease_token = gen_random_uuid(),
         claimed_at = p_now,
         lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
         completed_at = null, completion_fingerprint_sha256 = null,
         valuation_id = null, result = null, error_code = null,
         error_message = null, retryable = null
   where recovery_id = v_request.recovery_id returning * into v_request;
  perform set_config('twofold.arena_no_trade_recovery_mutation', 'off', true);
  return public.arena_no_trade_recovery_result(v_request);
end;
$$;

create or replace function public.fail_arena_no_trade_recovery(
  p_recovery_id uuid,
  p_lease_token uuid,
  p_completed_at timestamptz,
  p_error_code text,
  p_error_message text,
  p_retryable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_request public.arena_no_trade_recovery%rowtype;
  v_will_retry boolean;
begin
  if p_recovery_id is null or p_lease_token is null or p_completed_at is null
    or p_error_code is null or btrim(p_error_code) = ''
    or p_error_message is null or btrim(p_error_message) = ''
    or p_retryable is null
  then
    raise exception 'invalid Arena no-trade recovery failure'
      using errcode = '22023';
  end if;
  select * into v_request from public.arena_no_trade_recovery
   where recovery_id = p_recovery_id for update;
  if not found or v_request.status <> 'CLAIMED'
    or v_request.lease_token is distinct from p_lease_token
    or p_completed_at < v_request.claimed_at
    or p_completed_at > v_request.lease_expires_at
  then
    raise exception 'Arena no-trade recovery lease is stale or expired'
      using errcode = '40001';
  end if;
  v_will_retry := p_retryable and v_request.attempt_count < 3;
  perform set_config('twofold.arena_no_trade_recovery_mutation', 'on', true);
  update public.arena_no_trade_recovery
     set status = case when v_will_retry then 'REQUESTED' else 'FAILED' end,
         next_attempt_at = case when v_will_retry
           then p_completed_at + interval '1 minute' else next_attempt_at end,
         claimed_by = null, lease_token = null, claimed_at = null,
         lease_expires_at = null,
         completed_at = case when v_will_retry then null else p_completed_at end,
         result = jsonb_build_object('outcome', 'FAILED'),
         error_code = p_error_code, error_message = p_error_message,
         retryable = p_retryable
   where recovery_id = p_recovery_id returning * into v_request;
  perform set_config('twofold.arena_no_trade_recovery_mutation', 'off', true);
  return public.arena_no_trade_recovery_result(v_request);
end;
$$;

create or replace function public.try_enqueue_next_arena_round(
  p_round_id uuid,
  p_recorded_by text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_round public.arena_round%rowtype;
  v_snapshot public.market_snapshot%rowtype;
  v_available_at timestamptz;
begin
  if p_round_id is null
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid next Arena Round enqueue'
      using errcode = '22023';
  end if;
  select * into v_round from public.arena_round where round_id = p_round_id;
  if not found or exists (
    select 1 from public.arena_round_entry as entry
     where entry.round_id = p_round_id
       and (
         not exists (
           select 1 from public.arena_valuation as valuation
            where valuation.round_entry_id = entry.round_entry_id
              and valuation.stage = 'S2_CLOSE'
         )
         or not (
           exists (
             select 1 from public.arena_work_item as final_work
              where final_work.round_entry_id = entry.round_entry_id
                and final_work.phase = 'FINALIZE_ACCEPTED_TARGET_CYCLE'
                and final_work.status = 'SUCCEEDED'
           )
           or exists (
             select 1 from public.arena_no_trade_recovery as recovery
              where recovery.round_entry_id = entry.round_entry_id
                and recovery.status = 'SUCCEEDED'
           )
         )
       )
  ) or exists (
    select 1 from public.arena_round as next_round
     where next_round.season_id = v_round.season_id
       and next_round.round_index = v_round.round_index + 1
  ) then
    return;
  end if;
  select snapshot.* into v_snapshot
    from public.arena_round_close_snapshot as close_binding
    join public.market_snapshot as snapshot
      on snapshot.snapshot_id = close_binding.snapshot_id
   where close_binding.round_id = p_round_id
     and close_binding.stage = 'S2_CLOSE';
  if not found then
    raise exception 'terminal Round has no shared S2 close snapshot'
      using errcode = '23503';
  end if;
  select greatest(v_snapshot.sealed_at, max(valuation.recorded_at))
    into v_available_at
    from public.arena_valuation as valuation
   where valuation.round_id = p_round_id
     and valuation.stage = 'S2_CLOSE';
  insert into public.arena_round_provisioning (
    provisioning_id, source_round_id, season_id, next_round_index,
    decision_snapshot_id, decision_session_date, decision_available_at,
    recorded_by, next_attempt_at
  ) values (
    public.deterministic_uuid_from_sha256(
      'twofold.arena_round_provisioning/v1', p_round_id::text
    ),
    p_round_id, v_round.season_id, v_round.round_index + 1,
    v_snapshot.snapshot_id, v_snapshot.target_session_date, v_available_at,
    p_recorded_by, v_available_at
  ) on conflict (source_round_id) do nothing;
end;
$$;

create or replace function public.enqueue_next_arena_round_provisioning()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
begin
  if new.phase = 'FINALIZE_ACCEPTED_TARGET_CYCLE'
    and new.status = 'SUCCEEDED' and old.status <> 'SUCCEEDED'
  then
    perform public.try_enqueue_next_arena_round(new.round_id, new.recorded_by);
  end if;
  return new;
end;
$$;

create or replace function public.commit_arena_no_trade_recovery(
  p_recovery_id uuid,
  p_lease_token uuid,
  p_valuation_canonical_json text,
  p_completed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_request public.arena_no_trade_recovery%rowtype;
  v_entry public.arena_round_entry%rowtype;
  v_round public.arena_round%rowtype;
  v_source_work public.arena_work_item%rowtype;
  v_close public.arena_round_close_snapshot%rowtype;
  v_snapshot public.market_snapshot%rowtype;
  v_account public.strategy_account%rowtype;
  v_head public.strategy_ledger_head%rowtype;
  v_rulebook public.arena_execution_rulebook%rowtype;
  v_existing_valuation public.arena_valuation%rowtype;
  v_valuation jsonb;
  v_valuation_result jsonb;
  v_portfolio jsonb;
  v_position_market_value numeric;
  v_fingerprint text;
  v_result jsonb;
  v_completed_by text;
begin
  if p_recovery_id is null or p_lease_token is null
    or p_valuation_canonical_json is null or p_valuation_canonical_json = ''
    or p_valuation_canonical_json is distinct from btrim(p_valuation_canonical_json)
    or p_completed_at is null
  then
    raise exception 'invalid Arena no-trade recovery commit'
      using errcode = '22023';
  end if;
  v_fingerprint := encode(extensions.digest(convert_to(
    p_recovery_id::text || chr(31) || p_lease_token::text || chr(31)
      || p_valuation_canonical_json || chr(31)
      || to_char(p_completed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'UTF8'
  ), 'sha256'), 'hex');
  select * into v_request from public.arena_no_trade_recovery
   where recovery_id = p_recovery_id for update;
  if found and v_request.status = 'SUCCEEDED' then
    if v_request.completion_fingerprint_sha256 = v_fingerprint then
      return public.arena_no_trade_recovery_result(v_request);
    end if;
    raise exception 'Arena no-trade recovery identity was reused with different content'
      using errcode = '23505';
  end if;
  select * into v_entry from public.arena_round_entry
   where round_entry_id = v_request.round_entry_id;
  select * into v_round from public.arena_round
   where round_id = v_request.round_id;
  select * into v_source_work from public.arena_work_item
   where work_item_id = v_request.source_work_item_id;
  select * into v_close from public.arena_round_close_snapshot
   where round_id = v_request.round_id and stage = 'S2_CLOSE';
  select * into v_snapshot from public.market_snapshot
   where snapshot_id = v_close.snapshot_id;
  select * into v_account from public.strategy_account
   where run_id = v_request.run_id and live_trading is false;
  select * into v_head from public.strategy_ledger_head
   where strategy_account_id = v_account.strategy_account_id;
  select * into v_rulebook from public.arena_execution_rulebook
   where season_id = v_request.season_id;
  select * into v_existing_valuation from public.arena_valuation
   where round_entry_id = v_request.round_entry_id and stage = 'S2_CLOSE';
  if v_request.recovery_id is null or v_entry.round_entry_id is null
    or v_round.round_id is null or v_source_work.work_item_id is null
    or v_close.snapshot_id is null or v_snapshot.snapshot_id is null
    or v_account.strategy_account_id is null or v_head.strategy_account_id is null
    or v_rulebook.rulebook_id is null
    or v_request.status <> 'CLAIMED'
    or v_request.lease_token is distinct from p_lease_token
    or p_completed_at < v_request.claimed_at
    or p_completed_at > v_request.lease_expires_at
    or v_source_work.status not in ('FAILED', 'CANCELED')
    or v_source_work.round_entry_id is distinct from v_request.round_entry_id
    or v_source_work.round_id is distinct from v_request.round_id
    or v_source_work.season_id is distinct from v_request.season_id
    or v_source_work.entrant_id is distinct from v_request.entrant_id
    or v_source_work.run_id is distinct from v_request.run_id
    or v_source_work.phase is distinct from (case v_request.reason_code
      when 'DECISION_UNAVAILABLE' then 'RUN_AGENT_DECISION'
      when 'S1_PLAN_UNAVAILABLE' then 'PREPARE_S1_ORDERS'
      when 'S1_CHECKPOINT_UNAVAILABLE' then 'SETTLE_S1_AND_PREPARE_S2'
      when 'FINALIZATION_UNAVAILABLE' then 'FINALIZE_ACCEPTED_TARGET_CYCLE'
    end)
  then
    raise exception 'Arena no-trade recovery lease or evidence is invalid'
      using errcode = '40001';
  end if;
  v_completed_by := v_request.claimed_by;
  if v_existing_valuation.valuation_id is not null then
    v_valuation_result := public.arena_valuation_result(v_existing_valuation);
    v_result := jsonb_build_object(
      'outcome', 'EXISTING_S2_VALUATION',
      'reasonCode', v_request.reason_code,
      'valuationId', v_existing_valuation.valuation_id::text,
      'ledgerSequence', v_existing_valuation.ledger_sequence::text,
      'ledgerSha256', v_existing_valuation.ledger_sha256
    );
  else
    begin
      v_valuation := p_valuation_canonical_json::jsonb;
    exception when others then
      raise exception 'Arena no-trade valuation is invalid JSON'
        using errcode = '22023';
    end;
    v_portfolio := public.get_strategy_portfolio_state(v_request.run_id);
    select coalesce(sum(
      (position.value->>'quantity')::numeric * fact.close_price::numeric
    ), 0) into v_position_market_value
      from jsonb_array_elements(v_portfolio->'positions') as position(value)
      join public.market_snapshot_member as member
        on member.snapshot_id = v_snapshot.snapshot_id
       and member.symbol = position.value->>'symbol'
      join public.market_bar_fact as fact on fact.fact_id = member.fact_id;
    if jsonb_typeof(v_valuation) <> 'object'
      or public.jsonb_contains_number(v_valuation)
      or v_snapshot.target_session_date <> v_round.s2_session_date
      or v_valuation->>'ledgerSequence' <> v_head.head_sequence::text
      or v_valuation->>'ledgerSha256' <> v_head.head_sha256
      or v_valuation->>'portfolioAsOf' <> to_char(
        v_head.updated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
      or v_valuation->>'valuationAt' <> to_char(
        greatest(v_snapshot.sealed_at, v_head.updated_at) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
      or v_valuation->>'valuationDate' <> v_round.s2_session_date::text
      or v_valuation->>'settledCash' <> v_portfolio#>>'{cash,settled}'
      or v_valuation->>'taxReserve' <> v_portfolio#>>'{cash,taxReserve}'
      or v_valuation->>'positionMarketValue'
        <> public.accounting_decimal_text(v_position_market_value)
      or v_valuation->'feeScheduleIds'
        <> jsonb_build_array(v_rulebook.rulebook->>'feeScheduleId')
      or exists (
        select 1 from jsonb_array_elements(v_portfolio->'positions') as p(value)
         where not exists (
           select 1 from public.market_snapshot_member as member
            where member.snapshot_id = v_snapshot.snapshot_id
              and member.symbol = p.value->>'symbol'
         )
      )
      or exists (
        select 1 from public.accepted_target_cycle as cycle
         where cycle.decision_id = v_entry.decision_id
      )
    then
      raise exception 'Arena no-trade valuation diverges from unchanged ledger or S2 evidence'
        using errcode = '22023';
    end if;
    if exists (
      select 1 from public.arena_work_item
       where round_entry_id = v_request.round_entry_id
         and phase in (
           'RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS',
           'SETTLE_S1_AND_PREPARE_S2', 'FINALIZE_ACCEPTED_TARGET_CYCLE'
         ) and status = 'CLAIMED'
    ) then
      raise exception 'Arena entrant still has active local work'
        using errcode = '40001';
    end if;
    perform set_config('twofold.arena_work_item_mutation', 'on', true);
    update public.arena_work_item
       set status = 'CANCELED', completed_at = p_completed_at,
           completion_fingerprint_sha256 = null,
           result = jsonb_build_object('outcome', 'NO_TRADE_CARRY_FORWARD'),
           error_code = 'NO_TRADE_CARRY_FORWARD',
           error_message = 'Entrant ledger carried forward after terminal local work',
           retryable = false
     where round_entry_id = v_request.round_entry_id
       and phase in (
         'RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS',
         'SETTLE_S1_AND_PREPARE_S2', 'FINALIZE_ACCEPTED_TARGET_CYCLE'
       ) and status = 'REQUESTED';
    perform set_config('twofold.arena_work_item_mutation', 'off', true);
    v_valuation_result := public.register_arena_valuation(
      'arena-no-trade:' || v_request.round_entry_id::text || ':valuation',
      v_request.round_entry_id, 'S2_CLOSE', v_snapshot.snapshot_id,
      p_valuation_canonical_json, v_completed_by
    );
    v_result := jsonb_build_object(
      'outcome', 'NO_TRADE_CARRY_FORWARD',
      'reasonCode', v_request.reason_code,
      'valuationId', v_valuation_result->>'valuationId',
      'ledgerSequence', v_head.head_sequence::text,
      'ledgerSha256', v_head.head_sha256
    );
  end if;
  perform set_config('twofold.arena_no_trade_recovery_mutation', 'on', true);
  update public.arena_no_trade_recovery
     set status = 'SUCCEEDED', claimed_by = null, lease_token = null,
         claimed_at = null, lease_expires_at = null,
         completed_at = p_completed_at,
         completion_fingerprint_sha256 = v_fingerprint,
         valuation_id = (v_valuation_result->>'valuationId')::uuid,
         result = v_result, error_code = null, error_message = null,
         retryable = false
   where recovery_id = p_recovery_id returning * into v_request;
  perform set_config('twofold.arena_no_trade_recovery_mutation', 'off', true);
  perform public.try_enqueue_next_arena_round(
    v_request.round_id, v_completed_by
  );
  return public.arena_no_trade_recovery_result(v_request);
end;
$$;

-- Backfill local failures that predate this migration and still lack an S2 score.
insert into public.arena_no_trade_recovery (
  recovery_id, round_entry_id, round_id, season_id, entrant_id, run_id,
  source_work_item_id, reason_code, scheduled_at, next_attempt_at, recorded_by
)
select public.deterministic_uuid_from_sha256(
         'twofold.arena_no_trade_recovery/v1', failure.round_entry_id::text),
       failure.round_entry_id, failure.round_id, failure.season_id,
       failure.entrant_id, failure.run_id, failure.work_item_id,
       failure.reason_code, round.cycle_ready_at, round.cycle_ready_at,
       failure.recorded_by
  from (
    select distinct on (item.round_entry_id)
      item.*,
      case item.phase
        when 'RUN_AGENT_DECISION' then 'DECISION_UNAVAILABLE'
        when 'PREPARE_S1_ORDERS' then 'S1_PLAN_UNAVAILABLE'
        when 'SETTLE_S1_AND_PREPARE_S2' then 'S1_CHECKPOINT_UNAVAILABLE'
        else 'FINALIZATION_UNAVAILABLE'
      end as reason_code
    from public.arena_work_item as item
    where item.status in ('FAILED', 'CANCELED')
      and item.phase in (
        'RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS',
        'SETTLE_S1_AND_PREPARE_S2', 'FINALIZE_ACCEPTED_TARGET_CYCLE'
      )
      and not exists (
        select 1 from public.arena_valuation as valuation
         where valuation.round_entry_id = item.round_entry_id
           and valuation.stage = 'S2_CLOSE'
      )
    order by item.round_entry_id,
      case item.phase
        when 'RUN_AGENT_DECISION' then 1
        when 'PREPARE_S1_ORDERS' then 2
        when 'SETTLE_S1_AND_PREPARE_S2' then 3
        else 4
      end,
      item.completed_at, item.work_item_id
  ) as failure
  join public.arena_round as round on round.round_id = failure.round_id
on conflict (round_entry_id) do nothing;

alter table public.arena_no_trade_recovery enable row level security;
revoke all on table public.arena_no_trade_recovery
  from public, anon, authenticated, service_role;
grant select on table public.arena_no_trade_recovery to service_role;

revoke all on function public.arena_no_trade_recovery_result(
  public.arena_no_trade_recovery
) from public, anon, authenticated;
revoke all on function public.enqueue_arena_no_trade_recovery()
  from public, anon, authenticated, service_role;
revoke all on function public.try_enqueue_next_arena_round(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_arena_no_trade_recovery(
  text, integer, timestamptz
) from public, anon, authenticated;
revoke all on function public.fail_arena_no_trade_recovery(
  uuid, uuid, timestamptz, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.commit_arena_no_trade_recovery(
  uuid, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_arena_no_trade_recovery(
  text, integer, timestamptz
) to service_role;
grant execute on function public.fail_arena_no_trade_recovery(
  uuid, uuid, timestamptz, text, text, boolean
) to service_role;
grant execute on function public.commit_arena_no_trade_recovery(
  uuid, uuid, text, timestamptz
) to service_role;

commit;
