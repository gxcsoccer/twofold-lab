import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { composeEntries, loadProfile } from "@deepseek-ai/dsh-app-boot";
import { describe, expect, it } from "vitest";

import { ARENA_RUNTIME_PACKAGE_NAMES } from
  "../src/arena-runtime-package-manifest.js";
import { importArenaRuntimePackage } from
  "../src/arena-runtime-package-manifest.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function packageName(specifier: string): string {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]!;
}

describe("Arena serverless runtime package manifest", () => {
  it("imports declared packages and rejects undeclared dynamic specifiers", async () => {
    await expect(importArenaRuntimePackage("@deepseek-ai/dsh-base")).resolves.toBeDefined();
    await expect(importArenaRuntimePackage("@example/not-traced")).rejects.toThrow(
      "not declared in the serverless manifest",
    );
  });

  it("covers every active root and preset plugin with an explicit dependency", async () => {
    const installAnchor = resolve(repositoryRoot, "apps/worker/package.json");
    const profile = loadProfile(
      "twofold-arena-worker",
      "twofold",
      installAnchor,
      repositoryRoot,
    );
    const entries = composeEntries([
      ...profile.layers.map((layer) => layer.patches),
      profile.patches,
      [{ id: "hmr", disabled: true }],
      [{ id: "session-telemetry-otel", disabled: true }],
    ]);
    const activeRootPackages = entries
      .filter((entry) => entry.disabled !== true && entry.name.startsWith("@"))
      .map((entry) => entry.name);
    const presetPackages = new Set<string>();
    for (const path of [
      "profiles/twofold/agent-presets/twofold/agent.cordis.yml",
      "profiles/twofold/agent-presets/twofold-orchestrator/agent.cordis.yml",
    ]) {
      const source = await readFile(resolve(repositoryRoot, path), "utf8");
      for (const match of source.matchAll(/name:\s*['"]([^'"]+)['"]/g)) {
        presetPackages.add(match[1]!);
      }
    }
    const required = new Set([
      "@deepseek-ai/dsh-base",
      "@twofold-lab/dsh-twofold",
      ...activeRootPackages,
      ...presetPackages,
    ]);
    expect([...required].filter(
      (name) => !ARENA_RUNTIME_PACKAGE_NAMES.includes(name),
    )).toEqual([]);

    const workerManifest = JSON.parse(
      await readFile(installAnchor, "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(ARENA_RUNTIME_PACKAGE_NAMES.filter(
      (name) => workerManifest.dependencies?.[packageName(name)] === undefined,
    )).toEqual([]);
  });
});
