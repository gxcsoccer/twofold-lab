-- Enrich the stage-gated material with a stable, effective-dated instrument
-- universe. A target may include an asset with zero current quantity, so the
-- current portfolio alone is not the execution universe.

begin;

alter function public.get_arena_cycle_material(uuid, text)
  rename to arena_cycle_material_without_universe;

revoke all on function public.arena_cycle_material_without_universe(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.get_arena_cycle_material(
  p_round_entry_id uuid,
  p_stage text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_result jsonb;
  v_universe jsonb;
begin
  v_result := public.arena_cycle_material_without_universe(
    p_round_entry_id,
    p_stage
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'instrumentId', stable.instrument_id::text,
    'symbol', member.symbol,
    'sourceCountry', stable.issuer_tax_residency,
    'currency', stable.trading_currency
  ) order by member.member_index, stable.instrument_id), '[]'::jsonb)
    into v_universe
    from public.market_snapshot_member as member
    join public.market_bar_fact as fact
      on fact.fact_id = member.fact_id
     and fact.symbol = member.symbol
    join public.instrument_symbol_version as version
      on version.symbol = member.symbol
     and version.effective_from <= fact.bar_date
     and (version.effective_to is null or version.effective_to > fact.bar_date)
    join public.instrument as stable
      on stable.instrument_id = version.instrument_id
     and stable.trading_currency = fact.currency
   where member.snapshot_id = (v_result->'round'->>'decisionSnapshotId')::uuid;

  if jsonb_array_length(v_universe) = 0
    or jsonb_array_length(v_universe) <> (
      select cardinality(snapshot.symbols)
        from public.market_snapshot as snapshot
       where snapshot.snapshot_id =
         (v_result->'round'->>'decisionSnapshotId')::uuid
    )
    or exists (
      select 1
        from jsonb_array_elements(v_universe) as item(value)
       where item.value->>'instrumentId'
               !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          or item.value->>'symbol' !~ '^[A-Z][A-Z0-9.-]{0,14}$'
          or item.value->>'sourceCountry' !~ '^[A-Z]{2}$'
          or item.value->>'currency' !~ '^[A-Z]{3}$'
    )
    or exists (
      select 1
        from jsonb_array_elements(v_universe) as left_item(value)
        join jsonb_array_elements(v_universe) as right_item(value)
          on left_item.value <> right_item.value
         and (
           left_item.value->>'instrumentId'
             = right_item.value->>'instrumentId'
           or left_item.value->>'symbol' = right_item.value->>'symbol'
         )
    )
  then
    raise exception 'decision snapshot has no unique stable instrument universe'
      using errcode = '55000';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(
        v_result->'acceptedSubmission'->'targets'
      ) as target(value)
     where not exists (
       select 1 from jsonb_array_elements(v_universe) as item(value)
        where item.value->>'instrumentId'
                = target.value->>'instrumentId'
          and item.value->>'symbol' = target.value->>'symbol'
     )
  ) or exists (
    select 1
      from jsonb_array_elements(v_result->'portfolio'->'positions')
        as position(value)
     where not exists (
       select 1 from jsonb_array_elements(v_universe) as item(value)
        where item.value->>'instrumentId'
                = position.value->>'instrumentId'
          and item.value->>'symbol' = position.value->>'symbol'
     )
  ) then
    raise exception 'target or current position is outside the decision universe'
      using errcode = '55000';
  end if;

  v_result := jsonb_set(v_result, '{universe}', v_universe, true);
  if public.jsonb_contains_number(v_result) then
    raise exception 'Arena cycle material crossed the string-decimal boundary'
      using errcode = '55000';
  end if;
  return v_result;
end;
$$;

revoke all on function public.get_arena_cycle_material(uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_arena_cycle_material(uuid, text)
  to service_role;

comment on function public.get_arena_cycle_material(uuid, text) is
  'Returns stage-gated deterministic cycle inputs plus the unique effective-dated stable instrument universe; future evidence keys remain absent.';

commit;
