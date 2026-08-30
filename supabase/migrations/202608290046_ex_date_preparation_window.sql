-- Entitlement is the last pre-ex-open account state, not the account state on
-- announcement day. Expose preparation only during a bounded pre-open window;
-- earlier scans remain evidence but cannot freeze stale holdings.

begin;

do $$
declare
  v_oid regprocedure :=
    'public.get_corporate_action_account_work(timestamptz)'::regprocedure;
  v_source text;
  v_old text := E'        when preparation.preparation_id is null and p_as_of >= candidate.ex_open_at\n'
    || E'          then ''MISSED_PREPARATION''\n'
    || E'        when preparation.preparation_id is null then ''PREPARE''\n';
  v_new text := E'        when preparation.preparation_id is null and p_as_of >= candidate.ex_open_at\n'
    || E'          then ''MISSED_PREPARATION''\n'
    || E'        when preparation.preparation_id is null\n'
    || E'          and p_as_of >= candidate.ex_open_at - interval ''30 minutes''\n'
    || E'          then ''PREPARE''\n'
    || E'        when preparation.preparation_id is null then ''WAITING_PREPARATION''\n';
begin
  select pg_get_functiondef(v_oid) into v_source;
  if position(v_old in v_source) = 0 then
    raise exception 'could not locate corporate-action preparation scheduling clause'
      using errcode = '55000';
  end if;
  execute replace(v_source,v_old,v_new);
end;
$$;

commit;
