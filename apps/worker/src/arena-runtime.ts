import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-presets";
import {
  boot,
  healProfilesModuleFallback,
  loadOverlayPatches,
  loadProfile,
} from "@deepseek-ai/dsh-app-boot";
import {
  createUserMessage,
  isAgentLoopRequest,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import {
  SessionId,
  type Session,
  type SessionEvent,
  type TurnEndReason,
} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-session-projection";
import type {} from "@deepseek-ai/dsh-token-meter";
import {
  DECISION_GATEWAY_SERVICE,
  type DecisionPacketResult,
  type PortfolioTargetsResult,
  type PortfolioTargetsSubmission,
  type ReadyDecisionPacket,
  type TwofoldDecisionGateway,
} from "@twofold-lab/dsh-twofold";
import {
  type DecisionAdmissionEvidence,
  totalBillableTokens,
  type ActorKind,
  type EventPayload,
} from "@twofold/core";

import {
  addEstimatedCost,
  addUsageTokens,
  costStatusForAttempts,
  sumArenaUsage,
} from "./arena-usage.js";
import {
  checkArenaAttemptBudget,
  reserveGenerateOptions,
  type ArenaCostQuote,
  type ArenaTokenReservation,
} from "./arena-budget.js";
import type {
  ArenaAgentNode,
  ArenaDecisionStatus,
  ArenaProjectionState,
  PreparedArenaInvocation,
} from "./arena-types.js";
import { arenaRootMaxTokens } from "./arena-root-output-budget.js";
import {
  HarnessUsageAttemptBuffer,
  type FrozenHarnessUsage,
  type HarnessUsageAttemptKey,
} from "./model-usage-buffer.js";
import { sanitizeFailureMessage } from "./failure-safety.js";
import { portfolioConstraintViolation } from "./arena-inputs.js";
import { buildArenaDecisionAdmissionEvidence } from
  "./arena-decision-evidence.js";
import { importArenaRuntimePackage } from
  "./arena-runtime-package-manifest.js";

const PROFILE_NAME = "twofold";
const TRUSTED_PRESETS = new Set(["twofold", "twofold-orchestrator"]);
const LOCKED_PROVIDER = "deepseek-official";
const LOCKED_MODEL = "deepseek-v4-pro";
const RUNTIME_NAME = "twofold-arena-worker";
const DEFAULT_TASK = `Execute the bound Twofold Arena portfolio decision now.

Read the immutable decision packet first. You may delegate bounded, foreground research to the configured subagent when it materially improves the decision. Synthesize all evidence yourself and submit exactly one final target portfolio through submit_portfolio_targets. Do not use facts outside the packet and do not claim that orders or fills occurred.`;

const TRACKED_SESSION_EVENTS = new Set<SessionEvent["type"]>([
  "turn/start",
  "step/start",
  "tool/call",
  "tool/result",
  "step/end",
  "turn/end",
]);

export interface ArenaRuntimePersistence {
  appendEvent(input: {
    eventType: string;
    payload: EventPayload;
    eventTime?: string;
    actorKind?: ActorKind;
    actorId?: string;
    idempotencyKey?: string;
  }): Promise<{ eventId: string; eventSeq: string }>;

  project(state: ArenaProjectionState): Promise<void>;

  registerDescendant(input: {
    sessionId: string;
    parentSessionId: string;
    agentIdentity: string;
    agentPath: string;
    startedAt: string;
  }): Promise<{ eventId: string; eventSeq: string; depth: string }>;

  quoteAttempt(input: {
    provider: string;
    model: string;
    requestStartedAt: string;
    maxInputTokens: string;
    maxOutputTokens: string;
  }): Promise<ArenaCostQuote | null>;

  recordAttempt(input: {
    sessionId: string;
    turn: number;
    step: number;
    attempt: number;
    provider: string;
    model: string;
    requestStartedAt: string;
    completedAt: string;
    pricingId: string;
    pricingVersion: string;
    frozenUsage: FrozenHarnessUsage;
  }): Promise<PersistedAttemptReceipt>;

  acceptSubmission(input: {
    submission: PortfolioTargetsSubmission;
    acceptedAt: string;
    admissionEvidence: DecisionAdmissionEvidence;
  }): Promise<{
    submissionId: string;
    acceptedAt: string;
    eventId: string;
    eventSeq: string;
  }>;
}

interface PersistedAttemptReceipt {
  readonly eventId: string;
  readonly eventSeq: string;
  readonly costStatus: "estimated" | "unpriced" | "unavailable";
  readonly estimatedCost: string | null;
  readonly pricingVersion: string | null;
}

export interface ArenaCapturedSession {
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly agentPath: string;
  readonly events: readonly SessionEvent[];
}

export interface ArenaRecordedAttempt {
  readonly sessionId: string;
  readonly turn: number;
  readonly step: number;
  readonly attempt: number;
  readonly provider: string;
  readonly model: string;
  readonly requestStartedAt: string;
  readonly completedAt: string;
  readonly frozenUsage: FrozenHarnessUsage;
  readonly costStatus: "estimated" | "unpriced" | "unavailable";
  readonly estimatedCost: string | null;
  readonly pricingVersion: string | null;
  readonly eventId: string;
  readonly eventSeq: string;
}

export interface ArenaRuntimeResult {
  readonly projection: ArenaProjectionState;
  readonly sessions: readonly ArenaCapturedSession[];
  readonly attempts: readonly ArenaRecordedAttempt[];
  readonly runStreamSeq: string;
}

export interface CreateArenaRuntimeOptions {
  readonly repositoryRoot: string;
  readonly workerId: string;
  readonly installAnchor?: string;
  readonly profileBundlePatchPaths?: readonly string[];
  readonly profileDirectory?: string;
  readonly profileModuleHealing?: boolean;
  readonly runtimePackageManifest?: boolean;
  readonly now?: () => Date;
}

export interface RunArenaInvocationInput {
  readonly prepared: PreparedArenaInvocation;
  readonly persistence: ArenaRuntimePersistence;
  readonly signal?: AbortSignal;
  readonly task?: string;
}

interface SessionRecord {
  readonly session: Session;
  readonly node: ArenaAgentNode;
  lastObservedSeq: number;
}

interface AttemptRecord extends HarnessUsageAttemptKey {
  readonly provider: string;
  readonly model: string;
  readonly requestStartedAt: string;
  readonly reservation: ArenaTokenReservation;
  readonly quote: ArenaCostQuote;
  completedAt?: string;
  lastObservedSeqAtFinalize?: number;
  frozenUsage?: FrozenHarnessUsage;
  persisted?: PersistedAttemptReceipt;
  pendingResult?: ArenaRecordedAttempt;
  usageApplied?: boolean;
  settlementBudgetEventSeq?: string;
  finalized?: ArenaRecordedAttempt;
  finalizePromise?: Promise<ArenaRecordedAttempt>;
}

interface ArenaToolExecutionView {
  readonly name: string;
  readonly callId: unknown;
  readonly agent?: { readonly id: unknown };
}

interface ArenaToolRuntimeView {
  guard(
    guard: (execution: ArenaToolExecutionView) => string | undefined,
  ): () => void;
}

type ProviderAttemptStart =
  | { readonly kind: "ready"; readonly attempt: AttemptRecord }
  | { readonly kind: "denied"; readonly code: string; readonly message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTerminalAgentStatus(status: ArenaAgentNode["status"]): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELED";
}

export function hasRegisteredArenaDescendant(
  projection: ArenaProjectionState,
): boolean {
  return projection.agents.some(
    (agent) => agent.origin === "subagent" && agent.parentSessionId !== null,
  );
}

export function isArenaDescendantRequirementSatisfied(
  executionClass: "ROOT_ONLY" | "ORCHESTRATED",
  projection: ArenaProjectionState,
): boolean {
  return executionClass === "ROOT_ONLY" || hasRegisteredArenaDescendant(projection);
}

function asIso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function canonicalCount(value: string, field: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${field} must be a canonical non-negative integer string`);
  }
  return BigInt(value);
}

function canonicalDecimal(value: string, field: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${field} must be a canonical non-negative decimal string`);
  }
  return value;
}

