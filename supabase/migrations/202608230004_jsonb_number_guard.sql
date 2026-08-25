begin;

create or replace function public.jsonb_contains_number(p_value jsonb)
returns boolean
language plpgsql
immutable
strict
parallel safe
set search_path = public, pg_temp
as $$
declare
  v_child jsonb;
begin
  case jsonb_typeof(p_value)
    when 'number' then
      return true;
    when 'array' then
      for v_child in
        select item from jsonb_array_elements(p_value) as items(item)
      loop
        if public.jsonb_contains_number(v_child) then
          return true;
        end if;
      end loop;
    when 'object' then
      for v_child in
        select value from jsonb_each(p_value) as entries(key, value)
      loop
        if public.jsonb_contains_number(v_child) then
          return true;
        end if;
      end loop;
    else
      null;
  end case;

  return false;
end;
$$;

comment on function public.jsonb_contains_number(jsonb) is
  'Rejects JSON numeric tokens at durable financial/control boundaries; numeric values are canonical strings.';

commit;
