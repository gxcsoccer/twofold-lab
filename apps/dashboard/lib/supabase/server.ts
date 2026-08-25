import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { readServerSupabaseConfig } from "@/lib/supabase/env";

export function createServerSupabaseClient(): SupabaseClient | null {
  const config = readServerSupabaseConfig();
  if (!config) {
    return null;
  }

  return createClient(config.url, config.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
