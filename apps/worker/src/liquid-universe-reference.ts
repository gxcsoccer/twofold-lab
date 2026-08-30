import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { LiquidUniverseFreezeArtifact } from "./liquid-universe.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;

export interface LiquidUniverseReference {
  readonly schema: "twofold.liquid_universe_reference/v1";
  readonly artifactPath: string;
  readonly artifactSha256: string;
  readonly memberCount: string;
}

export interface LoadedLiquidUniverse {
  readonly artifact: LiquidUniverseFreezeArtifact;
  readonly sha256: string;
}

export async function loadLiquidUniverseReference(
  repositoryRoot: string,
  reference: LiquidUniverseReference,
): Promise<LoadedLiquidUniverse> {
  if (
    reference.schema !== "twofold.liquid_universe_reference/v1"
    || !reference.artifactPath.startsWith("config/universes/")
    || reference.artifactPath.includes("..")
    || !reference.artifactPath.endsWith(".json")
    || !SHA256_PATTERN.test(reference.artifactSha256)
    || !/^[1-9]\d*$/.test(reference.memberCount)
  ) throw new TypeError("liquid universe reference is invalid");
  const root = resolve(repositoryRoot);
  const artifactPath = resolve(root, reference.artifactPath);
  if (relative(root, artifactPath).startsWith("..")) {
    throw new TypeError("liquid universe artifact escaped the repository");
  }
  const content = await readFile(artifactPath, "utf8");
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  if (digest !== reference.artifactSha256) {
    throw new TypeError("liquid universe artifact SHA-256 does not match config");
  }
  const artifact = parseLiquidUniverseArtifact(JSON.parse(content) as unknown);
  if (artifact.members.length.toString() !== reference.memberCount) {
    throw new TypeError("liquid universe member count does not match config");
  }
  return Object.freeze({ artifact, sha256: digest });
}

export function parseLiquidUniverseArtifact(
  value: unknown,
): LiquidUniverseFreezeArtifact {
  assertNumberFree(value, "liquid universe artifact");
  const row = record(value, "liquid universe artifact");
  if (
    row.schema !== "twofold.liquid_universe_freeze/v1"
    || row.name !== "US Liquid 100"
    || typeof row.asOfSessionDate !== "string"
    || typeof row.frozenAt !== "string"
  ) throw new TypeError("liquid universe artifact identity is invalid");
  const policy = record(row.policy, "liquid universe policy");
  const constraints = record(policy.constraints, "liquid universe constraints");
  if (
    policy.name !== "US Liquid 100" || policy.size !== "100"
    || policy.minimumPriceUsd !== "5"
    || policy.minimumMedianDollarVolumeUsd !== "20000000"
    || policy.medianDollarVolumeSessions !== "20"
    || policy.minimumHistorySessions !== "120"
    || constraints.minimumPositions !== "5"
    || constraints.maximumPositions !== "10"
    || constraints.maximumPositionWeightBps !== "2000"
    || constraints.minimumCashWeightBps !== "500"
    || !Array.isArray(policy.mandatorySymbols)
    || policy.mandatorySymbols.length !== 1
    || policy.mandatorySymbols[0] !== "LULU"
  ) throw new TypeError("liquid universe frozen policy is unsupported");
  if (!Array.isArray(row.members) || row.members.length !== 100) {
    throw new TypeError("liquid universe artifact must contain 100 members");
  }
  if (!Array.isArray(row.candidates)) {
    throw new TypeError("liquid universe candidates must be an array");
  }
  const symbols = new Set<string>();
  const instrumentIds = new Set<string>();
  for (const [index, candidate] of row.members.entries()) {
    const member = record(candidate, `members[${index}]`);
    if (
      typeof member.instrumentId !== "string"
      || !UUID_PATTERN.test(member.instrumentId)
      || typeof member.symbol !== "string"
      || !SYMBOL_PATTERN.test(member.symbol)
      || member.instrumentType !== "common_stock"
      || typeof member.primaryExchange !== "string"
      || typeof member.issuerTaxResidency !== "string"
      || !/^[A-Z]{2}$/.test(member.issuerTaxResidency)
      || typeof member.effectiveFrom !== "string"
      || typeof member.issuer !== "string"
      || typeof member.liquidityRank !== "string"
      || (member.selectionReason !== "LIQUIDITY_RANK"
        && member.selectionReason !== "MANDATORY_CURRENT_HOLDING")
    ) throw new TypeError(`liquid universe member ${index} is invalid`);
    if (symbols.has(member.symbol) || instrumentIds.has(member.instrumentId)) {
      throw new TypeError("liquid universe members are not unique");
    }
    symbols.add(member.symbol);
    instrumentIds.add(member.instrumentId);
  }
  const selectedCandidates = row.candidates.filter((candidate, index) => {
    const parsed = record(candidate, `candidates[${index}]`);
    return parsed.selected === true;
  });
  if (
    selectedCandidates.length !== 100
    || selectedCandidates.some((candidate) =>
      typeof candidate.symbol !== "string" || !symbols.has(candidate.symbol))
  ) throw new TypeError("selected candidates do not reproduce the member set");
  return deepFreeze(row as unknown as LiquidUniverseFreezeArtifact);
}

function assertNumberFree(value: unknown, field: string): void {
  if (typeof value === "number") throw new TypeError(`${field} contains a JSON number`);
  if (Array.isArray(value)) {
    value.forEach((candidate, index) => assertNumberFree(candidate, `${field}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    Object.entries(value).forEach(([key, candidate]) =>
      assertNumberFree(candidate, `${field}.${key}`));
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
