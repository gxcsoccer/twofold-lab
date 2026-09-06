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

New regression tests were first run against failing behavior, then repaired.
`pnpm verify` passed: 643 unit tests, all workspace type checks, production
builds, Harness contract verification, and profile composition verification.
Both database migrations passed transactional preflight and were applied using
the migration ledger; `pnpm test:db:market-recovery` then passed all 38 planned
pgTAP checks with fixture changes rolled back. A read-only provider probe using
the repaired Round calendar/source returned HTTP 200 for all 100 frozen symbols
on the September 4 session. The full historical Round SQL fixture remains
blocked by its expired real-time S1 plan deadline; it is not counted as passing.

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
