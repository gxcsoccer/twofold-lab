import {
  fetchAlpacaCorporateActions,
  type AlpacaCorporateActionConfig,
  type AlpacaCorporateActionScan,
} from "./alpaca-corporate-actions.js";

const DAY_MS = 86_400_000;

export interface CorporateActionScanStore {
  latestObservedAt(): Promise<string | null>;
  activeSymbols(asOf: string): Promise<readonly string[]>;
  persist(scan: AlpacaCorporateActionScan): Promise<unknown>;
}

/**
 * A lightweight cadence controller around the durable scan repository. The
 * latest persisted observation is the cadence authority, so serverless cold
 * starts do not multiply provider polling. A failed poll is retried quickly
 * while contestant work stays unclaimed.
 */
export class CorporateActionScanner {
  readonly #config: AlpacaCorporateActionConfig;
  readonly #store: CorporateActionScanStore;
  readonly #scanIntervalMs: number;
  readonly #retryIntervalMs: number;
  readonly #lookbackDays: number;
  readonly #horizonDays: number;
  readonly #fetchImplementation: typeof fetch | undefined;
  readonly #now: () => Date;
  #nextAttemptAt = 0;
  #running = false;

  constructor(input: {
    readonly config: AlpacaCorporateActionConfig;
    readonly store: CorporateActionScanStore;
    readonly scanIntervalMs: number;
    readonly retryIntervalMs?: number;
    readonly lookbackDays: number;
    readonly horizonDays: number;
    readonly fetchImplementation?: typeof fetch;
    readonly now?: () => Date;
  }) {
    for (const [name, value] of [
      ["scanIntervalMs", input.scanIntervalMs],
      ["retryIntervalMs", input.retryIntervalMs ?? 60_000],
      ["lookbackDays", input.lookbackDays],
      ["horizonDays", input.horizonDays],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive integer`);
      }
    }
    this.#config = input.config;
    this.#store = input.store;
    this.#scanIntervalMs = input.scanIntervalMs;
    this.#retryIntervalMs = input.retryIntervalMs ?? 60_000;
    this.#lookbackDays = input.lookbackDays;
    this.#horizonDays = input.horizonDays;
    this.#fetchImplementation = input.fetchImplementation;
    this.#now = input.now ?? (() => new Date());
  }

  async tick(signal: AbortSignal): Promise<"idle" | "completed" | "failed"> {
    signal.throwIfAborted();
    const now = this.#now();
    if (this.#running || now.getTime() < this.#nextAttemptAt) return "idle";
    this.#running = true;
    try {
      const latestObservedAt = await this.#store.latestObservedAt();
      signal.throwIfAborted();
      if (latestObservedAt !== null) {
        const latestMilliseconds = Date.parse(latestObservedAt);
        if (!Number.isFinite(latestMilliseconds)) {
          throw new TypeError("latest corporate-action observation is not an instant");
        }
        const durableNextAttemptAt = latestMilliseconds + this.#scanIntervalMs;
        if (now.getTime() < durableNextAttemptAt) {
          this.#nextAttemptAt = durableNextAttemptAt;
          return "idle";
        }
      }
      const symbols = [...new Set(await this.#store.activeSymbols(now.toISOString()))]
        .sort((left, right) => left.localeCompare(right, "en"));
      if (symbols.length === 0) {
        this.#nextAttemptAt = now.getTime() + this.#scanIntervalMs;
        return "idle";
      }
      const processDate = newYorkDate(now);
      const scan = await fetchAlpacaCorporateActions(Object.freeze({
        ...this.#config,
        symbols: Object.freeze(symbols),
      }), {
        processDateStart: addDays(processDate, -this.#lookbackDays),
        processDateEnd: addDays(processDate, this.#horizonDays),
        ...(this.#fetchImplementation === undefined
          ? {}
          : { fetchImplementation: this.#fetchImplementation }),
        now: () => now,
        signal,
      });
      signal.throwIfAborted();
      await this.#store.persist(scan);
      this.#nextAttemptAt = now.getTime() + this.#scanIntervalMs;
      return "completed";
    } catch (error) {
      if (signal.aborted) throw error;
      this.#nextAttemptAt = now.getTime() + this.#retryIntervalMs;
      return "failed";
    } finally {
      this.#running = false;
    }
  }
}

function newYorkDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("could not derive America/New_York corporate-action date");
  }
  return `${year}-${month}-${day}`;
}

function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setTime(instant.getTime() + days * DAY_MS);
  return instant.toISOString().slice(0, 10);
}
