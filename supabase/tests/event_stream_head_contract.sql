-- Stable multi-Round stream-head contract. Every fixture rolls back.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(12);

select has_function(
  'public', 'get_event_stream_head', array['uuid', 'text'],
  'event streams expose one exact head reader'
);
select is(
  (select prosecdef from pg_proc
    where oid = 'public.get_event_stream_head(uuid,text)'::regprocedure),
  true,
  'stream-head read owns the private event-store boundary'
);
select ok(
  has_function_privilege(
    'service_role', 'public.get_event_stream_head(uuid,text)', 'EXECUTE'
  ),
  'service worker may reload a stream head'
);
select ok(
  not has_function_privilege(
    'anon', 'public.get_event_stream_head(uuid,text)', 'EXECUTE'
  ),
  'anonymous callers cannot enumerate private streams'
);

set local role service_role;
create temporary table empty_stream_head on commit drop as
select public.get_event_stream_head(
  'c1000000-0000-4000-8000-000000000001', 'run'
) as value;
reset role;

select is(
  (select value->>'sequence' from empty_stream_head), '0',
  'an unseen stable Run starts at sequence zero'
);
select is(
  (select value->>'lastEventId' from empty_stream_head), null,
  'an unseen stream has no fabricated last event'
);

set local role service_role;
select public.append_event(
  p_stream_id => 'c1000000-0000-4000-8000-000000000001',
  p_stream_type => 'run',
  p_expected_stream_seq => 0,
  p_event_type => 'contract.first',
  p_schema_version => '1',
  p_idempotency_key => 'event-stream-head-contract:first',
  p_actor_kind => 'worker',
  p_actor_id => 'event-stream-head-contract',
  p_event_time => '2026-08-29T00:00:00.000Z',
  p_payload => '{"value":"first"}',
  p_event_id => 'c2000000-0000-4000-8000-000000000001'
);
create temporary table populated_stream_head on commit drop as
select public.get_event_stream_head(
  'c1000000-0000-4000-8000-000000000001', 'run'
) as value;
reset role;

select is(
  (select value->>'schema' from populated_stream_head),
  'twofold.event_stream_head/v1',
  'stream-head schema is explicit and versioned'
);
select is(
  (select value->>'sequence' from populated_stream_head), '1',
  'the current CAS sequence is returned as a string'
);
select is(
  (select value->>'lastEventId' from populated_stream_head),
  'c2000000-0000-4000-8000-000000000001',
  'the current CAS event identity is exact'
);
select ok(
  not public.jsonb_contains_number(
    (select value from populated_stream_head)
  ),
  'stream-head output contains no JSON number tokens'
);

set local role service_role;
select throws_ok(
  $$select public.get_event_stream_head(
    'c1000000-0000-4000-8000-000000000001', 'season'
  )$$,
  '22023', 'stream already has a different type',
  'a stable stream cannot change type between Rounds'
);
reset role;

set local role anon;
select throws_ok(
  $$select public.get_event_stream_head(
    'c1000000-0000-4000-8000-000000000001', 'run'
  )$$,
  '42501', null,
  'anonymous callers cannot invoke the stream-head reader'
);
reset role;

select * from finish();
rollback;
