-- A zero-position account still needs the stable instrument identity to record
-- an explicit NO_POSITION/NO_ENTITLEMENT result. Enrich the work envelope from
-- the effective-dated symbol registry rather than asking the Worker to infer it.

begin;

do $$
declare
  v_oid regprocedure :=
    'public.get_corporate_action_account_work(timestamptz)'::regprocedure;
  v_source text;
  v_old text := E'    ''symbol'',item.symbol,\n    ''interpretation'',item.interpretation,';
  v_new text := E'    ''symbol'',item.symbol,\n'
    || E'    ''instrumentId'',(select version.instrument_id::text\n'
    || E'      from public.instrument_symbol_version as version\n'
    || E'     where version.symbol = item.symbol\n'
    || E'       and version.effective_from <= item.ex_date\n'
    || E'       and (version.effective_to is null\n'
    || E'         or version.effective_to > item.ex_date)\n'
    || E'     order by version.effective_from desc,version.symbol_version_id\n'
    || E'     limit 1),\n'
    || E'    ''interpretation'',item.interpretation,';
begin
  select pg_get_functiondef(v_oid) into v_source;
  if position(v_old in v_source) = 0 then
    raise exception 'could not locate corporate-action work symbol field'
      using errcode = '55000';
  end if;
  execute replace(v_source,v_old,v_new);
end;
$$;

commit;
