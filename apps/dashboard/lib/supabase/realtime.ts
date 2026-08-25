"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { getBrowserSupabaseClient } from "@/lib/supabase/client";

export type RealtimeStatus =
  | "unavailable"
  | "unauthenticated"
  | "connecting"
  | "live"
  | "degraded";

const INVALIDATION_TABLES = [
  "projection",
  "control_command",
  "worker_lease",
  "model_usage_record",
  "source_delivery",
  "market_snapshot",
] as const;

/**
 * Realtime is only an invalidation signal. Every notification causes a
 * debounced server refresh; the durable Postgres projection remains the
 * authoritative read model.
 */
export function useRealtimeRefresh(enabled: boolean): RealtimeStatus {
  const router = useRouter();
  const [status, setStatus] = useState<RealtimeStatus>("unavailable");

  useEffect(() => {
    if (!enabled) {
      setStatus("unavailable");
      return;
    }

    const client = getBrowserSupabaseClient();
    if (!client) {
      setStatus("unavailable");
      return;
    }

    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let channel: ReturnType<typeof client.channel> | undefined;
    const refresh = () => {
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => router.refresh(), 150);
    };

    void client.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error || !data.session) {
        setStatus("unauthenticated");
        return;
      }

      setStatus("connecting");
      channel = client.channel("twofold-dashboard-invalidation");
      for (const table of INVALIDATION_TABLES) {
        channel = channel.on(
          "postgres_changes",
          { event: "*", schema: "public", table },
          refresh,
        );
      }

      channel.subscribe((nextStatus) => {
        if (!active) return;
        if (nextStatus === "SUBSCRIBED") setStatus("live");
        else if (nextStatus === "CHANNEL_ERROR" || nextStatus === "TIMED_OUT") {
          setStatus("degraded");
        }
      });
    });

    return () => {
      active = false;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      if (channel !== undefined) void client.removeChannel(channel);
    };
  }, [enabled, router]);

  return status;
}
