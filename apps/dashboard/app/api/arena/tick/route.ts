import {
  createArenaTickRunner,
  loadWorkerConfig,
} from "@twofold/worker/arena-serverless";

import { handleArenaCronRequest } from "@/lib/arena-cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export function GET(request: Request): Promise<Response> {
  return handleArenaCronRequest(request, {
    cronSecret: process.env.CRON_SECRET,
    createRunner: () => createArenaTickRunner(loadWorkerConfig()),
  });
}
