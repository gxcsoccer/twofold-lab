import { loadWorkerConfig } from "./config.js";
import {
  fetchAlpacaDailyBars,
  loadAlpacaMarketDataConfig,
} from "./market-data.js";
import { SupabaseMarketDataRepository } from "./market-data-repository.js";

function readArgument(arguments_: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const argument = arguments_.find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

async function main(): Promise<void> {
  const worker = loadWorkerConfig();
  const market = loadAlpacaMarketDataConfig();
  const arguments_ = process.argv.slice(2);
  const endAt = readArgument(arguments_, "end");
  const targetSessionDate = readArgument(arguments_, "session-date");
  const delivery = await fetchAlpacaDailyBars(market, {
    ...(endAt === undefined ? {} : { endAt }),
    ...(targetSessionDate === undefined ? {} : { targetSessionDate }),
  });
  const repository = new SupabaseMarketDataRepository(
    worker.supabaseUrl!,
    worker.supabaseSecretKey!,
  );
  const persisted = await repository.persist(delivery);

  process.stdout.write(JSON.stringify({
    provider: delivery.source.provider,
    feed: delivery.source.feed,
    symbols: delivery.symbols,
    targetSessionDate: delivery.targetSessionDate,
    barCount: String(delivery.facts.length),
    retrievedAt: delivery.retrievedAt,
    availableAt: delivery.availableAt,
    responseSha256: delivery.responseSha256,
    ...persisted,
  }, null, 2) + "\n");
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-market-ingest] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
