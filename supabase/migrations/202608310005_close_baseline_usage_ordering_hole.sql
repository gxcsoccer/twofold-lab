-- Close the ordering hole in the baseline zero-token invariant.
--
-- reject_baseline_model_usage only fires when the decision_invocation row
-- already exists, and model_usage_record.decision_id carries no foreign key to
-- it. Usage could therefore be inserted first and the baseline invocation
-- opened afterwards, and neither statement would trip a guard. The property was
-- documented as a database invariant, so it has to hold in both orderings.
--
-- derive_decision_kind already runs before every decision_invocation insert and
-- already resolves the entrant class, so the symmetric check belongs there.

begin;

create or replace function public.derive_decision_kind()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_execution_class text;
begin
  select entrant.execution_class into v_execution_class
    from public.season_entrant as entrant
   where entrant.run_id = new.run_id;

  new.decision_kind := case
    when v_execution_class = 'DETERMINISTIC_BASELINE'
      then 'DETERMINISTIC_BASELINE'
    else 'AGENT'
  end;

  -- The other half of the invariant: a baseline decision may not be opened for
  -- a decision id that already carries provider usage.
  if new.decision_kind = 'DETERMINISTIC_BASELINE'
    and exists (
      select 1 from public.model_usage_record as usage
       where usage.decision_id = new.decision_id
    )
  then
    raise exception
      'a deterministic baseline decision cannot record model usage'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.derive_decision_kind() is
  'Derives decision provenance from immutable entrant identity and refuses to open a baseline decision over existing provider usage.';

revoke all on function public.derive_decision_kind()
  from public, anon, authenticated, service_role;

commit;