function compareDecimal(left: string, right: string): number {
  const parse = (value: string): { coefficient: bigint; scale: number } => {
    const [integer = "0", fraction = ""] = value.split(".");
    return { coefficient: BigInt(integer + fraction), scale: fraction.length };
  };
  const a = parse(left);
  const b = parse(right);
  const scale = Math.max(a.scale, b.scale);
  const ten = (power: number): bigint => 10n ** BigInt(power);
  const scaledA = a.coefficient * ten(scale - a.scale);
  const scaledB = b.coefficient * ten(scale - b.scale);
  return scaledA < scaledB ? -1 : scaledA > scaledB ? 1 : 0;
}

export function arenaBudgetEnforcementStatus(
  projection: Pick<ArenaProjectionState, "treeUsage" | "budget">,
  denials: Readonly<{
    providerBudgetDenied: boolean;
    descendantBudgetDenied: boolean;
  }>,
): ArenaProjectionState["budget"]["enforcementStatus"] {
  const { treeUsage: tree, budget } = projection;
  const requestLimitReached =
    BigInt(tree.providerRequestCount) >= BigInt(budget.maxProviderRequests);
  const tokenLimitReached =
    BigInt(tree.totalBillableTokens) >= BigInt(budget.maxBillableTokens);
  const costLimitReached = tree.estimatedCostUsd !== null
    && compareDecimal(tree.estimatedCostUsd, budget.maxEstimatedCostUsd) >= 0;
  if (
    denials.providerBudgetDenied
    || denials.descendantBudgetDenied
    || requestLimitReached
    || tokenLimitReached
    || costLimitReached
  ) return "EXHAUSTED";
  if (BigInt(tree.providerRequestCount) > 0n && tree.costStatus !== "ESTIMATED") {
    return "UNPRICED";
  }
  return "WITHIN_LIMITS";
}

function safeAgentPathSegment(sessionId: string): string {
  if (/^[A-Za-z0-9._:-]+$/.test(sessionId)) return sessionId;
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 20);
  return `session-${digest}`;
}

function attemptTupleKey(input: HarnessUsageAttemptKey): string {
  return [
    encodeURIComponent(input.sessionId),
    String(input.turn),
    String(input.step),
    String(input.attempt),
  ].join(":");
}

function eventTurnAndStep(event: SessionEvent): EventPayload {
  if (!("turn" in event.data)) return {};
  const data = event.data as { turn: number; step?: number };
  return {
    turn: String(data.turn),
    ...(data.step === undefined ? {} : { step: String(data.step) }),
  };
}

function sessionEventPayload(event: SessionEvent): EventPayload {
  const common: EventPayload = {
    harnessEventType: event.type,
    harnessEventSeq: String(event.seq),
    ...eventTurnAndStep(event),
  };
  if (event.type === "tool/call") {
    return {
      ...common,
      callId: String(event.data.callId),
      toolName: event.data.name,
    };
  }
  if (event.type === "tool/result") {
    return {
      ...common,
      callId: String(event.data.message.source.callId),
      isError: event.data.message.content[0].isError === true,
    };
  }
  if (event.type === "turn/end") {
    return {
      ...common,
      reasonKind: event.data.reason.kind,
      ...(event.data.reason.kind === "error"
        ? { failureCode: event.data.reason.error.code }
        : {}),
    };
  }
  return common;
}

function rootDecisionSymbolCount(prepared: PreparedArenaInvocation): number {
  const constraints = prepared.packet.payload.constraints;
  if (
    constraints === null
    || typeof constraints !== "object"
    || Array.isArray(constraints)
  ) throw new TypeError("Arena packet constraints are missing");
  const eligible = (constraints as Record<string, unknown>).eligible_symbols;
  if (
    !Array.isArray(eligible)
    || eligible.length === 0
    || eligible.some((symbol) => typeof symbol !== "string")
  ) throw new TypeError("Arena packet eligible symbols are invalid");
  return eligible.length;
}

function assertPreparedInvocation(prepared: PreparedArenaInvocation): void {
  const { identity, packet, projection } = prepared;
  if (!TRUSTED_PRESETS.has(identity.presetId)) {
    throw new Error("Arena preset is not in the trusted host allowlist");
  }
  if (identity.executionClass !== "ROOT_ONLY" && identity.executionClass !== "ORCHESTRATED") {
    throw new Error("Arena execution class is unsupported");
  }
  if (identity.provider !== LOCKED_PROVIDER || identity.model !== LOCKED_MODEL) {
    throw new Error(`Arena model must be ${LOCKED_PROVIDER}/${LOCKED_MODEL}`);
  }
  if (projection.rootSessionId !== identity.rootSessionId) {
    throw new Error("Arena projection root Session does not match invocation identity");
  }
  if (projection.decision.decisionId !== identity.decisionId) {
    throw new Error("Arena projection decision does not match invocation identity");
  }
  if (
    packet.decision_packet_id !== identity.decisionPacketId
    || packet.packet_sha256 !== identity.packetSha256
  ) {
    throw new Error("Arena decision packet does not match invocation fence");
  }
  const root = projection.agents.find((agent) => agent.sessionId === identity.rootSessionId);
  if (root === undefined || root.parentSessionId !== null || root.agentPath !== "root") {
    throw new Error("Arena projection must contain the bound root Agent");
  }
  canonicalCount(projection.budget.maxProviderRequests, "maxProviderRequests");
  canonicalCount(projection.budget.maxBillableTokens, "maxBillableTokens");
  canonicalCount(projection.budget.maxDescendants, "maxDescendants");
  canonicalDecimal(projection.budget.maxEstimatedCostUsd, "maxEstimatedCostUsd");
  if (!Number.isFinite(Date.parse(identity.submissionDeadlineAt))) {
    throw new Error("Arena submission deadline is invalid");
  }
}

class SerialPersistence {
  private tail: Promise<void> = Promise.resolve();
  private readonly backgroundFailures: unknown[] = [];

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  background(operation: () => Promise<unknown>): void {
    void this.run(operation).catch((error: unknown) => {
      this.backgroundFailures.push(error);
    });
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  throwBackgroundFailure(): void {
    const failure = this.backgroundFailures[0];
    if (failure !== undefined) throw failure;
  }
}

class ActiveArenaRun {
  readonly projection: ArenaProjectionState;
  readonly packet: ReadyDecisionPacket;
  readonly rootSessionId: string;
  readonly sessions = new Map<string, SessionRecord>();
  readonly attempts: AttemptRecord[] = [];
  readonly usageBuffer = new HarnessUsageAttemptBuffer();
  readonly serial = new SerialPersistence();
  readonly reservedDescendantCalls = new Set<string>();
  readonly activeSteps = new Map<string, { turn: number; step: number }>();
  readonly currentAttempts = new Map<string, AttemptRecord>();
  readonly turnEnds = new Map<string, TurnEndReason>();
  readonly attemptCostStatuses = new Map<
    string,
    Array<"estimated" | "unpriced" | "unavailable">
  >();

