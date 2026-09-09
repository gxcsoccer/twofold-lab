begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(17);

select ok(to_regclass('public.evolution_cycle_finding') is not null,
  'cycle-to-finding observations are durable without rewriting findings');
select ok(exists (
  select 1 from pg_trigger
   where tgrelid = 'public.evolution_cycle_finding'::regclass
     and tgname = 'evolution_cycle_finding_is_immutable'
     and not tgisinternal
), 'cycle finding associations are immutable');

set local role service_role;

-- Shared synthetic finding (content-addressed). Hash is synthetic for the
-- contract; the RPC only requires document shape + sha format.
create temporary table pgtap_finding_hash_reuse as
select
  repeat('c', 64) as finding_sha,
  jsonb_build_object(
    'schema', 'twofold.evolution_finding/v1',
    'findingSha256', repeat('c', 64),
    'scope', 'PLATFORM',
    'subject', 'worker-a',
    'lesson', 'Identical rediscovery must associate, not conflict.',
    'evidenceRefs', jsonb_build_array('arena_tick:pgtap-1')
  ) as finding,
  repeat('d', 64) as report_sha_a,
  repeat('e', 64) as report_sha_b,
  repeat('f', 64) as report_sha_conflict;

-- Window already ended so claim_evolution_cycle can pick it up.
select is(
  public.request_evolution_cycle(
    'pgtap:evolution-hash:cycle-a',
    '2026-09-01T00:00:00Z',
    '2026-09-01T06:00:00Z',
    '{"schema":"twofold.evolution_policy/v1","analyzerVersion":"pgtap-hash"}'::jsonb,
    'pgtap-hash'
  )->>'status',
  'REQUESTED',
  'first cycle can be requested'
);

select is(
  public.request_evolution_cycle(
    'pgtap:evolution-hash:cycle-b',
    '2026-09-01T06:00:00Z',
    '2026-09-01T12:00:00Z',
    '{"schema":"twofold.evolution_policy/v1","analyzerVersion":"pgtap-hash"}'::jsonb,
    'pgtap-hash'
  )->>'status',
  'REQUESTED',
  'second cycle with a later window can be requested'
);

create temporary table pgtap_claim_a as
select public.claim_evolution_cycle('pgtap-hash-worker', 600) as claim;

select is((select claim->>'status' from pgtap_claim_a), 'CLAIMED', 'first cycle is claimable');

select is(
  (
    select public.complete_evolution_cycle(
      (claim->>'cycleId')::uuid,
      (claim->>'leaseToken')::uuid,
      '[]'::jsonb,
      jsonb_build_object(
        'schema', 'twofold.evolution_analysis/v1',
        'reportSha256', (select report_sha_a from pgtap_finding_hash_reuse),
        'findings', jsonb_build_array((select finding from pgtap_finding_hash_reuse))
      ),
      (select report_sha_a from pgtap_finding_hash_reuse),
      'pgtap-hash-worker'
    )->>'status'
    from pgtap_claim_a
  ),
  'SUCCEEDED',
  'first cycle stores the finding'
);

-- Exact completion retry on the succeeded cycle is identity-preserving.
select is(
  (
    select public.complete_evolution_cycle(
      (claim->>'cycleId')::uuid,
      (claim->>'leaseToken')::uuid,
      '[]'::jsonb,
      jsonb_build_object(
        'schema', 'twofold.evolution_analysis/v1',
        'reportSha256', (select report_sha_a from pgtap_finding_hash_reuse),
        'findings', jsonb_build_array((select finding from pgtap_finding_hash_reuse))
      ),
      (select report_sha_a from pgtap_finding_hash_reuse),
      'pgtap-hash-worker'
    )->>'status'
    from pgtap_claim_a
  ),
  'SUCCEEDED',
  'same-cycle identical completion retry is idempotent'
);

select is(
  (
    select count(*)::text from public.evolution_finding
     where finding_sha256 = (select finding_sha from pgtap_finding_hash_reuse)
  ),
  '1',
  'idempotent retry does not duplicate findings'
);

