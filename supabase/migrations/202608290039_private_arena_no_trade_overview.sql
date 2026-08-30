-- Expose an explicit no-trade carry-forward beside the economic score. Keep
-- the prior read model as an internal base and version the changed exact JSON
-- contract instead of silently adding fields to v1.

begin;

alter function public.get_private_arena_overview(uuid, timestamptz)
  rename to get_private_arena_overview_v1_base;

revoke all on function public.get_private_arena_overview_v1_base(
  uuid, timestamptz
) from public, anon, authenticated, service_role;

create function public.get_private_arena_overview(
  p_season_id uuid default null,
  p_as_of timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_base jsonb;
  v_entrants jsonb;
begin
  v_base := public.get_private_arena_overview_v1_base(
    p_season_id, p_as_of
  );

  select coalesce(jsonb_agg(
    (entrant.value - 'schema') || jsonb_build_object(
      'schema', 'twofold.private_arena_entrant_overview/v2',
      'noTrade', case when recovery.recovery_id is null then null else
        jsonb_build_object(
          'schema', 'twofold.private_arena_no_trade_overview/v1',
          'status', recovery.status,
          'reasonCode', recovery.reason_code,
          'sourcePhase', source_work.phase,
          'scheduledAt', to_char(
            recovery.scheduled_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'completedAt', case when recovery.completed_at is null then null else
            to_char(
              recovery.completed_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
          end,
          'valuationId', recovery.valuation_id::text,
          'outcome', case when recovery.status = 'SUCCEEDED'
            then recovery.result->>'outcome' else null end
        )
      end
    ) order by entrant.ordinality
  ), '[]'::jsonb)
  into v_entrants
  from jsonb_array_elements(v_base->'entrants') with ordinality
    as entrant(value, ordinality)
  left join public.arena_no_trade_recovery as recovery
    on recovery.round_entry_id = nullif(
      entrant.value->>'roundEntryId', ''
    )::uuid
  left join public.arena_work_item as source_work
    on source_work.work_item_id = recovery.source_work_item_id;

  return jsonb_set(
    jsonb_set(
      v_base,
      '{schema}',
      to_jsonb('twofold.private_arena_overview/v2'::text)
    ),
    '{entrants}',
    v_entrants
  );
end;
$$;

revoke all on function public.get_private_arena_overview(
  uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.get_private_arena_overview(
  uuid, timestamptz
) to service_role;

comment on function public.get_private_arena_overview(uuid, timestamptz) is
  'Returns one number-free private Arena v2 snapshot including explicit no-trade carry-forward state beside the authoritative rank.';
comment on function public.get_private_arena_overview_v1_base(uuid, timestamptz)
  is 'Internal v1 base for the private Arena v2 read model; not directly callable by application roles.';

commit;