  runStreamSeq: string;
  handle?: AgentHandle;
  deadlineExceeded = false;
  providerBudgetDenied = false;
  descendantBudgetDenied = false;
  terminal = false;
  submissionInFlight?: {
    readonly canonical: string;
    readonly promise: Promise<PortfolioTargetsResult>;
  };
  acceptedSubmission?: {
    readonly canonical: string;
    readonly submissionId: string;
    readonly acceptedAt: string;
  };

  constructor(
    readonly prepared: PreparedArenaInvocation,
    readonly persistence: ArenaRuntimePersistence,
    readonly workerId: string,
    readonly now: () => Date,
  ) {
    assertPreparedInvocation(prepared);
    this.projection = structuredClone(prepared.projection);
    this.packet = prepared.packet;
    this.rootSessionId = prepared.identity.rootSessionId;
    this.runStreamSeq = prepared.runStreamSeq;
  }

  get deadlineAt(): number {
    return Date.parse(this.prepared.identity.submissionDeadlineAt);
  }

  get expired(): boolean {
    return this.now().getTime() > this.deadlineAt;
  }

  private node(sessionId: string): ArenaAgentNode {
    const record = this.sessions.get(sessionId);
    if (record !== undefined) return record.node;
    const existing = this.projection.agents.find((agent) => agent.sessionId === sessionId);
    if (existing !== undefined) return existing;
    throw new Error(`Arena Session ${sessionId} is not registered in this run`);
  }

  private refreshUsageAndBudget(): void {
    this.projection.treeUsage = sumArenaUsage(
      this.projection.agents.map((agent) => agent.usage),
    );
    const tree = this.projection.treeUsage;
    const budget = this.projection.budget;
    budget.usedProviderRequests = tree.providerRequestCount;
    budget.usedBillableTokens = tree.totalBillableTokens;
    budget.usedEstimatedCostUsd = tree.estimatedCostUsd;
    budget.activeDescendants = String(
      this.projection.agents.filter(
        (agent) => agent.origin === "subagent"
          && (agent.status === "QUEUED" || agent.status === "RUNNING"),
      ).length,
    );

    budget.enforcementStatus = arenaBudgetEnforcementStatus(this.projection, {
      providerBudgetDenied: this.providerBudgetDenied,
      descendantBudgetDenied: this.descendantBudgetDenied,
    });
  }

  private async projectCurrent(): Promise<void> {
    this.refreshUsageAndBudget();
    const failureMessage = this.projection.decision.failureMessage;
    if (failureMessage !== null) {
      this.projection.decision.failureMessage = sanitizeFailureMessage(failureMessage);
    }
    this.projection.updatedAt = this.now().toISOString();
    await this.persistence.project(structuredClone(this.projection));
  }

