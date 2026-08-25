import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildArenaInputs,
  canonicalJson,
  sha256,
  type ArenaMarketSnapshot,
} from "../src/arena-inputs.js";

const BUNDLE_FIXTURE_FILES = [
  "packages/dsh-twofold/package.json",
  "packages/dsh-twofold/cordis.patch.yml",
  "packages/dsh-twofold/src/contracts.ts",
  "packages/dsh-twofold/src/index.ts",
  "packages/dsh-twofold/src/orchestrator.ts",
  "packages/dsh-twofold/src/policy.ts",
  "profiles/twofold/agent-presets/twofold-orchestrator/agent.cordis.yml",
  "profiles/twofold/agent-presets/twofold-orchestrator/preset.yml",
] as const;

const sealedSnapshot: ArenaMarketSnapshot = Object.freeze({
  snapshotId: "60000000-0000-4000-8000-000000000001",
  sourceVersionId: "60000000-0000-4000-8000-000000000002",
  manifestSha256: "a".repeat(64),
  cutoffAt: "2026-08-23T00:10:00.000Z",
  targetSessionDate: "2026-08-21",
  selectionPolicy: "latest-complete-market-close-v1",
  sealedAt: "2026-08-23T00:10:01.000Z",
  symbols: Object.freeze(["LULU", "SPY"]),
  bars: Object.freeze([
    Object.freeze({
      factId: "60000000-0000-4000-8000-000000000011",
      symbol: "LULU",
      barStart: "2026-08-21T04:00:00.000Z",
      barDate: "2026-08-21",
      currency: "USD",
      openPrice: "191.1",
      highPrice: "196.2",
      lowPrice: "190.5",
      closePrice: "195.3",
      volume: "1234567",
      tradeCount: "23456",
      vwap: "194.21",
      factSha256: "b".repeat(64),
    }),
    Object.freeze({
      factId: "60000000-0000-4000-8000-000000000012",
      symbol: "SPY",
      barStart: "2026-08-21T04:00:00.000Z",
      barDate: "2026-08-21",
      currency: "USD",
      openPrice: "640.1",
      highPrice: "644.2",
      lowPrice: "639.5",
      closePrice: "643.3",
      volume: "76543210",
      tradeCount: "345678",
      vwap: "642.51",
      factSha256: "c".repeat(64),
    }),
  ]),
});

function createBundleFixture(): {
  repositoryRoot: string;
  harnessRoot: string;
  mutableBundleFile: string;
  cleanup: () => void;
} {
  const sandbox = mkdtempSync(join(tmpdir(), "twofold-arena-inputs-"));
  const repositoryRoot = join(sandbox, "repository");
  const harnessRoot = join(sandbox, "harness");

  for (const path of BUNDLE_FIXTURE_FILES) {
    const absolutePath = join(repositoryRoot, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, `fixture:${path}\n`);
  }

  mkdirSync(harnessRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: harnessRoot });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Twofold Test",
      "-c",
      "user.email=twofold-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "--quiet",
      "--message=fixture revision",
    ],
    {
      cwd: harnessRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-08-23T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-08-23T00:00:00Z",
      },
    },
  );

  return {
    repositoryRoot,
    harnessRoot,
    mutableBundleFile: join(
      repositoryRoot,
      "packages/dsh-twofold/src/orchestrator.ts",
    ),
    cleanup: () => rmSync(sandbox, { force: true, recursive: true }),
  };
}

function jsonNumberPaths(value: unknown, path = "$"): string[] {
  if (typeof value === "number") return [path];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => jsonNumberPaths(item, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    jsonNumberPaths(item, `${path}.${key}`),
  );
}

