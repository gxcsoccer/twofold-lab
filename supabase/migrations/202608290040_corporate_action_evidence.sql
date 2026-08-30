-- Raw daily bars are intentionally unadjusted. Corporate actions therefore
-- need their own source/revision boundary: otherwise a split can multiply or
-- destroy NAV and a dividend ex-date can silently penalize one entrant. This
-- migration stores every provider scan and immutable revision. Interpretation
-- and per-account application are separate downstream steps; until an action
-- is applied, the gate reports BLOCKED rather than guessing an economic result.

begin;

alter table public.data_source_version
  drop constraint data_source_version_dataset_check,
  drop constraint data_source_version_feed_check,
  drop constraint data_source_version_timeframe_check,
  drop constraint data_source_version_dataset_timeframe_consistent;
alter table public.data_source_version
  add constraint data_source_version_dataset_check check (dataset in (
    'us_stock_daily_bars', 'us_stock_intraday_open_references',
    'us_corporate_actions'
  )),
  add constraint data_source_version_feed_check check (
    feed in ('sip', 'iex', 'none')
  ),
  add constraint data_source_version_timeframe_check check (
    timeframe in ('1Day', '1Min', 'Event')
  ),
  add constraint data_source_version_dataset_timeframe_consistent check (
    (
      dataset = 'us_stock_daily_bars'
      and timeframe = '1Day'
      and feed in ('sip', 'iex')
    ) or (
      dataset = 'us_stock_intraday_open_references'
      and timeframe = '1Min'
      and feed = 'sip'
    ) or (
      dataset = 'us_corporate_actions'
      and timeframe = 'Event'
      and feed = 'none'
    )
  );

create table public.corporate_action_scan (
  scan_id uuid primary key,
  idempotency_key text not null unique
    check (idempotency_key <> '' and idempotency_key = btrim(idempotency_key)),
  source_version_id uuid not null
    references public.data_source_version(source_version_id),
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  process_date_start date not null,
  process_date_end date not null,
  observed_at timestamptz not null,
  canonical_json text not null check (
    canonical_json <> '' and canonical_json = btrim(canonical_json)
  ),
  scan jsonb not null,
  content_sha256 text not null unique
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by text not null
    check (recorded_by <> '' and recorded_by = btrim(recorded_by)),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint corporate_action_scan_interval check (
    process_date_end >= process_date_start
  ),
  constraint corporate_action_scan_id_deterministic check (
    scan_id = public.deterministic_uuid_from_sha256(
      'twofold.corporate_action_scan/v1', content_sha256
    )
  ),
  constraint corporate_action_scan_payload_object check (
    jsonb_typeof(scan) = 'object'
  ),
  constraint corporate_action_scan_payload_number_free check (
    not public.jsonb_contains_number(scan)
  ),
  constraint corporate_action_scan_bytes_bind_sha check (
    scan = canonical_json::jsonb
    and content_sha256 = encode(
      extensions.digest(convert_to(canonical_json, 'UTF8'), 'sha256'),
      'hex'
    )
  )
);

create index corporate_action_scan_observed_idx
  on public.corporate_action_scan (observed_at desc, scan_id desc);

create table public.corporate_action_scan_page (
  scan_id uuid not null references public.corporate_action_scan(scan_id),
  page_index integer not null check (page_index >= 0),
  raw_artifact_id uuid not null references public.raw_artifact(raw_artifact_id),
  provider_request_id text,
  primary key (scan_id, page_index)
);

create table public.corporate_action_revision (
  source_action_id uuid not null,
  revision_sha256 text not null
    check (revision_sha256 ~ '^[0-9a-f]{64}$'),
  source_version_id uuid not null
    references public.data_source_version(source_version_id),
  action_type text not null check (action_type in (
    'REVERSE_SPLIT', 'FORWARD_SPLIT', 'UNIT_SPLIT', 'CASH_DIVIDEND',
    'STOCK_DIVIDEND', 'SPIN_OFF', 'CASH_MERGER', 'STOCK_MERGER',
    'STOCK_AND_CASH_MERGER', 'REDEMPTION', 'NAME_CHANGE',
    'WORTHLESS_REMOVAL', 'RIGHTS_DISTRIBUTION', 'PARTIAL_CALL',
    'REORGANIZATION', 'CAPITAL_GAINS_DISTRIBUTION'
  )),
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.-]{0,14}$'),
  interpretation text not null check (
    interpretation in ('SPLIT', 'CASH_DIVIDEND', 'UNSUPPORTED')
  ),
  evidence_status text not null check (
    evidence_status in ('COMPLETE', 'INCOMPLETE')
  ),
  process_date date,
  ex_date date,
  record_date date,
  payable_date date,
  raw_canonical_json text not null check (
    raw_canonical_json <> '' and raw_canonical_json = btrim(raw_canonical_json)
  ),
  raw_action jsonb not null,
  normalized_action jsonb not null,
  first_recorded_at timestamptz not null default clock_timestamp(),
  primary key (source_action_id, revision_sha256),
  constraint corporate_action_revision_interpretation check (
    (
      action_type in ('FORWARD_SPLIT', 'REVERSE_SPLIT')
      and interpretation = 'SPLIT'
    ) or (
      action_type = 'CASH_DIVIDEND'
      and interpretation = 'CASH_DIVIDEND'
    ) or (
      action_type not in (
        'FORWARD_SPLIT', 'REVERSE_SPLIT', 'CASH_DIVIDEND'
      ) and interpretation = 'UNSUPPORTED'
    )
  ),
  constraint corporate_action_revision_raw_object check (
    jsonb_typeof(raw_action) = 'object'
  ),
  constraint corporate_action_revision_normalized_object check (
    jsonb_typeof(normalized_action) = 'object'
  ),
  constraint corporate_action_revision_number_free check (
    not public.jsonb_contains_number(raw_action)
    and not public.jsonb_contains_number(normalized_action)
  ),
  constraint corporate_action_revision_raw_bytes_bind_sha check (
    raw_action = raw_canonical_json::jsonb
    and revision_sha256 = encode(
      extensions.digest(convert_to(raw_canonical_json, 'UTF8'), 'sha256'),
      'hex'
    )
  )
);

