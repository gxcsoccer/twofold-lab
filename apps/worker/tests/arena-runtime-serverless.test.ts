import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { stageArenaRuntimeHome } from
  "../src/arena-agent-decision-handler.js";
import { createArenaRuntime } from "../src/arena-runtime.js";

describe("Arena runtime serverless boot", () => {
  it("boots from a read-only traced profile without creating module symlinks", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "twofold-arena-runtime-"));
    const deploymentRoot = join(sandbox, "deployment");
    const profilesRoot = join(deploymentRoot, "profiles");
    const previousDshHome = process.env.DSH_HOME;
    let runtimeRoot: string | undefined;
    mkdirSync(profilesRoot, { recursive: true });
    cpSync(
      resolve(process.cwd(), "profiles/twofold"),
      join(profilesRoot, "twofold"),
      { recursive: true },
    );
    chmodSync(profilesRoot, 0o555);

    try {
      delete process.env.DSH_HOME;
      const stagedRoot = await stageArenaRuntimeHome(deploymentRoot);
      runtimeRoot = stagedRoot;
      const runtime = await createArenaRuntime({
        repositoryRoot: stagedRoot,
        workerId: "serverless-boot-test",
        installAnchor: resolve(process.cwd(), "apps/worker/package.json"),
        profileBundlePatchPaths: [
          resolve(
            process.cwd(),
            "apps/worker/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml",
          ),
          resolve(process.cwd(), "packages/dsh-twofold/cordis.patch.yml"),
        ],
        profileDirectory: resolve(stagedRoot, "profiles/twofold"),
        profileModuleHealing: false,
        runtimePackageManifest: true,
      });
      await runtime.dispose();
      expect(() => mkdirSync(join(stagedRoot, "writable-check"))).not.toThrow();
      expect(existsSync(join(stagedRoot, "profiles/node_modules"))).toBe(false);
      expect(() => chmodSync(profilesRoot, 0o755)).not.toThrow();
    } finally {
      chmodSync(profilesRoot, 0o755);
      if (previousDshHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousDshHome;
      if (runtimeRoot !== undefined) {
        rmSync(runtimeRoot, { force: true, recursive: true });
      }
      rmSync(sandbox, { force: true, recursive: true });
    }
  });
});
