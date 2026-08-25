import type { Metadata } from "next";

import { AuditView } from "@/components/views/audit-view";
import { loadAuditData } from "@/lib/repositories";

export const metadata: Metadata = { title: "审计" };
export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const data = await loadAuditData();
  return <AuditView initialData={data} />;
}
