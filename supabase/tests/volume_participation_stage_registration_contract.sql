begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(10);

select ok(
  to_regprocedure(
    'public.register_arena_s1_plan_v2(text,uuid,bigint,text,text,text,text,text,text)'
  ) is not null,
  'v2 has a dedicated S1 freeze boundary'
);
select ok(
  to_regprocedure(
    'public.register_arena_s1_checkpoint_v2(text,uuid,bigint,text,text,text,text,text,text)'
  ) is not null,
  'v2 has a dedicated checkpoint and S2 freeze boundary'
);
select ok(
  to_regprocedure('public.arena_v2_engine_plan(jsonb,text,text)') is not null,
  'both v2 stages share one exact plan validator'
);
select ok(
  has_function_privilege('service_role',
    'public.register_arena_s1_plan_v2(text,uuid,bigint,text,text,text,text,text,text)',
    'EXECUTE'),
  'the private Worker can freeze v2 S1 plans'
);
select ok(
  has_function_privilege('service_role',
    'public.register_arena_s1_checkpoint_v2(text,uuid,bigint,text,text,text,text,text,text)',
    'EXECUTE'),
  'the private Worker can freeze v2 checkpoints'
);
select ok(
  not has_function_privilege('anon',
    'public.register_arena_s1_plan_v2(text,uuid,bigint,text,text,text,text,text,text)',
    'EXECUTE'),
  'anonymous callers cannot freeze v2 plans'
);
select ok(
  not has_function_privilege('anon',
    'public.register_arena_s1_checkpoint_v2(text,uuid,bigint,text,text,text,text,text,text)',
    'EXECUTE'),
  'anonymous callers cannot publish v2 checkpoints'
);

create temporary table v2_s1_engine on commit drop as
select '{"decisionId":"a","executionModel":"SIMULATED_MINUTE_PARTICIPATION","fillPriceScale":"8","maxParticipationBps":"100","orders":[],"schema":"twofold.frozen_order_plan/v1","slippageBps":"5","stage":"S1","taxAllocationScale":"12","taxRulesetId":"cn_resident_direct_foreign_securities_strict_v1"}'::text
  as canonical_json;
create temporary table v2_s1_wrapper on commit drop as
select jsonb_build_object(
  'manifestSchema', 'twofold.frozen_order_plan/v1',
  'runId', 'r',
  'decisionId', 'a',
  'acceptedSubmissionId', 's',
  'stage', 'S1',
  'plannedAt', '2027-01-01T00:00:00.000Z',
  'plannedTradeDate', '2027-01-02',
  'executionModel', 'SIMULATED_MINUTE_PARTICIPATION',
  'slippageBps', '5',
  'maxParticipationBps', '100',
  'fillPriceScale', '8',
  'enginePlanFingerprint', (select canonical_json from v2_s1_engine),
  'enginePlanFingerprintSha256', encode(extensions.digest(convert_to(
    (select canonical_json from v2_s1_engine), 'UTF8'
  ), 'sha256'), 'hex'),
  'orders', '[]'::jsonb,
  'taxRulesetId', 'cn_resident_direct_foreign_securities_strict_v1',
  'taxAllocationScale', '12'
) as value;

select is(
  public.arena_v2_engine_plan(
    (select value from v2_s1_wrapper), 'S1', '100'
  )->>'maxParticipationBps',
  '100',
  'the plan validator preserves the exact frozen participation cap'
);
select throws_ok(
  $$select public.arena_v2_engine_plan(
    (select value from v2_s1_wrapper), 'S1', '101'
  )$$,
  '22023', null,
  'a caller cannot substitute a different participation cap'
);
select throws_ok(
  $$select public.arena_v2_engine_plan(
    jsonb_set(
      (select value from v2_s1_wrapper),
      '{executionModel}', '"SIMULATED_SLIPPAGE"'::jsonb
    ), 'S1', '100'
  )$$,
  '22023', null,
  'the v2 boundary rejects the legacy execution model'
);

select * from finish();
rollback;
