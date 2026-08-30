import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readPublicSupabaseConfig,
  readServerSupabaseConfig,
} from "./env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Supabase environment boundary", () => {
  it("uses the service credential only when the private server lab is explicit", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TWOFOLD_PRIVATE_LAB", "true");
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "server-only-secret");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "public-browser-key");

    expect(readServerSupabaseConfig()).toEqual({
      url: "https://example.supabase.co",
      key: "server-only-secret",
      usesSecretKey: true,
    });
    expect(readPublicSupabaseConfig()).toEqual({
      url: "https://example.supabase.co",
      publishableKey: "public-browser-key",
    });
  });

  it("does not use the service credential in an ordinary production dashboard", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TWOFOLD_PRIVATE_LAB", "false");
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "server-only-secret");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "public-browser-key");

    expect(readServerSupabaseConfig()).toEqual({
      url: "https://example.supabase.co",
      key: "public-browser-key",
      usesSecretKey: false,
    });
  });
});