  private async appendThenProject(
    eventType: string,
    payload: EventPayload,
    mutate: () => void,
    eventTime = this.now().toISOString(),
    idempotencyKey?: string,
  ): Promise<void> {
    const event = await this.persistence.appendEvent({
      eventType,
      payload,
      eventTime,
      actorKind: "worker",
      actorId: this.workerId,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
    this.runStreamSeq = event.eventSeq;
    mutate();
    await this.projectCurrent();
  }

  async start(): Promise<void> {
    await this.serial.run(() => this.appendThenProject(
      "decision.runtime_started",
      {
        decisionId: this.prepared.identity.decisionId,
        rootHarnessSessionId: this.rootSessionId,
        presetId: this.prepared.identity.presetId,
        provider: LOCKED_PROVIDER,
        model: LOCKED_MODEL,
      },
      () => {
        this.projection.decision.status = "RUNNING";
        const root = this.node(this.rootSessionId);
        root.status = "RUNNING";
      },
    ));
  }

  observeSessionCreated(session: Session): void {
    const sessionId = String(session.id);
    if (this.sessions.has(sessionId)) return;
    if (sessionId === this.rootSessionId) {
      const root = this.projection.agents.find((agent) => agent.sessionId === sessionId);
      if (root === undefined) throw new Error("Arena root projection node disappeared");
      this.sessions.set(sessionId, {
        session,
        node: root,
        lastObservedSeq: Math.max(0, session.seq - 1),
      });
      return;
    }

    const parentSessionId = session.header.parentSession === undefined
      ? undefined
      : String(session.header.parentSession);
    if (parentSessionId === undefined || !this.sessions.has(parentSessionId)) return;
    const parent = this.node(parentSessionId);
    const childIndex = this.sessions.size;
    const startedAt = asIso(session.header.createdAt);
    const agentPath = `${parent.agentPath}/${safeAgentPathSegment(sessionId)}`;
    const depth = String(session.header.delegationDepth ?? Number(parent.delegationDepth) + 1);
    const node: ArenaAgentNode = {
      sessionId,
      parentSessionId,
      agentPath,
      displayName: `Research Subagent ${childIndex}`,
      origin: "subagent",
      delegationDepth: depth,
      status: "QUEUED",
      provider: LOCKED_PROVIDER,
      model: LOCKED_MODEL,
      startedAt,
      completedAt: null,
      lastEventSeq: String(Math.max(0, session.seq - 1)),
      usage: {
        providerRequestCount: "0",
        uncachedInputTokens: "0",
        cacheReadTokens: "0",
        cacheWriteTokens: "0",
        outputTokens: "0",
        reasoningTokens: "0",
        totalBillableTokens: "0",
        estimatedCostUsd: null,
        costStatus: "UNAVAILABLE",
        pricingVersions: [],
      },
    };
    this.sessions.set(sessionId, {
      session,
      node,
      lastObservedSeq: Math.max(0, session.seq - 1),
    });
    const reservation = this.reservedDescendantCalls.values().next().value as
      | string
      | undefined;
    if (reservation !== undefined) this.reservedDescendantCalls.delete(reservation);

    this.serial.background(async () => {
      const linked = await this.persistence.registerDescendant({
        sessionId,
        parentSessionId,
        agentIdentity: "twofold-research-subagent",
        agentPath,
        startedAt,
      });
      this.runStreamSeq = linked.eventSeq;
      node.delegationDepth = linked.depth;
      if (!this.projection.agents.some((agent) => agent.sessionId === sessionId)) {
        this.projection.agents.push(node);
      }
      await this.projectCurrent();
    });
  }

  observeAgentCreated(agent: Agent): void {
    const sessionId = String(agent.id);
    if (!this.sessions.has(sessionId)) return;
    if (agent.options.provider !== LOCKED_PROVIDER || agent.options.model !== LOCKED_MODEL) {
      agent.cancel({ kind: "hook", reason: "Twofold Arena model lock violation" });
      this.providerBudgetDenied = true;
    }
  }

  observeAgentStatus(agent: Agent, status: "idle" | "running"): void {
    const sessionId = String(agent.id);
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;
    const observedAt = this.now().toISOString();
    const lastObservedSeq = record.lastObservedSeq;
    this.serial.background(() => this.appendThenProject(
      "decision.agent_status_changed",
      {
        decisionId: this.prepared.identity.decisionId,
        harnessSessionId: sessionId,
        status: status.toUpperCase(),
        agentPath: record.node.agentPath,
      },
      () => {
        record.node.lastEventSeq = String(lastObservedSeq);
        if (status === "running") {
          if (!isTerminalAgentStatus(record.node.status)) record.node.status = "RUNNING";
          return;
        }
        if (sessionId === this.rootSessionId || isTerminalAgentStatus(record.node.status)) return;
        const reason = this.turnEnds.get(sessionId);
        record.node.status = reason?.kind === "completed"
          ? "SUCCEEDED"
          : reason?.kind === "aborted"
            ? "CANCELED"
            : "FAILED";
        record.node.completedAt = observedAt;
      },
      observedAt,
    ));
  }

  observeAgentDisposed(agent: Agent): void {
    const sessionId = String(agent.id);
    const record = this.sessions.get(sessionId);
    if (
      record === undefined
      || sessionId === this.rootSessionId
      || isTerminalAgentStatus(record.node.status)
    ) return;
    const observedAt = this.now().toISOString();
    const lastObservedSeq = record.lastObservedSeq;
    this.serial.background(() => this.appendThenProject(
      "decision.agent_disposed",
      {
        decisionId: this.prepared.identity.decisionId,
        harnessSessionId: sessionId,
        agentPath: record.node.agentPath,
      },
      () => {
        if (isTerminalAgentStatus(record.node.status)) return;
        record.node.status = "CANCELED";
        record.node.completedAt = observedAt;
        record.node.lastEventSeq = String(lastObservedSeq);
      },
      observedAt,
    ));
  }

  observeSessionEvent(session: Session, event: SessionEvent): void {
    const sessionId = String(session.id);
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;
    record.lastObservedSeq = Math.max(record.lastObservedSeq, event.seq);

    if (event.type === "step/start") {
      this.activeSteps.set(sessionId, {
        turn: event.data.turn,
        step: event.data.step,
      });
    }

    const attempt = this.currentAttempts.get(
      event.type === "assistant/chunk" || event.type === "assistant/message"
        ? `${sessionId}:${event.data.turn}:${event.data.step}`
        : "",
    );
    if (
      attempt !== undefined
      && event.type === "assistant/chunk"
      && event.data.chunk.type === "usage"
    ) {
      this.usageBuffer.observe({
        ...attempt,
        harnessEventSeq: event.seq,
        source: "stream_chunk",
        usage: event.data.chunk.usage,
      });
    }
    if (
      attempt !== undefined
      && event.type === "assistant/message"
      && event.data.usage !== undefined
    ) {
      this.usageBuffer.observe({
        ...attempt,
        harnessEventSeq: event.seq,
        source: "assistant_message",
        usage: event.data.usage,
      });
    }

    if (event.type === "turn/end") this.turnEnds.set(sessionId, event.data.reason);

    if (event.type === "step/end") {
      const key = `${sessionId}:${event.data.turn}:${event.data.step}`;
      const current = this.currentAttempts.get(key);
      if (current !== undefined) {
        void this.finalizeAttempt(current).catch(() => undefined);
      }
      this.activeSteps.delete(sessionId);
    }

    if (event.type === "tool/result" && sessionId === this.rootSessionId) {
      this.reservedDescendantCalls.delete(String(event.data.message.source.callId));
    }

    if (!TRACKED_SESSION_EVENTS.has(event.type)) return;
    const eventTime = asIso(event.time);
    this.serial.background(() => this.appendThenProject(
      "decision.harness_session_event",
      {
        decisionId: this.prepared.identity.decisionId,
        harnessSessionId: sessionId,
        agentPath: record.node.agentPath,
        ...sessionEventPayload(event),
      },
      () => {
        record.node.lastEventSeq = String(event.seq);
      },
      eventTime,
    ));
  }

  reserveSubagent(callId: string): string | undefined {
    if (this.terminal || this.expired) return "Twofold Arena decision is no longer active";
    const descendants = [...this.sessions.values()].filter(
      (record) => record.node.origin === "subagent",
    ).length;
    const max = canonicalCount(this.projection.budget.maxDescendants, "maxDescendants");
    if (BigInt(descendants + this.reservedDescendantCalls.size) >= max) {
      this.descendantBudgetDenied = true;
      this.queueBudgetExhausted("max_descendants");
      return "Twofold Arena descendant budget is exhausted";
    }
    if (this.providerLimitReached()) {
      this.providerBudgetDenied = true;
      this.queueBudgetExhausted("provider_or_token_budget");
      return "Twofold Arena shared model budget is exhausted";
    }
    this.reservedDescendantCalls.add(callId);
    return undefined;
  }

  private providerLimitReached(): boolean {
    const budget = this.projection.budget;
    if (BigInt(this.attempts.length) >= BigInt(budget.maxProviderRequests)) return true;
    if (BigInt(this.projection.treeUsage.totalBillableTokens) >= BigInt(budget.maxBillableTokens)) {
      return true;
    }
    return this.projection.treeUsage.estimatedCostUsd !== null
      && compareDecimal(
        this.projection.treeUsage.estimatedCostUsd,
        budget.maxEstimatedCostUsd,
      ) >= 0;
  }

  private queueBudgetExhausted(resource: string): void {
    this.serial.background(() => this.appendThenProject(
      "decision.budget_exhausted",
      {
        decisionId: this.prepared.identity.decisionId,
        rootHarnessSessionId: this.rootSessionId,
        resource,
      },
      () => undefined,
    ));
  }

  async beginProviderAttempt(options: GenerateOptions): Promise<ProviderAttemptStart> {
    const sessionId = options.sessionId === undefined ? "" : String(options.sessionId);
    const initiallyActive = this.activeSteps.get(sessionId);
    if (initiallyActive === undefined) {
      return {
        kind: "denied",
        code: "ARENA_UNTRACKED_STEP",
        message: `Arena model dispatch for Session ${sessionId || "<missing>"} has no active step`,
      };
    }
    if (options.provider !== LOCKED_PROVIDER || options.model !== LOCKED_MODEL) {
      return {
        kind: "denied",
        code: "ARENA_MODEL_LOCK_VIOLATION",
        message: `Arena model route must remain ${LOCKED_PROVIDER}/${LOCKED_MODEL}`,
      };
    }
    if (this.terminal || this.expired) {
      this.deadlineExceeded ||= this.expired;
      return {
        kind: "denied",
        code: "ARENA_DECISION_CLOSED",
        message: "Arena decision is closed or past its submission deadline",
      };
    }

    const key = `${sessionId}:${initiallyActive.turn}:${initiallyActive.step}`;
    const previous = this.currentAttempts.get(key);
    if (previous !== undefined && previous.finalized === undefined) {
      await this.finalizeAttempt(previous);
    }
    return this.serial.run(async () => {
      this.serial.throwBackgroundFailure();
      const active = this.activeSteps.get(sessionId);
      if (
        active === undefined
        || active.turn !== initiallyActive.turn
        || active.step !== initiallyActive.step
      ) {
        return {
          kind: "denied" as const,
          code: "ARENA_UNTRACKED_STEP",
          message: `Arena model dispatch for Session ${sessionId} no longer has the expected active step`,
        };
      }
      if (this.terminal || this.expired) {
        this.deadlineExceeded ||= this.expired;
        return {
          kind: "denied" as const,
          code: "ARENA_DECISION_CLOSED",
          message: "Arena decision is closed or past its submission deadline",
        };
      }

      const attemptIndex = this.attempts.filter(
        (attempt) => attempt.sessionId === sessionId
          && attempt.turn === active.turn
          && attempt.step === active.step,
      ).length;
      const tuple = attemptTupleKey({
        sessionId,
        turn: active.turn,
        step: active.step,
        attempt: attemptIndex,
      });
      const deniedEventKey =
        `arena:${this.prepared.identity.decisionId}:budget-denied:${tuple}`;
      if (this.providerBudgetDenied) {
        return {
          kind: "denied" as const,
          code: "ARENA_BUDGET_EXHAUSTED",
          message: "Twofold Arena shared provider/token/cost budget is exhausted",
        };
      }

      let reservation: ArenaTokenReservation;
      try {
        reservation = reserveGenerateOptions(options);
      } catch {
        this.providerBudgetDenied = true;
        await this.appendThenProject(
          "decision.budget_exhausted",
          {
            decisionId: this.prepared.identity.decisionId,
            rootHarnessSessionId: this.rootSessionId,
            resource: "invalid_request_reservation",
          },
          () => undefined,
          this.now().toISOString(),
          deniedEventKey,
        );
        return {
          kind: "denied" as const,
          code: "ARENA_BUDGET_RESERVATION_INVALID",
          message: "Arena could not establish an exact model request reservation",
        };
      }

      const requestStartedAt = this.now().toISOString();
      const quote = await this.persistence.quoteAttempt({
        provider: options.provider,
        model: options.model,
        requestStartedAt,
        maxInputTokens: reservation.maxInputTokens,
        maxOutputTokens: reservation.maxOutputTokens,
      });
      if (quote === null) {
        this.providerBudgetDenied = true;
        await this.appendThenProject(
          "decision.budget_exhausted",
          {
            decisionId: this.prepared.identity.decisionId,
            rootHarnessSessionId: this.rootSessionId,
            resource: "pricing_unavailable",
          },
          () => undefined,
          requestStartedAt,
          deniedEventKey,
        );
        return {
          kind: "denied" as const,
          code: "ARENA_PRICING_UNAVAILABLE",
          message: "No effective frozen USD price card is available for this model request",
        };
      }

      const tree = this.projection.treeUsage;
      if (
        BigInt(tree.providerRequestCount) > 0n
        && (tree.costStatus !== "ESTIMATED" || tree.estimatedCostUsd === null)
      ) {
        this.providerBudgetDenied = true;
        await this.appendThenProject(
          "decision.budget_exhausted",
          {
            decisionId: this.prepared.identity.decisionId,
            rootHarnessSessionId: this.rootSessionId,
            resource: "settled_usage_or_pricing_unavailable",
          },
          () => undefined,
          requestStartedAt,
          deniedEventKey,
        );
        return {
          kind: "denied" as const,
          code: "ARENA_USAGE_UNAVAILABLE",
          message: "Prior provider usage or pricing is unavailable; further requests are blocked",
        };
      }

      const heldReservations = this.attempts
        .filter((attempt) => attempt.finalized === undefined)
        .map((attempt) => ({
          maxBillableTokens: attempt.reservation.maxBillableTokens,
          maximumEstimatedCostUsd: attempt.quote.maximumEstimatedCostUsd,
        }));
      const budget = this.projection.budget;
      const check = checkArenaAttemptBudget({
        settledProviderRequests: tree.providerRequestCount,
        settledBillableTokens: tree.totalBillableTokens,
        settledEstimatedCostUsd: tree.estimatedCostUsd ?? "0",
        heldReservations,
        reservation,
        quote,
        maxProviderRequests: budget.maxProviderRequests,
        maxBillableTokens: budget.maxBillableTokens,
        maxEstimatedCostUsd: budget.maxEstimatedCostUsd,
      });
      if (!check.allowed) {
        this.providerBudgetDenied = true;
        await this.appendThenProject(
          "decision.budget_exhausted",
          {
            decisionId: this.prepared.identity.decisionId,
            rootHarnessSessionId: this.rootSessionId,
            resource: "model_request_reservation",
            violations: [...check.violations],
          },
          () => undefined,
          requestStartedAt,
          deniedEventKey,
        );
        return {
          kind: "denied" as const,
          code: "ARENA_BUDGET_EXHAUSTED",
          message: "Twofold Arena shared provider/token/cost budget cannot reserve this request",
        };
      }

      await this.appendThenProject(
        "decision.model_attempt_reserved",
        {
          decisionId: this.prepared.identity.decisionId,
          harnessSessionId: sessionId,
          turn: String(active.turn),
          step: String(active.step),
          attempt: String(attemptIndex),
          maxInputTokens: reservation.maxInputTokens,
          maxOutputTokens: reservation.maxOutputTokens,
          maxBillableTokens: reservation.maxBillableTokens,
          maximumEstimatedCostUsd: quote.maximumEstimatedCostUsd,
          pricingVersion: quote.pricingVersion,
        },
        () => undefined,
        requestStartedAt,
        `arena:${this.prepared.identity.decisionId}:model-reservation:${tuple}`,
      );
      const attempt: AttemptRecord = {
        sessionId,
        turn: active.turn,
        step: active.step,
        attempt: attemptIndex,
        provider: options.provider,
        model: options.model,
        requestStartedAt,
        reservation,
        quote,
      };
      this.attempts.push(attempt);
      this.currentAttempts.set(key, attempt);
      return { kind: "ready" as const, attempt };
    });
  }

  finalizeAttempt(attempt: AttemptRecord): Promise<ArenaRecordedAttempt> {
    if (attempt.finalized !== undefined) return Promise.resolve(attempt.finalized);
    if (attempt.finalizePromise !== undefined) return attempt.finalizePromise;
    attempt.completedAt ??= this.now().toISOString();
    attempt.lastObservedSeqAtFinalize ??=
      this.sessions.get(attempt.sessionId)?.lastObservedSeq ?? 0;
    attempt.frozenUsage ??= this.usageBuffer.freeze(attempt);
    const frozenUsage = attempt.frozenUsage;
    const finalizePromise = this.serial.run(async () => {
      const recorded = attempt.persisted ?? await this.persistence.recordAttempt({
        sessionId: attempt.sessionId,
        turn: attempt.turn,
        step: attempt.step,
        attempt: attempt.attempt,
        provider: attempt.provider,
        model: attempt.model,
        requestStartedAt: attempt.requestStartedAt,
        completedAt: attempt.completedAt!,
        pricingId: attempt.quote.pricingId,
        pricingVersion: attempt.quote.pricingVersion,
        frozenUsage,
      });
      attempt.persisted = recorded;
      this.runStreamSeq = recorded.eventSeq;

      let settlementBudgetResource: string | undefined;
      if (frozenUsage.usageStatus === "provider_unreported") {
        settlementBudgetResource = "provider_usage_unreported";
      } else if (recorded.costStatus !== "estimated" || recorded.estimatedCost === null) {
        settlementBudgetResource = "settled_pricing_unavailable";
      } else if (
        BigInt(totalBillableTokens(frozenUsage.usage))
          > BigInt(attempt.reservation.maxBillableTokens)
        || compareDecimal(
          recorded.estimatedCost,
          attempt.quote.maximumEstimatedCostUsd,
        ) > 0
      ) {
        settlementBudgetResource = "reservation_overrun";
      }
      if (settlementBudgetResource !== undefined) {
        this.providerBudgetDenied = true;
        if (attempt.settlementBudgetEventSeq === undefined) {
          const exhausted = await this.persistence.appendEvent({
            eventType: "decision.budget_exhausted",
            eventTime: attempt.completedAt!,
            actorKind: "worker",
            actorId: this.workerId,
            idempotencyKey:
              `arena:${this.prepared.identity.decisionId}:settlement-budget:${attemptTupleKey(attempt)}`,
            payload: {
              decisionId: this.prepared.identity.decisionId,
              rootHarnessSessionId: this.rootSessionId,
              harnessSessionId: attempt.sessionId,
              resource: settlementBudgetResource,
            },
          });
          attempt.settlementBudgetEventSeq = exhausted.eventSeq;
        }
        this.runStreamSeq = attempt.settlementBudgetEventSeq;
      }

      if (attempt.usageApplied !== true) {
        const node = this.node(attempt.sessionId);
        node.usage.providerRequestCount = String(BigInt(node.usage.providerRequestCount) + 1n);
        if (frozenUsage.usageStatus === "captured") {
          addUsageTokens(node.usage, frozenUsage.usage);
        }
        addEstimatedCost(node.usage, recorded.estimatedCost, recorded.pricingVersion);
        const statuses = this.attemptCostStatuses.get(attempt.sessionId) ?? [];
        statuses.push(recorded.costStatus);
        this.attemptCostStatuses.set(attempt.sessionId, statuses);
        node.usage.costStatus = costStatusForAttempts(statuses);
        node.lastEventSeq = String(attempt.lastObservedSeqAtFinalize!);
        attempt.pendingResult = Object.freeze({
          sessionId: attempt.sessionId,
          turn: attempt.turn,
          step: attempt.step,
          attempt: attempt.attempt,
          provider: attempt.provider,
          model: attempt.model,
          requestStartedAt: attempt.requestStartedAt,
          completedAt: attempt.completedAt!,
          frozenUsage,
          costStatus: recorded.costStatus,
          estimatedCost: recorded.estimatedCost,
          pricingVersion: recorded.pricingVersion,
          eventId: recorded.eventId,
          eventSeq: recorded.eventSeq,
        });
        attempt.usageApplied = true;
      }
      await this.projectCurrent();
      attempt.finalized = attempt.pendingResult!;
      return attempt.finalized;
    });
    attempt.finalizePromise = finalizePromise;
    void finalizePromise.catch(() => {
      if (attempt.finalizePromise === finalizePromise) {
        delete attempt.finalizePromise;
      }
    });
    return finalizePromise;
  }

  async finalizeOutstandingAttempts(): Promise<void> {
    const settlements = await Promise.allSettled(
      this.attempts.map((attempt) => this.finalizeAttempt(attempt)),
    );
    const failure = settlements.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
    await this.serial.drain();
    this.serial.throwBackgroundFailure();
  }

  async acceptSubmission(
    submission: PortfolioTargetsSubmission,
  ): Promise<PortfolioTargetsResult> {
    const canonical = JSON.stringify(submission);
    if (this.acceptedSubmission !== undefined) {
      if (this.acceptedSubmission.canonical !== canonical) {
        return { status: "rejected", reason: "This decision already has a different accepted submission" };
      }
      await this.serial.run(() => this.projectCurrent());
      return {
        status: "accepted",
        submission_id: this.acceptedSubmission.submissionId,
      };
    }
    if (this.submissionInFlight !== undefined) {
      if (this.submissionInFlight.canonical !== canonical) {
        return { status: "rejected", reason: "A different submission is already being accepted" };
      }
      return this.submissionInFlight.promise;
    }
    const operation = this.acceptSubmissionCore(submission, canonical);
    this.submissionInFlight = { canonical, promise: operation };
    try {
      return await operation;
    } finally {
      if (this.submissionInFlight?.promise === operation) delete this.submissionInFlight;
    }
  }

  private async acceptSubmissionCore(
    submission: PortfolioTargetsSubmission,
    canonical: string,
  ): Promise<PortfolioTargetsResult> {
    if (submission.session_id !== this.rootSessionId) {
      return this.rejectSubmission("ROOT_SESSION_REQUIRED", "Only the bound root Session may submit");
    }
    if (
      submission.decision_packet_id !== this.prepared.identity.decisionPacketId
      || submission.packet_sha256 !== this.prepared.identity.packetSha256
    ) {
      return this.rejectSubmission("PACKET_FENCE_MISMATCH", "Decision packet id or digest does not match the invocation fence");
    }
    if (this.terminal || this.expired) {
      this.deadlineExceeded ||= this.expired;
      return this.rejectSubmission("DECISION_CLOSED", "Decision is closed or past its submission deadline");
    }
    const policyViolation = portfolioConstraintViolation(submission, this.packet);
    if (policyViolation !== undefined) {
      return this.rejectSubmission("PORTFOLIO_POLICY_VIOLATION", policyViolation);
    }

    return this.serial.run(async () => {
      // Descendant registration is serialized on the same queue. Reaching this
      // check therefore proves at least one durable child lineage edge exists,
      // rather than merely observing an in-flight subagent tool call.
      if (!isArenaDescendantRequirementSatisfied(
        this.prepared.identity.executionClass,
        this.projection,
      )) {
        return this.persistSubmissionRejection(
          "DESCENDANT_REQUIRED",
          "The orchestrated contestant must register at least one research subagent before submitting",
        );
      }
      const acceptedAt = this.now().toISOString();
      const admissionEvidence = buildArenaDecisionAdmissionEvidence({
        identity: this.prepared.identity,
        packet: this.packet,
        submission,
        acceptedAt,
      });
      if (admissionEvidence.guardAction !== "ALLOW") {
        return this.persistSubmissionRejection(
          "ADMISSION_GUARD_BLOCKED",
          `Decision admission blocked: ${admissionEvidence.reasons.join(",")}`,
        );
      }
      const accepted = await this.persistence.acceptSubmission({
        submission,
        acceptedAt,
        admissionEvidence,
      });
      this.runStreamSeq = accepted.eventSeq;
      this.acceptedSubmission = {
        canonical,
        submissionId: accepted.submissionId,
        acceptedAt: accepted.acceptedAt,
      };
      this.projection.submission = {
        status: "ACCEPTED",
        acceptedSubmissionId: accepted.submissionId,
        acceptedAt: accepted.acceptedAt,
        rejectionCode: null,
      };
      await this.projectCurrent();
      return {
        status: "accepted" as const,
        submission_id: accepted.submissionId,
      };
    });
  }

  private rejectSubmission(code: string, reason: string): Promise<PortfolioTargetsResult> {
    return this.serial.run(() => this.persistSubmissionRejection(code, reason));
  }

  private async persistSubmissionRejection(
    code: string,
    reason: string,
  ): Promise<PortfolioTargetsResult> {
    await this.appendThenProject(
      "decision.submission_rejected",
      {
        decisionId: this.prepared.identity.decisionId,
        rootHarnessSessionId: this.rootSessionId,
        rejectionCode: code,
      },
      () => {
        this.projection.submission = {
          status: "REJECTED",
          acceptedSubmissionId: null,
          acceptedAt: null,
          rejectionCode: code,
        };
      },
    );
    return { status: "rejected" as const, reason };
  }

  async finishFromHarness(): Promise<void> {
    await this.finalizeOutstandingAttempts();
    if (this.terminal) return;
    const rootReason = this.turnEnds.get(this.rootSessionId);
    let status: ArenaDecisionStatus;
    let failureCode: string | null;
    let failureMessage: string | null;
    if (this.acceptedSubmission !== undefined) {
      status = "SUCCEEDED";
      failureCode = null;
      failureMessage = null;
    } else if (this.providerBudgetDenied || this.descendantBudgetDenied) {
      status = "BUDGET_EXHAUSTED";
      failureCode = "ARENA_BUDGET_EXHAUSTED";
      failureMessage = "The shared provider, token, cost, or descendant budget was exhausted";
    } else if (this.deadlineExceeded) {
      status = "FAILED";
      failureCode = "SUBMISSION_DEADLINE_EXCEEDED";
      failureMessage = "The decision did not produce an accepted submission before its deadline";
    } else if (rootReason?.kind === "error") {
      status = "FAILED";
      failureCode = rootReason.error.code;
      failureMessage = rootReason.error.message;
    } else if (rootReason?.kind === "aborted") {
      status = "FAILED";
      failureCode = "AGENT_ABORTED";
      failureMessage = `The root Agent was aborted (${rootReason.reason.kind})`;
    } else {
      status = "NO_ACCEPTED_SUBMISSION";
      failureCode = "NO_ACCEPTED_SUBMISSION";
      failureMessage = "The root Agent reached idle without a durably accepted target portfolio";
    }
    await this.finish(status, failureCode, failureMessage);
  }

  async fail(code: string, message: string): Promise<void> {
    if (this.terminal) return;
    await this.finish("FAILED", code, message);
  }

  private async finish(
    status: ArenaDecisionStatus,
    failureCode: string | null,
    failureMessage: string | null,
  ): Promise<void> {
    const completedAt = this.now().toISOString();
    const safeFailureMessage = failureMessage === null
      ? null
      : sanitizeFailureMessage(failureMessage);
    await this.serial.run(() => this.appendThenProject(
      status === "SUCCEEDED" ? "decision.runtime_succeeded" : "decision.runtime_failed",
      {
        decisionId: this.prepared.identity.decisionId,
        rootHarnessSessionId: this.rootSessionId,
        status,
        ...(failureCode === null ? {} : { failureCode }),
      },
      () => {
        this.terminal = true;
        this.projection.decision.status = status;
        this.projection.decision.completedAt = completedAt;
        this.projection.decision.failureCode = failureCode;
        this.projection.decision.failureMessage = safeFailureMessage;
        if (this.projection.submission.status === "PENDING") {
          this.projection.submission = {
            status: "NONE",
            acceptedSubmissionId: null,
            acceptedAt: null,
            rejectionCode: null,
          };
        }
        for (const node of this.projection.agents) {
          const record = this.sessions.get(node.sessionId);
          if (record !== undefined) {
            node.lastEventSeq = String(record.lastObservedSeq);
          }
          if (node.sessionId === this.rootSessionId) {
            node.status = status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED";
            node.completedAt = completedAt;
          } else if (!isTerminalAgentStatus(node.status)) {
            const reason = this.turnEnds.get(node.sessionId);
            node.status = reason?.kind === "completed"
              ? "SUCCEEDED"
              : reason?.kind === "aborted"
                ? "CANCELED"
                : "FAILED";
            node.completedAt = completedAt;
          }
        }
      },
      completedAt,
    ));
  }

  result(): ArenaRuntimeResult {
    const sessions = [...this.sessions.values()]
      .sort((left, right) => left.node.agentPath.localeCompare(right.node.agentPath))
      .map((record): ArenaCapturedSession => Object.freeze({
        sessionId: record.node.sessionId,
        parentSessionId: record.node.parentSessionId,
        agentPath: record.node.agentPath,
        events: record.session.events,
      }));
    const attempts = this.attempts
      .map((attempt) => attempt.finalized)
      .filter((attempt): attempt is ArenaRecordedAttempt => attempt !== undefined);
    return Object.freeze({
      projection: structuredClone(this.projection),
      sessions: Object.freeze(sessions),
      attempts: Object.freeze(attempts),
      runStreamSeq: this.runStreamSeq,
    });
  }
}

class ArenaCoordinator implements TwofoldDecisionGateway {
  private readonly runsByRoot = new Map<string, ActiveArenaRun>();
  private readonly runsBySession = new Map<string, ActiveArenaRun>();

  bind(run: ActiveArenaRun): void {
    if (this.runsByRoot.has(run.rootSessionId)) {
      throw new Error(`Arena root Session ${run.rootSessionId} is already active`);
    }
    this.runsByRoot.set(run.rootSessionId, run);
    this.runsBySession.set(run.rootSessionId, run);
  }

  unbind(run: ActiveArenaRun): void {
    if (this.runsByRoot.get(run.rootSessionId) === run) {
      this.runsByRoot.delete(run.rootSessionId);
    }
    for (const [sessionId, owner] of this.runsBySession) {
      if (owner === run) this.runsBySession.delete(sessionId);
    }
  }

  runForSession(sessionId: string): ActiveArenaRun | undefined {
    return this.runsBySession.get(sessionId);
  }

  onSessionCreated(session: Session): void {
    const sessionId = String(session.id);
    let run = this.runsByRoot.get(sessionId);
    if (run === undefined && session.header.parentSession !== undefined) {
      run = this.runsBySession.get(String(session.header.parentSession));
    }
    if (run === undefined) return;
    this.runsBySession.set(sessionId, run);
    run.observeSessionCreated(session);
  }

  onSessionEvent(session: Session, event: SessionEvent): void {
    this.runsBySession.get(String(session.id))?.observeSessionEvent(session, event);
  }

  onAgentCreated(agent: Agent): void {
    this.runsBySession.get(String(agent.id))?.observeAgentCreated(agent);
  }

  onAgentStatus(agent: Agent, status: "idle" | "running"): void {
    this.runsBySession.get(String(agent.id))?.observeAgentStatus(agent, status);
  }

  onAgentDisposed(agent: Agent): void {
    this.runsBySession.get(String(agent.id))?.observeAgentDisposed(agent);
  }

  guardTool(name: string, callId: string, sessionId: string | undefined): string | undefined {
    if (name !== "subagent" || sessionId === undefined) return undefined;
    const run = this.runsByRoot.get(sessionId);
    if (run === undefined) return "Only a bound Twofold Arena root Session may delegate";
    return run.reserveSubagent(callId);
  }

  stream(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    if (!isAgentLoopRequest(options) || options.sessionId === undefined) return next();
    const run = this.runsBySession.get(String(options.sessionId));
    if (run === undefined) return next();
    return this.arenaStream(run, options, next);
  }

  private async *arenaStream(
    run: ActiveArenaRun,
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const started = await run.beginProviderAttempt(options);
    if (started.kind === "denied") {
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: { code: started.code, message: started.message },
        },
      };
      return;
    }
    yield* next();
  }

