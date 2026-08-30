begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(10);

select ok(
  to_regclass('public.corporate_action_dividend_fx_reference') is not null,
  'cash dividends have one durable shared FX reference'
);
select ok(
  to_regprocedure(
    'public.get_corporate_action_dividend_fx_reference(uuid,uuid,text)'
  ) is not null,
  'the Worker can load one exact dividend FX reference'
);
select ok(
  to_regprocedure(
    'public.get_corporate_action_dividend_policy_material(uuid,uuid,text,uuid)'
  ) is not null,
  'instrument and provider tax facts cross a database-owned boundary'
);
select ok(
  to_regprocedure(
    'public.register_corporate_action_dividend_fx_reference(text,uuid,uuid,text,uuid,text,text,text,text,text)'
  ) is not null,
  'one exact ECB delivery can be frozen for a dividend revision'
);
select ok(exists (
  select 1 from pg_trigger
   where tgrelid = 'public.corporate_action_account_application'::regclass
     and tgname = 'corporate_action_application_dividend_policy_guard'
     and not tgisinternal
  ),
  'cash-dividend account commits are bound to the shared frozen policy'
);
select ok(
  has_function_privilege('service_role',
    'public.get_corporate_action_dividend_fx_reference(uuid,uuid,text)','EXECUTE'),
  'the private Worker can read shared dividend FX'
);
select ok(
  has_function_privilege('service_role',
    'public.get_corporate_action_dividend_policy_material(uuid,uuid,text,uuid)',
    'EXECUTE'),
  'the private Worker can read policy material'
);
select ok(
  not has_function_privilege('anon',
    'public.get_corporate_action_dividend_fx_reference(uuid,uuid,text)','EXECUTE'),
  'anonymous callers cannot inspect private dividend FX'
);
select ok(
  not has_function_privilege('anon',
    'public.get_corporate_action_dividend_policy_material(uuid,uuid,text,uuid)',
    'EXECUTE'),
  'anonymous callers cannot inspect private policy material'
);

set local role service_role;
select throws_ok(
  $$select public.get_corporate_action_dividend_policy_material(
    '11111111-1111-4111-8111-111111111111'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid,
    repeat('a',64),
    '33333333-3333-4333-8333-333333333333'::uuid
  )$$,
  '23503',null,
  'unknown policy identities fail closed instead of returning guessed defaults'
);
reset role;

select * from finish();
rollback;
