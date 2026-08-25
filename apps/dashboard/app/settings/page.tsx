import type { Metadata } from "next";

import { SettingsView } from "@/components/views/settings-view";
import { loadSettingsData } from "@/lib/repositories";

export const metadata: Metadata = { title: "设置" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const data = await loadSettingsData();
  return <SettingsView initialData={data} />;
}