  async readDecisionPacket(input: {
    sessionId: string;
    signal: AbortSignal;
  }): Promise<DecisionPacketResult> {
    input.signal.throwIfAborted();
    const run = this.runsByRoot.get(input.sessionId);
    if (run === undefined) {
      return { status: "unavailable", reason: "No active Arena packet is bound to this root Session" };
    }
    if (run.terminal || run.expired) {
      return { status: "unavailable", reason: "The Arena decision is closed or past its submission deadline" };
    }
    return run.packet;
  }

  async submitPortfolioTargets(
    input: PortfolioTargetsSubmission & { signal: AbortSignal },
  ): Promise<PortfolioTargetsResult> {
    input.signal.throwIfAborted();
    const run = this.runsByRoot.get(input.session_id);
    if (run === undefined) {
      return { status: "disabled", reason: "Only the active bound root Session may submit" };
    }
    const { signal: _signal, ...submission } = input;
    return run.acceptSubmission(submission);
  }
}

export class ArenaRuntime {
  private readonly activeRuns = new Set<ActiveArenaRun>();
  private readonly runPromises = new Set<Promise<ArenaRuntimeResult>>();
  private closing = false;

  private constructor(
    private readonly ctx: Context,
    private readonly coordinator: ArenaCoordinator,
    private readonly options: {
      readonly repositoryRoot: string;
      readonly workerId: string;
      readonly now: () => Date;
    },
  ) {}

