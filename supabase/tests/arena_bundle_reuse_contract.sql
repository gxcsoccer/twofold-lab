begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(2);

select ok(to_regprocedure(
  'public.open_decision_invocation(text,uuid,uuid,uuid,bigint,text,text,uuid,uuid,uuid,timestamptz,timestamptz,timestamptz,text[],timestamptz,text)'
) is not null, 'decision invocation boundary exists');

select ok(pg_get_functiondef(to_regprocedure(
  'public.open_decision_invocation(text,uuid,uuid,uuid,bigint,text,text,uuid,uuid,uuid,timestamptz,timestamptz,timestamptz,text[],timestamptz,text)'
)) like '%entrant.bundle_sha256 = v_bundle.sha256%',
  'cross-Season Bundle reuse is bound to the current entrant SHA-256');

select * from finish();
rollback;
