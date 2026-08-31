import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createDeterministicBaselinePolicy } from "@twofold/core";

import { loadBaselineCompetitionSeat } from "../src/arena-baseline-runner.js";
import type { ArenaWorkItem } from "../src/arena-work-repository.js";

const SEASON_ID = "1486ba8e-47ae-5774-ba44-5c26f9359eeb";
const ROUND_ID = "d83eff85-da7b-5e07-81d6-d4feaf4d9839";
const BASELINE_ENTRANT = "66666666-6666-4666-8666-666666666666";
const AGENT_ENTRANT = "196b42d0-9c43-5532-859e-9319f235f083";
const BASELINE_RUN = "77777777-7777-4777-8777-777777777777";
const AGENT_RUN = "ce2caf2a-a4f5-58fc-8794-16abb3d369aa";

const holdGenesis = createDeterministicBaselinePolicy({
  policyId: "hold-genesis",
  rule: "HOLD_GENESIS",
  symbol: null,
});

function workItem(overrides: Partial<ArenaWorkItem> = {}): ArenaWorkItem {
  return {
    schema: "twofold.arena_work_item_result/v1",
    workItemId: "88888888-8888-4888-8888-888888888888",
    roundEntryId: "44444444-4444-4444-8444-444444444444",
    roundId: ROUND_ID,
    seasonId: SEASON_ID,
    entrantId: BASELINE_ENTRANT,
    runId: BASELINE_RUN,
    phase: "RUN_AGENT_DECISION",
    predecessorWorkItemId: null,
    scheduledAt: "2026-08-29T21:28:55.699Z",
    deadlineAt: "2026-08-31T13:15:00.000Z",
    nextAttemptAt: "2026-08-29T21:28:55.699Z",
    status: "CLAIMED",
    attemptCount: "0",
    claimedBy: "twofold-test",
    leaseToken: "99999999-9999-4999-8999-999999999999",
    leaseExpiresAt: null,
    completedAt: null,
    result: null,
    errorCode: null,
    ...overrides,
  } as ArenaWorkItem;
}

function config(baselineOverrides: Record<string, unknown> = {}) {
  return {
    schema: "twofold.private_controlled_lab_config/v1",
    season: {
      seasonId: SEASON_ID,
      seasonCode: "private-us-liquid-100-s5",
      openingSymbol: "LULU",
    },
    rounds: [{ roundId: ROUND_ID, roundIndex: "1" }],
    entrants: [
      {
        entrantId: AGENT_ENTRANT,
        entrantCode: "twofold",
        runId: AGENT_RUN,
        bundleId: "twofold@0.1.0",
        bundleSha256: "7a2ecdef10a51c5c9d0d4235ae32625747b0af9d234ff1ef489536cc7ad7c473",
        presetId: "twofold",
        provider: "deepseek-official",
        model: "deepseek-v4-pro",
        executionClass: "ROOT_ONLY",
      },
      {
        entrantId: BASELINE_ENTRANT,
        entrantCode: "baseline-hold-lulu",
        runId: BASELINE_RUN,
        bundleId: "twofold-baseline-hold-genesis@1.0.0",
        bundleSha256: holdGenesis.policySha256,
        presetId: "none",
        provider: "none",
        model: "none",
        executionClass: "DETERMINISTIC_BASELINE",
        baselinePolicy: { policyId: "hold-genesis", rule: "HOLD_GENESIS", symbol: null },
        ...baselineOverrides,
      },
    ],
  };
}

let root = "";

async function writeConfig(value: unknown, name = "private-s5.json") {
  await writeFile(join(root, "config", name), JSON.stringify(value), "utf8");
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "twofold-baseline-seat-"));
  await mkdir(join(root, "config"), { recursive: true });
});

describe("baseline competition seat", () => {
  it("loads the frozen policy for a baseline entrant", async () => {
    await writeConfig(config());
    const seat = await loadBaselineCompetitionSeat(
      root,
      "config/private-s5.json",
      workItem(),
    );
    expect(seat).not.toBeNull();
    expect(seat!.entrantCode).toBe("baseline-hold-lulu");
    expect(seat!.genesisSymbol).toBe("LULU");
    expect(seat!.policy.policySha256).toBe(holdGenesis.policySha256);
    expect(seat!.roundIndex).toBe("1");
  });

  it("returns null for an Agent entrant so the Harness path runs", async () => {
    await writeConfig(config());
    const seat = await loadBaselineCompetitionSeat(
      root,
      "config/private-s5.json",
      workItem({ entrantId: AGENT_ENTRANT, runId: AGENT_RUN }),
    );
    expect(seat).toBeNull();
  });

  it("rejects policy bytes edited after entrant registration", async () => {
    await writeConfig(config({
      baselinePolicy: { policyId: "all-in-nvda", rule: "ALL_IN_SYMBOL", symbol: "NVDA" },
    }));
    await expect(loadBaselineCompetitionSeat(
      root,
      "config/private-s5.json",
      workItem(),
    )).rejects.toThrow(/do not match the registered entrant identity/);
  });

  it("rejects a baseline seat that claims a provider route", async () => {
    await writeConfig(config({ provider: "deepseek-official" }));
    await expect(loadBaselineCompetitionSeat(
      root,
      "config/private-s5.json",
      workItem(),
    )).rejects.toThrow(/does not match claimed baseline work/);
  });

  it("rejects a seat whose run identity diverges from the work item", async () => {
    await writeConfig(config({ runId: AGENT_RUN }));
    await expect(loadBaselineCompetitionSeat(
      root,
      "config/private-s5.json",
      workItem(),
    )).rejects.toThrow(/does not match claimed baseline work/);
  });

  it("fails closed when no config matches the claimed Season", async () => {
    await writeConfig(config());
    await expect(loadBaselineCompetitionSeat(
      root,
      "config/private-s5.json",
      workItem({ seasonId: "12121212-1212-4212-8212-121212121212" }),
    )).rejects.toThrow(/no competition config matches/);
  });
});

describe("baseline seat round fallback", () => {
  it("loads a seat for a Round the config file no longer lists", async () => {
    const later = config();
    later.rounds = [{ roundId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", roundIndex: "1" }];
    await writeConfig(later);
    const seat = await loadBaselineCompetitionSeat(
      root,
      "config/private-s5.json",
      workItem({ roundId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
    );
    // The database fence supplies the authoritative index for a later Round.
    expect(seat).not.toBeNull();
    expect(seat!.roundIndex).toBeUndefined();
    expect(seat!.policy.policySha256).toBe(holdGenesis.policySha256);
  });
});
