import { readFile } from "node:fs/promises";

import { validatePortfolioArtifacts } from "./portfolio-import.js";

function readArgument(arguments_: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  const value = arguments_.find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
  if (value === undefined || value.length === 0) {
    throw new TypeError(`missing required --${name}=<path> argument`);
  }
  return value;
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const snapshotPath = readArgument(arguments_, "snapshot");
  const sourcePath = readArgument(arguments_, "source");
  const [snapshotJson, sourceBytes] = await Promise.all([
    readFile(snapshotPath, "utf8"),
    readFile(sourcePath),
  ]);
  const result = validatePortfolioArtifacts({
    snapshotJsonText: snapshotJson,
    sourceBytes,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-portfolio-validate] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
