import { NextResponse } from "next/server";

import { parseArenaOperationalHealth } from "@/lib/arena-health";
import { readServerSupabaseConfig } from "@/lib/supabase/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function GET() {
  const config = readServerSupabaseConfig();
  const client = createServerSupabaseClient();
  const base = Object.freeze({
    service: "twofold-dashboard",
    dataSource: config ? "supabase" : "unconfigured",
    modelCredentialsExposed: false,
  });
  if (!config?.usesSecretKey || client === null) {
    return NextResponse.json({
      ok: false,
      ...base,
      arena: null,
      reason: "service_role_required",
    }, { status: 503 });
  }
  try {
    const workerId = process.env.TWOFOLD_WORKER_ID?.trim()
      || "twofold-vercel-arena";
    const response = await client.rpc("get_arena_operational_health", {
      p_worker_id: workerId,
    });
    if (response.error !== null) throw response.error;
    const arena = parseArenaOperationalHealth(response.data);
    return NextResponse.json({
      ok: arena.ok,
      ...base,
      arena,
    }, { status: arena.ok ? 200 : 503 });
  } catch {
    return NextResponse.json({
      ok: false,
      ...base,
      arena: null,
      reason: "health_evidence_unavailable",
    }, { status: 503 });
  }
}
