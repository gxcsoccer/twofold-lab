import type { Metadata } from "next";

import { MarketDataView } from "@/components/views/market-data-view";
import { loadMarketData } from "@/lib/repositories";

export const metadata: Metadata = { title: "真实数据" };
export const dynamic = "force-dynamic";

export default async function DataPage() {
  const data = await loadMarketData();
  return <MarketDataView data={data} />;
}