create index corporate_action_revision_symbol_date_idx
  on public.corporate_action_revision (
    symbol, ex_date, process_date, source_action_id, revision_sha256
  );

create table public.corporate_action_scan_revision (
  scan_id uuid not null references public.corporate_action_scan(scan_id),
  source_action_id uuid not null,
  revision_sha256 text not null,
  action_index integer not null check (action_index >= 0),
  primary key (scan_id, source_action_id),
  unique (scan_id, action_index),
  foreign key (source_action_id, revision_sha256)
    references public.corporate_action_revision(
      source_action_id, revision_sha256
    )
);

comment on table public.corporate_action_scan is
  'One immutable, paginated Alpaca corporate-action observation over a process-date interval; absence is evidence only for this exact scan.';
comment on table public.corporate_action_revision is
  'Content-addressed provider revisions. A later update never rewrites an earlier split, dividend, or unsupported action.';
comment on table public.corporate_action_scan_revision is
  'Many-to-many observation history between scans and immutable action revisions.';

create trigger corporate_action_scan_is_immutable
before update or delete on public.corporate_action_scan
for each row execute function public.reject_immutable_mutation();
create trigger corporate_action_scan_rejects_truncate
before truncate on public.corporate_action_scan
for each statement execute function public.reject_immutable_mutation();
create trigger corporate_action_scan_page_is_immutable
before update or delete on public.corporate_action_scan_page
for each row execute function public.reject_immutable_mutation();
create trigger corporate_action_scan_page_rejects_truncate
before truncate on public.corporate_action_scan_page
for each statement execute function public.reject_immutable_mutation();
create trigger corporate_action_revision_is_immutable
before update or delete on public.corporate_action_revision
for each row execute function public.reject_immutable_mutation();
create trigger corporate_action_revision_rejects_truncate
before truncate on public.corporate_action_revision
for each statement execute function public.reject_immutable_mutation();
create trigger corporate_action_scan_revision_is_immutable
before update or delete on public.corporate_action_scan_revision
for each row execute function public.reject_immutable_mutation();
create trigger corporate_action_scan_revision_rejects_truncate
before truncate on public.corporate_action_scan_revision
for each statement execute function public.reject_immutable_mutation();

