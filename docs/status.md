# Implementation status

Updated: 2026-08-30 (Asia/Shanghai).

## Current production outcome

`private-us-liquid-100-s4` is the active production Season behind the
authenticated Vercel dashboard. It is the first clean activation in which both
the root-only and orchestrated DeepSeek entrants completed a real 100-symbol
decision and froze deterministic S1 plans.

- Season ID: `1486ba8e-47ae-5774-ba44-5c26f9359eeb`.
- Round 1 ID: `d83eff85-da7b-5e07-81d6-d4feaf4d9839`.
- Frozen universe: exactly 100 common stocks, including the mandatory current
  holding LULU; artifact SHA-256
  `900de98ab433e769818c6ef419a0a8594562e09c1a1360aba54d5b395dc73b3c`.
- Opening market snapshot: `e502936c-1c97-49d5-9351-deb16721cb5b`, with the
  exact same 100-symbol member set for 2026-08-28.
- Equal genesis: each isolated paper account holds exactly `150 LULU` and zero
  cash. Both opening Liquidation NAV values are `$18,118.66` and rank 1.
- The accounts were initialized at `2026-08-29T21:20:32Z`, before the immutable
  Season/decision opening at `2026-08-29T21:28:55.699Z`.
- Round 1 has two entrant seats and all 16 items in its eight-phase durable DAG.
- The static start gate reports `READY_FOR_S1`: two accepted decisions, two
  frozen S1 plans, four successful pre-S1 work items, a live production Worker,
  the correct active Season, and no operational alerts.
- S1 executes on 2026-08-31 and S2 on 2026-09-01; final ranking follows the S2
  close evidence boundary.

No live-broker capability exists. Every order and fill is simulated.

## Real decision results

Both entrants read the same content-addressed decision packet and passed the
same 5-10 position, 20% single-position, and 5% minimum-cash constraints.

- `twofold` selected 10 positions plus 5% cash. It retained LULU at 6% and used
  packet-provided liquidity and 5/20/60-day momentum features. The complete
  tree used 2 Provider requests, 28,625 billable tokens, and an estimated
  `$0.027609`.
- `twofold-orchestrator` used one independent research descendant, then applied
  a risk and correlation review. It selected 10 positions plus 10% cash and
  retained LULU at 3%. The complete tree used its allowed 4 Provider requests,
  71,606 billable tokens, and an estimated `$0.051736`.
- Every accepted symbol, weight, rationale, cash allocation, decision summary,
  and submission hash is now visible on the read-only Agent decision page.

## Architecture now in production

### Frozen universe and activation

- Universe research is a content-addressed artifact, not a mutable environment
  list. It freezes source URLs and hashes, eligibility evidence, liquidity rank,
  5/20/60-day returns, 20-session median dollar volume, selection reasons, and
  stable instrument identities.
- The builder joins active/tradable Alpaca assets with Nasdaq stock and traded-
  security catalogs, excludes ETFs and test issues, and requires common-stock
  identity, at least 120 sessions of history, a `$5` close, and `$20M` median
  20-session dollar volume.
- LULU is mandatory only while it passes every eligibility rule.
- A reusable preparation command binds an existing artifact to an exact sealed
  snapshot and future opening boundary. It rejects date/member mismatches and
  ensures account initialization can complete before decision time.
- Runtime config discovery is by claimed Season identity. Multiple immutable
  universes and Seasons coexist without one global symbol switch.

### Budget proportional to the decision surface

- The old fixed limits worked for a small pool but did not represent the cost of
  replaying a 100-symbol packet through a root/descendant/root workflow.
- Root output capacity now starts at 8,192 for up to 32 symbols, adds 128 per
  additional symbol, and stops at 32,768. A 100-symbol root receives 16,896.
- The tree-wide billable-token ceiling starts at 120,000, adds 2,048 per
  additional symbol, and stops at 512,000. A 100-symbol tree receives 259,264.
- Provider-request, estimated-cost, descendant, deadline, and tool fences remain
  independent hard limits. Every reservation and settlement remains part of the
  immutable event stream.

### Durable competition loop

- Postgres owns immutable Season/Round identity, decision deadlines, entrant
  seats, leases, dependency DAG, exact retry fingerprints, accounting ledgers,
  market evidence, valuations, and ranking.
- A one-minute Vercel cron runs seven bounded services: Agent decisions,
  contestant cycle work, shared market capture, corporate-action scanning,
  corporate-action reconciliation, no-trade recovery, and next-Round
  provisioning.
- Shared market evidence is captured once per Round and reused by every entrant.
  Entrant processing order cannot change a price path.
- The v2 rulebook uses Alpaca SIP first-minute VWAP and caps whole-share fills at
  1% of that minute's volume. Core derives the capacity and Postgres independently
  rejects excess settlement bytes.
- Fills remain cash-limited, FIFO, fee-aware, and tax-reserve-aware. There is no
  margin, shorting, fabricated liquidity, or hidden minimum fill.
