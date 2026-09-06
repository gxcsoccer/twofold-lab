# Production repair and evolution audit — 2026-09-06

Scope: S4 Round 2, read-only audit followed by user-authorized TDD repairs.

## Confirmed defects and repair boundaries

- SIP open capture was claimed at open + 2 minutes despite delayed entitlement.
  Claim eligibility now waits until query end + 16 minutes, without changing
  frozen schedules, source versions, price windows, or retry counts.
- Close capture passed `closeAvailableAt` as the provider query end. It now uses
  the frozen exchange close, including early-close calendar support.
- Provider errors discarded the diagnostic body. They now retain sanitized
  JSON messages/request IDs and distinguish permanent permission failures from
  retryable transport/rate-limit failures.
- PostgREST offset/microsecond timestamps entered canonical decision packets.
  Snapshot timestamps are normalized at the database boundary for future
  packets. Existing artifacts remain immutable. Invalid admission evidence now
  records an explicit rejection instead of disappearing as a tool exception.
- The September 4 no-trade source gate incorrectly excluded every accepted
  target. It now excludes accepted targets only for stale decision failures;
  terminal execution failures remain eligible, subject to the existing shared
  S2 evidence and duplicate-valuation fences.
- Corporate-action account reconciliation swallowed operational exceptions.
  Future failures produce structured, sanitized server logs. The cause of the
  two historical transient failures cannot be recovered from missing logs.
- Local production builds traced profile `node_modules` directory symlinks and
  crashed Turbopack. Profile tracing now includes only configuration files;
  explicitly traced runtime packages remain unchanged.

## Verification

### Source-scoped recovery follow-up

Migration `202609060003` retains legacy recovery IDs and immutable source/rearm
history, but keys new recovery identities by entry and source work item. A later
terminal phase appends its own request instead of being suppressed by the old
entry-level uniqueness. A partial unique index and serialized, nonblocking claim
transaction permit only one live recovery lease per entry. The overview selects
one recovery per entrant, so additional history cannot duplicate rows. Synthetic
carry-forward cancellations and unsupported corporate-action failures do not
enqueue additional recovery requests.

The sequential regression uses the real operator recovery RPC, accepts targets
after the reopened decision succeeds, then fails later execution phases without
rolling back between those transitions. The first run against the old schema
failed seven assertions; the repaired migration passed transactional preflight.
The fixture now has 24 assertions, including preservation of legacy bytes,
independent retry budgets, live-lease exclusion, overview cardinality, and
synthetic/policy-failure exclusions. Full `pnpm verify` passed with 691 unit tests
and all type/build/Harness/profile checks.

After applying `202609060003` through the migration ledger,
`pnpm test:db:market-recovery` passed **62 planned pgTAP checks (13 + 25 + 24)**,
with all fixture writes rolled back. This is the current database-test total;
the 38/48 totals below belong only to earlier commits.

The production backfill appended two S4 S1-plan failure sources, both REQUESTED
with zero attempts and the original September 8 20:20 UTC S2 boundary. Nine
missing sources from retired Seasons were excluded. All 12 pre-existing recovery
rows retained the same aggregate digest (`e9bb1f838eff244d593b48ebed37cef5`), all
ledger heads retained digest `00b7a74a10069a34302d9915d386ac32`, and the valuation
count remained 12. No expired work was reopened or marked successful.

### Earlier verification — historical results, not current totals

New regression tests were first run against failing behavior, then repaired.
The initial repair (`6e085c4`) passed `pnpm verify` with 643 unit tests, all
workspace type checks, production builds, Harness contract verification, and
profile composition verification. The rejection-redaction follow-up (`c437126`)
added four regressions and passed the same full verification with 647 unit
tests. These are version-specific counts, not a claim about the latest PR head.

The transport-error follow-up (`e2f63b7`) added 20 regressions across both daily-bar and
open-reference adapters. Fetch failures, response-body read failures, and provider
timeouts now reach the queue as retryable `ALPACA_TRANSIENT_FAILURE` errors;
parent cancellation remains `WORKER_ABORTED`, and JSON validation errors are not
reclassified as transport failures. The new tests first reproduced the missing
classification (12 failed, 8 passed), then passed after the repair. Full
`pnpm verify` passed with 667 unit tests plus all type, build, Harness, and profile
checks. `pnpm test:db:market-recovery` also passed its 38 planned pgTAP checks again
with fixture changes rolled back.

