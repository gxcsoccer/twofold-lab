import { timingSafeEqual } from "node:crypto";

export interface ArenaCronTickResult {
  readonly outcome: "idle" | "completed" | "failed";
}

export interface ArenaCronRunner {
  tick(signal: AbortSignal): Promise<ArenaCronTickResult>;
}

export async function handleArenaCronRequest(
  request: Request,
  input: {
    readonly cronSecret: string | undefined;
    readonly createRunner: () => ArenaCronRunner;
  },
): Promise<Response> {
  const secret = input.cronSecret;
  if (secret === undefined || secret.length < 16) {
    return json({ error: "cron is not configured" }, 503);
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (!sameSecret(authorization, `Bearer ${secret}`)) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    const result = await input.createRunner().tick(request.signal);
    return json(result, result.outcome === "failed" ? 503 : 200);
  } catch {
    return json({ error: "arena tick failed" }, 503);
  }
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
