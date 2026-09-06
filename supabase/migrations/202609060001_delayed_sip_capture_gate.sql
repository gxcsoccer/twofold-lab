-- Delayed SIP permits bars only once their query end is sufficiently old.
-- Keep immutable round schedules and first-minute price semantics unchanged;
-- waiting is eligibility, not a failed attempt. Both S1 and S2 use the same gate.
begin;

do $migration$
declare
  v_definition text;
  v_original constant text := $original$     and item.scheduled_at <= p_now
     and item.next_attempt_at <= p_now$original$;
  v_replacement constant text := $replacement$     and item.scheduled_at <= p_now
     and (
       item.phase not in ('CAPTURE_S1_OPEN_REFERENCE', 'CAPTURE_S2_OPEN_REFERENCE')
       or exists (
         select 1 from public.arena_round as round
          where round.round_id = item.round_id
            and p_now >= (case item.phase
              when 'CAPTURE_S1_OPEN_REFERENCE' then round.s1_open_at
              else round.s2_open_at
            end) + interval '17 minutes'
       )
     )
     and item.next_attempt_at <= p_now$replacement$;
begin
  select pg_get_functiondef('public.claim_arena_work_item(text,integer,timestamptz,uuid,text[])'::regprocedure)
    into v_definition;
  if strpos(v_definition, v_original) = 0 then
    raise exception 'Arena work eligibility fence changed unexpectedly' using errcode = '55000';
  end if;
  execute replace(v_definition, v_original, v_replacement);
end;
$migration$;

-- Only provider transport/rate-limit retries change cadence. Preserve the
-- existing retry budget and apply the same delay to the deadline eligibility.
do $migration$
declare
  v_definition text;
  v_original constant text := $original$p_completed_at + interval '1 minute'$original$;
  v_replacement constant text := $replacement$p_completed_at + case
      when p_error_code = 'ALPACA_TRANSIENT_FAILURE'
        then make_interval(secs => 60 * (2 ^ least(v_item.attempt_count - 1, 5))::integer)
      else interval '1 minute' end$replacement$;
begin
  select pg_get_functiondef('public.complete_arena_work_item(uuid,uuid,timestamptz,boolean,jsonb,text,text,boolean)'::regprocedure)
    into v_definition;
  if (length(v_definition) - length(replace(v_definition, v_original, '')))
    / length(v_original) <> 2 then
    raise exception 'Arena work retry/deadline fences changed unexpectedly' using errcode = '55000';
  end if;
  execute replace(v_definition, v_original, v_replacement);
end;
$migration$;

commit;
