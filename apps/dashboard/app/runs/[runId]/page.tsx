import type { Metadata } from "next";

import { RunDetail } from "@/components/views/run-detail";
import { loadRunDetail } from "@/lib/repositories";

export const metadata: Metadata = { title: "运行详情" };
export const dynamic = "force-dynamic";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const data = await loadRunDetail(runId);
  return <RunDetail initialData={data} />;
}
