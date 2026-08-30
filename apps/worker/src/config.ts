export interface WorkerConfig {
  readonly workerId: string;
  readonly pollIntervalMs: number;
  readonly leaseSeconds: number;
  readonly agentLeaseSeconds: number;
  readonly supabaseUrl?: string;
  readonly supabaseSecretKey?: string;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function boundedLease(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = positiveInteger(value, fallback, name);
  if (parsed < 5 || parsed > 3_600) {
    throw new Error(`${name} must be between 5 and 3600 seconds`);
  }
  return parsed;
}

export function loadWorkerConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkerConfig {
  const supabaseUrl = environment.SUPABASE_URL;
  const supabaseSecretKey = environment.SUPABASE_SECRET_KEY;
  const hasSupabase = Boolean(supabaseUrl && supabaseSecretKey);

  if ((supabaseUrl === undefined) !== (supabaseSecretKey === undefined)) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be provided together");
  }
  if (!hasSupabase) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required for real data");
  }

  return {
    workerId: environment.TWOFOLD_WORKER_ID ?? "twofold-local-worker",
    pollIntervalMs: positiveInteger(
      environment.TWOFOLD_POLL_INTERVAL_MS,
      5_000,
      "TWOFOLD_POLL_INTERVAL_MS",
    ),
    leaseSeconds: boundedLease(
      environment.TWOFOLD_LEASE_SECONDS,
      60,
      "TWOFOLD_LEASE_SECONDS",
    ),
    agentLeaseSeconds: boundedLease(
      environment.TWOFOLD_AGENT_LEASE_SECONDS,
      environment.VERCEL === "1" ? 780 : 1_800,
      "TWOFOLD_AGENT_LEASE_SECONDS",
    ),
    ...(supabaseUrl === undefined ? {} : { supabaseUrl }),
    ...(supabaseSecretKey === undefined ? {} : { supabaseSecretKey }),
  };
}