describe("Arena invocation inputs", () => {
  it("serializes nested objects to stable canonical JSON bytes", () => {
    const first = canonicalJson({
      z: "last",
      a: { y: ["2", { d: "4", c: "3" }], x: true },
    });
    const second = canonicalJson({
      a: { x: true, y: ["2", { c: "3", d: "4" }] },
      z: "last",
    });

    expect(first).toBe(
      '{"a":{"x":true,"y":["2",{"c":"3","d":"4"}]},"z":"last"}',
    );
    expect(second).toBe(first);
    expect(sha256(second)).toBe(sha256(first));
  });

  it("derives a stable season from the complete Bundle and changes it with Bundle bytes", async () => {
    const fixture = createBundleFixture();
    try {
      const first = await buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        now: new Date("2026-08-23T01:00:00.000Z"),
      });
      const second = await buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        now: new Date("2026-08-30T01:00:00.000Z"),
      });

      expect(second.identity.bundleSha256).toBe(first.identity.bundleSha256);
      expect(second.identity.seasonId).toBe(first.identity.seasonId);
      expect(second.identity.decisionAt).not.toBe(first.identity.decisionAt);
      expect(first.identity.seasonId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(canonicalJson(JSON.parse(first.bundleArtifact.content))).toBe(
        first.bundleArtifact.content,
      );
      const persistedPacket = JSON.parse(first.packetArtifact.content) as {
        decision_packet_id: string;
        available_at: string;
        payload: { decision: { decision_id: string } };
      };
      expect(persistedPacket.decision_packet_id).toBe(
        first.identity.decisionPacketId,
      );
      expect(persistedPacket.available_at).toBe(first.identity.decisionAt);
      expect(persistedPacket.payload.decision.decision_id).toBe(
        first.identity.decisionId,
      );
      expect(sha256(first.packetArtifact.content)).toBe(
        first.identity.packetSha256,
      );

      writeFileSync(fixture.mutableBundleFile, "fixture:changed orchestrator bytes\n");
      const changed = await buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        now: new Date("2026-08-30T01:00:00.000Z"),
      });

      expect(changed.identity.bundleSha256).not.toBe(first.identity.bundleSha256);
      expect(changed.identity.seasonId).not.toBe(first.identity.seasonId);
    } finally {
      fixture.cleanup();
    }
  });

  it("binds the packet to the sealed snapshot and emits no JSON numeric tokens", async () => {
    const fixture = createBundleFixture();
    try {
      const built = await buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        now: new Date("2026-08-23T01:00:00.000Z"),
      });
      const packetJson = JSON.parse(built.packetArtifact.content) as {
        decision_packet_id: string;
        payload: {
          decision: { data_cutoff_at: string };
          market_snapshot: {
            snapshot_id: string;
            source_version_id: string;
            manifest_sha256: string;
            cutoff_at: string;
            symbols: string[];
            bars: Array<{ fact_id: string; fact_sha256: string; symbol: string }>;
          };
          constraints: {
            eligible_symbols: string[];
            target_weight_total_bps: string;
          };
        };
      };
      const bundleJson = JSON.parse(built.bundleArtifact.content) as unknown;

      expect(packetJson.decision_packet_id).toBe(built.identity.decisionPacketId);
      expect(packetJson.payload.market_snapshot).toMatchObject({
        snapshot_id: sealedSnapshot.snapshotId,
        source_version_id: sealedSnapshot.sourceVersionId,
        manifest_sha256: sealedSnapshot.manifestSha256,
        cutoff_at: sealedSnapshot.cutoffAt,
        symbols: ["LULU", "SPY"],
        bars: [
          {
            fact_id: sealedSnapshot.bars[0]!.factId,
            fact_sha256: sealedSnapshot.bars[0]!.factSha256,
            symbol: "LULU",
          },
          {
            fact_id: sealedSnapshot.bars[1]!.factId,
            fact_sha256: sealedSnapshot.bars[1]!.factSha256,
            symbol: "SPY",
          },
        ],
      });
      expect(packetJson.payload.decision.data_cutoff_at).toBe(sealedSnapshot.cutoffAt);
      expect(packetJson.payload.constraints).toEqual({
        allow_cash: true,
        eligible_symbols: ["LULU", "SPY"],
        live_trading: false,
        target_weight_total_bps: "10000",
      });
      expect(built.projection.budget).toMatchObject({
        maxProviderRequests: "4",
        maxDescendants: "1",
      });
      expect(built.identity.snapshotId).toBe(sealedSnapshot.snapshotId);
      expect(built.identity.packetSha256).toBe(built.packetArtifact.sha256);
      expect(built.packet.packet_sha256).toBe(built.packetArtifact.sha256);
      expect(sha256(built.packetArtifact.content)).toBe(built.packetArtifact.sha256);
      expect(canonicalJson(packetJson)).toBe(built.packetArtifact.content);
      expect(jsonNumberPaths(packetJson)).toEqual([]);
      expect(jsonNumberPaths(bundleJson)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});
