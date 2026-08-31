"use client";

import { useRealtimeRefresh } from "@/lib/supabase/realtime";

/**
 * The realtime connection indicator.
 *
 * Realtime only invalidates and triggers a refetch; it is never a ledger. This
 * is the one place the subscription is mounted, and it stays mounted for the
 * whole session because the masthead is always rendered.
 */
export function EnvironmentStatus({
  serverDataConfigured,
}: {
  serverDataConfigured: boolean;
}) {
  const realtimeStatus = useRealtimeRefresh(true);
  const label = realtimeStatus === "live"
    ? "实时 · Supabase"
    : realtimeStatus === "connecting"
      ? "正在连接 · Supabase"
      : realtimeStatus === "unauthenticated"
        ? serverDataConfigured
          ? "真实投影 · 手动刷新"
          : "需要登录 Supabase"
      : realtimeStatus === "degraded"
        ? "实时连接异常"
        : serverDataConfigured
          ? "真实数据 · 服务端 Supabase"
          : "需要完成真实数据设置";
  const dotClass = realtimeStatus === "live"
    ? "status-dot status-dot-live"
    : realtimeStatus === "degraded"
      ? "status-dot status-dot-degraded"
      : "status-dot";

  return (
    <span className="environment-status" aria-live="polite">
      <span className={dotClass} />
      <span>{label}</span>
    </span>
  );
}
