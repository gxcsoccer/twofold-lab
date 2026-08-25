import { NextResponse } from "next/server";

import { readServerSupabaseConfig } from "@/lib/supabase/env";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "twofold-dashboard",
    dataSource: readServerSupabaseConfig() ? "supabase" : "unconfigured",
    modelCredentialsExposed: false,
  });
}
