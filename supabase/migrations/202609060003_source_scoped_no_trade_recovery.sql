-- Keep distinct terminal phase sources without rewriting legacy recovery evidence.
begin;

alter table public.arena_no_trade_recovery
  drop constraint arena_no_trade_recovery_round_entry_id_key,
  drop constraint arena_no_trade_recovery_id_deterministic;
alter table public.arena_no_trade_recovery
  add constraint arena_no_trade_recovery_id_deterministic check (
    recovery_id = public.deterministic_uuid_from_sha256(
      'twofold.arena_no_trade_recovery/v1', round_entry_id::text
    ) or recovery_id = public.deterministic_uuid_from_sha256(
      'twofold.arena_no_trade_recovery_source/v1',
      round_entry_id::text || ':' || source_work_item_id::text
    )
  );
create index arena_no_trade_recovery_entry_history_idx
  on public.arena_no_trade_recovery(round_entry_id, recorded_at desc, recovery_id);
create unique index arena_no_trade_recovery_one_live_lease
  on public.arena_no_trade_recovery(round_entry_id) where status = 'CLAIMED';

-- Existing source uniqueness and immutable-identity triggers stay in place.
do $enqueue$
declare
  definition text;
  old_identity constant text := $old$'twofold.arena_no_trade_recovery/v1', new.round_entry_id::text$old$;
begin
  definition := pg_get_functiondef('public.enqueue_arena_no_trade_recovery()'::regprocedure);
  if strpos(definition, old_identity) = 0
    or strpos(definition, 'on conflict (round_entry_id) do nothing') = 0
    or strpos(definition, 'or new.error_code = ''CORPORATE_ACTION_GATE_BLOCKED''') = 0
  then
    raise exception 'recovery enqueue definition changed unexpectedly';
  end if;
  definition := replace(definition, old_identity,
    $new$'twofold.arena_no_trade_recovery_source/v1',
      new.round_entry_id::text || ':' || new.work_item_id::text$new$);
  definition := replace(definition, 'on conflict (round_entry_id) do nothing',
    'on conflict (source_work_item_id) do nothing');
  definition := replace(definition, 'or new.error_code = ''CORPORATE_ACTION_GATE_BLOCKED''',
    'or new.error_code in (''CORPORATE_ACTION_GATE_BLOCKED'', ''NO_TRADE_CARRY_FORWARD'')');
  execute definition;
end;
$enqueue$;

-- Serialize the short claim transaction (nonblocking); retain skip-locked row
-- selection and enforce one live lease per entry even with multiple histories.
do $claim$
declare
  definition text;
  mutation constant text := $old$  perform set_config('twofold.arena_no_trade_recovery_mutation', 'on', true);$old$;
  eligibility constant text := $old$     and request.scheduled_at <= p_now$old$;
begin
  definition := pg_get_functiondef('public.claim_arena_no_trade_recovery(text,integer,timestamptz)'::regprocedure);
  if strpos(definition, mutation) = 0 or strpos(definition, eligibility) = 0 then
    raise exception 'recovery claim definition changed unexpectedly';
  end if;
  definition := replace(definition, mutation, $new$  if not pg_try_advisory_xact_lock(hashtextextended('arena-no-trade-claim', 0)) then
    return null;
  end if;
$new$ || mutation);
  definition := replace(definition, eligibility, eligibility || $new$
     and not exists (
       select 1 from public.arena_no_trade_recovery as active
        where active.round_entry_id = request.round_entry_id
          and active.status = 'CLAIMED'
     )$new$);
  if strpos(definition, 'request.entrant_id') = 0 then
    raise exception 'recovery claim ordering changed unexpectedly';
  end if;
  definition := replace(definition, 'request.entrant_id',
    'request.entrant_id, request.recorded_at, request.recovery_id');
  execute definition;
end;
$claim$;

-- Preserve exactly one overview entrant, selecting successful/active recovery
-- first, then current terminal sources, then fenced history for audit visibility.
do $overview$
declare
  definition text;
  old_join constant text := $old$  left join public.arena_no_trade_recovery as recovery
    on recovery.round_entry_id = nullif(
      entrant.value->>'roundEntryId', ''
    )::uuid$old$;
  new_join constant text := $new$  left join lateral (
    select history.*
      from public.arena_no_trade_recovery as history
      join public.arena_work_item as source
        on source.work_item_id = history.source_work_item_id
     where history.round_entry_id = nullif(entrant.value->>'roundEntryId', '')::uuid
     order by case
       when history.status = 'SUCCEEDED' then 0
       when history.status = 'CLAIMED' then 1
       when source.status in ('FAILED', 'CANCELED') then 2
       else 3 end,
       history.recorded_at desc, history.recovery_id
     limit 1
  ) as recovery on true$new$;
begin
  definition := pg_get_functiondef('public.get_private_arena_overview(uuid,timestamptz)'::regprocedure);
  if strpos(definition, old_join) = 0 then
    raise exception 'recovery overview join changed unexpectedly';
  end if;
  execute replace(definition, old_join, new_join);
end;
$overview$;

-- Append only sources the old per-entry uniqueness could have suppressed.
-- Retired Seasons, finished economic outcomes, synthetic carry-forward
-- cancellations, and unsupported corporate-action gates are excluded.
insert into public.arena_no_trade_recovery (
  recovery_id, round_entry_id, round_id, season_id, entrant_id, run_id,
  source_work_item_id, reason_code, scheduled_at, next_attempt_at, recorded_by
)
select public.deterministic_uuid_from_sha256(
    'twofold.arena_no_trade_recovery_source/v1',
    source.round_entry_id::text || ':' || source.work_item_id::text
  ),
  source.round_entry_id, source.round_id, source.season_id, source.entrant_id,
  source.run_id, source.work_item_id,
  case source.phase
    when 'RUN_AGENT_DECISION' then 'DECISION_UNAVAILABLE'
    when 'PREPARE_S1_ORDERS' then 'S1_PLAN_UNAVAILABLE'
    when 'SETTLE_S1_AND_PREPARE_S2' then 'S1_CHECKPOINT_UNAVAILABLE'
    else 'FINALIZATION_UNAVAILABLE'
  end,
  round.cycle_ready_at, round.cycle_ready_at, 'migration:202609060003'
from public.arena_work_item as source
join public.arena_round as round on round.round_id = source.round_id
where source.status in ('FAILED', 'CANCELED')
  and source.phase in ('RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS',
    'SETTLE_S1_AND_PREPARE_S2', 'FINALIZE_ACCEPTED_TARGET_CYCLE')
  and coalesce(source.error_code, '') not in ('CORPORATE_ACTION_GATE_BLOCKED', 'NO_TRADE_CARRY_FORWARD')
  and not exists (
    select 1 from public.arena_season_retirement as retirement
     where retirement.season_id = source.season_id
  )
  and not exists (
    select 1 from public.arena_no_trade_recovery as history
     where history.source_work_item_id = source.work_item_id
  )
  and not exists (
    select 1 from public.arena_valuation as valuation
     where valuation.round_entry_id = source.round_entry_id and valuation.stage = 'S2_CLOSE'
  )
on conflict (source_work_item_id) do nothing;

comment on table public.arena_no_trade_recovery is
  'One immutable recovery source per terminal work item; legacy identities retained, independent retry histories, at most one live lease per entry.';
commit;
