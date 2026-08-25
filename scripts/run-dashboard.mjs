import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const dashboardDirectory = resolve(repositoryRoot, "apps/dashboard");
const nextCli = resolve(dashboardDirectory, "node_modules/next/dist/bin/next");

function readPort(arguments_) {
  const argument = arguments_.find((value) => value.startsWith("--port="));
  const port = argument?.slice("--port=".length) ?? "3000";
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return port;
}

function loadLocalEnvironment() {
  const fileEnvironment = {};
  for (const filename of [".env", ".env.local"]) {
    const absolutePath = resolve(repositoryRoot, filename);
    if (existsSync(absolutePath)) {
      Object.assign(fileEnvironment, parseEnv(readFileSync(absolutePath, "utf8")));
    }
  }
  // Explicit shell/runner variables win over local files.
  return { ...fileEnvironment, ...process.env };
}

const child = spawn(
  process.execPath,
  [nextCli, "dev", dashboardDirectory, "-H", "127.0.0.1", "-p", readPort(process.argv.slice(2))],
  {
    cwd: repositoryRoot,
    env: loadLocalEnvironment(),
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  process.stderr.write(`[twofold-dashboard] failed to start: ${error.message}\n`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
