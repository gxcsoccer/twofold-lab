import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const workerManifest = JSON.parse(readFileSync(
  resolve(repositoryRoot, "apps/worker/package.json"),
  "utf8",
)) as { dependencies?: Readonly<Record<string, string>> };
const harnessRuntimePackages = Object.freeze(Object.keys(
  workerManifest.dependencies ?? {},
).filter((name) =>
  name.startsWith("@deepseek-ai/") || name === "@twofold-lab/dsh-twofold"
).sort((left, right) => left.localeCompare(right, "en")));
if (
  !harnessRuntimePackages.includes("@deepseek-ai/cordis")
  || !harnessRuntimePackages.includes("@twofold-lab/dsh-twofold")
) throw new TypeError("Worker manifest is missing the Arena runtime dependencies");

const nextConfig: NextConfig = {
  agentRules: false,
  outputFileTracingRoot: repositoryRoot,
  outputFileTracingIncludes: {
    "/api/arena/tick": [
      "../../apps/worker/package.json",
      "../../apps/worker/dist/serverless-profile/**/*",
      "../../config/**/*.json",
      "../../node_modules/.pnpm/@koromix+koffi-linux-x64@*/node_modules/@koromix/koffi-linux-x64/**/*",
      "../../node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/linux-x64/**/*",
      "../../packages/dsh-twofold/package.json",
      "../../packages/dsh-twofold/cordis.patch.yml",
      "../../packages/dsh-twofold/dist/**/*",
      "../../packages/dsh-twofold/src/**/*",
      "../../profiles/twofold/**/*",
    ],
  },
  outputFileTracingExcludes: {
    "*": ["../../.env", "../../.env.*"],
  },
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: [...harnessRuntimePackages],
  transpilePackages: ["@twofold/worker", "@twofold/core"],
};

export default nextConfig;
