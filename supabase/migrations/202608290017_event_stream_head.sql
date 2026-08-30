-- Stable Strategy Runs span many decisions. A worker must append at the real
-- current stream head instead of assuming every Round starts at sequence zero.

begin;

create or replace function public.get_event_stream_head(
  p_stream_id uuid,
  p_stream_type text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_event public.event_stream%rowtype;
begin
  if p_stream_id is null or p_stream_type is null or btrim(p_stream_type) = '' then
    raise exception 'stream identity and type are required'
      using errcode = '22023';
  end if;

  select * into v_event
    from public.event_stream
   where stream_id = p_stream_id
   order by stream_seq desc
   limit 1;

  if found and v_event.stream_type <> p_stream_type then
    raise exception 'stream already has a different type'
      using errcode = '22023';
  end if;

  return jsonb_build_object(
    'schema', 'twofold.event_stream_head/v1',
    'streamId', p_stream_id::text,
    'streamType', p_stream_type,
    'sequence', case when found then v_event.stream_seq::text else '0' end,
    'lastEventId', case
      when found then to_jsonb(v_event.event_id::text)
      else 'null'::jsonb
    end
  );
end;
$$;

comment on function public.get_event_stream_head(uuid, text) is
  'Returns the exact append CAS pointer with BIGINT sequence serialized as a string; an unseen stream has sequence zero.';

revoke all on function public.get_event_stream_head(uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_event_stream_head(uuid, text)
  to service_role;

commit;