  static async create(options: CreateArenaRuntimeOptions): Promise<ArenaRuntime> {
    const repositoryRoot = resolve(options.repositoryRoot);
    const configuredHome = process.env.DSH_HOME;
    if (
      configuredHome !== undefined
      && configuredHome.length > 0
      && resolve(configuredHome) !== repositoryRoot
    ) {
      throw new Error(
        `DSH_HOME must resolve to the Twofold repository root (${repositoryRoot}), got ${configuredHome}`,
      );
    }
    process.env.DSH_HOME = repositoryRoot;

    const workerPackageJson = resolve(
      options.installAnchor
        ?? fileURLToPath(new URL("../package.json", import.meta.url)),
    );
    if (options.profileModuleHealing !== false) {
      healProfilesModuleFallback(workerPackageJson, repositoryRoot);
    }
    const profileDirectory = resolve(/* turbopackIgnore: true */
      options.profileDirectory ?? join(repositoryRoot, "profiles", PROFILE_NAME),
    );
    const profile = options.profileBundlePatchPaths === undefined
      ? loadProfile(RUNTIME_NAME, PROFILE_NAME, workerPackageJson, repositoryRoot)
      : {
          dir: profileDirectory,
          layers: options.profileBundlePatchPaths.map((patchPath) => ({
            patches: loadOverlayPatches(RUNTIME_NAME, resolve(patchPath)),
          })),
          patches: loadOverlayPatches(
            RUNTIME_NAME,
            join(profileDirectory, "cordis.patch.yml"),
          ),
        };
    const patches: PatchOptions[] = [
      ...profile.layers.flatMap((layer) => layer.patches),
      ...profile.patches,
      { id: "hmr", disabled: true },
      { id: "session-telemetry-otel", disabled: true },
    ];
    const coordinator = new ArenaCoordinator();
    const ctx = await boot(
      RUNTIME_NAME,
      join(profile.dir, "cordis.yml"),
      structuredClone(patches),
      (hostCtx) => {
        if (options.runtimePackageManifest === true) {
          const loader = hostCtx.loader as unknown as {
            internal: {
              import(specifier: string): Promise<unknown>;
            } | undefined;
          };
          loader.internal = {
            import: (specifier: string) => importArenaRuntimePackage(specifier),
          };
        }
        hostCtx.provide(DECISION_GATEWAY_SERVICE, coordinator);
        hostCtx.on("session/created", (session) => coordinator.onSessionCreated(session));
        hostCtx.on("session/event", (session, event) => coordinator.onSessionEvent(session, event));
        hostCtx.on("agent/created", ({ agent }) => coordinator.onAgentCreated(agent));
        hostCtx.on("agent/status", ({ agent, status }) => coordinator.onAgentStatus(agent, status));
        hostCtx.on("agent/disposed", ({ agent }) => coordinator.onAgentDisposed(agent));
        hostCtx.on("llm/stream", (llmOptions, next) => coordinator.stream(llmOptions, next));
      },
      pathToFileURL(workerPackageJson).href,
    );
    return new ArenaRuntime(ctx, coordinator, {
      repositoryRoot,
      workerId: options.workerId,
      now: options.now ?? (() => new Date()),
    });
  }

