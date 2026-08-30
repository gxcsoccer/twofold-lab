import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "../src/config.js";

const database = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "service-role-secret",
} as const;

describe("worker configuration", () => {
  it("keeps the Agent lease below the Vercel function ceiling", () => {
    expect(loadWorkerConfig({ ...database, VERCEL: "1" }).agentLeaseSeconds).toBe(780);
    expect(loadWorkerConfig(database).agentLeaseSeconds).toBe(1_800);
  });

  it("honors an explicit bounded Agent lease", () => {
    expect(loadWorkerConfig({
      ...database,
      VERCEL: "1",
      TWOFOLD_AGENT_LEASE_SECONDS: "600",
    }).agentLeaseSeconds).toBe(600);
  });
});
