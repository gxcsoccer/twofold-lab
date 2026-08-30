-- Corporate actions are account mutations, not market-data adjustments and not
-- paper fills. Freeze each account's ex-date state first, then admit the due
-- economic mutation through the same ledger-head lock/CAS used by settlements.

begin;

alter table public.strategy_ledger_head
  drop constraint strategy_ledger_head_sequence_matches_settlements;

alter table public.strategy_ledger_head
  add column corporate_action_mutation_count bigint not null default 0
    check (corporate_action_mutation_count >= 0),
  add constraint strategy_ledger_head_sequence_matches_mutations check (
    head_sequence = settlement_count + corporate_action_mutation_count
  );

create table public.corporate_action_account_preparation (
  preparation_id uuid primary key,
  idempotency_key text not null unique check (
    idempotency_key <> '' and idempotency_key = btrim(idempotency_key)
  ),
  strategy_account_id uuid not null
    references public.strategy_account(strategy_account_id),
  run_id uuid not null references public.run_manifest(run_id),
  source_action_id uuid not null,
  revision_sha256 text not null check (revision_sha256 ~ '^[0-9a-f]{64}$'),
  action_type text not null check (
    action_type in ('FORWARD_SPLIT', 'REVERSE_SPLIT', 'CASH_DIVIDEND')
  ),
  status text not null check (
    status in ('PREPARED', 'NO_POSITION', 'NO_ENTITLEMENT')
  ),
  ledger_head_sequence bigint not null check (ledger_head_sequence >= 0),
  ledger_head_sha256 text not null check (ledger_head_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_schema text not null check (
    artifact_schema = 'twofold.corporate_action_account_preparation/v1'
  ),
  preparation_canonical_json text not null check (
    preparation_canonical_json <> ''
    and preparation_canonical_json = btrim(preparation_canonical_json)
  ),
  preparation jsonb not null,
  content_sha256 text not null unique check (content_sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz not null,
  source_event_id uuid not null references public.event_stream(event_id),
  source_stream_seq bigint not null check (source_stream_seq > 0),
  recorded_by text not null check (
    recorded_by <> '' and recorded_by = btrim(recorded_by)
  ),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (strategy_account_id, source_action_id, revision_sha256),
  unique (preparation_id, content_sha256),
  foreign key (source_action_id, revision_sha256)
    references public.corporate_action_revision(source_action_id, revision_sha256),
  constraint corporate_action_preparation_id_deterministic check (
    preparation_id = public.deterministic_uuid_from_sha256(
      'twofold.corporate_action_account_preparation/v1', content_sha256
    )
  ),
  constraint corporate_action_preparation_bytes_bind_sha check (
    preparation = preparation_canonical_json::jsonb
    and content_sha256 = encode(extensions.digest(
      convert_to(preparation_canonical_json, 'UTF8'), 'sha256'
    ), 'hex')
  ),
  constraint corporate_action_preparation_number_free check (
    not public.jsonb_contains_number(preparation)
  )
);

create table public.corporate_action_account_application (
  application_id uuid primary key,
  idempotency_key text not null unique check (
    idempotency_key <> '' and idempotency_key = btrim(idempotency_key)
  ),
  strategy_account_id uuid not null
    references public.strategy_account(strategy_account_id),
  run_id uuid not null references public.run_manifest(run_id),
  preparation_id uuid not null
    references public.corporate_action_account_preparation(preparation_id),
  preparation_sha256 text not null,
  source_action_id uuid not null,
  revision_sha256 text not null check (revision_sha256 ~ '^[0-9a-f]{64}$'),
  action_type text not null check (
    action_type in ('FORWARD_SPLIT', 'REVERSE_SPLIT', 'CASH_DIVIDEND')
  ),
  status text not null check (
    status in ('APPLIED', 'NO_POSITION', 'NO_ENTITLEMENT')
  ),
  opening_head_sequence bigint not null check (opening_head_sequence >= 0),
  opening_head_sha256 text not null check (opening_head_sha256 ~ '^[0-9a-f]{64}$'),
  final_head_sequence bigint not null check (final_head_sequence >= 0),
  final_head_sha256 text not null check (final_head_sha256 ~ '^[0-9a-f]{64}$'),
  mutation_canonical_json text not null check (
    mutation_canonical_json <> ''
    and mutation_canonical_json = btrim(mutation_canonical_json)
  ),
  mutation_sha256 text not null check (mutation_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_schema text not null check (
    artifact_schema = 'twofold.corporate_action_account_application/v1'
  ),
  application_canonical_json text not null check (
    application_canonical_json <> ''
    and application_canonical_json = btrim(application_canonical_json)
  ),
  application jsonb not null,
  content_sha256 text not null unique check (content_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null,
  source_event_id uuid not null references public.event_stream(event_id),
  source_stream_seq bigint not null check (source_stream_seq > 0),
  recorded_by text not null check (
    recorded_by <> '' and recorded_by = btrim(recorded_by)
  ),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (strategy_account_id, source_action_id, revision_sha256),
  foreign key (source_action_id, revision_sha256)
    references public.corporate_action_revision(source_action_id, revision_sha256),
  foreign key (preparation_id, preparation_sha256)
    references public.corporate_action_account_preparation(
      preparation_id, content_sha256
    ),
  constraint corporate_action_application_id_deterministic check (
    application_id = public.deterministic_uuid_from_sha256(
      'twofold.corporate_action_account_application/v1', content_sha256
    )
  ),
  constraint corporate_action_application_head_advance check (
    (
      status = 'APPLIED'
      and final_head_sequence = opening_head_sequence + 1
    ) or (
      status <> 'APPLIED'
      and final_head_sequence = opening_head_sequence
      and final_head_sha256 = opening_head_sha256
    )
  ),
  constraint corporate_action_application_mutation_bytes_bind_sha check (
    mutation_sha256 = encode(extensions.digest(
      convert_to(mutation_canonical_json, 'UTF8'), 'sha256'
    ), 'hex')
  ),
  constraint corporate_action_application_bytes_bind_sha check (
    application = application_canonical_json::jsonb
    and content_sha256 = encode(extensions.digest(
      convert_to(application_canonical_json, 'UTF8'), 'sha256'
    ), 'hex')
  ),
  constraint corporate_action_application_number_free check (
    not public.jsonb_contains_number(application)
  )
);

create index corporate_action_preparation_due_idx
  on public.corporate_action_account_preparation (
    action_type, captured_at, source_action_id, strategy_account_id
  );
create index corporate_action_application_due_idx
  on public.corporate_action_account_application (
    applied_at, source_action_id, strategy_account_id
  );

comment on table public.corporate_action_account_preparation is
  'Immutable pre-open account fence: split adjustment or dividend entitlement bound to one exact ledger head and provider revision.';
comment on table public.corporate_action_account_application is
  'Immutable due-date account result. APPLIED advances the durable ledger head once; explicit no-position/no-entitlement evaluations do not.';

create trigger corporate_action_account_preparation_is_immutable
before update or delete on public.corporate_action_account_preparation
for each row execute function public.reject_immutable_mutation();
create trigger corporate_action_account_preparation_rejects_truncate
before truncate on public.corporate_action_account_preparation
for each statement execute function public.reject_immutable_mutation();
create trigger corporate_action_account_application_is_immutable
before update or delete on public.corporate_action_account_application
for each row execute function public.reject_immutable_mutation();
create trigger corporate_action_account_application_rejects_truncate
before truncate on public.corporate_action_account_application
for each statement execute function public.reject_immutable_mutation();

create or replace function public.guard_strategy_ledger_head_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'strategy_ledger_head cannot be deleted'
      using errcode = '55000';
  end if;
  if current_setting('twofold.atomic_settlement', true) is distinct from 'on'
    and current_setting('twofold.atomic_ledger_mutation', true) is distinct from 'on'
  then
    raise exception 'strategy_ledger_head may change only inside an atomic ledger mutation'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function public.corporate_action_preparation_result(
  p_preparation public.corporate_action_account_preparation
)
returns jsonb
language sql
stable
strict
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'twofold.corporate_action_account_preparation_result/v1',
    'preparationId', p_preparation.preparation_id::text,
    'strategyAccountId', p_preparation.strategy_account_id::text,
    'runId', p_preparation.run_id::text,
    'sourceActionId', p_preparation.source_action_id::text,
    'revisionSha256', p_preparation.revision_sha256,
    'actionType', p_preparation.action_type,
    'status', p_preparation.status,
    'ledgerHeadSequence', p_preparation.ledger_head_sequence::text,
    'ledgerHeadSha256', p_preparation.ledger_head_sha256,
    'contentSha256', p_preparation.content_sha256,
    'capturedAt', to_char(p_preparation.captured_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'sourceStreamSeq', p_preparation.source_stream_seq::text
  )
$$;

create or replace function public.corporate_action_application_result(
  p_application public.corporate_action_account_application
)
returns jsonb
language sql
stable
strict
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'twofold.corporate_action_account_application_result/v1',
    'applicationId', p_application.application_id::text,
    'preparationId', p_application.preparation_id::text,
    'strategyAccountId', p_application.strategy_account_id::text,
    'runId', p_application.run_id::text,
    'sourceActionId', p_application.source_action_id::text,
    'revisionSha256', p_application.revision_sha256,
    'actionType', p_application.action_type,
    'status', p_application.status,
    'openingHeadSequence', p_application.opening_head_sequence::text,
    'openingHeadSha256', p_application.opening_head_sha256,
    'finalHeadSequence', p_application.final_head_sequence::text,
    'finalHeadSha256', p_application.final_head_sha256,
    'mutationSha256', p_application.mutation_sha256,
    'contentSha256', p_application.content_sha256,
    'appliedAt', to_char(p_application.applied_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'sourceStreamSeq', p_application.source_stream_seq::text
  )
$$;

create or replace function public.register_corporate_action_account_preparation(
  p_idempotency_key text,
  p_preparation_id uuid,
  p_strategy_account_id uuid,
  p_run_id uuid,
  p_source_action_id uuid,
  p_revision_sha256 text,
  p_preparation_canonical_json text,
  p_content_sha256 text,
  p_captured_at timestamptz,
  p_expected_run_stream_seq bigint,
  p_event_id uuid,
  p_recorded_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_existing public.corporate_action_account_preparation%rowtype;
  v_account public.strategy_account%rowtype;
  v_head public.strategy_ledger_head%rowtype;
  v_revision public.corporate_action_revision%rowtype;
  v_current_revision text;
  v_preparation jsonb;
  v_status text;
  v_action_type text;
  v_event public.event_stream%rowtype;
  v_inserted public.corporate_action_account_preparation%rowtype;
  v_effective_at timestamptz;
begin
  if p_idempotency_key is null or p_idempotency_key = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_preparation_id is null or p_strategy_account_id is null
    or p_run_id is null or p_source_action_id is null
    or p_revision_sha256 !~ '^[0-9a-f]{64}$'
    or p_preparation_canonical_json is null
    or p_preparation_canonical_json = ''
    or p_preparation_canonical_json is distinct from btrim(p_preparation_canonical_json)
    or p_content_sha256 !~ '^[0-9a-f]{64}$'
    or p_captured_at is null or p_expected_run_stream_seq is null
    or p_expected_run_stream_seq < 0 or p_event_id is null
    or p_recorded_by is null or p_recorded_by = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid corporate-action preparation header'
      using errcode = '22023';
  end if;
  begin v_preparation := p_preparation_canonical_json::jsonb;
  exception when others then
    raise exception 'corporate-action preparation bytes are not valid JSON'
      using errcode = '22023';
  end;
  if encode(extensions.digest(convert_to(p_preparation_canonical_json, 'UTF8'),
      'sha256'), 'hex') is distinct from p_content_sha256
    or p_preparation_id is distinct from public.deterministic_uuid_from_sha256(
      'twofold.corporate_action_account_preparation/v1', p_content_sha256)
    or p_event_id is distinct from public.deterministic_uuid_from_sha256(
      'twofold.event.corporate_action_account_preparation/v1',
      p_preparation_id::text)
  then
    raise exception 'corporate-action preparation content identity is invalid'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'corporate-action-preparation:' || p_strategy_account_id::text || ':'
      || p_source_action_id::text, 0));
  select * into v_existing
    from public.corporate_action_account_preparation
   where idempotency_key = p_idempotency_key
      or preparation_id = p_preparation_id
      or (strategy_account_id = p_strategy_account_id
          and source_action_id = p_source_action_id
          and revision_sha256 = p_revision_sha256)
   limit 1;
  if found then
    if v_existing.idempotency_key is distinct from p_idempotency_key
      or v_existing.preparation_id is distinct from p_preparation_id
      or v_existing.strategy_account_id is distinct from p_strategy_account_id
      or v_existing.run_id is distinct from p_run_id
      or v_existing.source_action_id is distinct from p_source_action_id
      or v_existing.revision_sha256 is distinct from p_revision_sha256
      or v_existing.preparation_canonical_json
           is distinct from p_preparation_canonical_json
      or v_existing.content_sha256 is distinct from p_content_sha256
      or v_existing.captured_at is distinct from p_captured_at
      or v_existing.source_event_id is distinct from p_event_id
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'corporate-action preparation identity was reused with different content'
        using errcode = '23505';
    end if;
    return public.corporate_action_preparation_result(v_existing);
  end if;

  select * into v_account from public.strategy_account
   where strategy_account_id = p_strategy_account_id and run_id = p_run_id
     and live_trading is false and base_currency = 'USD';
  if not found then
    raise exception 'corporate-action preparation account is invalid'
      using errcode = '23503';
  end if;
  select * into v_revision from public.corporate_action_revision
   where source_action_id = p_source_action_id
     and revision_sha256 = p_revision_sha256;
  if not found or v_revision.evidence_status <> 'COMPLETE'
    or v_revision.interpretation not in ('SPLIT', 'CASH_DIVIDEND')
  then
    raise exception 'corporate-action revision is not application-ready'
      using errcode = '55000';
  end if;
  select observation.revision_sha256 into v_current_revision
    from public.corporate_action_scan_revision as observation
    join public.corporate_action_scan as scan on scan.scan_id = observation.scan_id
   where observation.source_action_id = p_source_action_id
     and scan.observed_at <= p_captured_at
   order by scan.observed_at desc, scan.scan_id desc
   limit 1;
  if v_current_revision is distinct from p_revision_sha256 then
    raise exception 'corporate-action preparation does not use the latest visible revision'
      using errcode = '40001';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('twofold-ledger:' || p_strategy_account_id::text, 0));
  select * into v_head from public.strategy_ledger_head
   where strategy_account_id = p_strategy_account_id for update;
  if not found then
    raise exception 'strategy ledger head is not initialized' using errcode = '55000';
  end if;

  v_action_type := v_preparation->>'actionType';
  v_status := v_preparation->>'status';
  if jsonb_typeof(v_preparation) <> 'object'
    or public.jsonb_contains_number(v_preparation)
    or (select count(*) from jsonb_object_keys(v_preparation)) <> 10
    or not (v_preparation ?& array[
      'schema','strategyAccountId','runId','sourceActionId','revisionSha256',
      'actionType','status','capturedAt','ledgerHead','material'
    ]::text[])
    or v_preparation->>'schema'
       <> 'twofold.corporate_action_account_preparation/v1'
    or v_preparation->>'strategyAccountId' <> p_strategy_account_id::text
    or v_preparation->>'runId' <> p_run_id::text
    or v_preparation->>'sourceActionId' <> p_source_action_id::text
    or v_preparation->>'revisionSha256' <> p_revision_sha256
    or v_preparation->>'capturedAt' <> to_char(p_captured_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    or v_action_type <> v_revision.action_type
    or v_status not in ('PREPARED','NO_POSITION','NO_ENTITLEMENT')
    or jsonb_typeof(v_preparation->'ledgerHead') <> 'object'
    or v_preparation#>>'{ledgerHead,sequence}' <> v_head.head_sequence::text
    or v_preparation#>>'{ledgerHead,sha256}' <> v_head.head_sha256
    or jsonb_typeof(v_preparation->'material') <> 'object'
    or v_preparation#>>'{material,actionType}' <> v_action_type
  then
    raise exception 'corporate-action preparation envelope is invalid'
      using errcode = '22023';
  end if;

  if v_action_type = 'CASH_DIVIDEND' then
    v_effective_at := (v_preparation#>>'{material,entitlement,exDateOpenAt}')::timestamptz;
    if v_status not in ('PREPARED','NO_ENTITLEMENT')
      or v_preparation#>>'{material,entitlement,schema}'
         <> 'twofold.cash_dividend_entitlement/v1'
      or v_preparation#>>'{material,entitlement,capturedAt}'
         <> v_preparation->>'capturedAt'
      or v_preparation#>>'{material,entitlement,ledgerHeadSequence}'
         <> v_head.head_sequence::text
      or v_preparation#>>'{material,entitlement,ledgerHeadSha256}'
         <> v_head.head_sha256
      or v_preparation#>>'{material,entitlement,quantity}'
         !~ '^(0|[1-9][0-9]*)$'
      or (v_status = 'NO_ENTITLEMENT')
         <> (v_preparation#>>'{material,entitlement,quantity}' = '0')
    then
      raise exception 'cash-dividend entitlement preparation is invalid'
        using errcode = '22023';
    end if;
  else
    v_effective_at := (v_preparation#>>'{material,application,effectiveAt}')::timestamptz;
    if v_status not in ('PREPARED','NO_POSITION')
      or v_preparation#>>'{material,application,sourceActionId}'
         <> p_source_action_id::text
      or v_preparation#>>'{material,application,revisionSha256}'
         <> p_revision_sha256
      or (v_status = 'NO_POSITION')
         <> (v_preparation#>>'{material,application,status}' = 'NO_POSITION')
    then
      raise exception 'split preparation is invalid' using errcode = '22023';
    end if;
  end if;
  if v_revision.ex_date is null or v_effective_at::date <> v_revision.ex_date
    or p_captured_at >= v_effective_at
  then
    raise exception 'corporate-action preparation misses the pre-open fence'
      using errcode = '22023';
  end if;

  v_event := public.append_event(
    p_run_id, 'run', p_expected_run_stream_seq,
    'portfolio.corporate_action_prepared', '1',
    'corporate-action-preparation:' || p_preparation_id::text,
    'worker', p_recorded_by, p_captured_at,
    jsonb_build_object(
      'preparationId', p_preparation_id::text,
      'sourceActionId', p_source_action_id::text,
      'revisionSha256', p_revision_sha256,
      'actionType', v_action_type,
      'status', v_status,
      'contentSha256', p_content_sha256
    ), jsonb_build_object(
      'artifactSchema', 'twofold.corporate_action_account_preparation/v1'
    ), p_event_id, p_source_action_id, null,
    v_revision.ex_date, v_revision.payable_date
  );
  insert into public.corporate_action_account_preparation (
    preparation_id,idempotency_key,strategy_account_id,run_id,
    source_action_id,revision_sha256,action_type,status,
    ledger_head_sequence,ledger_head_sha256,artifact_schema,
    preparation_canonical_json,preparation,content_sha256,captured_at,
    source_event_id,source_stream_seq,recorded_by
  ) values (
    p_preparation_id,p_idempotency_key,p_strategy_account_id,p_run_id,
    p_source_action_id,p_revision_sha256,v_action_type,v_status,
    v_head.head_sequence,v_head.head_sha256,
    'twofold.corporate_action_account_preparation/v1',
    p_preparation_canonical_json,v_preparation,p_content_sha256,p_captured_at,
    v_event.event_id,v_event.stream_seq,p_recorded_by
  ) returning * into v_inserted;
  return public.corporate_action_preparation_result(v_inserted);
end;
$$;

create or replace function public.commit_corporate_action_account_application(
  p_idempotency_key text,
  p_application_id uuid,
  p_strategy_account_id uuid,
  p_run_id uuid,
  p_source_action_id uuid,
  p_revision_sha256 text,
  p_application_canonical_json text,
  p_content_sha256 text,
  p_applied_at timestamptz,
  p_expected_run_stream_seq bigint,
  p_event_id uuid,
  p_recorded_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_existing public.corporate_action_account_application%rowtype;
  v_account public.strategy_account%rowtype;
  v_head public.strategy_ledger_head%rowtype;
  v_revision public.corporate_action_revision%rowtype;
  v_prepared public.corporate_action_account_preparation%rowtype;
  v_current_revision text;
  v_application jsonb;
  v_mutation jsonb;
  v_mutation_text text;
  v_mutation_sha text;
  v_expected_final_sha text;
  v_status text;
  v_action_type text;
  v_event public.event_stream%rowtype;
  v_inserted public.corporate_action_account_application%rowtype;
  v_cash numeric;
  v_reserve numeric;
  v_buying_power numeric;
  v_decimal_pattern text := '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$';
begin
  if p_idempotency_key is null or p_idempotency_key = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_application_id is null or p_strategy_account_id is null
    or p_run_id is null or p_source_action_id is null
    or p_revision_sha256 !~ '^[0-9a-f]{64}$'
    or p_application_canonical_json is null or p_application_canonical_json = ''
    or p_application_canonical_json is distinct from btrim(p_application_canonical_json)
    or p_content_sha256 !~ '^[0-9a-f]{64}$'
    or p_applied_at is null or p_expected_run_stream_seq is null
    or p_expected_run_stream_seq < 0 or p_event_id is null
    or p_recorded_by is null or p_recorded_by = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid corporate-action application header'
      using errcode = '22023';
  end if;
  begin v_application := p_application_canonical_json::jsonb;
  exception when others then
    raise exception 'corporate-action application bytes are not valid JSON'
      using errcode = '22023';
  end;
  if encode(extensions.digest(convert_to(p_application_canonical_json, 'UTF8'),
      'sha256'), 'hex') is distinct from p_content_sha256
    or p_application_id is distinct from public.deterministic_uuid_from_sha256(
      'twofold.corporate_action_account_application/v1', p_content_sha256)
    or p_event_id is distinct from public.deterministic_uuid_from_sha256(
      'twofold.event.corporate_action_account_application/v1',
      p_application_id::text)
  then
    raise exception 'corporate-action application content identity is invalid'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'corporate-action-application:' || p_strategy_account_id::text || ':'
      || p_source_action_id::text, 0));
  select * into v_existing from public.corporate_action_account_application
   where idempotency_key = p_idempotency_key
      or application_id = p_application_id
      or (strategy_account_id = p_strategy_account_id
          and source_action_id = p_source_action_id
          and revision_sha256 = p_revision_sha256)
   limit 1;
  if found then
    if v_existing.idempotency_key is distinct from p_idempotency_key
      or v_existing.application_id is distinct from p_application_id
      or v_existing.strategy_account_id is distinct from p_strategy_account_id
      or v_existing.run_id is distinct from p_run_id
      or v_existing.source_action_id is distinct from p_source_action_id
      or v_existing.revision_sha256 is distinct from p_revision_sha256
      or v_existing.application_canonical_json
           is distinct from p_application_canonical_json
      or v_existing.content_sha256 is distinct from p_content_sha256
      or v_existing.applied_at is distinct from p_applied_at
      or v_existing.source_event_id is distinct from p_event_id
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'corporate-action application identity was reused with different content'
        using errcode = '23505';
    end if;
    return public.corporate_action_application_result(v_existing);
  end if;

  select * into v_account from public.strategy_account
   where strategy_account_id = p_strategy_account_id and run_id = p_run_id
     and live_trading is false and base_currency = 'USD';
  if not found then
    raise exception 'corporate-action application account is invalid'
      using errcode = '23503';
  end if;
  select * into v_revision from public.corporate_action_revision
   where source_action_id = p_source_action_id
     and revision_sha256 = p_revision_sha256;
  if not found or v_revision.evidence_status <> 'COMPLETE'
    or v_revision.interpretation not in ('SPLIT', 'CASH_DIVIDEND')
  then
    raise exception 'corporate-action revision is not application-ready'
      using errcode = '55000';
  end if;
  select observation.revision_sha256 into v_current_revision
    from public.corporate_action_scan_revision as observation
    join public.corporate_action_scan as scan on scan.scan_id = observation.scan_id
   where observation.source_action_id = p_source_action_id
     and scan.observed_at <= p_applied_at
   order by scan.observed_at desc, scan.scan_id desc
   limit 1;
  if v_current_revision is distinct from p_revision_sha256 then
    raise exception 'corporate-action application does not use the latest visible revision'
      using errcode = '40001';
  end if;

  select * into v_prepared from public.corporate_action_account_preparation
   where strategy_account_id = p_strategy_account_id
     and source_action_id = p_source_action_id
     and revision_sha256 = p_revision_sha256;
  if not found then
    raise exception 'corporate-action application has no pre-open preparation'
      using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('twofold-ledger:' || p_strategy_account_id::text, 0));
  select * into v_head from public.strategy_ledger_head
   where strategy_account_id = p_strategy_account_id for update;
  if not found then
    raise exception 'strategy ledger head is not initialized' using errcode = '55000';
  end if;

  v_action_type := v_application->>'actionType';
  v_status := v_application->>'status';
  v_mutation_text := v_application->>'mutationCanonicalJson';
  begin v_mutation := v_mutation_text::jsonb;
  exception when others then
    raise exception 'corporate-action mutation bytes are not valid JSON'
      using errcode = '22023';
  end;
  v_mutation_sha := encode(extensions.digest(convert_to(v_mutation_text, 'UTF8'),
    'sha256'), 'hex');
  if jsonb_typeof(v_application) <> 'object'
    or public.jsonb_contains_number(v_application)
    or (select count(*) from jsonb_object_keys(v_application)) <> 17
    or not (v_application ?& array[
      'schema','strategyAccountId','runId','sourceActionId','revisionSha256',
      'actionType','status','recordedAt','openingLedgerHead',
      'preparationSha256','mutationCanonicalJson','mutationSha256',
      'application','positions','ledger','cash','finalLedgerHead'
    ]::text[])
    or v_application->>'schema'
       <> 'twofold.corporate_action_account_application/v1'
    or v_application->>'strategyAccountId' <> p_strategy_account_id::text
    or v_application->>'runId' <> p_run_id::text
    or v_application->>'sourceActionId' <> p_source_action_id::text
    or v_application->>'revisionSha256' <> p_revision_sha256
    or v_application->>'recordedAt' <> to_char(p_applied_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    or v_application->>'preparationSha256' <> v_prepared.content_sha256
    or v_action_type <> v_revision.action_type
    or v_status not in ('APPLIED','NO_POSITION','NO_ENTITLEMENT')
    or v_application->>'mutationSha256' <> v_mutation_sha
    or jsonb_typeof(v_application->'application') <> 'object'
    or v_application#>>'{application,sourceActionId}' <> p_source_action_id::text
    or v_application#>>'{application,revisionSha256}' <> p_revision_sha256
    or v_application#>>'{application,status}' <> v_status
    or jsonb_typeof(v_application->'positions') <> 'array'
    or jsonb_typeof(v_application->'ledger') <> 'object'
    or jsonb_typeof(v_application->'cash') <> 'object'
    or jsonb_typeof(v_application->'openingLedgerHead') <> 'object'
    or jsonb_typeof(v_application->'finalLedgerHead') <> 'object'
    or v_application#>>'{openingLedgerHead,sequence}' <> v_head.head_sequence::text
    or v_application#>>'{openingLedgerHead,sha256}' <> v_head.head_sha256
  then
    raise exception 'corporate-action application envelope is invalid'
      using errcode = '22023';
  end if;

  if v_mutation is distinct from jsonb_build_object(
      'schema','twofold.corporate_action_account_mutation/v1',
      'strategyAccountId',p_strategy_account_id::text,
      'runId',p_run_id::text,
      'sourceActionId',p_source_action_id::text,
      'revisionSha256',p_revision_sha256,
      'preparationSha256',v_prepared.content_sha256,
      'actionType',v_action_type,
      'status',v_status,
      'recordedAt',v_application->>'recordedAt',
      'application',v_application->'application'
    )
  then
    raise exception 'corporate-action mutation bytes do not bind the application'
      using errcode = '22023';
  end if;

  if (v_action_type = 'CASH_DIVIDEND' and (
        v_status not in ('APPLIED','NO_ENTITLEMENT')
        or v_application#>'{application,entitlement}'
           is distinct from v_prepared.preparation#>'{material,entitlement}'
        or p_applied_at::date < v_revision.payable_date
      )) or (v_action_type <> 'CASH_DIVIDEND' and (
        v_status not in ('APPLIED','NO_POSITION')
        or v_application->'application'
           is distinct from v_prepared.preparation#>'{material,application}'
        or p_applied_at < (v_prepared.preparation#>>
          '{material,application,effectiveAt}')::timestamptz
      ))
    or (v_prepared.status = 'PREPARED') <> (v_status = 'APPLIED')
    or (v_prepared.status = 'NO_POSITION') <> (v_status = 'NO_POSITION')
    or (v_prepared.status = 'NO_ENTITLEMENT') <> (v_status = 'NO_ENTITLEMENT')
  then
    raise exception 'corporate-action application does not match its due preparation'
      using errcode = '22023';
  end if;

  if v_application#>>'{cash,settled}' !~ v_decimal_pattern
    or v_application#>>'{cash,taxReserve}' !~ v_decimal_pattern
    or v_application#>>'{cash,buyingPower}' !~ v_decimal_pattern
    or v_application#>>'{ledger,transactionCount}' !~ '^(0|[1-9][0-9]*)$'
    or jsonb_typeof(v_application#>'{ledger,balances}') <> 'array'
    or jsonb_typeof(v_application#>'{ledger,positions}') <> 'array'
    or jsonb_typeof(v_application#>'{application,ledgerTransactions}') <> 'array'
    or (v_status = 'APPLIED')
       <> (jsonb_array_length(v_application#>'{application,ledgerTransactions}') > 0)
  then
    raise exception 'corporate-action ledger or cash projection is invalid'
      using errcode = '22023';
  end if;
  v_cash := (v_application#>>'{cash,settled}')::numeric;
  v_reserve := (v_application#>>'{cash,taxReserve}')::numeric;
  v_buying_power := (v_application#>>'{cash,buyingPower}')::numeric;
  if v_cash - v_reserve <> v_buying_power
    or v_reserve > v_cash
    or coalesce((select (item.value->>'amount')::numeric
      from jsonb_array_elements(v_application#>'{ledger,balances}') as item(value)
     where item.value->>'accountId' = 'asset.cash'
       and item.value->>'currency' = v_account.base_currency), 0) <> v_cash
    or (select count(*) from jsonb_array_elements(
      v_application#>'{ledger,balances}') as item(value)
     where item.value->>'accountId' = 'asset.cash'
       and item.value->>'currency' = v_account.base_currency) > 1
  then
    raise exception 'corporate-action cash does not reconcile to ledger projection'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_application->'positions') as item(value)
     where item.value->>'quantity' !~ '^(0|[1-9][0-9]*)$'
        or item.value->>'grossCost' !~ v_decimal_pattern
        or jsonb_typeof(item.value->'lots') <> 'array'
        or jsonb_typeof(item.value->'acquisitionFxBindings') <> 'array'
        or jsonb_array_length(item.value->'lots')
           <> jsonb_array_length(item.value->'acquisitionFxBindings')
        or coalesce((select sum((lot.value->>'quantity')::numeric)
          from jsonb_array_elements(item.value->'lots') as lot(value)),0)
           <> (item.value->>'quantity')::numeric
        or coalesce((select sum((lot.value->>'grossPurchasePrice')::numeric)
          from jsonb_array_elements(item.value->'lots') as lot(value)),0)
           <> (item.value->>'grossCost')::numeric
  ) or exists (
    select 1 from jsonb_array_elements(v_application#>'{ledger,positions}') as item(value)
     where item.value->>'accountId' = 'securities.inventory'
       and not exists (
         select 1 from jsonb_array_elements(v_application->'positions') as position(value)
          where position.value->>'instrumentId' = item.value->>'instrumentId'
            and position.value->>'quantity' = item.value->>'quantity'
       )
  ) then
    raise exception 'corporate-action positions do not reconcile to ledger projection'
      using errcode = '22023';
  end if;

  if v_status = 'APPLIED' then
    if v_application#>>'{finalLedgerHead,sequence}'
         <> (v_head.head_sequence + 1)::text then
      raise exception 'corporate-action final head must advance exactly once'
        using errcode = '22023';
    end if;
    v_expected_final_sha := encode(extensions.digest(convert_to(format(
      '{"corporateActionMutationSha256":"%s","previousHeadSha256":"%s","sequence":"%s"}',
      v_mutation_sha, v_head.head_sha256, (v_head.head_sequence + 1)::text
    ), 'UTF8'), 'sha256'), 'hex');
  else
    v_expected_final_sha := v_head.head_sha256;
    if v_application#>>'{finalLedgerHead,sequence}' <> v_head.head_sequence::text
    then
      raise exception 'no-op corporate action cannot advance the ledger head'
        using errcode = '22023';
    end if;
  end if;
  if v_application#>>'{finalLedgerHead,sha256}' <> v_expected_final_sha then
    raise exception 'corporate-action final ledger hash is invalid'
      using errcode = '22023';
  end if;

  v_event := public.append_event(
    p_run_id, 'run', p_expected_run_stream_seq,
    'portfolio.corporate_action_application_recorded', '1',
    'corporate-action-application:' || p_application_id::text,
    'worker', p_recorded_by, p_applied_at,
    jsonb_build_object(
      'applicationId',p_application_id::text,
      'preparationId',v_prepared.preparation_id::text,
      'sourceActionId',p_source_action_id::text,
      'revisionSha256',p_revision_sha256,
      'actionType',v_action_type,
      'status',v_status,
      'mutationSha256',v_mutation_sha,
      'contentSha256',p_content_sha256,
      'finalLedgerHead',v_application->'finalLedgerHead'
    ), jsonb_build_object(
      'artifactSchema','twofold.corporate_action_account_application/v1'
    ), p_event_id, p_source_action_id, v_prepared.source_event_id,
    v_revision.ex_date, v_revision.payable_date
  );
  insert into public.corporate_action_account_application (
    application_id,idempotency_key,strategy_account_id,run_id,
    preparation_id,preparation_sha256,source_action_id,revision_sha256,
    action_type,status,opening_head_sequence,opening_head_sha256,
    final_head_sequence,final_head_sha256,mutation_canonical_json,
    mutation_sha256,artifact_schema,application_canonical_json,application,
    content_sha256,applied_at,source_event_id,source_stream_seq,recorded_by
  ) values (
    p_application_id,p_idempotency_key,p_strategy_account_id,p_run_id,
    v_prepared.preparation_id,v_prepared.content_sha256,p_source_action_id,
    p_revision_sha256,v_action_type,v_status,v_head.head_sequence,
    v_head.head_sha256,(v_application#>>'{finalLedgerHead,sequence}')::bigint,
    v_expected_final_sha,v_mutation_text,v_mutation_sha,
    'twofold.corporate_action_account_application/v1',
    p_application_canonical_json,v_application,p_content_sha256,p_applied_at,
    v_event.event_id,v_event.stream_seq,p_recorded_by
  ) returning * into v_inserted;
  if v_status = 'APPLIED' then
    perform set_config('twofold.atomic_ledger_mutation','on',true);
    update public.strategy_ledger_head
       set head_sequence = v_inserted.final_head_sequence,
           head_sha256 = v_inserted.final_head_sha256,
           corporate_action_mutation_count = corporate_action_mutation_count + 1,
           updated_at = clock_timestamp()
     where strategy_account_id = p_strategy_account_id;
    perform set_config('twofold.atomic_ledger_mutation','off',true);
  end if;
  return public.corporate_action_application_result(v_inserted);
end;
$$;

create or replace function public.strategy_ledger_head_result(
  p_head public.strategy_ledger_head
)
returns jsonb
language sql
stable
strict
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schema','twofold.strategy_ledger_head_result/v1',
    'strategyAccountId',p_head.strategy_account_id::text,
    'headSequence',p_head.head_sequence::text,
    'headSha256',p_head.head_sha256,
    'lastSettlementId',case when p_head.last_settlement_id is null then null
      else to_jsonb(p_head.last_settlement_id::text) end,
    'accountingTransactionCount',p_head.accounting_transaction_count::text,
    'lotOriginCount',p_head.lot_origin_count::text,
    'acquisitionFxBindingCount',p_head.acquisition_fx_binding_count::text,
    'settlementCount',p_head.settlement_count::text,
    'corporateActionMutationCount',p_head.corporate_action_mutation_count::text,
    'initializedBy',p_head.initialized_by,
    'initializedAt',to_char(p_head.initialized_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(p_head.updated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
$$;

alter table public.corporate_action_account_preparation enable row level security;
alter table public.corporate_action_account_application enable row level security;
revoke all on table public.corporate_action_account_preparation
  from public, anon, authenticated, service_role;
revoke all on table public.corporate_action_account_application
  from public, anon, authenticated, service_role;
revoke all on function public.corporate_action_preparation_result(
  public.corporate_action_account_preparation) from public, anon, authenticated;
revoke all on function public.corporate_action_application_result(
  public.corporate_action_account_application) from public, anon, authenticated;
revoke all on function public.register_corporate_action_account_preparation(
  text,uuid,uuid,uuid,uuid,text,text,text,timestamptz,bigint,uuid,text
) from public, anon, authenticated;
revoke all on function public.commit_corporate_action_account_application(
  text,uuid,uuid,uuid,uuid,text,text,text,timestamptz,bigint,uuid,text
) from public, anon, authenticated;
grant execute on function public.register_corporate_action_account_preparation(
  text,uuid,uuid,uuid,uuid,text,text,text,timestamptz,bigint,uuid,text
) to service_role;
grant execute on function public.commit_corporate_action_account_application(
  text,uuid,uuid,uuid,uuid,text,text,text,timestamptz,bigint,uuid,text
) to service_role;

commit;
