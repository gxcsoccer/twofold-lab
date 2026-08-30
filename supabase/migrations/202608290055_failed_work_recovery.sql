-- A failed queue item is terminal for normal Workers. Operators still need one
-- narrow, audited recovery boundary for corrected deployment/runtime defects
-- before the immutable market deadline. Recovery never edits decisions,
-- submissions, plans, fills, or ledgers.

begin;

create table public.arena_work_recovery (
  recovery_id uuid primary key,
  work_item_id uuid not null references public.arena_work_item(work_item_id),
  previous_attempt_count bigint not null check (previous_attempt_count > 0),
  reason text not null check (
    reason <> '' and reason = btrim(reason) and length(reason) <= 500
  ),
  recovered_by text not null check (
    recovered_by <> '' and recovered_by = btrim(recovered_by)
  ),
  recovered_at timestamptz not null default clock_timestamp(),
  constraint arena_work_recovery_attempt_unique
    unique (work_item_id, previous_attempt_count),
  constraint arena_work_recovery_id_deterministic check (
    recovery_id = public.deterministic_uuid_from_sha256(
      'twofold.arena_work_recovery/v1',
      work_item_id::text || ':' || previous_attempt_count::text
    )
  )
);

alter table public.arena_work_recovery enable row level security;

create trigger arena_work_recovery_is_immutable
before update or delete on public.arena_work_recovery
for each row execute function public.reject_immutable_mutation();

create trigger arena_work_recovery_rejects_truncate
before truncate on public.arena_work_recovery
for each statement execute function public.reject_immutable_mutation();

create or replace function public.recover_failed_arena_work_item(
  p_work_item_id uuid,
  p_expected_attempt_count bigint,
  p_reason text,
  p_recovered_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_item public.arena_work_item%rowtype;
  v_recovery public.arena_work_recovery%rowtype;
  v_now timestamptz := clock_timestamp();
  v_recovery_id uuid;
begin
  if p_work_item_id is null
    or p_expected_attempt_count is null or p_expected_attempt_count <= 0
    or p_reason is null or btrim(p_reason) = ''
    or p_reason is distinct from btrim(p_reason) or length(p_reason) > 500
    or p_recovered_by is null or btrim(p_recovered_by) = ''
    or p_recovered_by is distinct from btrim(p_recovered_by)
  then
    raise exception 'invalid failed-work recovery request' using errcode = '22023';
  end if;
  v_recovery_id := public.deterministic_uuid_from_sha256(
    'twofold.arena_work_recovery/v1',
    p_work_item_id::text || ':' || p_expected_attempt_count::text
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'arena-work-recovery:' || p_work_item_id::text, 0
  ));
  select * into v_item from public.arena_work_item
   where work_item_id = p_work_item_id for update;
  if not found then
    raise exception 'Arena work item does not exist' using errcode = '23503';
  end if;
  select * into v_recovery from public.arena_work_recovery
   where recovery_id = v_recovery_id;
  if found then
    if v_recovery.work_item_id is distinct from p_work_item_id
      or v_recovery.previous_attempt_count
        is distinct from p_expected_attempt_count
      or v_recovery.reason is distinct from p_reason
      or v_recovery.recovered_by is distinct from p_recovered_by
    then
      raise exception 'failed-work recovery identity was reused'
        using errcode = '23505';
    end if;
    return public.arena_work_item_result(v_item);
  end if;
  if v_item.status <> 'FAILED'
    or v_item.attempt_count <> p_expected_attempt_count
    or v_item.deadline_at is null or v_now >= v_item.deadline_at
    or exists (
      select 1 from public.arena_round_entry as entry
      join public.accepted_target_submission as submission
        on submission.decision_id = entry.decision_id
     where entry.round_entry_id = v_item.round_entry_id
    )
    or exists (
      select 1 from public.arena_work_dependency as dependency
      join public.arena_work_item as downstream
        on downstream.work_item_id = dependency.work_item_id
     where dependency.prerequisite_work_item_id = v_item.work_item_id
       and downstream.status in ('CLAIMED', 'SUCCEEDED')
    )
  then
    raise exception 'failed Arena work item is not safely recoverable'
      using errcode = '55000';
  end if;

  insert into public.arena_work_recovery (
    recovery_id, work_item_id, previous_attempt_count,
    reason, recovered_by, recovered_at
  ) values (
    v_recovery_id, p_work_item_id, p_expected_attempt_count,
    p_reason, p_recovered_by, v_now
  );
  perform set_config('twofold.arena_work_item_mutation', 'on', true);
  update public.arena_work_item
     set status = 'REQUESTED', next_attempt_at = v_now,
         claimed_by = null, lease_token = null, claimed_at = null,
         lease_expires_at = null, completed_at = null,
         completion_fingerprint_sha256 = null, result = null,
         error_code = null, error_message = null, retryable = null
   where work_item_id = p_work_item_id
   returning * into v_item;
  perform set_config('twofold.arena_work_item_mutation', 'off', true);
  return public.arena_work_item_result(v_item);
end;
$$;

revoke all on table public.arena_work_recovery
  from public, anon, authenticated;
grant select on table public.arena_work_recovery to service_role;
revoke all on function public.recover_failed_arena_work_item(
  uuid, bigint, text, text
) from public, anon, authenticated;
grant execute on function public.recover_failed_arena_work_item(
  uuid, bigint, text, text
) to service_role;

commit;
