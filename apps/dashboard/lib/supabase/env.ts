export interface PublicSupabaseConfig {
  url: string;
  publishableKey: string;
}

export interface ServerSupabaseConfig {
  url: string;
  key: string;
  usesSecretKey: boolean;
}

function hasHttpProtocol(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function readPublicSupabaseConfig(): PublicSupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const publishableKey = (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )?.trim() ?? "";

  if (!url || !publishableKey || !hasHttpProtocol(url)) {
    return null;
  }

  return { url, publishableKey };
}

export function readServerSupabaseConfig(): ServerSupabaseConfig | null {
  const publicConfig = readPublicSupabaseConfig();
  const url = (
    process.env.SUPABASE_URL
    ?? publicConfig?.url
    ?? ""
  ).trim();
  const privateLabEnabled =
    process.env.TWOFOLD_PRIVATE_LAB?.trim().toLowerCase() === "true";
  const localDogfoodEnabled = process.env.NODE_ENV !== "production"
    && process.env.TWOFOLD_LOCAL_DOGFOOD?.trim().toLowerCase() === "true";
  const serverSecretEnabled = privateLabEnabled || localDogfoodEnabled;
  const secretKey = serverSecretEnabled
    ? (
        process.env.SUPABASE_SECRET_KEY
        ?? process.env.SUPABASE_SERVICE_ROLE_KEY
      )?.trim() ?? ""
    : "";
  const key = secretKey || publicConfig?.publishableKey || "";
  if (!url || !key || !hasHttpProtocol(url)) return null;
  return { url, key, usesSecretKey: secretKey.length > 0 };
}
