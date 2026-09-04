-- The public valuation contract serializes instants to milliseconds. Database
-- evidence may retain microseconds, so provenance ordering must compare at the
-- same published precision.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(5);

select has_function(
  'public', 'register_arena_valuation',
  array['text', 'uuid', 'text', 'uuid', 'text', 'text'],
  'Arena valuation registration remains available'
);
select ok(
  pg_get_functiondef(
    'public.register_arena_valuation(text,uuid,text,uuid,text,text)'::regprocedure
  ) like '%date_trunc(''milliseconds'', v_snapshot.sealed_at)%',
  'the provenance fence uses the published millisecond precision'
);
select ok(
  '2026-09-01T20:39:15.419Z'::timestamptz
    >= date_trunc('milliseconds',
      '2026-09-01T20:39:15.419546Z'::timestamptz),
  'a canonical RPC instant is not earlier than its equivalent sealed instant'
);
select ok(
  '2026-09-01T20:39:15.418Z'::timestamptz
    < date_trunc('milliseconds',
      '2026-09-01T20:39:15.419546Z'::timestamptz),
  'an actually earlier millisecond remains rejected'
);
select ok(has_function_privilege(
  'service_role',
  'public.register_arena_valuation(text,uuid,text,uuid,text,text)',
  'EXECUTE'
), 'the Worker keeps its valuation registration grant');

select * from finish();
rollback;
