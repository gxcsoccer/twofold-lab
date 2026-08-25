import type { ArenaDecisionStatus } from "./arena-types.js";

export const DOGFOOD_TIMEOUT_MS = 14 * 60_000;

export interface DogfoodSignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface DogfoodAbortScope {
  readonly signal: AbortSignal;
  dispose(): void;
}

/** Fuse the wall-clock deadline and both operator shutdown signals. */
export function createDogfoodAbortScope(
  options: {
    readonly timeoutMs?: number;
    readonly signalSource?: DogfoodSignalSource;
  } = {},
): DogfoodAbortScope {
  const timeoutMs = options.timeoutMs ?? DOGFOOD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("dogfood timeoutMs must be a positive safe integer");
  }
  const source = options.signalSource ?? process;
  const controller = new AbortController();
  const abortFor = (signal: "SIGINT" | "SIGTERM") => (): void => {
    controller.abort(new Error(`Dogfood run interrupted by ${signal}`));
  };
  const onSigint = abortFor("SIGINT");
  const onSigterm = abortFor("SIGTERM");
  source.on("SIGINT", onSigint);
  source.on("SIGTERM", onSigterm);
  const timer = setTimeout(() => {
    controller.abort(new Error(`Dogfood run exceeded ${timeoutMs}ms timeout`));
  }, timeoutMs);

  let disposed = false;
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      source.off("SIGINT", onSigint);
      source.off("SIGTERM", onSigterm);
    },
  };
}

export function dogfoodExitCode(status: ArenaDecisionStatus): 0 | 1 {
  return status === "SUCCEEDED" ? 0 : 1;
}
