-- Round 1 of private-us-liquid-100-s4 froze an S1 plan and then could not
-- carry it, and Round 2 never produced one at all. Underneath both is the same
-- confusion: the accounting kernel fenced planning on the UTC calendar day,
-- while the exchange fences it on the market session.
--
-- The two boundaries are not the same boundary. A Round publishes a decision
-- window that closes fifteen minutes before the S1 open, and 09:30 New York is
-- 13:30 UTC, so the last legal instant to accept a target is 13:15 UTC *on the
-- S1 session date* - already past UTC midnight. Every plan frozen in that
-- window was legal to the market and refused by
-- `register_frozen_order_plan`, which asked only whether the UTC day had
-- turned. A Round that landed there could never prepare its orders, and no
-- retry could ever help, because the calendar only moves the wrong way.
--
-- The Arena registration RPCs never had this problem: `register_arena_s1_plan`
-- and `register_arena_s1_checkpoint` fence on `arena_round.s1_open_at` and
-- `arena_round.s2_open_at`, which is the authoritative open for exactly that
-- Round. This migration brings the generic kernel onto the same boundary by
-- letting a caller that holds an exchange calendar name the official open of
-- the trade date it already declared.
--
-- Nothing is loosened by default. `p_trade_session_open_at` defaults to null,
-- and with null the two original checks stand byte-for-byte, including their
-- messages: the UTC proxy is strictly narrower than the session rule, so the
-- default can only ever refuse more. A named open is validated before it is
-- used and must fall on `p_planned_trade_date`, so a caller cannot widen the
-- fence by pointing at another session; the arrival check then still refuses
-- anything that reaches the database once that session has opened. Retries are
-- untouched - an existing binding is returned before any of these checks, so a
-- byte-identical replay stays recoverable after trade day.
--
-- The body is taken from the installed function and patched in place rather
-- than retyped, so every other rule it enforces is provably unchanged. Adding
-- a parameter cannot be done with `create or replace` without leaving a second
-- overload behind, which PostgREST would refuse to route, so the twelve-
-- argument form is dropped and its grants re-applied to the new signature.

begin;

do $migrate$
declare
  v_target regprocedure := 'public.register_frozen_order_plan('
    || 'text, uuid, uuid, uuid, uuid, text, timestamptz, date, text, text,'
    || ' text, text)';
  v_source text;
  v_old text := $fence_old$  -- Temporary fail-closed UTC boundary until an exchange calendar and market
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
$fence_old$;
  v_new text := $fence_new$  -- The market session, not the UTC calendar day, decides whether a plan is
  -- late. A caller holding an exchange calendar names the official open of the
  -- planned trade date and is fenced on that instant; the Arena registration
  -- RPCs already fence on arena_round.s1_open_at / s2_open_at, so this is the
  -- same boundary reached from the kernel. With no instant the older UTC proxy
  -- stands unchanged, and it is strictly narrower, so the default can only
  -- refuse more. Both forms apply only to a genuinely new insert: a
  -- byte-identical retry must remain recoverable after trade day if the
  -- original successful response was lost.
  --
  -- The named open is checked before it is used, so the widest window a caller
  -- can claim is the trade date it had already declared.
  if p_trade_session_open_at is not null
    and (p_trade_session_open_at at time zone 'UTC')::date
      is distinct from p_planned_trade_date
  then
    raise exception
      'frozen order plan trade session open must fall on its planned trade date'
      using errcode = '22023';
  end if;

  if p_trade_session_open_at is null then
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
  else
    if v_arrival_at >= p_trade_session_open_at then
      raise exception
        'frozen order plan admission has already reached its trade session open'
        using errcode = '22023';
    end if;

    -- Defence in depth: the arrival fence above and the planned_at-versus-
    -- arrival fence below already imply this, because a plan cannot be frozen
    -- after it arrives. It is stated anyway, where a reader looks for it.
    if p_planned_at >= p_trade_session_open_at then
      raise exception
        'frozen order plan must be recorded before its trade session open'
        using errcode = '22023';
    end if;
  end if;
$fence_new$;
begin
  select prosrc into strict v_source from pg_proc where oid = v_target;
  if position(v_old in v_source) = 0 then
    raise exception 'could not locate the frozen order plan UTC planning fence'
      using errcode = '55000';
  end if;
  v_source := replace(v_source, v_old, v_new);

  execute 'drop function public.register_frozen_order_plan('
    || 'text, uuid, uuid, uuid, uuid, text, timestamptz, date, text, text,'
    || ' text, text)';
  execute format(
    $create$
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
  p_recorded_by text,
  p_trade_session_open_at timestamptz default null
)
returns public.frozen_order_plan
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as %L
$create$,
    v_source
  );
end;
$migrate$;

revoke all on function public.register_frozen_order_plan(
  text, uuid, uuid, uuid, uuid, text, timestamptz, date, text, text, text,
  text, timestamptz
) from public, anon, authenticated;
grant execute on function public.register_frozen_order_plan(
  text, uuid, uuid, uuid, uuid, text, timestamptz, date, text, text, text,
  text, timestamptz
) to service_role;

comment on function public.register_frozen_order_plan(
  text, uuid, uuid, uuid, uuid, text, timestamptz, date, text, text, text,
  text, timestamptz
) is
  'Admits one immutable frozen order plan under the trusted database clock. p_trade_session_open_at names the official open of p_planned_trade_date and fences planning on that market session; omitted, the narrower UTC trade-date proxy applies unchanged. A byte-identical retry stays recoverable after trade day.';

commit;