- Terminal contestant-local failure is retained as evidence and may later be
  valued only through explicit no-trade carry-forward. Failed work is never
  relabeled as successful.

### Multi-season and recovery hardening

- Market capture derives symbols from the claimed Round snapshot. Corporate-
  action scans use the union of active Season symbols and normalize Alpaca merger
  records through the affected acquiree symbol.
- Migration 055 provides service-only audited recovery for a failed queue item
  only when no accepted submission, downstream work, or deadline conflict exists.
- Migration 056 allows one immutable Bundle artifact to be reused across Seasons
  only when the current Season entrant freezes the exact same Bundle SHA-256.
- Earlier s1-s3 activations remain immutable evidence. s1 exposed account
  initialization after decision time; s2 exposed cross-Season artifact
  assumptions and the 8,192 root-output ceiling; s3 exposed the fixed 120,000
  tree budget. s4 fixes the causes without weakening a historical fence or
  rewriting a failed result.

### Self-evolution loop

- Migration 057 adds leased analysis cycles, immutable findings and experiences,
  an audited experiment state machine, and isolated local/online-shadow trials.
- Migration 058 makes a deterministic analysis window portable across workers:
  the first scheduler remains provenance, while rolling deployments may request
  the same byte-equivalent window without a false identity conflict.
- The Arena tick now has an eighth independent `evolution` phase. Every six hours
  it harvests agent failures, queue retries, tick reliability, model usage, and
  data evidence without touching official portfolio state.
- The first real production analysis retained four findings, including an
  orchestrator terminal-failure observation of `0.75`, Vercel tick failure rate,
  and work retry pressure. These are evidence from earlier s1-s3 failures, not
  rewritten outcomes.
- A real temporal replay compared s2+s3 with s4. Agent terminal failure rate
  improved from `0.5` to `0`; estimated model cost per decision increased from
  `$0.032217933` to `$0.03967249`, within the preregistered `$0.01` guardrail.
  The result is `PROMOTE_CANDIDATE`, remains unpromoted, and has immutable result
  hash `6cb253de5b143353abbeb6082880b1fa4639494a16bf0ae74b665368876d60a1`.
- `evolution-observer-online-shadow-v1` is preregistered as `PROPOSED` with
  ranking scope `SHADOW`; no human approval or online trial has been fabricated.
- The Dashboard `/evolution` view exposes cycles, experience, experiment state,
  ranking scope, human approval, and recommendations separately from the
  official Season leaderboard.

### Decision evidence and same-snapshot comparison

- Migration 059 adds immutable decision-admission receipts and content-addressed
  official-versus-candidate comparison artifacts.
- Every future Arena submission records `guardAction`, reason codes, input age,
  maximum market jump, stability window, maximum target delta, cooldown, and
  the exact evidence snapshot. A blocking observation never becomes an accepted
  target.
- The production service role has no execute permission on the old
  evidence-free submission RPC; it may submit only through the evidenced RPC.
- `LOCAL_REPLAY` can now bind an official and candidate decision to one snapshot
  and persist symbol deltas, cash delta, maximum change, and turnover before the
  trial starts. Different snapshots fail closed in Core and Postgres.

### Portfolio-policy evolution evaluation

- Migration 060 binds each same-snapshot decision comparison to official and
  candidate replay outcomes with one replay-input SHA, replay policy, and NAV
  currency.
- The immutable evaluation covers constraint violations, turnover, simulated
  slippage/fees/tax, terminal NAV, maximum drawdown, and terminal failures.
  Constraint violations and terminal failures have an absolute candidate
  maximum of zero in addition to relative guardrails.
- Core derives the standard evolution recommendation; Postgres independently
  checks every metric binding and recommendation before accepting the exact
  bytes. The Dashboard self-evolution view exposes the paired evidence.
- `PROMOTE_CANDIDATE` is still evidence only. The runner issues no `PROMOTE`
  transition and the database retains its existing named-human gate.

## Verification

- 110 Core, Worker, and Dashboard test files pass: 514 tests.
- Core, DSH Bundle, Worker, and Dashboard production TypeScript builds pass.
- The clean Vercel production build passes package builds, Next.js compile,
  typecheck, page generation, output tracing, and deployment.
- Relevant remote pgTAP contracts pass, including Round readiness, v2 market
  evidence, v2 stage registration, failed-work recovery, and cross-Season Bundle
  reuse.
- The production start gate returned `ready: true` with 100 members, 2 accepted
  decisions, 2 frozen S1 plans, all 4 pre-S1 tasks successful, and no alerts.
- ego-lite verified the authenticated desktop and 390px mobile Season views, both
  real decision pages, the orchestrator descendant tree, accepted allocations,
  and the production `/evolution` P1 evidence section with zero document-level
  horizontal overflow.
- Migrations through 060 are aligned locally and remotely; the 63-test Arena
  decision/evolution contract passes against production Supabase.
- Current production deployment is `dpl_HrpdfYZSTspA1ZAmVBdXkjziKxJ8` and owns
  `https://twofold-lab-neon.vercel.app`.