  run(input: RunArenaInvocationInput): Promise<ArenaRuntimeResult> {
    if (this.closing) throw new Error("Arena runtime is disposing and accepts no new runs");
    const promise = this.runCore(input);
    this.runPromises.add(promise);
    void promise.then(
      () => this.runPromises.delete(promise),
      () => this.runPromises.delete(promise),
    );
    return promise;
  }

  private async runCore(input: RunArenaInvocationInput): Promise<ArenaRuntimeResult> {
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const run = new ActiveArenaRun(
      input.prepared,
      input.persistence,
      this.options.workerId,
      this.options.now,
    );
    this.coordinator.bind(run);
    this.activeRuns.add(run);

    let handle: AgentHandle | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      handle?.agent.cancel({ kind: "hook", reason: "Twofold Arena worker aborted" });
    };
    signal.addEventListener("abort", abort, { once: true });

    try {
      await run.start();
      const remaining = run.deadlineAt - this.options.now().getTime();
      if (remaining <= 0) {
        run.deadlineExceeded = true;
        await run.fail(
          "SUBMISSION_DEADLINE_EXCEEDED",
          "The decision invocation was already past its submission deadline",
        );
      } else {
        handle = await this.ctx.agents.create({
          sessionId: SessionId(input.prepared.identity.rootSessionId),
          meta: {
            cwd: this.options.repositoryRoot,
            agentPreset: input.prepared.identity.presetId,
          },
          agentOptions: {
            provider: LOCKED_PROVIDER,
            model: LOCKED_MODEL,
            maxTokens: arenaRootMaxTokens(
              rootDecisionSymbolCount(input.prepared),
            ),
          },
          signal,
          setup: async (agentCtx) => {
            await this.ctx.agentPresets.mount(
              agentCtx,
              input.prepared.identity.presetId,
            );
            const tools = (agentCtx as Context & { tools: ArenaToolRuntimeView }).tools;
            tools.guard((execution) => this.coordinator.guardTool(
              execution.name,
              String(execution.callId),
              execution.agent === undefined ? undefined : String(execution.agent.id),
            ));
          },
        });
        run.handle = handle;
        if (signal.aborted) abort();
        const postCreateRemaining = run.deadlineAt - this.options.now().getTime();
        if (postCreateRemaining <= 0) {
          run.deadlineExceeded = true;
          handle.agent.cancel({
            kind: "hook",
            reason: "Twofold Arena submission deadline exceeded",
          });
          await run.fail(
            "SUBMISSION_DEADLINE_EXCEEDED",
            "The decision invocation expired while its Agent was being created",
          );
        } else {
          const boundedDelay = Math.min(postCreateRemaining, 2_147_483_647);
          deadlineTimer = setTimeout(() => {
            run.deadlineExceeded = true;
            handle?.agent.cancel({
              kind: "hook",
              reason: "Twofold Arena submission deadline exceeded",
            });
          }, boundedDelay);
          handle.agent.followup(createUserMessage({
            content: [{ type: "text", text: input.task ?? DEFAULT_TASK }],
            source: { kind: "user" },
          }));
          await handle.agent.whenIdle();
          if (signal.aborted) {
            await run.fail("WORKER_ABORTED", "The Arena worker aborted the active decision");
          } else {
            await run.finishFromHarness();
          }
        }
        await this.ctx.sessions.flush(handle.agent.session);
      }
    } catch (error: unknown) {
      const code = signal.aborted ? "WORKER_ABORTED" : "HARNESS_RUNTIME_FAILED";
      try {
        await run.fail(code, errorMessage(error));
      } catch (finalizeError: unknown) {
        throw new AggregateError(
          [error, finalizeError],
          `Arena run failed and terminal projection could not be written: ${errorMessage(error)}`,
        );
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      signal.removeEventListener("abort", abort);
      try {
        if (handle !== undefined) await handle.dispose();
        await run.serial.drain();
      } finally {
        this.coordinator.unbind(run);
        this.activeRuns.delete(run);
      }
    }
    return run.result();
  }

  async dispose(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const run of this.activeRuns) {
      run.handle?.agent.cancel({ kind: "hook", reason: "Twofold Arena runtime is shutting down" });
    }
    await Promise.allSettled([...this.runPromises]);
    await this.ctx.fiber.dispose();
  }
}

export function createArenaRuntime(
  options: CreateArenaRuntimeOptions,
): Promise<ArenaRuntime> {
  return ArenaRuntime.create(options);
}

export async function runArenaInvocation(
  options: CreateArenaRuntimeOptions & RunArenaInvocationInput,
): Promise<ArenaRuntimeResult> {
  const runtime = await createArenaRuntime(options);
  try {
    return await runtime.run(options);
  } finally {
    await runtime.dispose();
  }
}
