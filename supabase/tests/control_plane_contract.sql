-- Keyless pgTAP contract tests. Run with `supabase test db` after starting the
-- local Supabase stack. The enclosing transaction leaves no durable fixtures.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(19);

select has_table('public', 'event_stream', 'event_stream exists');
select has_table('public', 'projection', 'projection exists');
select has_table('public', 'control_command', 'control_command exists');
select has_table(
  'public',
  'model_pricing_version',
  'model_pricing_version exists'
);
select has_table('public', 'model_usage_record', 'model_usage_record exists');

select is(
  (
    select count(*)
      from public.model_pricing_version
     where provider = 'deepseek-official'
       and model = 'deepseek-v4-pro'
       and pricing_version =
         'deepseek-v4-pro-0813-usd-2026-08-23-freeze-v1'
  ),
  2::bigint,
  'the frozen DeepSeek V4 Pro 0813 schedule contains exactly two bands'
);

select ok(
  exists (
    select 1
      from public.model_pricing_version
     where provider = 'deepseek-official'
       and model = 'deepseek-v4-pro'
       and pricing_version =
         'deepseek-v4-pro-0813-usd-2026-08-23-freeze-v1'
       and pricing_band = 'off-peak'
       and selection_rule = 'deepseek-weekday-utc-v1'
       and currency = 'USD'
       and unit_tokens = 1000000
       and uncached_input_rate = 0.66
       and cache_read_rate = 0.022
       and cache_write_rate = 0.66
       and output_rate = 1.98
       and effective_from = '2026-08-23T00:00:00Z'::timestamptz
       and effective_to is null
       and source_url =
         'https://api-docs.deepseek.com/quick_start/pricing/'
  ),
  'the frozen off-peak rate card matches the official USD schedule'
);

