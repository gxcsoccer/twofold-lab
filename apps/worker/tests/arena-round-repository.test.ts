import { describe, expect, it, vi } from "vitest";

import {
  registerArenaRoundExact,
  registerArenaRoundEntryExact,
  type ArenaRoundRpcClient,
  type ArenaRoundEntryRpcClient,
  type RegisterArenaRoundRpcArguments,
} from "../src/arena-round-repository.js";

const args: RegisterArenaRoundRpcArguments = Object.freeze({
  p_idempotency_key: "private-controlled-lab-s1:round:1",
  p_round_id: "d1000000-0000-4000-8000-000000000001",
  p_season_id: "286387f5-c8b8-5b50-98c5-6cf6027e547f",
  p_round_index: "1",
  p_decision_snapshot_id: "2480b451-5c5b-4863-86c8-ec5827926536",
  p_decision_window_opens_at: "2026-08-28T22:23:53.027Z",
  p_decision_window_closes_at: "2026-08-31T13:15:00.000Z",
  p_calendar_artifact_id: "d2000000-0000-4000-8000-000000000001",
  p_calendar_artifact_sha256: "a".repeat(64),
  p_schedule: {
    schema: "twofold.two_stage_cycle_calendar/v1",
    decisionSessionDate: "2026-08-28",
    s1SessionDate: "2026-08-31",
    s1OpenAt: "2026-08-31T13:30:00.000Z",
    s1ReferenceAvailableAt: "2026-08-31T13:32:00.000Z",
    s1CloseAt: "2026-08-31T20:00:00.000Z",
    s1CloseAvailableAt: "2026-08-31T20:20:00.000Z",
    s2SessionDate: "2026-09-01",
    s2OpenAt: "2026-09-01T13:30:00.000Z",
    s2ReferenceAvailableAt: "2026-09-01T13:32:00.000Z",
    s2CloseAt: "2026-09-01T20:00:00.000Z",
    cycleReadyAt: "2026-09-01T20:20:00.000Z",
  } as const,
  p_recorded_by: "twofold-local-worker",
});

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "twofold.arena_round_result/v1",
    roundId: args.p_round_id,
    seasonId: args.p_season_id,
    roundIndex: "1",
    decisionSnapshotId: args.p_decision_snapshot_id,
    decisionSessionDate: "2026-08-28",
    decisionWindowOpensAt: args.p_decision_window_opens_at,
    decisionWindowClosesAt: args.p_decision_window_closes_at,
    s1SessionDate: "2026-08-31",
    s2SessionDate: "2026-09-01",
    cycleReadyAt: "2026-09-01T20:20:00.000Z",
    calendarArtifactId: args.p_calendar_artifact_id,
    calendarArtifactSha256: args.p_calendar_artifact_sha256,
    recordedBy: args.p_recorded_by,
    recordedAt: "2026-08-28T22:24:00.000Z",
    ...overrides,
  };
}

function client(data: unknown): ArenaRoundRpcClient {
  return { rpc: vi.fn(async () => ({ data, error: null, status: 200 })) };
}

describe("Arena Round repository", () => {
  it("registers one exact shared calendar/data fence", async () => {
    const rpc = client(response());
    const round = await registerArenaRoundExact(rpc, args);
    expect(rpc.rpc).toHaveBeenCalledWith("register_arena_round", args);
    expect(round).toMatchObject({
      roundId: args.p_round_id,
      roundIndex: "1",
      decisionSessionDate: "2026-08-28",
      s1SessionDate: "2026-08-31",
      s2SessionDate: "2026-09-01",
    });
  });

  it("rejects numeric tokens and response identity drift", async () => {
    await expect(registerArenaRoundExact(client(response({ roundIndex: 1 })), args))
      .rejects.toThrow("numeric token");
    await expect(registerArenaRoundExact(client(response({
      decisionSnapshotId: "d3000000-0000-4000-8000-000000000001",
    })), args)).rejects.toThrow("inconsistent");
  });

  it("rejects a decision window that reaches the S1 open", async () => {
    await expect(registerArenaRoundExact(client(response()), {
      ...args,
      p_decision_window_closes_at: "2026-08-31T13:30:00.000Z",
    })).rejects.toThrow("before S1 open");
  });

  it("registers one deterministic decision seat per Round entrant", async () => {
    const entryArgs = {
      p_idempotency_key: "private-controlled-lab-s1:round:1:twofold",
      p_round_id: args.p_round_id,
      p_entrant_id: "d4000000-0000-4000-8000-000000000001",
      p_recorded_by: args.p_recorded_by,
    } as const;
    const rpc: ArenaRoundEntryRpcClient = {
      rpc: vi.fn(async () => ({
        data: {
          schema: "twofold.arena_round_entry_result/v1",
          roundEntryId: "d5000000-0000-8000-8000-000000000001",
          roundId: entryArgs.p_round_id,
          seasonId: args.p_season_id,
          entrantId: entryArgs.p_entrant_id,
          runId: "d6000000-0000-4000-8000-000000000001",
          decisionId: "d7000000-0000-8000-8000-000000000001",
          recordedBy: entryArgs.p_recorded_by,
          recordedAt: "2026-08-28T22:24:00.000Z",
        },
        error: null,
        status: 200,
      })),
    };
    const entry = await registerArenaRoundEntryExact(rpc, entryArgs, {
      seasonId: args.p_season_id,
      runId: "d6000000-0000-4000-8000-000000000001",
    });
    expect(rpc.rpc).toHaveBeenCalledWith(
      "register_arena_round_entry",
      entryArgs,
    );
    expect(entry).toMatchObject({
      roundId: args.p_round_id,
      entrantId: entryArgs.p_entrant_id,
      decisionId: "d7000000-0000-8000-8000-000000000001",
    });
  });

  it("rejects Round entry identity drift", async () => {
    const rpc: ArenaRoundEntryRpcClient = {
      rpc: vi.fn(async () => ({
        data: {
          schema: "twofold.arena_round_entry_result/v1",
          roundEntryId: "d5000000-0000-8000-8000-000000000001",
          roundId: args.p_round_id,
          seasonId: args.p_season_id,
          entrantId: "d4000000-0000-4000-8000-000000000001",
          runId: "d6000000-0000-4000-8000-000000000099",
          decisionId: "d7000000-0000-8000-8000-000000000001",
          recordedBy: args.p_recorded_by,
          recordedAt: "2026-08-28T22:24:00.000Z",
        },
        error: null,
        status: 200,
      })),
    };
    await expect(registerArenaRoundEntryExact(rpc, {
      p_idempotency_key: "private-controlled-lab-s1:round:1:twofold",
      p_round_id: args.p_round_id,
      p_entrant_id: "d4000000-0000-4000-8000-000000000001",
      p_recorded_by: args.p_recorded_by,
    }, {
      seasonId: args.p_season_id,
      runId: "d6000000-0000-4000-8000-000000000001",
    })).rejects.toThrow("inconsistent identity");
  });
});