create temporary table pgtap_claim_b as
select public.claim_evolution_cycle('pgtap-hash-worker', 600) as claim;

select is((select claim->>'status' from pgtap_claim_b), 'CLAIMED', 'second cycle is claimable');

select is(
  (
    select public.complete_evolution_cycle(
      (claim->>'cycleId')::uuid,
      (claim->>'leaseToken')::uuid,
      '[]'::jsonb,
      jsonb_build_object(
        'schema', 'twofold.evolution_analysis/v1',
        'reportSha256', (select report_sha_b from pgtap_finding_hash_reuse),
        'findings', jsonb_build_array((select finding from pgtap_finding_hash_reuse))
      ),
      (select report_sha_b from pgtap_finding_hash_reuse),
      'pgtap-hash-worker'
    )->>'status'
    from pgtap_claim_b
  ),
  'SUCCEEDED',
  'cross-cycle identical finding hash is legal reuse, not a content conflict'
);

select is(
  (
    select count(*)::text from public.evolution_cycle_finding
     where finding_sha256 = (select finding_sha from pgtap_finding_hash_reuse)
  ),
  '2',
  'both cycles keep an observation association for the shared finding'
);

select is(
  (
    select count(*)::text from public.evolution_finding
     where finding_sha256 = (select finding_sha from pgtap_finding_hash_reuse)
  ),
  '1',
  'rediscovery does not rewrite or duplicate the immutable finding row'
);

-- Dedicated claimed cycle for true content conflict (same hash, different body).
select is(
  public.request_evolution_cycle(
    'pgtap:evolution-hash:cycle-conflict',
    '2026-09-01T12:00:00Z',
    '2026-09-01T18:00:00Z',
    '{"schema":"twofold.evolution_policy/v1","analyzerVersion":"pgtap-hash"}'::jsonb,
    'pgtap-hash'
  )->>'status',
  'REQUESTED',
  'conflict probe cycle can be requested'
);

create temporary table pgtap_claim_conflict as
select public.claim_evolution_cycle('pgtap-hash-worker', 600) as claim;

select is((select claim->>'status' from pgtap_claim_conflict), 'CLAIMED',
  'conflict probe cycle is claimable');

select throws_ok(
  format(
    $sql$
      select public.complete_evolution_cycle(
        %L::uuid,
        %L::uuid,
        '[]'::jsonb,
        jsonb_build_object(
          'schema', 'twofold.evolution_analysis/v1',
          'reportSha256', %L,
          'findings', jsonb_build_array(jsonb_build_object(
            'schema', 'twofold.evolution_finding/v1',
            'findingSha256', %L,
            'scope', 'PLATFORM',
            'subject', 'worker-a',
            'lesson', 'Different lesson under the same hash must fail closed.',
            'evidenceRefs', jsonb_build_array('arena_tick:pgtap-2')
          ))
        ),
        %L,
        'pgtap-hash-worker'
      )
    $sql$,
    (select claim->>'cycleId' from pgtap_claim_conflict),
    (select claim->>'leaseToken' from pgtap_claim_conflict),
    (select report_sha_conflict from pgtap_finding_hash_reuse),
    (select finding_sha from pgtap_finding_hash_reuse),
    (select report_sha_conflict from pgtap_finding_hash_reuse)
  ),
  '23505',
  null,
  'same hash with different finding content still fails as a reuse conflict'
);

select is(
  (
    select count(*)::text from public.evolution_finding
     where finding_sha256 = (select finding_sha from pgtap_finding_hash_reuse)
       and finding = (select finding from pgtap_finding_hash_reuse)
  ),
  '1',
  'content-conflict path does not overwrite the original immutable finding'
);

select is(
  (
    select count(*)::text from public.evolution_cycle_finding
     where cycle_id = ((select claim->>'cycleId' from pgtap_claim_conflict)::uuid)
  ),
  '0',
  'failed content-conflict completion leaves no cycle association (txn rolled back by throws_ok subtransaction)'
);

reset role;
select * from finish();
rollback;