select ok(
  exists (
    select 1
      from public.model_pricing_version
     where provider = 'deepseek-official'
       and model = 'deepseek-v4-pro'
       and pricing_version =
         'deepseek-v4-pro-0813-usd-2026-08-23-freeze-v1'
       and pricing_band = 'peak'
       and selection_rule = 'deepseek-weekday-utc-v1'
       and currency = 'USD'
       and unit_tokens = 1000000
       and uncached_input_rate = 1.32
       and cache_read_rate = 0.044
       and cache_write_rate = 1.32
       and output_rate = 3.96
       and effective_from = '2026-08-23T00:00:00Z'::timestamptz
       and effective_to is null
       and source_url =
         'https://api-docs.deepseek.com/quick_start/pricing/'
  ),
  'the frozen peak rate card matches the official USD schedule'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

select is(
  (
    public.request_control_command(
      'test:auth-derived-requester',
      'freeze_config',
      'system',
      null,
      '{}'::jsonb,
      'spoofed-user-id'
    )
  ).requested_by,
  '10000000-0000-4000-8000-000000000001',
  'authenticated requested_by is derived from auth.uid()'
);

select is(
  (
    public.append_event(
      '20000000-0000-4000-8000-000000000001',
      'control',
      0,
      'control.command_requested',
      '1',
      'test:first-event',
      'system',
      'contract-test',
      '2026-08-23T00:00:00Z',
      '{"amount":"9007199254740993.00000001"}'::jsonb
    )
  ).stream_seq,
  1::bigint,
  'append_event assigns expected head plus one'
);

select is(
  (
    public.put_projection(
      'test.exact-retry',
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000001',
      0,
      1,
      (
        select event_id
          from public.event_stream
         where stream_id = '20000000-0000-4000-8000-000000000001'
           and stream_seq = 1
      ),
      '{"status":"READY"}'::jsonb,
      repeat('b', 64)
    )
  ).last_stream_seq,
  1::bigint,
  'put_projection commits the requested event-stream head'
);

select is(
  (
    public.put_projection(
      'test.exact-retry',
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000001',
      0,
      1,
      (
        select event_id
          from public.event_stream
         where stream_id = '20000000-0000-4000-8000-000000000001'
           and stream_seq = 1
      ),
      '{"status":"READY"}'::jsonb,
      repeat('b', 64)
    )
  ).last_event_id,
  (
    select event_id
      from public.event_stream
     where stream_id = '20000000-0000-4000-8000-000000000001'
       and stream_seq = 1
  ),
  'an exact put_projection retry returns the committed projection'
);

select throws_ok(
  $$
    select public.put_projection(
      'test.exact-retry',
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000001',
      0,
      1,
      (
        select event_id
          from public.event_stream
         where stream_id = '20000000-0000-4000-8000-000000000001'
           and stream_seq = 1
      ),
      '{"status":"DIFFERENT"}'::jsonb,
      repeat('c', 64)
    )
  $$,
  '23505',
  'projection exact retry content conflict for test.exact-retry/20000000-0000-4000-8000-000000000002 at stream sequence 1',
  'a same-sequence projection replay with different content fails closed'
);

select throws_ok(
  $$
    select public.append_event(
      '20000000-0000-4000-8000-000000000001',
      'control',
      0,
      'control.command_requested',
      '1',
      'test:conflicting-event',
      'system',
      'contract-test',
      '2026-08-23T00:00:01Z',
      '{}'::jsonb
    )
  $$,
  '40001',
  'stream head conflict for 20000000-0000-4000-8000-000000000001',
  'append_event fails closed on a stale expected sequence'
);

select is(
  (
    public.register_model_pricing(
      'test:deepseek-pricing-v1',
      'deepseek-official',
      'deepseek-v4-pro',
      'test-v1',
      'off-peak',
      'outside test peak windows',
      'USD',
      1000000,
      2,
      0.5,
      2.5,
      8,
      '2026-08-23T00:00:00Z',
      'https://example.invalid/test-rate-card',
      'contract-test'
    )
  ).pricing_version,
  'test-v1',
  'register_model_pricing stores an immutable versioned rate card'
);

select is(
  (
    public.register_model_usage(
      'test:model-usage:1',
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000003',
      'session-test-1',
      1,
      1,
      0,
      'deepseek-official',
      'deepseek-v4-pro',
      '2026-08-23T00:00:59Z',
      '2026-08-23T00:01:00Z',
      'captured',
      'assistant_message',
      1000,
      2000,
      300,
      400,
      250,
      'contract-test',
      null,
      (
        select pricing_id
          from public.model_pricing_version
         where idempotency_key = 'test:deepseek-pricing-v1'
      ),
      null,
      null,
      1001
    )
  ).estimated_cost,
  0.006950000000000000::numeric,
  'model usage cost is derived exactly without billing reasoning twice'
);

select is(
  (
    public.register_model_usage(
      'test:model-usage:unpriced',
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000004',
      'session-test-2',
      1,
      1,
      0,
      'deepseek-official',
      'deepseek-v4-pro',
      '2026-08-23T00:01:59Z',
      '2026-08-23T00:02:00Z',
      'captured',
      'stream_chunk_fallback',
      10,
      0,
      0,
      5,
      2,
      'contract-test',
      null,
      null,
      null,
      null,
      2001
    )
  ).cost_status,
  'unpriced',
  'captured token usage remains explicit when no rate card is available'
);

select is(
  (
    public.register_model_usage(
      'test:model-usage:unpriced',
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000004',
      'session-test-2',
      1,
      1,
      0,
      'deepseek-official',
      'deepseek-v4-pro',
      '2026-08-23T00:01:59Z',
      '2026-08-23T00:02:00Z',
      'captured',
      'stream_chunk_fallback',
      10,
      0,
      0,
      5,
      2,
      'contract-test',
      null,
      null,
      null,
      null,
      2001
    )
  ).usage_id,
  (
    select usage_id
      from public.model_usage_record
     where idempotency_key = 'test:model-usage:unpriced'
  ),
  'an exact model-usage retry returns the original immutable fact'
);

select is(
  (
    public.register_model_usage(
      'test:model-usage:attempt-1',
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000004',
      'session-test-2',
      1,
      1,
      1,
      'deepseek-official',
      'deepseek-v4-pro',
      '2026-08-23T00:02:01Z',
      '2026-08-23T00:02:02Z',
      'provider_unreported',
      'provider_unreported',
      null,
      null,
      null,
      null,
      null,
      'contract-test'
    )
  ).attempt_index,
  1::bigint,
  'a physical retry is a distinct immutable attempt in the same Harness step'
);

select * from finish();
rollback;
