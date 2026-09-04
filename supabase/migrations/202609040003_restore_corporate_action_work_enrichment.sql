-- Migration 202609040001 added retirement filtering by replacing the
-- corporate-action work projection from its original definition. Restore the
-- later instrument-identity and bounded-preparation enrichments that must be
-- composed with that filter.

begin;

do $$
declare
  v_function regprocedure :=
    'public.get_corporate_action_account_work(timestamptz)'::regprocedure;
  v_definition text;
  v_symbol_old text := E'    ''symbol'',item.symbol,\n    ''interpretation'',item.interpretation,';
  v_symbol_new text := E'    ''symbol'',item.symbol,\n'
    || E'    ''instrumentId'',(select version.instrument_id::text\n'
    || E'      from public.instrument_symbol_version as version\n'
    || E'     where version.symbol = item.symbol\n'
    || E'       and version.effective_from <= item.ex_date\n'
    || E'       and (version.effective_to is null\n'
    || E'         or version.effective_to > item.ex_date)\n'
    || E'     order by version.effective_from desc,version.symbol_version_id\n'
    || E'     limit 1),\n'
    || E'    ''interpretation'',item.interpretation,';
  v_schedule_old text := E'        when preparation.preparation_id is null and p_as_of >= candidate.ex_open_at\n'
    || E'          then ''MISSED_PREPARATION''\n'
    || E'        when preparation.preparation_id is null then ''PREPARE''\n';
  v_schedule_new text := E'        when preparation.preparation_id is null and p_as_of >= candidate.ex_open_at\n'
    || E'          then ''MISSED_PREPARATION''\n'
    || E'        when preparation.preparation_id is null\n'
    || E'          and p_as_of >= candidate.ex_open_at - interval ''30 minutes''\n'
    || E'          then ''PREPARE''\n'
    || E'        when preparation.preparation_id is null then ''WAITING_PREPARATION''\n';
begin
  select pg_get_functiondef(v_function) into v_definition;
  if position(v_symbol_old in v_definition) = 0 then
    raise exception 'could not restore corporate-action instrument identity'
      using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_symbol_old, v_symbol_new);
  if position(v_schedule_old in v_definition) = 0 then
    raise exception 'could not restore corporate-action preparation window'
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_schedule_old, v_schedule_new);
end;
$$;

commit;
