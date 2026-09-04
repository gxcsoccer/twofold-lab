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
  buildArenaBundleArtifact,
  buildArenaInputs,
  canonicalJson,
  portfolioConstraintViolation,
  sha256,
  type ArenaMarketSnapshot,
  type ArenaPortfolioState,
} from "../src/arena-inputs.js";
import type { LoadedLiquidUniverse } from
  "../src/liquid-universe-reference.js";

const BUNDLE_FIXTURE_FILES = [
  "packages/dsh-twofold/package.json",
  "packages/dsh-twofold/cordis.patch.yml",
  "packages/dsh-twofold/src/contracts.ts",
  "packages/dsh-twofold/src/index.ts",
  "packages/dsh-twofold/src/orchestrator.ts",
  "packages/dsh-twofold/src/policy.ts",
  "profiles/twofold/agent-presets/twofold-orchestrator/agent.cordis.yml",
  "profiles/twofold/agent-presets/twofold-orchestrator/preset.yml",
  "profiles/twofold/agent-presets/twofold/agent.cordis.yml",
  "profiles/twofold/agent-presets/twofold/preset.yml",
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

const configuredPortfolio: ArenaPortfolioState = Object.freeze({
  schema: "twofold.strategy_portfolio_state/v1",
  strategyAccountId: "73000000-0000-4000-8000-000000000001",
  runId: "72000000-0000-4000-8000-000000000001",
  asOf: "2026-08-23T00:30:00.000Z",
  account: Object.freeze({
    accountCode: "private-controlled-lab-s1:twofold-orchestrator",
    broker: "TWOFOLD_PAPER",
    brokerRegion: "US",
    baseCurrency: "USD",
    liveTrading: false,
  }),
  ledgerHead: Object.freeze({
    sequence: "0",
    sha256: "d".repeat(64),
    accountingTransactionCount: "1",
    lotOriginCount: "1",
    acquisitionFxBindingCount: "1",
    settlementCount: "0",
    corporateActionMutationCount: "0",
  }),
  cash: Object.freeze({
    settled: "0",
    taxReserve: "0",
    buyingPower: "0",
  }),
  positions: Object.freeze([
    Object.freeze({
      instrumentId: "74000000-0000-4000-8000-000000000001",
      symbol: "LULU",
      quantity: "150",
      grossCost: "18121.5",
      taxBasis: "18121.5",
      currency: "USD",
      lotCount: "1",
    }),
  ]),
});

function decisionUniverse(asOfSessionDate: string): LoadedLiquidUniverse {
  const candidates = sealedSnapshot.symbols.map((symbol, index) => ({
    symbol,
    assetId: `asset-${symbol}`,
    issuer: `${symbol} Corporation`,
    issuerTaxResidency: "US",
    primaryExchange: "NASDAQ",
    effectiveFrom: "2000-01-01",
    asOfSessionDate,
    historyStartDate: "2026-01-01",
    historySessionCount: "160",
    latestClosePrice: index === 0 ? "195.3" : "643.3",
    medianDollarVolume20d: "100000000",
    return5dBps: "100",
    return20dBps: "200",
    return60dBps: "300",
    liquidityRank: String(index + 1),
    selected: true,
    selectionReason: symbol === "LULU"
      ? "MANDATORY_CURRENT_HOLDING" as const
      : "LIQUIDITY_RANK" as const,
  }));
  return {
    sha256: "e".repeat(64),
    artifact: {
      schema: "twofold.liquid_universe_freeze/v1",
      name: "US Liquid 100",
      asOfSessionDate,
      frozenAt: "2026-08-20T20:00:00.000Z",
      policy: {
        name: "US Liquid 100",
        size: "100",
        minimumPriceUsd: "5",
        minimumMedianDollarVolumeUsd: "20000000",
        medianDollarVolumeSessions: "20",
        minimumHistorySessions: "120",
        allowedExchanges: ["AMEX", "NASDAQ", "NYSE"],
        mandatorySymbols: ["LULU"],
        constraints: {
          minimumPositions: "5",
          maximumPositions: "10",
          maximumPositionWeightBps: "2000",
          minimumCashWeightBps: "500",
        },
      },
      sources: {
        observedAt: "2026-08-20T20:00:00.000Z",
        alpacaAssets: { url: "https://example.com/a", responseSha256: "1".repeat(64) },
        nasdaqStockScreener: { url: "https://example.com/b", responseSha256: "2".repeat(64) },
        nasdaqTradedDirectory: { url: "https://example.com/c", responseSha256: "3".repeat(64) },
        alpacaDailyBars: { url: "https://example.com/d", responseSha256: "4".repeat(64) },
      },
      eligibleCandidateCount: "2",
      members: candidates.map((candidate, index) => ({
        instrumentId: `74000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
        symbol: candidate.symbol,
        instrumentType: "common_stock" as const,
        primaryExchange: candidate.primaryExchange,
        issuerTaxResidency: candidate.issuerTaxResidency,
        effectiveFrom: candidate.effectiveFrom,
        issuer: candidate.issuer,
        liquidityRank: candidate.liquidityRank,
        selectionReason: candidate.selectionReason,
      })),
      candidates,
    },
  };
}

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
  it("enforces the complete Liquid 100 portfolio policy at submission time", () => {
    const packet = {
      status: "ready",
      decision_packet_id: "packet-1",
      packet_sha256: "a".repeat(64),
      available_at: "2026-08-30T00:00:00.000Z",
      payload: {
        constraints: {
          minimum_positions: "5",
          maximum_positions: "10",
          maximum_position_weight_bps: "2000",
          minimum_cash_weight_bps: "500",
        },
      },
    } as const;
    const submission = (targets: Array<{ symbol: string; target_weight_bps: string }>, cash = "500") => ({
      session_id: "session-1",
      decision_packet_id: "packet-1",
      packet_sha256: "a".repeat(64),
      targets,
      cash_weight_bps: cash,
      decision_summary: "test",
    });
    const validTargets = ["AAPL", "AMZN", "META", "MSFT", "NVDA"]
      .map((symbol) => ({ symbol, target_weight_bps: "1900" }));

    expect(portfolioConstraintViolation(submission(validTargets), packet)).toBeUndefined();
    expect(portfolioConstraintViolation(submission(validTargets.slice(0, 4)), packet))
      .toBe("Portfolio must contain 5-10 positions");
    expect(portfolioConstraintViolation(submission([
      { symbol: "AAPL", target_weight_bps: "2001" },
      ...validTargets.slice(1),
    ]), packet)).toBe("AAPL exceeds the 2000 bps position cap");
    expect(portfolioConstraintViolation(submission(validTargets, "499"), packet))
      .toBe("Portfolio must retain at least 500 bps cash");
  });

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

  it("keeps one explicit Season/Run across Rounds and binds it to Bundle bytes", async () => {
    const fixture = createBundleFixture();
    try {
      const discovery = await buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        now: new Date("2026-08-23T01:00:00.000Z"),
      });
      const competitionIdentity = {
        seasonId: "71000000-0000-4000-8000-000000000001",
        runId: "72000000-0000-4000-8000-000000000001",
        entrantCode: "twofold-orchestrator",
        bundleId: discovery.identity.bundleId,
        bundleSha256: discovery.identity.bundleSha256,
        presetId: "twofold-orchestrator" as const,
        executionClass: "ORCHESTRATED" as const,
      };
      const first = await buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        competitionIdentity,
        portfolioState: configuredPortfolio,
        now: new Date("2026-08-23T01:00:00.000Z"),
      });
      const second = await buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        competitionIdentity,
        portfolioState: configuredPortfolio,
        now: new Date("2026-08-30T01:00:00.000Z"),
      });

      expect(second.identity.bundleSha256).toBe(first.identity.bundleSha256);
      expect(second.identity.seasonId).toBe(first.identity.seasonId);
      expect(second.identity.runId).toBe(first.identity.runId);
      expect(first.identity.seasonId).toBe(competitionIdentity.seasonId);
      expect(first.identity.runId).toBe(competitionIdentity.runId);
      expect(second.identity.decisionAt).not.toBe(first.identity.decisionAt);
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
      await expect(buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        competitionIdentity,
        portfolioState: configuredPortfolio,
        now: new Date("2026-08-30T01:00:00.000Z"),
      })).rejects.toThrow("does not match the immutable Agent Bundle");
    } finally {
      fixture.cleanup();
    }
  });

  it("rebuilds one entrant Round to byte-identical decision inputs", async () => {
    const fixture = createBundleFixture();
    try {
      const bundle = await buildArenaBundleArtifact({
        ...fixture,
        presetId: "twofold-orchestrator",
      });
      const competitionIdentity = {
        seasonId: "71000000-0000-4000-8000-000000000001",
        runId: configuredPortfolio.runId,
        entrantCode: "twofold-orchestrator",
        bundleId: bundle.bundleId,
        bundleSha256: bundle.material.sha256,
        presetId: "twofold-orchestrator" as const,
        executionClass: "ORCHESTRATED" as const,
      };
      const roundFence = {
        roundId: "75000000-0000-4000-8000-000000000001",
        roundIndex: "1",
        decisionId: "76000000-0000-4000-8000-000000000001",
        decisionAt: "2026-08-23T01:00:00.000Z",
        submissionDeadlineAt: "2026-08-23T01:15:00.000Z",
      } as const;
      const first = await buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        competitionIdentity,
        roundFence,
        portfolioState: configuredPortfolio,
        now: new Date("2026-08-23T01:01:00.000Z"),
      });
      const replay = await buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        competitionIdentity,
        roundFence,
        portfolioState: configuredPortfolio,
        now: new Date("2026-08-23T01:10:00.000Z"),
      });

      expect(replay.identity).toEqual(first.identity);
      expect(replay.packetArtifact.content).toBe(first.packetArtifact.content);
      expect(replay.packetArtifact.sha256).toBe(first.packetArtifact.sha256);
      expect(replay.identity.decisionId).toBe(roundFence.decisionId);
      expect(replay.identity.submissionDeadlineAt).toBe(
        roundFence.submissionDeadlineAt,
      );
      const packet = JSON.parse(replay.packetArtifact.content) as {
        payload: { round: unknown };
      };
      expect(packet.payload.round).toEqual({
        round_id: roundFence.roundId,
        round_index: "1",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when a competition Round lacks its durable portfolio state", async () => {
    const fixture = createBundleFixture();
    try {
      const discovery = await buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        now: new Date("2026-08-23T01:00:00.000Z"),
      });
      await expect(buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        competitionIdentity: {
          seasonId: "71000000-0000-4000-8000-000000000001",
          runId: configuredPortfolio.runId,
          entrantCode: "twofold-orchestrator",
          bundleId: discovery.identity.bundleId,
          bundleSha256: discovery.identity.bundleSha256,
          presetId: "twofold-orchestrator",
          executionClass: "ORCHESTRATED",
        },
        now: new Date("2026-08-23T01:00:00.000Z"),
      })).rejects.toThrow("competition Round requires a durable portfolio state");
    } finally {
      fixture.cleanup();
    }
  });

  it("binds the decision packet to the exact account head and 150 LULU shares", async () => {
    const fixture = createBundleFixture();
    try {
      const discovery = await buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        now: new Date("2026-08-23T01:00:00.000Z"),
      });
      const built = await buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        competitionIdentity: {
          seasonId: "71000000-0000-4000-8000-000000000001",
          runId: configuredPortfolio.runId,
          entrantCode: "twofold-orchestrator",
          bundleId: discovery.identity.bundleId,
          bundleSha256: discovery.identity.bundleSha256,
          presetId: "twofold-orchestrator",
          executionClass: "ORCHESTRATED",
        },
        portfolioState: configuredPortfolio,
        now: new Date("2026-08-23T01:00:00.000Z"),
      });
      const packet = JSON.parse(built.packetArtifact.content) as {
        payload: { portfolio_state: unknown };
      };

      expect(packet.payload.portfolio_state).toEqual({
        status: "configured",
        strategy_account_id: configuredPortfolio.strategyAccountId,
        run_id: configuredPortfolio.runId,
        as_of: configuredPortfolio.asOf,
        account: {
          account_code: configuredPortfolio.account.accountCode,
          broker: configuredPortfolio.account.broker,
          broker_region: configuredPortfolio.account.brokerRegion,
          base_currency: "USD",
          live_trading: false,
        },
        ledger_head: {
          sequence: "0",
          sha256: "d".repeat(64),
          accounting_transaction_count: "1",
          lot_origin_count: "1",
          acquisition_fx_binding_count: "1",
          settlement_count: "0",
          corporate_action_mutation_count: "0",
        },
        cash: {
          settled: "0",
          tax_reserve: "0",
          buying_power: "0",
        },
        positions: [{
          instrument_id: "74000000-0000-4000-8000-000000000001",
          symbol: "LULU",
          quantity: "150",
          gross_cost: "18121.5",
          tax_basis: "18121.5",
          currency: "USD",
          lot_count: "1",
        }],
      });
      expect(jsonNumberPaths(packet.payload.portfolio_state)).toEqual([]);
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

  it("reuses a frozen Season universe for a later Round snapshot", async () => {
    const fixture = createBundleFixture();
    try {
      const built = await buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        decisionUniverse: decisionUniverse("2026-08-20"),
        now: new Date("2026-08-23T01:00:00.000Z"),
      });
      const packet = JSON.parse(built.packetArtifact.content) as {
        payload: {
          decision_universe: { as_of_session_date: string };
          market_snapshot: { target_session_date: string };
        };
      };

      expect(packet.payload.decision_universe.as_of_session_date).toBe("2026-08-20");
      expect(packet.payload.market_snapshot.target_session_date).toBe("2026-08-21");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a frozen universe dated after the bound snapshot", async () => {
    const fixture = createBundleFixture();
    try {
      await expect(buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        decisionUniverse: decisionUniverse("2026-08-22"),
        now: new Date("2026-08-23T01:00:00.000Z"),
      })).rejects.toThrow("liquid universe does not match the bound market snapshot");
    } finally {
      fixture.cleanup();
    }
  });

  it("treats the root-only preset as a distinct immutable entrant Bundle", async () => {
    const fixture = createBundleFixture();
    try {
      const rootBundle = await buildArenaBundleArtifact({
        ...fixture,
        presetId: "twofold",
      });
      const orchestratorBundle = await buildArenaBundleArtifact({
        ...fixture,
        presetId: "twofold-orchestrator",
      });
      expect(rootBundle.bundleId).toBe("twofold@0.1.0");
      expect(orchestratorBundle.bundleId).toBe("twofold-orchestrator@0.1.0");
      expect(rootBundle.material.sha256).not.toBe(orchestratorBundle.material.sha256);

      const rootPortfolio = {
        ...configuredPortfolio,
        runId: "72000000-0000-4000-8000-000000000002",
      } as const;
      const built = await buildArenaInputs({
        ...fixture,
        snapshot: sealedSnapshot,
        competitionIdentity: {
          seasonId: "71000000-0000-4000-8000-000000000001",
          runId: rootPortfolio.runId,
          entrantCode: "twofold",
          bundleId: rootBundle.bundleId,
          bundleSha256: rootBundle.material.sha256,
          presetId: "twofold",
          executionClass: "ROOT_ONLY",
        },
        portfolioState: rootPortfolio,
        now: new Date("2026-08-23T01:00:00.000Z"),
      });
      expect(built.identity.presetId).toBe("twofold");
      expect(built.projection.budget.maxDescendants).toBe("0");
      expect(built.bundleArtifact.sha256).toBe(rootBundle.material.sha256);
    } finally {
      fixture.cleanup();
    }
  });

  it("builds the same immutable Bundle from an explicit frozen Harness revision", async () => {
    const fixture = createBundleFixture();
    try {
      const harnessRevision = execFileSync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: fixture.harnessRoot, encoding: "utf8" },
      ).trim();
      const local = await buildArenaBundleArtifact({
        ...fixture,
        presetId: "twofold-orchestrator",
      });
      const frozen = await buildArenaBundleArtifact({
        repositoryRoot: fixture.repositoryRoot,
        harnessRoot: join(fixture.harnessRoot, "not-present-in-serverless"),
        harnessRevision,
        presetId: "twofold-orchestrator",
      });

      expect(frozen).toEqual(local);
      expect(JSON.parse(frozen.material.content)).toMatchObject({
        harness: { revision: harnessRevision },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a non-commit Harness revision before building a Bundle", async () => {
    const fixture = createBundleFixture();
    try {
      await expect(buildArenaBundleArtifact({
        ...fixture,
        harnessRevision: "main",
        presetId: "twofold-orchestrator",
      })).rejects.toThrow("Harness revision must be a lowercase 40-hex commit");
    } finally {
      fixture.cleanup();
    }
  });
});
