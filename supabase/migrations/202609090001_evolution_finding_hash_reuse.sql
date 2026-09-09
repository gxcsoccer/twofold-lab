begin;

-- Content-addressed findings may be rediscovered across cycles. Keep the first
-- discoverer on evolution_finding.cycle_id immutable, and record each cycle's
-- observation separately so complete_evolution_cycle can reuse identical hashes
-- without mistaking them for content conflicts.

create table public.evolution_cycle_finding (
  cycle_id uuid not null references public.evolution_cycle(cycle_id),
  finding_sha256 text not null references public.evolution_finding(finding_sha256),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (cycle_id, finding_sha256)
);

comment on table public.evolution_cycle_finding is
  'Associates a content-addressed evolution finding with every cycle that observed it; finding rows themselves stay immutable.';

-- Rediscovery lookups filter by hash alone ("which cycles observed this
-- finding?"), which the (cycle_id, finding_sha256) primary key cannot serve.
create index evolution_cycle_finding_finding_sha256_idx
  on public.evolution_cycle_finding (finding_sha256);

insert into public.evolution_cycle_finding (cycle_id, finding_sha256)
select cycle_id, finding_sha256
  from public.evolution_finding
on conflict do nothing;

alter table public.evolution_cycle_finding enable row level security;

drop trigger if exists evolution_cycle_finding_is_immutable on public.evolution_cycle_finding;
create trigger evolution_cycle_finding_is_immutable
before update or delete on public.evolution_cycle_finding
for each row execute function public.reject_immutable_mutation();

revoke all on table public.evolution_cycle_finding from public, anon, authenticated;
grant select on table public.evolution_cycle_finding to service_role;

create or replace function public.complete_evolution_cycle(
  p_cycle_id uuid,
  p_lease_token uuid,
  p_observations jsonb,
  p_analysis_report jsonb,
  p_report_sha256 text,
  p_worker_id text
)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp set row_security = off as $$
declare
  v_cycle public.evolution_cycle%rowtype;
  v_finding jsonb;
  v_finding_sha text;
  v_existing jsonb;
begin
  if p_cycle_id is null or p_lease_token is null
    or jsonb_typeof(p_observations) is distinct from 'array'
    or public.jsonb_contains_number(p_observations)
    or jsonb_typeof(p_analysis_report) is distinct from 'object'
    or p_analysis_report->>'schema' is distinct from 'twofold.evolution_analysis/v1'
    or public.jsonb_contains_number(p_analysis_report)
    or p_report_sha256 !~ '^[0-9a-f]{64}$'
    or p_analysis_report->>'reportSha256' is distinct from p_report_sha256
    or jsonb_typeof(p_analysis_report->'findings') is distinct from 'array'
    or p_worker_id is null or btrim(p_worker_id) = ''
    or p_worker_id is distinct from btrim(p_worker_id)
  then raise exception 'invalid evolution cycle completion' using errcode = '22023'; end if;
  select * into v_cycle from public.evolution_cycle
   where cycle_id = p_cycle_id for update;
  if not found then raise exception 'evolution cycle is missing' using errcode = '23503'; end if;
  if v_cycle.status = 'SUCCEEDED' then
    if v_cycle.lease_token is distinct from p_lease_token
      or v_cycle.claimed_by is distinct from p_worker_id
      or v_cycle.observations is distinct from p_observations
      or v_cycle.analysis_report is distinct from p_analysis_report
      or v_cycle.report_sha256 is distinct from p_report_sha256
    then raise exception 'evolution completion identity was reused' using errcode = '23505'; end if;
    return public.evolution_cycle_result(v_cycle);
  end if;
  if v_cycle.status <> 'CLAIMED'
    or v_cycle.lease_token is distinct from p_lease_token
    or v_cycle.claimed_by is distinct from p_worker_id
    or v_cycle.lease_expires_at <= clock_timestamp()
  then raise exception 'evolution cycle lease is not owned' using errcode = '55000'; end if;
  for v_finding in select value from jsonb_array_elements(p_analysis_report->'findings')
  loop
    v_finding_sha := v_finding->>'findingSha256';
    if v_finding->>'schema' is distinct from 'twofold.evolution_finding/v1'
      or v_finding_sha !~ '^[0-9a-f]{64}$'
      or coalesce(v_finding->>'scope', '') not in ('AGENT','PLATFORM','DATA','ACCOUNTING')
      or coalesce(v_finding->>'subject', '') = ''
      or coalesce(v_finding->>'lesson', '') = ''
      or jsonb_typeof(v_finding->'evidenceRefs') is distinct from 'array'
      or jsonb_array_length(v_finding->'evidenceRefs') = 0
    then raise exception 'invalid evolution finding' using errcode = '22023'; end if;

    -- Insert first discovery only. Identical rediscovery across cycles must not
    -- rewrite the immutable finding row; only true content mismatches fail.
    insert into public.evolution_finding (finding_sha256, cycle_id, finding)
      values (v_finding_sha, p_cycle_id, v_finding)
      on conflict (finding_sha256) do nothing;

    select finding into v_existing
      from public.evolution_finding
     where finding_sha256 = v_finding_sha;

    -- Diagnostics stay machine-parseable on conflict_type but carry only
    -- redacted identifier prefixes, never the full cycle id or finding hash.
    if not found then
      raise exception 'evolution finding hash was reused'
        using errcode = '23505',
              detail = format(
                'conflict_type=missing_after_insert cycle_id=%s finding_sha256=%s',
                left(p_cycle_id::text, 8), left(v_finding_sha, 12)
              );
    end if;

    if v_existing is distinct from v_finding then
      raise exception 'evolution finding hash was reused'
        using errcode = '23505',
              detail = format(
                'conflict_type=content_conflict cycle_id=%s finding_sha256=%s',
                left(p_cycle_id::text, 8), left(v_finding_sha, 12)
              );
    end if;

    insert into public.evolution_cycle_finding (cycle_id, finding_sha256)
      values (p_cycle_id, v_finding_sha)
      on conflict do nothing;

    insert into public.evolution_experience (
      experience_id, cycle_id, finding_sha256, scope, subject, lesson, evidence_refs
    ) values (
      public.deterministic_uuid_from_sha256('twofold.evolution_experience/v1', v_finding_sha),
      p_cycle_id, v_finding_sha, v_finding->>'scope', v_finding->>'subject',
      v_finding->>'lesson', v_finding->'evidenceRefs'
    ) on conflict (finding_sha256) do nothing;
  end loop;
  perform set_config('twofold.evolution_cycle_mutation', 'on', true);
  update public.evolution_cycle set status = 'SUCCEEDED', completed_at = clock_timestamp(),
    observations = p_observations, analysis_report = p_analysis_report,
    report_sha256 = p_report_sha256, lease_expires_at = null
   where cycle_id = p_cycle_id returning * into v_cycle;
  perform set_config('twofold.evolution_cycle_mutation', 'off', true);
  return public.evolution_cycle_result(v_cycle);
end;
$$;

comment on function public.complete_evolution_cycle(uuid,uuid,jsonb,jsonb,text,text) is
  'Completes a claimed evolution cycle; identical finding hashes may be associated across cycles, while same-hash different content remains a hard conflict.';

revoke all on function public.complete_evolution_cycle(uuid,uuid,jsonb,jsonb,text,text)
  from public, anon, authenticated;
grant execute on function public.complete_evolution_cycle(uuid,uuid,jsonb,jsonb,text,text)
  to service_role;

commit;
