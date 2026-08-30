import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  commitCorporateActionAccountApplicationExact,
  registerCorporateActionAccountPreparationExact,
  type CorporateActionAccountRpcClient,
} from "../src/corporate-action-account-repository.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const actionId = "33333333-3333-4333-8333-333333333333";
const preparationId = "44444444-4444-4444-8444-444444444444";
const applicationId = "55555555-5555-4555-8555-555555555555";
const eventId = "66666666-6666-4666-8666-666666666666";

const preparationCanonicalJson = JSON.stringify({ schema: "fixture.preparation/v1" });
const preparationSha256 = sha256(preparationCanonicalJson);
const applicationCanonicalJson = JSON.stringify({ schema: "fixture.application/v1" });
const applicationSha256 = sha256(applicationCanonicalJson);

function client(data: unknown): CorporateActionAccountRpcClient {
  return { rpc: vi.fn(async () => ({ data, error: null, status: 200 })) };
}

describe("corporate-action account repository", () => {
  it("registers one exact pre-open preparation and validates the returned fence", async () => {
    const rpc = client({
      schema: "twofold.corporate_action_account_preparation_result/v1",
      preparationId,
      strategyAccountId: accountId,
      runId,
      sourceActionId: actionId,
      revisionSha256: "a".repeat(64),
      actionType: "FORWARD_SPLIT",
      status: "PREPARED",
      ledgerHeadSequence: "7",
      ledgerHeadSha256: "b".repeat(64),
      contentSha256: preparationSha256,
      capturedAt: "2026-09-01T13:29:00.000Z",
      sourceStreamSeq: "11",
    });
    const arguments_ = {
      p_idempotency_key: "corporate-action:prepare:fixture",
      p_preparation_id: preparationId,
      p_strategy_account_id: accountId,
      p_run_id: runId,
      p_source_action_id: actionId,
      p_revision_sha256: "a".repeat(64),
      p_preparation_canonical_json: preparationCanonicalJson,
      p_content_sha256: preparationSha256,
      p_captured_at: "2026-09-01T13:29:00.000Z",
      p_expected_run_stream_seq: "10",
      p_event_id: eventId,
      p_recorded_by: "worker:test",
    } as const;

    await expect(registerCorporateActionAccountPreparationExact(
      rpc,
      arguments_,
      { ledgerHeadSequence: "7", ledgerHeadSha256: "b".repeat(64) },
    )).resolves.toMatchObject({ status: "PREPARED", sourceStreamSeq: "11" });
    expect(rpc.rpc).toHaveBeenCalledWith(
      "register_corporate_action_account_preparation",
      arguments_,
    );
  });

  it("commits one due application and rejects a response for another final head", async () => {
    const rpc = client({
      schema: "twofold.corporate_action_account_application_result/v1",
      applicationId,
      preparationId,
      strategyAccountId: accountId,
      runId,
      sourceActionId: actionId,
      revisionSha256: "a".repeat(64),
      actionType: "FORWARD_SPLIT",
      status: "APPLIED",
      openingHeadSequence: "7",
      openingHeadSha256: "b".repeat(64),
      finalHeadSequence: "8",
      finalHeadSha256: "c".repeat(64),
      mutationSha256: "d".repeat(64),
      contentSha256: applicationSha256,
      appliedAt: "2026-09-01T13:30:00.000Z",
      sourceStreamSeq: "12",
    });
    const arguments_ = {
      p_idempotency_key: "corporate-action:apply:fixture",
      p_application_id: applicationId,
      p_strategy_account_id: accountId,
      p_run_id: runId,
      p_source_action_id: actionId,
      p_revision_sha256: "a".repeat(64),
      p_application_canonical_json: applicationCanonicalJson,
      p_content_sha256: applicationSha256,
      p_applied_at: "2026-09-01T13:30:00.000Z",
      p_expected_run_stream_seq: "11",
      p_event_id: eventId,
      p_recorded_by: "worker:test",
    } as const;

    await expect(commitCorporateActionAccountApplicationExact(
      rpc,
      arguments_,
      {
        preparationId,
        openingHeadSequence: "7",
        openingHeadSha256: "b".repeat(64),
        finalHeadSequence: "8",
        finalHeadSha256: "c".repeat(64),
      },
    )).resolves.toMatchObject({ status: "APPLIED", finalHeadSequence: "8" });

    await expect(commitCorporateActionAccountApplicationExact(
      client({
        ...((rpc.rpc as ReturnType<typeof vi.fn>).mock.results[0]?.value ?? {}),
        schema: "twofold.corporate_action_account_application_result/v1",
        applicationId,
        preparationId,
        strategyAccountId: accountId,
        runId,
        sourceActionId: actionId,
        revisionSha256: "a".repeat(64),
        actionType: "FORWARD_SPLIT",
        status: "APPLIED",
        openingHeadSequence: "7",
        openingHeadSha256: "b".repeat(64),
        finalHeadSequence: "9",
        finalHeadSha256: "e".repeat(64),
        mutationSha256: "d".repeat(64),
        contentSha256: applicationSha256,
        appliedAt: "2026-09-01T13:30:00.000Z",
        sourceStreamSeq: "12",
      }),
      arguments_,
      {
        preparationId,
        openingHeadSequence: "7",
        openingHeadSha256: "b".repeat(64),
        finalHeadSequence: "8",
        finalHeadSha256: "c".repeat(64),
      },
    )).rejects.toThrow(/different final ledger head/i);
  });

  it("rejects numeric tokens and database errors at the RPC boundary", async () => {
    const numeric = client({
      schema: "twofold.corporate_action_account_preparation_result/v1",
      sourceStreamSeq: 11,
    });
    await expect(registerCorporateActionAccountPreparationExact(
      numeric,
      {
        p_idempotency_key: "x", p_preparation_id: preparationId,
        p_strategy_account_id: accountId, p_run_id: runId,
        p_source_action_id: actionId, p_revision_sha256: "a".repeat(64),
        p_preparation_canonical_json: preparationCanonicalJson,
        p_content_sha256: preparationSha256,
        p_captured_at: "2026-09-01T13:29:00.000Z",
        p_expected_run_stream_seq: "10", p_event_id: eventId,
        p_recorded_by: "worker:test",
      },
      { ledgerHeadSequence: "7", ledgerHeadSha256: "b".repeat(64) },
    )).rejects.toThrow(/numeric token/i);

    const failing: CorporateActionAccountRpcClient = {
      rpc: vi.fn(async () => ({
        data: null,
        error: { message: "ledger head conflict", code: "40001" },
        status: 409,
      })),
    };
    await expect(commitCorporateActionAccountApplicationExact(
      failing,
      {
        p_idempotency_key: "x", p_application_id: applicationId,
        p_strategy_account_id: accountId, p_run_id: runId,
        p_source_action_id: actionId, p_revision_sha256: "a".repeat(64),
        p_application_canonical_json: applicationCanonicalJson,
        p_content_sha256: applicationSha256,
        p_applied_at: "2026-09-01T13:30:00.000Z",
        p_expected_run_stream_seq: "11", p_event_id: eventId,
        p_recorded_by: "worker:test",
      },
      {
        preparationId,
        openingHeadSequence: "7",
        openingHeadSha256: "b".repeat(64),
        finalHeadSequence: "8",
        finalHeadSha256: "c".repeat(64),
      },
    )).rejects.toThrow("ledger head conflict");
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
