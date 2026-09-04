-- Arena valuation JSON intentionally uses canonical millisecond timestamps,
-- while Postgres retains microseconds on sealed_at. Comparing the parsed JSON
-- instant directly to the raw row made a valid valuation appear a fraction of
-- a millisecond early. Compare at the public contract's frozen precision.

begin;

do $$
declare
  v_function regprocedure := 'public.register_arena_valuation('
    || 'text, uuid, text, uuid, text, text)';
  v_definition text;
  v_old text := E'    or v_valuation_at < v_snapshot.sealed_at\n';
  v_new text := E'    or v_valuation_at\n'
    || E'      < date_trunc(''milliseconds'', v_snapshot.sealed_at)\n';
begin
  select pg_get_functiondef(v_function) into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'could not locate the Arena valuation snapshot-time fence'
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$$;

commit;
