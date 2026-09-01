-- Round 1 of private-us-liquid-100-s4 could not settle S1 even after its close
-- was captured, and the reason was structural. The corporate-action gate held
-- SETTLE_S1_AND_PREPARE_S2 behind every ex-date through s2_session_date, but
-- account preparation is exposed only from ex_open_at - 30 minutes, while the
-- S2 plan must be written before the S2 calendar date. For a Round whose S2
-- session carries an ex-date on a universe member, those two windows never
-- overlap.
--
-- A cash dividend changes no share count and its cash lands on the payable
-- date, so the S2 buy plan's arithmetic does not depend on it; evaluating it
-- through s1_session_date settles S1 honestly and leaves the entitlement
-- guarantee to FINALIZE_ACCEPTED_TARGET_CYCLE, which still evaluates through
-- s2_session_date and still requires the preparation. A split does change the
-- share counts a frozen plan is written in, so it keeps the wider horizon and
-- a split on the S2 session date remains a hard stop.
--
-- The deadline is deliberately left alone. Legality is decided by the sealed
-- evidence instant, not by queue completion: CAPTURE_S1_CLOSE persists the
-- shared close and disposition FX before its entrant-scoped item completes,
-- and every later item reuses those rows, so an item that completes after
-- midnight over evidence sealed before it is still legal. Expiring the queue
-- item at midnight would cancel exactly that case - a lost completion RPC, or
-- a sibling entrant not yet processed - and a cancelled prerequisite can never
-- be claimed again. The boundary belongs on the evidence, and is enforced in
-- the close handler, which now refuses to seal a close that could never carry
-- a legal S2 plan.

begin;

create or replace function public.arena_corporate_action_phase_is_clear(
  p_round_id uuid, p_phase text, p_as_of timestamptz
) returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_round public.arena_round%rowtype;
  v_season public.arena_season%rowtype;
  v_through_date date;
  v_dividend_through_date date;
begin
  if p_round_id is null or p_as_of is null
    or p_phase not in (
      'RUN_AGENT_DECISION','PREPARE_S1_ORDERS',
      'SETTLE_S1_AND_PREPARE_S2','FINALIZE_ACCEPTED_TARGET_CYCLE'
    ) then return false; end if;
  select * into v_round from public.arena_round where round_id = p_round_id;
  if not found then return false; end if;
  select * into v_season from public.arena_season where season_id = v_round.season_id;
  if not found then return false; end if;
  v_through_date := case p_phase
    when 'RUN_AGENT_DECISION' then v_round.decision_session_date
    when 'PREPARE_S1_ORDERS' then v_round.s1_session_date
    else v_round.s2_session_date end;
  v_dividend_through_date := case p_phase
    when 'SETTLE_S1_AND_PREPARE_S2' then v_round.s1_session_date
    else v_through_date end;

  if not exists (select 1 from public.corporate_action_scan
    where observed_at <= p_as_of
      and process_date_start <=
        (v_season.opens_at at time zone v_season.market_timezone)::date
      and process_date_end >= v_through_date)
  then return false; end if;

  return not exists (
    with latest as (
      select distinct on (revision.source_action_id) revision.*
        from public.corporate_action_scan_revision as observation
        join public.corporate_action_scan as scan on scan.scan_id = observation.scan_id
        join public.corporate_action_revision as revision
          on revision.source_action_id = observation.source_action_id
         and revision.revision_sha256 = observation.revision_sha256
       where scan.observed_at <= p_as_of
       order by revision.source_action_id,scan.observed_at desc,scan.scan_id desc
    ), relevant as (
      select revision.* from latest as revision
       where revision.ex_date <= case
           when revision.interpretation = 'CASH_DIVIDEND'
             then v_dividend_through_date
           else v_through_date end
         and revision.ex_date >=
           (v_season.opens_at at time zone v_season.market_timezone)::date
         and exists (
           select 1 from public.arena_round as round
           join public.market_snapshot as snapshot
             on snapshot.snapshot_id = round.decision_snapshot_id
          where round.season_id = v_season.season_id
            and revision.symbol = any(snapshot.symbols)
         )
    )
    select 1 from relevant as revision
     where revision.evidence_status <> 'COMPLETE'
        or revision.interpretation not in ('SPLIT','CASH_DIVIDEND')
        or (revision.interpretation = 'SPLIT' and (
          revision.normalized_action->>'oldRate' !~ '^[1-9][0-9]*$'
          or revision.normalized_action->>'newRate' !~ '^[1-9][0-9]*$'
        ))
        or (revision.interpretation = 'CASH_DIVIDEND' and (
          revision.normalized_action->>'foreign' <> 'false'
          or revision.normalized_action->>'special' <> 'false'
        ))
        or exists (
          select 1 from public.season_entrant as entrant
          join public.strategy_account as account on account.run_id = entrant.run_id
         where entrant.season_id = v_season.season_id
           and (
             not exists (
               select 1 from public.corporate_action_account_preparation as prep
                where prep.strategy_account_id = account.strategy_account_id
                  and prep.source_action_id = revision.source_action_id
                  and prep.revision_sha256 = revision.revision_sha256
             )
             or (
               revision.interpretation = 'SPLIT'
               and not exists (
                 select 1 from public.corporate_action_account_application as app
                  where app.strategy_account_id = account.strategy_account_id
                    and app.source_action_id = revision.source_action_id
                    and app.revision_sha256 = revision.revision_sha256
               )
             )
             or (
               revision.interpretation = 'CASH_DIVIDEND'
               and revision.payable_date <= v_dividend_through_date
               and not exists (
                 select 1 from public.corporate_action_account_application as app
                  where app.strategy_account_id = account.strategy_account_id
                    and app.source_action_id = revision.source_action_id
                    and app.revision_sha256 = revision.revision_sha256
               )
             )
           )
        )
  );
end;
$$;

commit;
