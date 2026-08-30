begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(12);

select has_column(
  'public', 'market_open_reference_fact', 'observed_volume',
  'first-minute facts can retain canonical whole-share volume'
);
select ok(exists (
  select 1 from pg_constraint
   where conrelid = 'public.market_open_reference_fact'::regclass
     and conname = 'market_open_reference_fact_observed_volume_check'
), 'whole-share volume has a database check constraint');
select ok(exists (
  select 1 from pg_constraint
   where conrelid = 'public.market_open_reference_snapshot'::regclass
     and conname = 'market_open_reference_snapshot_method_check'
     and pg_get_constraintdef(oid)
       like '%ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE%'
), 'open snapshots admit the versioned VWAP and volume method');
select ok(exists (
  select 1 from pg_constraint
   where conrelid = 'public.arena_execution_rulebook'::regclass
     and conname = 'arena_execution_rulebook_rulebook_schema_check'
     and pg_get_constraintdef(oid)
       like '%twofold.arena_execution_rulebook/v2%'
), 'Season rulebooks admit the participation-capped v2 policy');
select ok(
  has_function_privilege('service_role',
    'public.register_arena_execution_rulebook(text,uuid,text,text,text)',
    'EXECUTE'),
  'the private Worker can register a v2 rulebook'
);
select ok(
  has_function_privilege('service_role',
    'public.register_arena_round_open_reference(text,uuid,text,uuid,text,text,bigint,text,text,text)',
    'EXECUTE'),
  'the private Worker can register shared VWAP and volume evidence'
);
select ok(
  not has_function_privilege('anon',
    'public.get_arena_round_open_reference(uuid,text)', 'EXECUTE'),
  'anonymous callers cannot inspect private execution evidence'
);

set local role service_role;

select public.register_arena_season(
  'pgtap:volume-participation:season',
  'f0500000-0000-4000-8000-000000000001'::uuid,
  'pgtap-volume-participation',
  'pgTAP volume participation',
  '2027-01-01T00:00:00.000Z'::timestamptz,
  '2027-02-01T00:00:00.000Z'::timestamptz,
  'US_EQUITY_DAILY_AFTER_CLOSE',
  'America/New_York',
  '{}'::jsonb,
  'pgtap'
);

select is(
  (public.register_arena_execution_rulebook(
    'pgtap:volume-participation:rulebook',
    'f0500000-0000-4000-8000-000000000001'::uuid,
    '{"executionModel":"SIMULATED_MINUTE_PARTICIPATION","feeScheduleId":"futu_hk_us_equity_fixed_2026-08-23","fillPriceScale":"8","maxParticipationBps":"100","openReferenceMethod":"ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE","rankingNav":"LIQUIDATION_NAV","schema":"twofold.arena_execution_rulebook/v2","slippageBps":"5","taxAllocationScale":"12","taxRulesetId":"cn_resident_direct_foreign_securities_strict_v1"}',
    encode(extensions.digest(convert_to(
      '{"executionModel":"SIMULATED_MINUTE_PARTICIPATION","feeScheduleId":"futu_hk_us_equity_fixed_2026-08-23","fillPriceScale":"8","maxParticipationBps":"100","openReferenceMethod":"ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE","rankingNav":"LIQUIDATION_NAV","schema":"twofold.arena_execution_rulebook/v2","slippageBps":"5","taxAllocationScale":"12","taxRulesetId":"cn_resident_direct_foreign_securities_strict_v1"}',
      'UTF8'
    ), 'sha256'), 'hex'),
    'pgtap'
  )#>>'{rulebook,maxParticipationBps}'),
  '100',
  'v2 freezes the participation cap as an exact string'
);
select is(
  (select rulebook_schema from public.arena_execution_rulebook
    where season_id = 'f0500000-0000-4000-8000-000000000001'::uuid),
  'twofold.arena_execution_rulebook/v2',
  'the durable rulebook records its policy schema'
);
select is(
  (public.register_arena_execution_rulebook(
    'pgtap:volume-participation:rulebook',
    'f0500000-0000-4000-8000-000000000001'::uuid,
    '{"executionModel":"SIMULATED_MINUTE_PARTICIPATION","feeScheduleId":"futu_hk_us_equity_fixed_2026-08-23","fillPriceScale":"8","maxParticipationBps":"100","openReferenceMethod":"ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE","rankingNav":"LIQUIDATION_NAV","schema":"twofold.arena_execution_rulebook/v2","slippageBps":"5","taxAllocationScale":"12","taxRulesetId":"cn_resident_direct_foreign_securities_strict_v1"}',
    encode(extensions.digest(convert_to(
      '{"executionModel":"SIMULATED_MINUTE_PARTICIPATION","feeScheduleId":"futu_hk_us_equity_fixed_2026-08-23","fillPriceScale":"8","maxParticipationBps":"100","openReferenceMethod":"ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE","rankingNav":"LIQUIDATION_NAV","schema":"twofold.arena_execution_rulebook/v2","slippageBps":"5","taxAllocationScale":"12","taxRulesetId":"cn_resident_direct_foreign_securities_strict_v1"}',
      'UTF8'
    ), 'sha256'), 'hex'),
    'pgtap'
  )->>'seasonId'),
  'f0500000-0000-4000-8000-000000000001',
  'an exact v2 retry is idempotent'
);
select throws_ok(
  $$select public.register_arena_execution_rulebook(
    'pgtap:volume-participation:missing-cap',
    'f0500000-0000-4000-8000-000000000001'::uuid,
    '{"executionModel":"SIMULATED_MINUTE_PARTICIPATION","feeScheduleId":"futu_hk_us_equity_fixed_2026-08-23","fillPriceScale":"8","openReferenceMethod":"ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE","rankingNav":"LIQUIDATION_NAV","schema":"twofold.arena_execution_rulebook/v2","slippageBps":"5","taxAllocationScale":"12","taxRulesetId":"cn_resident_direct_foreign_securities_strict_v1"}',
    repeat('0',64), 'pgtap'
  )$$,
  '22023', null,
  'v2 cannot omit its participation cap'
);
select throws_ok(
  $$select public.register_arena_execution_rulebook(
    'pgtap:volume-participation:numeric-cap',
    'f0500000-0000-4000-8000-000000000001'::uuid,
    '{"executionModel":"SIMULATED_MINUTE_PARTICIPATION","feeScheduleId":"futu_hk_us_equity_fixed_2026-08-23","fillPriceScale":"8","maxParticipationBps":100,"openReferenceMethod":"ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE","rankingNav":"LIQUIDATION_NAV","schema":"twofold.arena_execution_rulebook/v2","slippageBps":"5","taxAllocationScale":"12","taxRulesetId":"cn_resident_direct_foreign_securities_strict_v1"}',
    repeat('0',64), 'pgtap'
  )$$,
  '22023', null,
  'v2 rejects JSON numeric tokens'
);

reset role;
select * from finish();
rollback;
