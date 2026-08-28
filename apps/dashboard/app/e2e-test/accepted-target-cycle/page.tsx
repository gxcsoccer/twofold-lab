import { notFound } from "next/navigation";

import { AcceptedTargetCyclePanel } from "@/components/views/arena-decision";
import { PageHeader, StatusBadge } from "@/components/ui";
import type {
  AcceptedTargetCycleProjection,
  AcceptedTargetCycleReadiness,
} from "@/lib/data/contracts";

export const dynamic = "force-dynamic";

const fixture = Object.freeze({
  schema: "twofold.dashboard.accepted_target_cycle/v1",
  status: "COMPLETED",
  cycleId: "10000000-0000-8000-8000-000000000001",
  decisionId: "40000000-0000-4000-8000-000000000001",
  acceptedSubmissionId: "50000000-0000-4000-8000-000000000001",
  s1: Object.freeze({ status: "COMPLETED", orderCount: "1", settlementCount: "1" }),
  s2: Object.freeze({ status: "COMPLETED", orderCount: "1", settlementCount: "1" }),
  ledger: Object.freeze({
    transactionCount: "4",
    headSequence: "2",
    headSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }),
  nav: Object.freeze({
    currency: "USD",
    positionMarketValue: "1610",
    brokerNav: "2110",
    taxReserveDeductions: "135",
    taxReservedNav: "1975",
    liquidationDeductions: "0",
    liquidationNav: "1975",
  }),
  artifactSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  completedAt: "2026-08-26T20:15:00.000Z",
}) satisfies AcceptedTargetCycleProjection;

const blockedFixture = Object.freeze({
  schema: "twofold.accepted_target_cycle_readiness/v1",
  status: "BLOCKED",
  decisionId: "40000000-0000-4000-8000-000000000001",
  runId: "30000000-0000-4000-8000-000000000001",
  acceptedSubmissionId: "50000000-0000-4000-8000-000000000001",
  strategyAccountId: null,
  ledgerHeadSha256: null,
  cycleId: null,
  blockers: ["STRATEGY_ACCOUNT_MISSING"] as const,
}) satisfies AcceptedTargetCycleReadiness;

const completedReadiness = Object.freeze({
  ...blockedFixture,
  status: "COMPLETED",
  strategyAccountId: "20000000-0000-4000-8000-000000000001",
  ledgerHeadSha256: fixture.ledger.headSha256,
  cycleId: fixture.cycleId,
  blockers: [] as const,
}) satisfies AcceptedTargetCycleReadiness;

export default function AcceptedTargetCycleE2EPage() {
  if (
    process.env.NODE_ENV === "production"
    || process.env.TWOFOLD_E2E !== "true"
  ) notFound();
  return (
    <main className="page-stack">
      <PageHeader
        eyebrow="E2E contract fixture"
        title="Accepted target execution cycle"
        description="只在 TWOFOLD_E2E=true 时暴露；生产运行不会读取该 fixture。"
        actions={<StatusBadge label="TEST ONLY" tone="neutral" />}
      />
      <AcceptedTargetCyclePanel cycle={null} readiness={blockedFixture} />
      <AcceptedTargetCyclePanel cycle={fixture} readiness={completedReadiness} />
    </main>
  );
}
