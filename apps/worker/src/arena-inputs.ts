import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { JsonValue, ReadyDecisionPacket } from "@twofold-lab/dsh-twofold";

import {
  ARENA_PROJECTION_SCHEMA_VERSION,
  DECISION_PACKET_SCHEMA_VERSION,
  emptyArenaUsage,
  type ArenaInvocationIdentity,
  type ArenaProjectionState,
} from "./arena-types.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_ARENA_BUDGET = Object.freeze({
  maxProviderRequests: "4",
  maxBillableTokens: "120000",
  maxEstimatedCostUsd: "1.00",
  maxDescendants: "1",
});

export interface ArenaMarketBar {
  factId: string;
  symbol: string;
  barStart: string;
  barDate: string;
  currency: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
  tradeCount: string;
  vwap: string | null;
  factSha256: string;
}

export interface ArenaMarketSnapshot {
  snapshotId: string;
  sourceVersionId: string;
  manifestSha256: string;
  cutoffAt: string;
  targetSessionDate: string;
  selectionPolicy: string;
  sealedAt: string;
  symbols: readonly string[];
  bars: readonly ArenaMarketBar[];
}

export interface ArenaArtifactMaterial {
  content: string;
  sha256: string;
  byteSize: string;
  objectPath: string;
}

export interface BuiltArenaInputs {
  identity: Omit<
    ArenaInvocationIdentity,
    "packetArtifactId" | "bundleArtifactId"
  >;
  packet: ReadyDecisionPacket;
  packetArtifact: ArenaArtifactMaterial;
  bundleArtifact: ArenaArtifactMaterial;
  projection: ArenaProjectionState;
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortedJsonValue(record[key])]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedJsonValue(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(content: string, prefix: string): ArenaArtifactMaterial {
  const digest = sha256(content);
  return Object.freeze({
    content,
    sha256: digest,
    byteSize: String(Buffer.byteLength(content)),
    objectPath: `${prefix}/${digest}.json`,
  });
}

function uuidFromDigest(digest: string): string {
  const chars = digest.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

const BUNDLE_FILES = [
  "packages/dsh-twofold/package.json",
  "packages/dsh-twofold/cordis.patch.yml",
  "packages/dsh-twofold/src/contracts.ts",
  "packages/dsh-twofold/src/index.ts",
  "packages/dsh-twofold/src/orchestrator.ts",
  "packages/dsh-twofold/src/policy.ts",
  "profiles/twofold/agent-presets/twofold-orchestrator/agent.cordis.yml",
  "profiles/twofold/agent-presets/twofold-orchestrator/preset.yml",
] as const;

async function gitRevision(root: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  return stdout.trim();
}

async function buildBundleArtifact(
  repositoryRoot: string,
  harnessRoot: string,
): Promise<{ bundleId: string; material: ArenaArtifactMaterial }> {
  const files = await Promise.all(
    BUNDLE_FILES.map(async (path) => {
      const content = await readFile(resolve(repositoryRoot, path));
      return { path, sha256: sha256(content) };
    }),
  );
  const manifest = {
    schema_version: "twofold.dsh_agent_bundle_manifest/v1",
    bundle_id: "twofold-orchestrator@0.1.0",
    preset_id: "twofold-orchestrator",
    provider: "deepseek-official",
    model: "deepseek-v4-pro",
    harness: {
      repository: "deepseek-ai/deepseek-harness",
      revision: await gitRevision(harnessRoot),
    },
    files,
  };
  const content = canonicalJson(manifest);
  return {
    bundleId: manifest.bundle_id,
    material: artifact(content, "arena/agent-bundles"),
  };
}

export async function buildArenaInputs(input: {
  repositoryRoot: string;
  harnessRoot: string;
  snapshot: ArenaMarketSnapshot;
  now?: Date;
}): Promise<BuiltArenaInputs> {
  const now = input.now ?? new Date();
  const decisionAt = now.toISOString();
  const submissionDeadlineAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  const decisionId = randomUUID();
  const runId = randomUUID();
  const decisionPacketId = randomUUID();
  const rootSessionId = `twofold-${decisionId}`;
  const { bundleId, material: bundleArtifact } = await buildBundleArtifact(
    input.repositoryRoot,
    input.harnessRoot,
  );
  // A Bundle defines the comparable Agent season. Repeated dogfood decisions
  // using byte-identical Agent code therefore reuse one stable season scope.
  const seasonId = uuidFromDigest(sha256(`twofold-season:${bundleArtifact.sha256}`));

  const payload = {
    schema_version: DECISION_PACKET_SCHEMA_VERSION,
    decision: {
      decision_id: decisionId,
      decision_at: decisionAt,
      data_cutoff_at: input.snapshot.cutoffAt,
      submission_deadline_at: submissionDeadlineAt,
      scope: "paper_portfolio_targets_only",
    },
    market_snapshot: {
      snapshot_id: input.snapshot.snapshotId,
      source_version_id: input.snapshot.sourceVersionId,
      manifest_sha256: input.snapshot.manifestSha256,
      cutoff_at: input.snapshot.cutoffAt,
      target_session_date: input.snapshot.targetSessionDate,
      selection_policy: input.snapshot.selectionPolicy,
      sealed_at: input.snapshot.sealedAt,
      symbols: [...input.snapshot.symbols],
      bars: input.snapshot.bars.map((bar) => ({
        fact_id: bar.factId,
        symbol: bar.symbol,
        bar_start: bar.barStart,
        bar_date: bar.barDate,
        currency: bar.currency,
        open_price: bar.openPrice,
        high_price: bar.highPrice,
        low_price: bar.lowPrice,
        close_price: bar.closePrice,
        volume: bar.volume,
        trade_count: bar.tradeCount,
        vwap: bar.vwap,
        fact_sha256: bar.factSha256,
      })),
    },
    portfolio_state: {
      status: "not_configured",
      note: "This thin-slice decision records target weights only; no holdings, orders, fills, fees, taxes, or NAV are inferred.",
    },
    constraints: {
      eligible_symbols: [...input.snapshot.symbols],
      target_weight_total_bps: "10000",
      allow_cash: true,
      live_trading: false,
    },
    runtime_budget: {
      ...DEFAULT_ARENA_BUDGET,
      note: "Provider requests and token usage include the root and all descendant Sessions.",
    },
  } satisfies Record<string, JsonValue>;
  // Persist the complete reconstructable packet envelope. The digest is kept
  // outside the envelope to avoid a self-referential hash; it can be recovered
  // exactly from the immutable artifact metadata on replay.
  const packetContent = canonicalJson({
    status: "ready",
    decision_packet_id: decisionPacketId,
    available_at: decisionAt,
    payload,
  });
  const packetArtifact = artifact(packetContent, "arena/decision-packets");
  const persistedPacket = JSON.parse(packetContent) as {
    status: "ready";
    decision_packet_id: string;
    available_at: string;
    payload: Record<string, JsonValue>;
  };
  const packet: ReadyDecisionPacket = Object.freeze({
    status: persistedPacket.status,
    decision_packet_id: persistedPacket.decision_packet_id,
    packet_sha256: packetArtifact.sha256,
    available_at: persistedPacket.available_at,
    payload: persistedPacket.payload,
  });

  const identity = Object.freeze({
    decisionId,
    runId,
    seasonId,
    decisionPacketId,
    rootSessionId,
    snapshotId: input.snapshot.snapshotId,
    packetSha256: packetArtifact.sha256,
    bundleId,
    bundleSha256: bundleArtifact.sha256,
    presetId: "twofold-orchestrator" as const,
    provider: "deepseek-official" as const,
    model: "deepseek-v4-pro" as const,
    decisionAt,
    dataCutoffAt: input.snapshot.cutoffAt,
    submissionDeadlineAt,
  });
  const projection: ArenaProjectionState = {
    schemaVersion: ARENA_PROJECTION_SCHEMA_VERSION,
    decision: {
      decisionId,
      runId,
      seasonId,
      bundleId,
      bundleSha256: bundleArtifact.sha256,
      presetId: identity.presetId,
      status: "QUEUED",
      decisionPacketId,
      snapshotId: input.snapshot.snapshotId,
      packetSha256: packetArtifact.sha256,
      dataCutoffAt: input.snapshot.cutoffAt,
      startedAt: decisionAt,
      completedAt: null,
      failureCode: null,
      failureMessage: null,
    },
    rootSessionId,
    agents: [
      {
        sessionId: rootSessionId,
        parentSessionId: null,
        agentPath: "root",
        displayName: "Root Portfolio Manager",
        origin: "root",
        delegationDepth: "0",
        status: "QUEUED",
        provider: identity.provider,
        model: identity.model,
        startedAt: decisionAt,
        completedAt: null,
        lastEventSeq: "0",
        usage: emptyArenaUsage(),
      },
    ],
    treeUsage: emptyArenaUsage(),
    budget: {
      maxProviderRequests: DEFAULT_ARENA_BUDGET.maxProviderRequests,
      usedProviderRequests: "0",
      maxBillableTokens: DEFAULT_ARENA_BUDGET.maxBillableTokens,
      usedBillableTokens: "0",
      maxEstimatedCostUsd: DEFAULT_ARENA_BUDGET.maxEstimatedCostUsd,
      usedEstimatedCostUsd: null,
      maxDescendants: DEFAULT_ARENA_BUDGET.maxDescendants,
      activeDescendants: "0",
      enforcementStatus: "WITHIN_LIMITS",
    },
    submission: {
      status: "PENDING",
      acceptedSubmissionId: null,
      acceptedAt: null,
      rejectionCode: null,
    },
    updatedAt: decisionAt,
  };

  return Object.freeze({
    identity,
    packet,
    packetArtifact,
    bundleArtifact,
    projection,
  });
}

export function relativeHarnessPath(repositoryRoot: string, harnessRoot: string): string {
  return relative(repositoryRoot, harnessRoot);
}
