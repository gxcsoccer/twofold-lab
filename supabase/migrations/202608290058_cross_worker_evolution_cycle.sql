-- A deterministic analysis window is global work. The first scheduler is
-- provenance, not identity: any worker must be able to request the same
-- byte-equivalent window without turning a rolling deployment into a conflict.

begin;

create or replace function public.request_evolution_cycle(
  p_idempotency_key text,
  p_window_started_at timestamptz,
  p_window_ended_at timestamptz,
  p_policy jsonb,
  p_recorded_by text
)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp set row_security = off as $$
declare
  v_cycle public.evolution_cycle%rowtype;
  v_cycle_id uuid;
  v_policy_sha text;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_window_started_at is null or p_window_ended_at <= p_window_started_at
    or jsonb_typeof(p_policy) is distinct from 'object'
    or public.jsonb_contains_number(p_policy)
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid evolution cycle request' using errcode = '22023';
  end if;
  v_cycle_id := public.deterministic_uuid_from_sha256(
    'twofold.evolution_cycle/v1', p_idempotency_key
  );
  v_policy_sha := encode(
    extensions.digest(convert_to(p_policy::text, 'UTF8'), 'sha256'), 'hex'
  );
  perform pg_advisory_xact_lock(
    hashtextextended('evolution-cycle:' || p_idempotency_key, 0)
  );
  select * into v_cycle from public.evolution_cycle
   where cycle_id = v_cycle_id or idempotency_key = p_idempotency_key limit 1;
  if found then
    if v_cycle.cycle_id is distinct from v_cycle_id
      or v_cycle.window_started_at is distinct from p_window_started_at
      or v_cycle.window_ended_at is distinct from p_window_ended_at
      or v_cycle.policy is distinct from p_policy
      or v_cycle.policy_sha256 is distinct from v_policy_sha
    then
      raise exception 'evolution cycle identity was reused' using errcode = '23505';
    end if;
    return public.evolution_cycle_result(v_cycle);
  end if;
  insert into public.evolution_cycle (
    cycle_id, idempotency_key, window_started_at, window_ended_at,
    policy, policy_sha256, recorded_by
  ) values (
    v_cycle_id, p_idempotency_key, p_window_started_at, p_window_ended_at,
    p_policy, v_policy_sha, p_recorded_by
  ) returning * into v_cycle;
  return public.evolution_cycle_result(v_cycle);
end;
$$;

comment on function public.request_evolution_cycle(
  text, timestamptz, timestamptz, jsonb, text
) is
  'Requests one global deterministic window; recorded_by preserves the first scheduler but is not part of exact content identity.';

commit;