The review follow-up at `a17801b` preserved a known HTTP status and request ID
when response-body reading fails: 401/403 remain terminal permission errors,
other terminal HTTP rejections stay terminal, and successful-response stream
failures plus 408/429/5xx stay retryable. Transport diagnostics now include
bounded, cycle-safe cause/aggregate messages and error codes, redacted before
truncation, without retaining raw cause objects. Its 24 added regressions first
produced 22 failures and two passes, then passed after the repair. Full
`pnpm verify` passed with 691 unit tests and all type/build/Harness/profile checks.

At `a17801b`, `phase_aware_recovery_behavior_contract.sql` added 10 behavioral checks using
real accepted targets, terminal work transitions, the enqueue trigger, and the
claim RPC. Both FAILED/CANCELED decision sources are fenced by accepted targets;
all three later execution phases remain claimable. Missing S2 evidence consumes
no attempts, while a decision failure without accepted targets can recover once
S2 evidence exists. A session-local mutation control cloned the claim function
into `pg_temp` and removed its phase condition: all six later-phase assertions
failed, proving the fixture catches the old unconditional fence. No public
function was replaced. At that commit, `pnpm test:db:market-recovery`
included this fixture and passed 48 planned pgTAP checks; every fixture write
was rolled back, without disabling deadline guards or changing economic records.

During the initial repair (`6e085c4`), the first two database migrations passed
transactional preflight and were applied using the migration ledger. The earlier,
pre-behavioral-fixture `pnpm test:db:market-recovery` run passed 38 planned pgTAP
checks with fixture changes rolled back; 38 is a historical total only.
A read-only provider probe using
the repaired Round calendar/source returned HTTP 200 for all 100 frozen symbols
on the September 4 session. The full historical Round SQL fixture remains
blocked by its expired real-time S1 plan deadline; it is not counted as passing.

The initial production deployment `dpl_5TattDMvuPRBVi3E7K4yyjqFUtcR` became Ready
on `https://twofold-lab-neon.vercel.app` (later review fixes supersede that build).
The normal production cron completed both
audited S1-close recoveries at attempt 4. Both tasks reference shared snapshot
`c5cc72e5-65b8-4d03-8b56-58b10d487f61` and shared tax FX evidence. The snapshot
contains all 100 symbols for September 4, observed September 6 at
08:42:11.122 UTC and sealed at 08:42:17.637531 UTC; neither time was backdated.
Both Strategy Ledger heads remain sequence 0 with their original hashes.
Expired decisions and opens remain failed. R2 no-trade recovery still has zero
attempts and waits for September 8 at 20:20 UTC (September 9 at 04:20 Singapore).
Health continues to report the historical terminal-work and unsupported RCL
policy alerts; successful collection is not the same as an all-green season.

Expired S1 opens/agent decisions must not be revived. R2's failed contestant
outcomes are not overwritten. RCL's foreign-dividend policy remains explicitly
unsupported pending authoritative policy evidence; no tax treatment is guessed.
The orchestrator's `max-tokens` exit is a remaining model/runtime-budget
experiment question, not proof that all decision failures have that cause.

## Does self-evolution work?

At audit time the production database contained:

- 30 successful analysis cycles;
- 27 immutable findings and 27 experience records;
- one completed local replay, `runtime-surface-scaling-replay-v1`;
- one proposed, not approved, online shadow experiment;
- zero promoted experiments and zero `decision_evolution_evaluation` records.

The local replay reported terminal failure rate 0.5 → 0 with 4 baseline and 2
treatment samples, and a `PROMOTE_CANDIDATE` recommendation. This is a small
retrospective temporal holdout, not robust evidence of sustained improvement:
R2 subsequently failed for both contestants. There is no proven trading/NAV
improvement and no automatic promotion or production editing.

The observer did detect the SIP incident as retry pressure. Its diagnoses are
fixed rule text, not causal analysis: the agent-terminal-failure rule attributes
all failures to runtime budget, including the root's platform evidence error.
The worker has no reader that feeds `evolution_experience` into official Agent
packets. This is presently an operational evidence/experiment-control loop,
not a self-improving live strategy. Human admission/promotion gates remain intact.

Next evolution work should preregister cause-specific replay cases (permission,
packet validity, true output truncation), evaluate on later held-out rounds,
and compare completion and cost before requesting human promotion. Do not
silently inject lessons or alter a frozen contestant's rules during a Season.