create or replace function public.corporate_action_scan_commit_result(
  p_scan public.corporate_action_scan
)
returns jsonb
language sql
volatile
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'twofold.corporate_action_scan_commit_result/v1',
    'scanId', p_scan.scan_id::text,
    'sourceVersionId', p_scan.source_version_id::text,
    'requestFingerprint', p_scan.request_fingerprint,
    'processDateStart', p_scan.process_date_start::text,
    'processDateEnd', p_scan.process_date_end::text,
    'observedAt', to_char(
      p_scan.observed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'contentSha256', p_scan.content_sha256,
    'pageCount', (
      select count(*)::text from public.corporate_action_scan_page as page
       where page.scan_id = p_scan.scan_id
    ),
    'actionCount', (
      select count(*)::text from public.corporate_action_scan_revision as item
       where item.scan_id = p_scan.scan_id
    ),
    'recordedBy', p_scan.recorded_by,
    'recordedAt', to_char(
      p_scan.recorded_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  )
$$;

create or replace function public.register_corporate_action_scan(
  p_idempotency_key text,
  p_source_version_id uuid,
  p_request_fingerprint text,
  p_process_date_start date,
  p_process_date_end date,
  p_observed_at timestamptz,
  p_canonical_json text,
  p_content_sha256 text,
  p_pages jsonb,
  p_actions jsonb,
  p_recorded_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_existing public.corporate_action_scan%rowtype;
  v_inserted public.corporate_action_scan%rowtype;
  v_source public.data_source_version%rowtype;
  v_scan_id uuid;
  v_scan jsonb;
  v_page jsonb;
  v_action jsonb;
  v_raw jsonb;
  v_artifact public.raw_artifact%rowtype;
  v_page_hashes jsonb;
  v_expected_keys text[];
  v_index integer;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_idempotency_key is distinct from btrim(p_idempotency_key)
    or p_source_version_id is null
    or p_request_fingerprint is null
      or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_process_date_start is null or p_process_date_end is null
    or p_process_date_end < p_process_date_start
    or p_observed_at is null
    or p_canonical_json is null or p_canonical_json = ''
    or p_canonical_json is distinct from btrim(p_canonical_json)
    or p_content_sha256 is null
      or p_content_sha256 !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_pages) is distinct from 'array'
    or jsonb_array_length(p_pages) = 0
    or jsonb_typeof(p_actions) is distinct from 'array'
    or public.jsonb_contains_number(p_pages)
    or public.jsonb_contains_number(p_actions)
    or p_recorded_by is null or btrim(p_recorded_by) = ''
    or p_recorded_by is distinct from btrim(p_recorded_by)
  then
    raise exception 'invalid corporate-action scan request'
      using errcode = '22023';
  end if;

  begin
    v_scan := p_canonical_json::jsonb;
  exception when others then
    raise exception 'corporate-action scan bytes are not valid JSON'
      using errcode = '22023';
  end;
  if encode(
    extensions.digest(convert_to(p_canonical_json, 'UTF8'), 'sha256'), 'hex'
  ) is distinct from p_content_sha256 then
    raise exception 'corporate-action scan SHA256 does not match exact bytes'
      using errcode = '22023';
  end if;
  v_scan_id := public.deterministic_uuid_from_sha256(
    'twofold.corporate_action_scan/v1', p_content_sha256
  );
  select coalesce(jsonb_agg(page.value->>'responseSha256'
    order by page.ordinality), '[]'::jsonb) into v_page_hashes
    from jsonb_array_elements(p_pages) with ordinality as page(value, ordinality);
  if jsonb_typeof(v_scan) is distinct from 'object'
    or public.jsonb_contains_number(v_scan)
    or not (v_scan ?& array[
      'schema', 'source', 'processDateStart', 'processDateEnd',
      'observedAt', 'requestFingerprint', 'pageResponseSha256', 'actions'
    ]::text[])
    or (select count(*) from jsonb_object_keys(v_scan)) <> 8
    or v_scan->>'schema'
      is distinct from 'twofold.alpaca_corporate_action_scan/v1'
    or v_scan->>'processDateStart' is distinct from p_process_date_start::text
    or v_scan->>'processDateEnd' is distinct from p_process_date_end::text
    or v_scan->>'observedAt' is distinct from to_char(
      p_observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
    or v_scan->>'requestFingerprint' is distinct from p_request_fingerprint
    or v_scan->'pageResponseSha256' is distinct from v_page_hashes
    or v_scan->'actions' is distinct from p_actions
  then
    raise exception 'corporate-action scan manifest diverges from request'
      using errcode = '22023';
  end if;

  select * into v_source
    from public.data_source_version
   where source_version_id = p_source_version_id
     and provider = 'alpaca'
     and dataset = 'us_corporate_actions'
     and feed = 'none'
     and adjustment = 'raw'
     and timeframe = 'Event';
  if not found then
    raise exception 'corporate-action source version is invalid'
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('corporate-action-scan:' || p_idempotency_key, 0)
  );
  select * into v_existing
    from public.corporate_action_scan
   where idempotency_key = p_idempotency_key or scan_id = v_scan_id
   order by (idempotency_key = p_idempotency_key) desc
   limit 1;
  if found then
    if v_existing.idempotency_key is distinct from p_idempotency_key
      or v_existing.scan_id is distinct from v_scan_id
      or v_existing.source_version_id is distinct from p_source_version_id
      or v_existing.request_fingerprint is distinct from p_request_fingerprint
      or v_existing.process_date_start is distinct from p_process_date_start
      or v_existing.process_date_end is distinct from p_process_date_end
      or v_existing.observed_at is distinct from p_observed_at
      or v_existing.canonical_json is distinct from p_canonical_json
      or v_existing.content_sha256 is distinct from p_content_sha256
      or v_existing.recorded_by is distinct from p_recorded_by
    then
      raise exception 'corporate-action scan identity was reused with different content'
        using errcode = '23505';
    end if;
    return public.corporate_action_scan_commit_result(v_existing);
  end if;

  insert into public.corporate_action_scan (
    scan_id, idempotency_key, source_version_id, request_fingerprint,
    process_date_start, process_date_end, observed_at, canonical_json,
    scan, content_sha256, recorded_by
  ) values (
    v_scan_id, p_idempotency_key, p_source_version_id,
    p_request_fingerprint, p_process_date_start, p_process_date_end,
    p_observed_at, p_canonical_json, v_scan, p_content_sha256,
    p_recorded_by
  ) returning * into v_inserted;

  for v_page, v_index in
    select page.value, page.ordinality::integer - 1
      from jsonb_array_elements(p_pages) with ordinality as page(value, ordinality)
     order by page.ordinality
  loop
    if jsonb_typeof(v_page) is distinct from 'object'
      or not (v_page ?& array[
        'pageIndex', 'providerRequestId', 'storageBucket', 'objectPath',
        'byteSize', 'responseSha256'
      ]::text[])
      or (select count(*) from jsonb_object_keys(v_page)) <> 6
      or v_page->>'pageIndex' !~ '^(0|[1-9][0-9]*)$'
      or (v_page->>'pageIndex')::integer is distinct from v_index
      or v_page->>'storageBucket' is distinct from 'twofold-private-artifacts'
      or v_page->>'byteSize' !~ '^[1-9][0-9]*$'
      or v_page->>'responseSha256' !~ '^[0-9a-f]{64}$'
      or v_page->>'objectPath' is distinct from (
        'raw/alpaca/' || left((v_page->>'responseSha256'), 2) || '/'
          || (v_page->>'responseSha256') || '.json'
      )
      or (
        v_page->'providerRequestId' <> 'null'::jsonb
        and jsonb_typeof(v_page->'providerRequestId') <> 'string'
      )
    then
      raise exception 'corporate-action scan page is invalid'
        using errcode = '22023';
    end if;
    insert into public.raw_artifact (
      storage_bucket, object_path, content_type, byte_size, response_sha256
    ) values (
      v_page->>'storageBucket', v_page->>'objectPath', 'application/json',
      (v_page->>'byteSize')::bigint, v_page->>'responseSha256'
    ) on conflict (response_sha256) do nothing;
    select * into v_artifact from public.raw_artifact
     where response_sha256 = v_page->>'responseSha256';
    if not found
      or v_artifact.storage_bucket is distinct from v_page->>'storageBucket'
      or v_artifact.object_path is distinct from v_page->>'objectPath'
      or v_artifact.byte_size is distinct from (v_page->>'byteSize')::bigint
    then
      raise exception 'corporate-action raw artifact identity conflict'
        using errcode = '23505';
    end if;
    insert into public.corporate_action_scan_page (
      scan_id, page_index, raw_artifact_id, provider_request_id
    ) values (
      v_scan_id, v_index, v_artifact.raw_artifact_id,
      nullif(v_page->>'providerRequestId', '')
    );
  end loop;

  for v_action, v_index in
    select item.value, item.ordinality::integer - 1
      from jsonb_array_elements(p_actions) with ordinality as item(value, ordinality)
     order by item.ordinality
  loop
    if jsonb_typeof(v_action) is distinct from 'object'
      or not (v_action ?& array[
        'schema', 'source', 'sourceActionId', 'revisionSha256', 'type',
        'symbol', 'status', 'interpretation', 'processDate', 'exDate',
        'recordDate', 'payableDate', 'rawCanonicalJson'
      ]::text[])
      or v_action->>'schema'
        is distinct from 'twofold.alpaca_corporate_action_revision/v1'
      or v_action->>'source'
        is distinct from 'ALPACA_CORPORATE_ACTIONS_V1'
      or v_action->>'sourceActionId'
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or v_action->>'revisionSha256' !~ '^[0-9a-f]{64}$'
      or v_action->>'type' not in (
        'REVERSE_SPLIT', 'FORWARD_SPLIT', 'UNIT_SPLIT', 'CASH_DIVIDEND',
        'STOCK_DIVIDEND', 'SPIN_OFF', 'CASH_MERGER', 'STOCK_MERGER',
        'STOCK_AND_CASH_MERGER', 'REDEMPTION', 'NAME_CHANGE',
        'WORTHLESS_REMOVAL', 'RIGHTS_DISTRIBUTION', 'PARTIAL_CALL',
        'REORGANIZATION', 'CAPITAL_GAINS_DISTRIBUTION'
      )
      or v_action->>'symbol' !~ '^[A-Z][A-Z0-9.-]{0,14}$'
      or v_action->>'status' not in ('COMPLETE', 'INCOMPLETE')
      or v_action->>'interpretation' not in (
        'SPLIT', 'CASH_DIVIDEND', 'UNSUPPORTED'
      )
      or (v_action->'processDate' <> 'null'::jsonb
        and v_action->>'processDate' !~ '^\d{4}-\d{2}-\d{2}$')
      or (v_action->'exDate' <> 'null'::jsonb
        and v_action->>'exDate' !~ '^\d{4}-\d{2}-\d{2}$')
      or (v_action->'recordDate' <> 'null'::jsonb
        and v_action->>'recordDate' !~ '^\d{4}-\d{2}-\d{2}$')
      or (v_action->'payableDate' <> 'null'::jsonb
        and v_action->>'payableDate' !~ '^\d{4}-\d{2}-\d{2}$')
    then
      raise exception 'corporate-action revision envelope is invalid'
        using errcode = '22023';
    end if;
    if (v_action->>'type') in ('FORWARD_SPLIT', 'REVERSE_SPLIT') then
      v_expected_keys := array[
        'schema', 'source', 'sourceActionId', 'revisionSha256', 'type',
        'symbol', 'status', 'interpretation', 'processDate', 'exDate',
        'recordDate', 'payableDate', 'rawCanonicalJson', 'oldRate', 'newRate'
      ];
      if v_action->>'interpretation' is distinct from 'SPLIT'
        or (select count(*) from jsonb_object_keys(v_action)) <> 15
        or not (v_action ?& v_expected_keys)
        or (v_action->'oldRate' <> 'null'::jsonb
          and v_action->>'oldRate'
            !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$')
        or (v_action->'newRate' <> 'null'::jsonb
          and v_action->>'newRate'
            !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$')
        or (
          v_action->>'status' = 'COMPLETE'
          and (
            v_action->'processDate' = 'null'::jsonb
            or v_action->'exDate' = 'null'::jsonb
            or v_action->'oldRate' = 'null'::jsonb
            or v_action->'newRate' = 'null'::jsonb
            or (
              v_action->>'type' = 'FORWARD_SPLIT'
              and (v_action->>'newRate')::numeric
                <= (v_action->>'oldRate')::numeric
            )
            or (
              v_action->>'type' = 'REVERSE_SPLIT'
              and (v_action->>'newRate')::numeric
                >= (v_action->>'oldRate')::numeric
            )
          )
        )
      then
        raise exception 'split corporate-action revision is invalid'
          using errcode = '22023';
      end if;
    elsif v_action->>'type' = 'CASH_DIVIDEND' then
      v_expected_keys := array[
        'schema', 'source', 'sourceActionId', 'revisionSha256', 'type',
        'symbol', 'status', 'interpretation', 'processDate', 'exDate',
        'recordDate', 'payableDate', 'rawCanonicalJson', 'rate', 'foreign',
        'special'
      ];
      if v_action->>'interpretation' is distinct from 'CASH_DIVIDEND'
        or (select count(*) from jsonb_object_keys(v_action)) <> 16
        or not (v_action ?& v_expected_keys)
        or (v_action->'rate' <> 'null'::jsonb
          and v_action->>'rate'
            !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$')
        or (v_action->'foreign' <> 'null'::jsonb
          and jsonb_typeof(v_action->'foreign') <> 'boolean')
        or (v_action->'special' <> 'null'::jsonb
          and jsonb_typeof(v_action->'special') <> 'boolean')
        or (
          v_action->>'status' = 'COMPLETE'
          and (
            v_action->'processDate' = 'null'::jsonb
            or v_action->'exDate' = 'null'::jsonb
            or v_action->'payableDate' = 'null'::jsonb
            or v_action->'rate' = 'null'::jsonb
            or v_action->'foreign' = 'null'::jsonb
            or v_action->'special' = 'null'::jsonb
          )
        )
      then
        raise exception 'cash-dividend corporate-action revision is invalid'
          using errcode = '22023';
      end if;
    else
      v_expected_keys := array[
        'schema', 'source', 'sourceActionId', 'revisionSha256', 'type',
        'symbol', 'status', 'interpretation', 'processDate', 'exDate',
        'recordDate', 'payableDate', 'rawCanonicalJson'
      ];
      if v_action->>'interpretation' is distinct from 'UNSUPPORTED'
        or (select count(*) from jsonb_object_keys(v_action)) <> 13
        or not (v_action ?& v_expected_keys)
      then
        raise exception 'unsupported corporate-action revision is invalid'
          using errcode = '22023';
      end if;
    end if;
    begin
      v_raw := (v_action->>'rawCanonicalJson')::jsonb;
    exception when others then
      raise exception 'corporate-action raw revision is not valid JSON'
        using errcode = '22023';
    end;
    if jsonb_typeof(v_raw) is distinct from 'object'
      or public.jsonb_contains_number(v_raw)
      or encode(extensions.digest(
        convert_to(v_action->>'rawCanonicalJson', 'UTF8'), 'sha256'
      ), 'hex') is distinct from v_action->>'revisionSha256'
    then
      raise exception 'corporate-action revision SHA256 does not bind raw bytes'
        using errcode = '22023';
    end if;
    insert into public.corporate_action_revision (
      source_action_id, revision_sha256, source_version_id, action_type,
      symbol, interpretation, evidence_status, process_date, ex_date,
      record_date, payable_date, raw_canonical_json, raw_action,
      normalized_action
    ) values (
      (v_action->>'sourceActionId')::uuid,
      v_action->>'revisionSha256', p_source_version_id,
      v_action->>'type', v_action->>'symbol',
      v_action->>'interpretation', v_action->>'status',
      nullif(v_action->>'processDate', '')::date,
      nullif(v_action->>'exDate', '')::date,
      nullif(v_action->>'recordDate', '')::date,
      nullif(v_action->>'payableDate', '')::date,
      v_action->>'rawCanonicalJson', v_raw, v_action
    ) on conflict (source_action_id, revision_sha256) do nothing;
    if not exists (
      select 1 from public.corporate_action_revision as revision
       where revision.source_action_id = (v_action->>'sourceActionId')::uuid
         and revision.revision_sha256 = v_action->>'revisionSha256'
         and revision.source_version_id = p_source_version_id
         and revision.normalized_action = v_action
    ) then
      raise exception 'corporate-action revision identity conflict'
        using errcode = '23505';
    end if;
    insert into public.corporate_action_scan_revision (
      scan_id, source_action_id, revision_sha256, action_index
    ) values (
      v_scan_id, (v_action->>'sourceActionId')::uuid,
      v_action->>'revisionSha256', v_index
    );
  end loop;

  return public.corporate_action_scan_commit_result(v_inserted);
end;
$$;

create or replace function public.get_corporate_action_gate(
  p_symbols text[],
  p_through_date date,
  p_as_of timestamptz
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_scan public.corporate_action_scan%rowtype;
  v_actions jsonb;
  v_status text;
  v_reason text;
  v_result jsonb;
begin
  if p_symbols is null or cardinality(p_symbols) = 0
    or p_through_date is null or p_as_of is null
    or exists (
      select 1 from unnest(p_symbols) with ordinality as symbol(value, ordinal)
       where symbol.value !~ '^[A-Z][A-Z0-9.-]{0,14}$'
          or exists (
            select 1 from unnest(p_symbols) with ordinality as prior(value, ordinal)
             where prior.ordinal < symbol.ordinal
               and prior.value >= symbol.value
          )
    )
  then
    raise exception 'invalid corporate-action gate request'
      using errcode = '22023';
  end if;
  select * into v_scan from public.corporate_action_scan
   where observed_at <= p_as_of
   order by observed_at desc, scan_id desc
   limit 1;
  if not found then
    v_status := 'NO_SCAN';
    v_reason := 'CORPORATE_ACTION_SCAN_REQUIRED';
    v_actions := '[]'::jsonb;
  elsif v_scan.process_date_end < p_through_date then
    v_status := 'STALE_SCAN';
    v_reason := 'CORPORATE_ACTION_SCAN_COVERAGE_INCOMPLETE';
    v_actions := '[]'::jsonb;
  else
    with latest_observation as (
      select distinct on (revision.source_action_id)
        revision.*,
        scan.observed_at
      from public.corporate_action_scan_revision as observation
      join public.corporate_action_scan as scan
        on scan.scan_id = observation.scan_id
      join public.corporate_action_revision as revision
        on revision.source_action_id = observation.source_action_id
       and revision.revision_sha256 = observation.revision_sha256
      where scan.observed_at <= p_as_of
        and revision.symbol = any(p_symbols)
      order by revision.source_action_id, scan.observed_at desc,
               scan.scan_id desc
    ), relevant as (
      select * from latest_observation
       where (ex_date is not null and ex_date <= p_through_date)
          or (
            ex_date is null
            and process_date is not null
            and process_date <= p_through_date
          )
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'sourceActionId', source_action_id::text,
      'revisionSha256', revision_sha256,
      'symbol', symbol,
      'type', action_type,
      'interpretation', interpretation,
      'evidenceStatus', evidence_status,
      'processDate', case when process_date is null then null
        else to_jsonb(process_date::text) end,
      'exDate', case when ex_date is null then null
        else to_jsonb(ex_date::text) end,
      'payableDate', case when payable_date is null then null
        else to_jsonb(payable_date::text) end,
      'observedAt', to_char(
        observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    ) order by coalesce(ex_date, process_date), action_type, source_action_id),
      '[]'::jsonb) into v_actions
      from relevant;
    if jsonb_array_length(v_actions) = 0 then
      v_status := 'CLEAR';
      v_reason := null;
    else
      v_status := 'BLOCKED';
      v_reason := 'CORPORATE_ACTION_APPLICATION_REQUIRED';
    end if;
  end if;
  v_result := jsonb_build_object(
    'schema', 'twofold.corporate_action_gate/v1',
    'status', v_status,
    'reason', v_reason,
    'throughDate', p_through_date::text,
    'asOf', to_char(
      p_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'scanId', case when v_scan.scan_id is null then null
      else to_jsonb(v_scan.scan_id::text) end,
    'scanObservedAt', case when v_scan.scan_id is null then null
      else to_jsonb(to_char(
        v_scan.observed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )) end,
    'actions', v_actions
  );
  if public.jsonb_contains_number(v_result) then
    raise exception 'corporate-action gate crossed the string-decimal boundary'
      using errcode = '55000';
  end if;
  return v_result;
end;
$$;

create or replace function public.arena_corporate_action_phase_is_clear(
  p_round_id uuid,
  p_phase text,
  p_as_of timestamptz
)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_round public.arena_round%rowtype;
  v_symbols text[];
  v_through_date date;
  v_gate jsonb;
begin
  if p_round_id is null or p_as_of is null
    or p_phase not in (
      'RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS',
      'SETTLE_S1_AND_PREPARE_S2', 'FINALIZE_ACCEPTED_TARGET_CYCLE'
    )
  then
    return false;
  end if;
  select * into v_round from public.arena_round
   where round_id = p_round_id;
  if not found then return false; end if;
  select symbols into v_symbols from public.market_snapshot
   where snapshot_id = v_round.decision_snapshot_id;
  if v_symbols is null or cardinality(v_symbols) = 0 then return false; end if;
  select array_agg(symbol order by symbol) into v_symbols
    from unnest(v_symbols) as symbol;
  v_through_date := case p_phase
    when 'RUN_AGENT_DECISION' then v_round.decision_session_date
    when 'PREPARE_S1_ORDERS' then v_round.s1_session_date
    else v_round.s2_session_date
  end;
  v_gate := public.get_corporate_action_gate(
    v_symbols, v_through_date, p_as_of
  );
  return v_gate->>'status' = 'CLEAR';
end;
$$;

-- A company-action evidence gap is an operational halt, not an entrant's
-- decision failure. Never turn it into the ordinary no-trade carry-forward.
create or replace function public.enqueue_arena_no_trade_recovery()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_entry public.arena_round_entry%rowtype;
  v_round public.arena_round%rowtype;
  v_reason text;
begin
  if new.status not in ('FAILED', 'CANCELED')
    or old.status in ('FAILED', 'CANCELED')
    or new.error_code = 'CORPORATE_ACTION_GATE_BLOCKED'
    or new.phase not in (
      'RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS',
      'SETTLE_S1_AND_PREPARE_S2', 'FINALIZE_ACCEPTED_TARGET_CYCLE'
    )
  then
    return new;
  end if;
  select * into v_entry from public.arena_round_entry
   where round_entry_id = new.round_entry_id;
  select * into v_round from public.arena_round
   where round_id = new.round_id and season_id = new.season_id;
  if v_entry.round_entry_id is null or v_round.round_id is null then
    raise exception 'terminal Arena work has no Round entry'
      using errcode = '23503';
  end if;
  v_reason := case new.phase
    when 'RUN_AGENT_DECISION' then 'DECISION_UNAVAILABLE'
    when 'PREPARE_S1_ORDERS' then 'S1_PLAN_UNAVAILABLE'
    when 'SETTLE_S1_AND_PREPARE_S2' then 'S1_CHECKPOINT_UNAVAILABLE'
    else 'FINALIZATION_UNAVAILABLE'
  end;
  insert into public.arena_no_trade_recovery (
    recovery_id, round_entry_id, round_id, season_id, entrant_id, run_id,
    source_work_item_id, reason_code, scheduled_at, next_attempt_at, recorded_by
  ) values (
    public.deterministic_uuid_from_sha256(
      'twofold.arena_no_trade_recovery/v1', new.round_entry_id::text
    ),
    new.round_entry_id, new.round_id, new.season_id, new.entrant_id, new.run_id,
    new.work_item_id, v_reason, v_round.cycle_ready_at,
    v_round.cycle_ready_at, coalesce(old.claimed_by, new.recorded_by)
  ) on conflict (round_entry_id) do nothing;
  return new;
end;
$$;

create or replace function public.claim_arena_work_item(
  p_worker_id text,
  p_lease_seconds integer,
  p_now timestamptz,
  p_round_id uuid,
  p_allowed_phases text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set row_security = off
as $$
declare
  v_item public.arena_work_item%rowtype;
  v_normalized_phases text[];
begin
  select array_agg(distinct phase order by phase)
    into v_normalized_phases
    from unnest(p_allowed_phases) as requested(phase);
  if p_worker_id is null or btrim(p_worker_id) = ''
    or p_worker_id is distinct from btrim(p_worker_id)
    or p_lease_seconds is null or p_lease_seconds < 5 or p_lease_seconds > 3600
    or p_now is null
    or p_allowed_phases is null or cardinality(p_allowed_phases) = 0
    or p_allowed_phases is distinct from v_normalized_phases
    or exists (
      select 1 from unnest(p_allowed_phases) as requested(phase)
       where requested.phase not in (
         'RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS',
         'CAPTURE_S1_OPEN_REFERENCE', 'CAPTURE_S1_CLOSE',
         'SETTLE_S1_AND_PREPARE_S2', 'CAPTURE_S2_OPEN_REFERENCE',
         'CAPTURE_S2_CLOSE', 'FINALIZE_ACCEPTED_TARGET_CYCLE'
       )
    )
  then
    raise exception 'invalid capability-filtered Arena work claim'
      using errcode = '22023';
  end if;

  perform set_config('twofold.arena_work_item_mutation', 'on', true);
  update public.arena_work_item
     set status = 'REQUESTED', claimed_by = null, lease_token = null,
         claimed_at = null, lease_expires_at = null, next_attempt_at = p_now
   where status = 'CLAIMED' and lease_expires_at <= p_now
     and (p_round_id is null or round_id = p_round_id);

  -- Expiring under an unresolved company-action gate records an explicit
  -- competition halt and deliberately bypasses no-trade recovery.
  update public.arena_work_item as item
     set status = 'CANCELED', completed_at = p_now,
         completion_fingerprint_sha256 = null,
         result = jsonb_build_object(
           'outcome', 'CORPORATE_ACTION_GATE_BLOCKED'
         ),
         error_code = 'CORPORATE_ACTION_GATE_BLOCKED',
         error_message =
           'Corporate-action evidence or application was not ready by deadline',
         retryable = false
   where item.status = 'REQUESTED' and item.deadline_at <= p_now
     and item.phase in (
       'RUN_AGENT_DECISION', 'PREPARE_S1_ORDERS',
       'SETTLE_S1_AND_PREPARE_S2', 'FINALIZE_ACCEPTED_TARGET_CYCLE'
     )
     and (p_round_id is null or item.round_id = p_round_id)
     and not public.arena_corporate_action_phase_is_clear(
       item.round_id, item.phase, p_now
     );
  update public.arena_work_item
     set status = 'CANCELED', completed_at = p_now,
         completion_fingerprint_sha256 = null,
         result = jsonb_build_object('outcome', 'DEADLINE_EXPIRED'),
         error_code = 'DEADLINE_EXPIRED',
         error_message = 'Work item was not completed before its deadline',
         retryable = false
   where status = 'REQUESTED' and deadline_at <= p_now
     and (p_round_id is null or round_id = p_round_id);

  select item.* into v_item
    from public.arena_work_item as item
   where item.status = 'REQUESTED'
     and item.phase = any(p_allowed_phases)
     and (p_round_id is null or item.round_id = p_round_id)
     and item.scheduled_at <= p_now
     and item.next_attempt_at <= p_now
     and (item.deadline_at is null or p_now < item.deadline_at)
     and (
       item.phase in (
         'CAPTURE_S1_OPEN_REFERENCE', 'CAPTURE_S1_CLOSE',
         'CAPTURE_S2_OPEN_REFERENCE', 'CAPTURE_S2_CLOSE'
       )
       or public.arena_corporate_action_phase_is_clear(
         item.round_id, item.phase, p_now
       )
     )
     and not exists (
       select 1
         from public.arena_work_dependency as dependency
         join public.arena_work_item as prerequisite
           on prerequisite.work_item_id = dependency.prerequisite_work_item_id
        where dependency.work_item_id = item.work_item_id
          and prerequisite.status <> 'SUCCEEDED'
     )
   order by item.scheduled_at, item.round_id, item.entrant_id, item.work_item_id
   for update of item skip locked
   limit 1;
  if not found then
    perform set_config('twofold.arena_work_item_mutation', 'off', true);
    return null;
  end if;
  update public.arena_work_item
     set status = 'CLAIMED', attempt_count = attempt_count + 1,
         claimed_by = p_worker_id, lease_token = gen_random_uuid(),
         claimed_at = p_now,
         lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
         completed_at = null, completion_fingerprint_sha256 = null,
         result = null, error_code = null, error_message = null,
         retryable = null
   where work_item_id = v_item.work_item_id
   returning * into v_item;
  perform set_config('twofold.arena_work_item_mutation', 'off', true);
  return public.arena_work_item_result(v_item);
end;
$$;

alter table public.corporate_action_scan enable row level security;
alter table public.corporate_action_scan_page enable row level security;
alter table public.corporate_action_revision enable row level security;
alter table public.corporate_action_scan_revision enable row level security;

revoke all on table public.corporate_action_scan
  from public, anon, authenticated, service_role;
revoke all on table public.corporate_action_scan_page
  from public, anon, authenticated, service_role;
revoke all on table public.corporate_action_revision
  from public, anon, authenticated, service_role;
revoke all on table public.corporate_action_scan_revision
  from public, anon, authenticated, service_role;
revoke all on function public.corporate_action_scan_commit_result(
  public.corporate_action_scan
) from public, anon, authenticated, service_role;
revoke all on function public.register_corporate_action_scan(
  text, uuid, text, date, date, timestamptz, text, text, jsonb, jsonb, text
) from public, anon, authenticated;
revoke all on function public.get_corporate_action_gate(
  text[], date, timestamptz
) from public, anon, authenticated;
revoke all on function public.arena_corporate_action_phase_is_clear(
  uuid, text, timestamptz
) from public, anon, authenticated, service_role;

grant execute on function public.register_corporate_action_scan(
  text, uuid, text, date, date, timestamptz, text, text, jsonb, jsonb, text
) to service_role;
grant execute on function public.get_corporate_action_gate(
  text[], date, timestamptz
) to service_role;

commit;
