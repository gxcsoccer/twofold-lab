"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { readPublicSupabaseConfig } from "@/lib/supabase/env";

let browserClient: SupabaseClient | null | undefined;

export function getBrowserSupabaseClient(): SupabaseClient | null {
  if (browserClient !== undefined) {
    return browserClient;
  }

  const config = readPublicSupabaseConfig();
  browserClient = config
    ? createClient(config.url, config.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true },
      })
    : null;

  return browserClient;
}
