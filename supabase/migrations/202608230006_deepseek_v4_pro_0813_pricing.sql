begin;

-- Season-frozen USD rate card captured from DeepSeek's official pricing page
-- for DeepSeek-V4-Pro-0813. The provider publishes no cache-write bucket;
-- cache writes therefore use the conservative cache-miss rate. The current
-- adapter reports zero cache-write tokens, but the rate remains explicit so a
-- future adapter change cannot silently make writes free.
select public.register_model_pricing(
  p_idempotency_key =>
    'pricing:deepseek-official:deepseek-v4-pro-0813:2026-08-23:off-peak:usd:v1',
  p_provider => 'deepseek-official',
  p_model => 'deepseek-v4-pro',
  p_pricing_version =>
    'deepseek-v4-pro-0813-usd-2026-08-23-freeze-v1',
  p_pricing_band => 'off-peak',
  p_selection_rule => 'deepseek-weekday-utc-v1',
  p_currency => 'USD',
  p_unit_tokens => 1000000,
  p_uncached_input_rate => 0.66,
  p_cache_read_rate => 0.022,
  p_cache_write_rate => 0.66,
  p_output_rate => 1.98,
  p_effective_from => '2026-08-23T00:00:00Z',
  p_source_url => 'https://api-docs.deepseek.com/quick_start/pricing/',
  p_recorded_by => 'migration:202608230006'
);

select public.register_model_pricing(
  p_idempotency_key =>
    'pricing:deepseek-official:deepseek-v4-pro-0813:2026-08-23:peak:usd:v1',
  p_provider => 'deepseek-official',
  p_model => 'deepseek-v4-pro',
  p_pricing_version =>
    'deepseek-v4-pro-0813-usd-2026-08-23-freeze-v1',
  p_pricing_band => 'peak',
  p_selection_rule => 'deepseek-weekday-utc-v1',
  p_currency => 'USD',
  p_unit_tokens => 1000000,
  p_uncached_input_rate => 1.32,
  p_cache_read_rate => 0.044,
  p_cache_write_rate => 1.32,
  p_output_rate => 3.96,
  p_effective_from => '2026-08-23T00:00:00Z',
  p_source_url => 'https://api-docs.deepseek.com/quick_start/pricing/',
  p_recorded_by => 'migration:202608230006'
);

commit;
