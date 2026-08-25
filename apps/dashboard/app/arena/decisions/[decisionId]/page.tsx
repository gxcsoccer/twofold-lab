import type { Metadata } from "next";

import { ArenaDecisionView } from "@/components/views/arena-decision";
import { loadArenaDecision } from "@/lib/repositories";

export const metadata: Metadata = { title: "Agent 运行" };
export const dynamic = "force-dynamic";

export default async function ArenaDecisionPage({
  params,
}: {
  params: Promise<{ decisionId: string }>;
}) {
  const { decisionId } = await params;
  const data = await loadArenaDecision(decisionId);
  return <ArenaDecisionView initialData={data} />;
}
