import type { Metadata } from "next";

import { SeasonOverview } from "@/components/views/season-overview";
import { loadSeasonOverview } from "@/lib/repositories";

export const metadata: Metadata = { title: "赛季概览" };
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const data = await loadSeasonOverview();
  return <SeasonOverview initialData={data} />;
}
