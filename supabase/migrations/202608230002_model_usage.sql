begin;

create table public.model_pricing_version (
  pricing_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key <> ''),
  provider text not null check (provider <> ''),
  model text not null check (model <> ''),
  pricing_version text not null check (pricing_version <> ''),
  pricing_band text not null check (pricing_band <> ''),
  selection_rule text not null check (selection_rule <> ''),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  unit_tokens bigint not null default 1000000 check (unit_tokens = 1000000),
  uncached_input_rate numeric not null check (
    uncached_input_rate::text not in ('NaN', 'Infinity', '-Infinity')
    and uncached_input_rate >= 0
  ),
  cache_read_rate numeric not null check (
    cache_read_rate::text not in ('NaN', 'Infinity', '-Infinity')
    and cache_read_rate >= 0
  ),
  cache_write_rate numeric not null check (
    cache_write_rate::text not in ('NaN', 'Infinity', '-Infinity')
    and cache_write_rate >= 0
  ),
  output_rate numeric not null check (
    output_rate::text not in ('NaN', 'Infinity', '-Infinity')
    and output_rate >= 0
  ),
  effective_from timestamptz not null,
  effective_to timestamptz,
  source_url text not null check (source_url <> ''),
  source_artifact_id uuid references public.artifact_metadata(artifact_id),
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint model_pricing_version_identity_unique
    unique (provider, model, pricing_version, pricing_band),
  constraint model_pricing_version_effective_window check (
    effective_to is null or effective_to > effective_from
  )
);

comment on table public.model_pricing_version is
  'Immutable provider rate cards. Rates are exact currency units per one million tokens; selection_rule identifies recurring bands such as DeepSeek peak/off-peak.';

create index model_pricing_version_lookup_idx
  on public.model_pricing_version (
    provider,
    model,
    effective_from desc,
    effective_to
  );

create table public.model_usage_record (
  usage_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key <> ''),
  run_id uuid not null,
  season_id uuid not null,
  decision_id uuid not null,
  source_event_id uuid references public.event_stream(event_id),
  harness_artifact_id uuid references public.artifact_metadata(artifact_id),
  harness_event_seq bigint check (harness_event_seq >= 0),
  harness_session_id text not null check (harness_session_id <> ''),
  turn_index bigint not null check (turn_index >= 0),
  step_index bigint not null check (step_index >= 0),
  attempt_index bigint not null check (attempt_index >= 0),
  provider text not null check (provider <> ''),
  model text not null check (model <> ''),
  provider_request_id text,
  request_started_at timestamptz not null,
  completed_at timestamptz not null,
  usage_status text not null check (
    usage_status in ('captured', 'provider_unreported')
  ),
  usage_source text not null check (
    usage_source in (
      'assistant_message',
      'stream_chunk_fallback',
      'provider_unreported'
    )
  ),
  uncached_input_tokens numeric check (
    uncached_input_tokens::text not in ('NaN', 'Infinity', '-Infinity')
    and uncached_input_tokens >= 0
    and trunc(uncached_input_tokens) = uncached_input_tokens
  ),
  cache_read_tokens numeric check (
    cache_read_tokens::text not in ('NaN', 'Infinity', '-Infinity')
    and cache_read_tokens >= 0
    and trunc(cache_read_tokens) = cache_read_tokens
  ),
  cache_write_tokens numeric check (
    cache_write_tokens::text not in ('NaN', 'Infinity', '-Infinity')
    and cache_write_tokens >= 0
    and trunc(cache_write_tokens) = cache_write_tokens
  ),
  output_tokens numeric check (
    output_tokens::text not in ('NaN', 'Infinity', '-Infinity')
    and output_tokens >= 0
    and trunc(output_tokens) = output_tokens
  ),
  reasoning_tokens numeric check (
    reasoning_tokens::text not in ('NaN', 'Infinity', '-Infinity')
    and reasoning_tokens >= 0
    and trunc(reasoning_tokens) = reasoning_tokens
  ),
  pricing_id uuid references public.model_pricing_version(pricing_id),
  estimated_cost numeric check (
    estimated_cost::text not in ('NaN', 'Infinity', '-Infinity')
    and estimated_cost >= 0
  ),
  cost_currency text check (
    cost_currency is null or cost_currency ~ '^[A-Z]{3}$'
  ),
  cost_status text not null check (
    cost_status in ('estimated', 'unpriced', 'unavailable')
  ),
  recorded_by text not null check (recorded_by <> ''),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint model_usage_record_attempt_unique
    unique (harness_session_id, turn_index, step_index, attempt_index),
  constraint model_usage_record_provider_request check (
    provider_request_id is null or provider_request_id <> ''
  ),
  constraint model_usage_record_reasoning_subset check (
    reasoning_tokens is null
    or (output_tokens is not null and reasoning_tokens <= output_tokens)
  ),
  constraint model_usage_record_time_order check (
    completed_at >= request_started_at
  ),
  constraint model_usage_record_evidence_shape check (
    (usage_status = 'captured' and harness_event_seq is not null)
    or (usage_status = 'provider_unreported' and harness_event_seq is null)
  ),
  constraint model_usage_record_capture_shape check (
    (
      usage_status = 'captured'
      and usage_source in ('assistant_message', 'stream_chunk_fallback')
      and uncached_input_tokens is not null
      and cache_read_tokens is not null
      and cache_write_tokens is not null
      and output_tokens is not null
    )
    or (
      usage_status = 'provider_unreported'
      and usage_source = 'provider_unreported'
      and uncached_input_tokens is null
      and cache_read_tokens is null
      and cache_write_tokens is null
      and output_tokens is null
      and reasoning_tokens is null
    )
  ),
  constraint model_usage_record_cost_shape check (
    (
      cost_status = 'estimated'
      and usage_status = 'captured'
      and pricing_id is not null
      and estimated_cost is not null
      and cost_currency is not null
    )
    or (
      cost_status = 'unpriced'
      and usage_status = 'captured'
      and pricing_id is null
      and estimated_cost is null
      and cost_currency is null
    )
    or (
      cost_status = 'unavailable'
      and usage_status = 'provider_unreported'
      and pricing_id is null
      and estimated_cost is null
      and cost_currency is null
    )
  )
);