- The post-deploy production cron invocation returned HTTP 200.

## Remaining operations

1. Observe the real S1 close, S1 settlement/S2 plan, S2 execution, and final
   Liquidation-NAV ranking on 2026-08-31 and 2026-09-01. The S1 open reference
   completed on 2026-08-31 for both entrants, but only after a first-run defect
   described below.

   The first S1 this project has ever reached exposed an inclusive-boundary bug
   in `alpaca-open-reference.ts`: Alpaca treats the bars `end` parameter as
   inclusive, so the one-minute window returned both the opening bar and the one
   after it, and the guard requiring exactly one bar per symbol rejected every
   symbol. Every later phase in the cycle is likewise executing in production for
   the first time, so a comparable first-run defect in the S1 close, S2 capture,
   or finalization paths should be treated as likely rather than surprising.
2. Obtain an explicit named-human decision before scheduling the proposed
   `ONLINE_SHADOW` experiment for Round 2; rejection remains a valid result.
3. Connect database-derived critical health alerts to an external paging
   destination.
4. Add process/container isolation before accepting untrusted external Bundles.
5. Record per-phase failure detail on the Arena tick. `arena_tick_observation`
   stores only `outcome` and `phase_outcomes`, so a failing phase is visible as
   `failed` and nothing more. The real cause is written to
   `arena_work_item.error_message`, but only once the item reaches a terminal
   state, which left roughly fifteen minutes of the 2026-08-31 incident with no
   diagnosable signal anywhere.
6. Make provider-shape errors name the observation rather than the symbol. The
   open-reference guard reported `ambiguous AAOI bars`, which reads as a data
   anomaly in one instrument; in fact every symbol returned two bars and AAOI was
   merely the alphabetically first Liquid 100 member checked. Reporting the
   observed count and timestamps would have pointed at the window immediately.
7. Evaluate splitting `SETTLE_S1_AND_PREPARE_S2`, but only after Round 1 has
   run to completion. The phase bundles two steps with different data needs.
   Settling S1 requires the first-minute open reference and the ECB USD/CNY
   cross for the CNY disposition reserve; ECB publishes around 14:15 UTC, so
   that half could complete roughly six hours before it does today. Only the S2
   buy plan genuinely needs the session close, because it sizes against the
   post-S1 investable balance. `CAPTURE_S1_CLOSE` currently captures the close
   snapshot and the tax-FX reference together, which is what couples them.

   The benefit is detection latency rather than throughput: the 2026-08-31
   incident was only diagnosable once the phase came due, so settling S1 in the
   early afternoon would surface a settlement-side defect with most of a day of
   retry runway instead of a few hours.

   Three things must be settled first, none of them verified yet: whether early
   settlement can race the Season-bounded corporate-action gates when an ex-date
   falls inside the session; whether the stage gating in `arena_cycle_material`
   tolerates a "S1 settled, S2 unplanned" intermediate state, since the two
   currently commit together; and the change surface, since an eight-phase DAG
   would become ten, touching `seed_arena_round_work`, the readiness gate's
   exact-phase and `entrants * 8` checks, the claim whitelist, and their pgTAP
   contracts.

   Do not attempt this before Round 1 completes. Every phase after the decision
   is executing in production for the first time, and restructuring the DAG on
   paths that have never been observed working would confound a first-run defect
   with a refactor.
8. Offer an indicative live account value, strictly outside the evidence chain.
   The pieces exist: `strategy_portfolio_state` holds current positions and
   `calculateCompetitionValuation` is a pure function that will price any mark
   set. What is missing is a latest-quote path - the Worker fetches daily bars
   and the first regular-session minute, nothing intraday.

   It must never reach `arena_valuation`. That table constrains `stage` to
   `OPENING`, `S1_CLOSE`, and `S2_CLOSE`, and every stored valuation is bound to
   a sealed, reproducible snapshot; a live figure is by definition none of those.
   The existing check constraint is a sufficient guard, so the requirement is a
   read-only projection that is visibly separate from the ranking, not a new
   valuation stage.

   Two things to get right in the presentation. The figure will not equal the
   ranking NAV, because ranking uses Liquidation NAV net of estimated close fees
   and unrealized liquidation tax; showing both without explaining the gap
   invites reading the ranking as wrong. And the Alpaca `licenseScope` is
   `private-research`, so confirm whether the subscription actually carries
   real-time SIP quotes rather than delayed data, and label whichever it is
   honestly.

   Not useful before Round 1 completes: until S2 settles, every entrant still
   holds the identical genesis position, so a live value shows the same number
   for all of them.
9. Extend audited recovery deliberately, not reactively. Migration
   `202608310008` had to widen `recover_failed_arena_work_item` mid-incident
   because its accepted-submission fence made the four shared market-capture
   phases unrecoverable for any Round that had reached S1 - which is every Round
   that has a decision at all. Review the remaining fences for the same class of
   over-broad refusal before the next Season.

The exact startup, deadline, recovery, and readiness procedure is in
[arena-runbook.md](arena-runbook.md).
