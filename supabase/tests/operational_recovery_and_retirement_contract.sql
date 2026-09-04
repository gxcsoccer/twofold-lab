-- Structural and access contract for dependency-gated operational recovery.
-- Behavioral rearm/retirement paths are covered by the Round and Season
-- fixture contracts; this file stays safe against any pre-existing live data.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(24);

select has_table(
  'public', 'arena_no_trade_recovery_rearm',
  'no-trade rearm evidence is durable'
);
select has_table(
  'public', 'arena_season_retirement',
  'Season retirement evidence is durable'
);
select has_function(
  'public', 'rearm_failed_arena_no_trade_recovery',
  array['uuid', 'bigint', 'text', 'text', 'timestamp with time zone'],
  'exhausted no-trade recovery has an audited boundary'
);
select has_function(
  'public', 'retire_arena_season',
  array['uuid', 'text', 'text', 'timestamp with time zone'],
  'Season retirement has an audited boundary'
);
select has_function(
  'public', 'get_active_arena_season_symbols',
  array['timestamp with time zone'],
  'the Worker reads a retirement-aware symbol universe'
);

select ok(
  pg_get_functiondef(
    'public.claim_arena_no_trade_recovery(text,integer,timestamptz)'::regprocedure
  ) like '%arena_round_close_snapshot%',
  'claiming explicitly depends on immutable shared close evidence'
);
select ok(
  pg_get_functiondef(
    'public.claim_arena_no_trade_recovery(text,integer,timestamptz)'::regprocedure
  ) like '%binding.stage = ''S2_CLOSE''%',
  'only the S2 close binding releases no-trade work'
);
select ok(
  pg_get_functiondef(
    'public.claim_arena_no_trade_recovery(text,integer,timestamptz)'::regprocedure
  ) like '%source.status in (''FAILED'', ''CANCELED'')%',
  'a reopened source task fences its old no-trade request'
);
select ok(
  pg_get_functiondef(
    'public.claim_arena_no_trade_recovery(text,integer,timestamptz)'::regprocedure
  ) like '%accepted_target_submission%',
  'an accepted decision fences no-trade recovery'
);
select ok(
  pg_get_functiondef(
    'public.claim_arena_no_trade_recovery(text,integer,timestamptz)'::regprocedure
  ) like '%valuation.stage = ''S2_CLOSE''%',
  'an existing close valuation fences duplicate no-trade recovery'
);
select ok(
  pg_get_functiondef(
    'public.get_corporate_action_account_work(timestamptz)'::regprocedure
  ) like '%arena_season_retirement%',
  'corporate-action work excludes retired Seasons'
);
select ok(
  pg_get_functiondef(
    'public.get_arena_operational_health(text,timestamptz)'::regprocedure
  ) like '%CORPORATE_ACTION_POLICY_REQUIRED%',
  'unsupported policy is a stable explicit health alert'
);
select ok(
  pg_get_functiondef(
    'public.get_arena_operational_health(text,timestamptz)'::regprocedure
  ) like '%CORPORATE_ACTION_PREPARATION_MISSED%',
  'missed preparation is a stable explicit health alert'
);

select ok(exists (
  select 1 from pg_trigger
   where tgrelid = 'public.arena_no_trade_recovery_rearm'::regclass
     and tgname = 'arena_no_trade_recovery_rearm_is_immutable'
     and not tgisinternal
), 'no-trade rearm evidence is immutable');
select ok(exists (
  select 1 from pg_trigger
   where tgrelid = 'public.arena_season_retirement'::regclass
     and tgname = 'arena_season_retirement_is_immutable'
     and not tgisinternal
), 'Season retirement evidence is immutable');
select ok((
  select relrowsecurity
    from pg_class
   where oid = 'public.arena_no_trade_recovery_rearm'::regclass
), 'no-trade rearm evidence has row-level security enabled');
select ok((
  select relrowsecurity
    from pg_class
   where oid = 'public.arena_season_retirement'::regclass
), 'Season retirement evidence has row-level security enabled');

select ok(has_function_privilege(
  'service_role',
  'public.rearm_failed_arena_no_trade_recovery(uuid,bigint,text,text,timestamptz)',
  'EXECUTE'
), 'service role can invoke audited no-trade rearm');
select ok(not has_function_privilege(
  'anon',
  'public.rearm_failed_arena_no_trade_recovery(uuid,bigint,text,text,timestamptz)',
  'EXECUTE'
), 'anonymous callers cannot rearm recovery');
select ok(has_function_privilege(
  'service_role',
  'public.retire_arena_season(uuid,text,text,timestamptz)',
  'EXECUTE'
), 'service role can retire a Season');
select ok(not has_function_privilege(
  'anon',
  'public.retire_arena_season(uuid,text,text,timestamptz)',
  'EXECUTE'
), 'anonymous callers cannot retire a Season');
select ok(has_function_privilege(
  'service_role',
  'public.get_active_arena_season_symbols(timestamptz)',
  'EXECUTE'
), 'service role can load active symbols');
select ok(not has_function_privilege(
  'anon',
  'public.get_active_arena_season_symbols(timestamptz)',
  'EXECUTE'
), 'anonymous callers cannot inspect active symbols');

set local role service_role;
select ok(
  (public.get_active_arena_season_symbols(clock_timestamp())->>'schema')
    = 'twofold.active_arena_season_symbols/v1'
  and not public.jsonb_contains_number(
    public.get_active_arena_season_symbols(clock_timestamp())
  ),
  'active symbols return a versioned decimal-safe private contract'
);
reset role;

select * from finish();
rollback;