comment on table public.model_usage_record is
  'One immutable usage fact per physical Harness provider attempt, frozen at step/end. The final assistant message wins, with the last stream usage chunk as failure fallback.';
comment on column public.model_usage_record.estimated_cost is
  'A reproducible rate-card estimate, not an invoice amount. Future billing reconciliation must append a separate fact.';

create index model_usage_record_run_idx
  on public.model_usage_record (run_id, completed_at, usage_id);
create index model_usage_record_season_idx
  on public.model_usage_record (season_id, completed_at, usage_id);
create index model_usage_record_decision_idx
  on public.model_usage_record (decision_id, completed_at, usage_id);
create unique index model_usage_record_provider_request_unique
  on public.model_usage_record (provider, provider_request_id)
  where provider_request_id is not null;
create unique index model_usage_record_harness_event_unique
  on public.model_usage_record (harness_session_id, harness_event_seq)
  where harness_event_seq is not null;

create trigger model_pricing_version_is_immutable
before update or delete on public.model_pricing_version
for each row execute function public.reject_immutable_mutation();

create trigger model_usage_record_is_immutable
before update or delete on public.model_usage_record
for each row execute function public.reject_immutable_mutation();

create or replace function public.register_model_pricing(
  p_idempotency_key text,
  p_provider text,
  p_model text,
  p_pricing_version text,
  p_pricing_band text,
  p_selection_rule text,
  p_currency text,
  p_unit_tokens bigint,
  p_uncached_input_rate numeric,
  p_cache_read_rate numeric,
  p_cache_write_rate numeric,
  p_output_rate numeric,
  p_effective_from timestamptz,
  p_source_url text,
  p_recorded_by text,
  p_effective_to timestamptz default null,
  p_source_artifact_id uuid default null
)
returns public.model_pricing_version
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_existing public.model_pricing_version%rowtype;
  v_inserted public.model_pricing_version%rowtype;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('model-pricing:' || p_idempotency_key, 0)
  );

  select pricing.*
    into v_existing
    from public.model_pricing_version as pricing
   where pricing.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.provider is distinct from p_provider
      or v_existing.model is distinct from p_model
      or v_existing.pricing_version is distinct from p_pricing_version
      or v_existing.pricing_band is distinct from p_pricing_band
      or v_existing.selection_rule is distinct from p_selection_rule
      or v_existing.currency is distinct from p_currency
      or v_existing.unit_tokens is distinct from p_unit_tokens
      or v_existing.uncached_input_rate is distinct from p_uncached_input_rate
      or v_existing.cache_read_rate is distinct from p_cache_read_rate
      or v_existing.cache_write_rate is distinct from p_cache_write_rate
      or v_existing.output_rate is distinct from p_output_rate
      or v_existing.effective_from is distinct from p_effective_from
      or v_existing.effective_to is distinct from p_effective_to
      or v_existing.source_url is distinct from p_source_url
      or v_existing.source_artifact_id is distinct from p_source_artifact_id
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'idempotency key % was reused with different pricing content',
        p_idempotency_key
        using errcode = '23505';
    end if;

    return v_existing;
  end if;

  insert into public.model_pricing_version (
    idempotency_key,
    provider,
    model,
    pricing_version,
    pricing_band,
    selection_rule,
    currency,
    unit_tokens,
    uncached_input_rate,
    cache_read_rate,
    cache_write_rate,
    output_rate,
    effective_from,
    effective_to,
    source_url,
    source_artifact_id,
    recorded_by
  ) values (
    p_idempotency_key,
    p_provider,
    p_model,
    p_pricing_version,
    p_pricing_band,
    p_selection_rule,
    p_currency,
    p_unit_tokens,
    p_uncached_input_rate,
    p_cache_read_rate,
    p_cache_write_rate,
    p_output_rate,
    p_effective_from,
    p_effective_to,
    p_source_url,
    p_source_artifact_id,
    p_recorded_by
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

create or replace function public.register_model_usage(
  p_idempotency_key text,
  p_run_id uuid,
  p_season_id uuid,
  p_decision_id uuid,
  p_harness_session_id text,
  p_turn_index bigint,
  p_step_index bigint,
  p_attempt_index bigint,
  p_provider text,
  p_model text,
  p_request_started_at timestamptz,
  p_completed_at timestamptz,
  p_usage_status text,
  p_usage_source text,
  p_uncached_input_tokens numeric,
  p_cache_read_tokens numeric,
  p_cache_write_tokens numeric,
  p_output_tokens numeric,
  p_reasoning_tokens numeric,
  p_recorded_by text,
  p_provider_request_id text default null,
  p_pricing_id uuid default null,
  p_source_event_id uuid default null,
  p_harness_artifact_id uuid default null,
  p_harness_event_seq bigint default null
)
returns public.model_usage_record
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_existing public.model_usage_record%rowtype;
  v_inserted public.model_usage_record%rowtype;
  v_pricing public.model_pricing_version%rowtype;
  v_estimated_cost numeric;
  v_cost_currency text;
  v_cost_status text;
begin
  if p_usage_status not in ('captured', 'provider_unreported') then
    raise exception 'invalid usage status %', p_usage_status
      using errcode = '22023';
  end if;

  if (p_usage_status = 'captured'
      and p_usage_source not in ('assistant_message', 'stream_chunk_fallback'))
    or (p_usage_status = 'provider_unreported'
      and p_usage_source <> 'provider_unreported')
  then
    raise exception 'usage source % does not match usage status %',
      p_usage_source, p_usage_status
      using errcode = '22023';
  end if;

  if p_usage_status = 'captured' and p_pricing_id is not null then
    select pricing.*
      into v_pricing
      from public.model_pricing_version as pricing
     where pricing.pricing_id = p_pricing_id;

    if not found then
      raise exception 'pricing version % does not exist', p_pricing_id
        using errcode = '23503';
    end if;

    if v_pricing.provider is distinct from p_provider
      or v_pricing.model is distinct from p_model
    then
      raise exception 'pricing provider/model does not match usage provider/model'
        using errcode = '22023';
    end if;

    if p_request_started_at < v_pricing.effective_from
      or (
        v_pricing.effective_to is not null
        and p_request_started_at >= v_pricing.effective_to
      )
    then
      raise exception 'pricing version is not effective for model request time'
        using errcode = '22023';
    end if;

    v_estimated_cost := round(
      (
        p_uncached_input_tokens * v_pricing.uncached_input_rate
        + p_cache_read_tokens * v_pricing.cache_read_rate
        + p_cache_write_tokens * v_pricing.cache_write_rate
        + p_output_tokens * v_pricing.output_rate
      ) / v_pricing.unit_tokens,
      18
    );
    v_cost_currency := v_pricing.currency;
    v_cost_status := 'estimated';
  elsif p_usage_status = 'captured' then
    v_cost_status := 'unpriced';
  else
    if p_pricing_id is not null then
      raise exception 'unreported usage cannot be priced'
        using errcode = '22023';
    end if;
    v_cost_status := 'unavailable';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('model-usage:' || p_idempotency_key, 0)
  );

  select usage.*
    into v_existing
    from public.model_usage_record as usage
   where usage.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.run_id is distinct from p_run_id
      or v_existing.season_id is distinct from p_season_id
      or v_existing.decision_id is distinct from p_decision_id
      or v_existing.source_event_id is distinct from p_source_event_id
      or v_existing.harness_artifact_id is distinct from p_harness_artifact_id
      or v_existing.harness_event_seq is distinct from p_harness_event_seq
      or v_existing.harness_session_id is distinct from p_harness_session_id
      or v_existing.turn_index is distinct from p_turn_index
      or v_existing.step_index is distinct from p_step_index
      or v_existing.attempt_index is distinct from p_attempt_index
      or v_existing.provider is distinct from p_provider
      or v_existing.model is distinct from p_model
      or v_existing.provider_request_id is distinct from p_provider_request_id
      or v_existing.request_started_at is distinct from p_request_started_at
      or v_existing.completed_at is distinct from p_completed_at
      or v_existing.usage_status is distinct from p_usage_status
      or v_existing.usage_source is distinct from p_usage_source
      or v_existing.uncached_input_tokens is distinct from p_uncached_input_tokens
      or v_existing.cache_read_tokens is distinct from p_cache_read_tokens
      or v_existing.cache_write_tokens is distinct from p_cache_write_tokens
      or v_existing.output_tokens is distinct from p_output_tokens
      or v_existing.reasoning_tokens is distinct from p_reasoning_tokens
      or v_existing.pricing_id is distinct from p_pricing_id
      or v_existing.estimated_cost is distinct from v_estimated_cost
      or v_existing.cost_currency is distinct from v_cost_currency
      or v_existing.cost_status is distinct from v_cost_status
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'idempotency key % was reused with different model usage content',
        p_idempotency_key
        using errcode = '23505';
    end if;

    return v_existing;
  end if;

  insert into public.model_usage_record (
    idempotency_key,
    run_id,
    season_id,
    decision_id,
    source_event_id,
    harness_artifact_id,
    harness_event_seq,
    harness_session_id,
    turn_index,
    step_index,
    attempt_index,
    provider,
    model,
    provider_request_id,
    request_started_at,
    completed_at,
    usage_status,
    usage_source,
    uncached_input_tokens,
    cache_read_tokens,
    cache_write_tokens,
    output_tokens,
    reasoning_tokens,
    pricing_id,
    estimated_cost,
    cost_currency,
    cost_status,
    recorded_by
  ) values (
    p_idempotency_key,
    p_run_id,
    p_season_id,
    p_decision_id,
    p_source_event_id,
    p_harness_artifact_id,
    p_harness_event_seq,
    p_harness_session_id,
    p_turn_index,
    p_step_index,
    p_attempt_index,
    p_provider,
    p_model,
    p_provider_request_id,
    p_request_started_at,
    p_completed_at,
    p_usage_status,
    p_usage_source,
    p_uncached_input_tokens,
    p_cache_read_tokens,
    p_cache_write_tokens,
    p_output_tokens,
    p_reasoning_tokens,
    p_pricing_id,
    v_estimated_cost,
    v_cost_currency,
    v_cost_status,
    p_recorded_by
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

alter table public.model_pricing_version enable row level security;
alter table public.model_usage_record enable row level security;

create policy model_pricing_version_read_authenticated
  on public.model_pricing_version for select to authenticated using (true);
create policy model_usage_record_read_authenticated
  on public.model_usage_record for select to authenticated using (true);

revoke all on table public.model_pricing_version from public, anon, authenticated;
revoke all on table public.model_usage_record from public, anon, authenticated;
revoke insert, update, delete, truncate
  on table public.model_pricing_version from service_role;
revoke insert, update, delete, truncate
  on table public.model_usage_record from service_role;

grant select on table public.model_pricing_version to authenticated, service_role;
grant select on table public.model_usage_record to authenticated, service_role;

revoke execute on function public.register_model_pricing(
  text, text, text, text, text, text, text, bigint,
  numeric, numeric, numeric, numeric,
  timestamptz, text, text, timestamptz, uuid
) from public, anon, authenticated;
revoke execute on function public.register_model_usage(
  text, uuid, uuid, uuid, text, bigint, bigint, bigint, text, text,
  timestamptz, timestamptz, text, text,
  numeric, numeric, numeric, numeric, numeric,
  text, text, uuid, uuid, uuid, bigint
) from public, anon, authenticated;

grant execute on function public.register_model_pricing(
  text, text, text, text, text, text, text, bigint,
  numeric, numeric, numeric, numeric,
  timestamptz, text, text, timestamptz, uuid
) to service_role;
grant execute on function public.register_model_usage(
  text, uuid, uuid, uuid, text, bigint, bigint, bigint, text, text,
  timestamptz, timestamptz, text, text,
  numeric, numeric, numeric, numeric, numeric,
  text, text, uuid, uuid, uuid, bigint
) to service_role;

alter table public.model_usage_record replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.model_usage_record;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

commit;
