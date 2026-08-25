#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [voltaPath, targetPath, projectRef, vercelScope] = process.argv.slice(2);

if (!voltaPath || !targetPath || !projectRef || !vercelScope) {
  throw new Error(
    "Usage: configure-local-dogfood.mjs <volta-path> <target> <project-ref> <vercel-scope>",
  );
}

function parseDotenv(source) {
  const values = new Map();

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = JSON.parse(value);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    values.set(match[1], value);
  }

  return values;
}

function requireValue(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`Required value ${key} is missing`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`Required value ${key} is empty`);
  if (/[\r\n]/.test(normalized)) {
    throw new Error(`Required value ${key} contains an embedded newline`);
  }
  return normalized;
}

function serializeValue(value) {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "twofold-credentials-"));
const vercelEnvPath = join(temporaryDirectory, "volta-production.env");

try {
  execFileSync(
    "vercel",
    [
      "env",
      "pull",
      vercelEnvPath,
      "--environment=production",
      `--scope=${vercelScope}`,
      "--yes",
      "--no-color",
    ],
    { cwd: voltaPath, stdio: ["ignore", "ignore", "pipe"] },
  );

  const supabaseKeysOutput = execFileSync(
    "supabase",
    [
      "projects",
      "api-keys",
      "--project-ref",
      projectRef,
      "--reveal",
      "--output",
      "json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  const vercelValues = parseDotenv(readFileSync(vercelEnvPath, "utf8"));
  const alpacaKey = requireValue(vercelValues, "ALPACA_API_KEY");
  const alpacaSecret = requireValue(vercelValues, "ALPACA_API_SECRET");

  const supabaseKeys = JSON.parse(supabaseKeysOutput);
  if (!Array.isArray(supabaseKeys)) {
    throw new Error("Supabase API key response is not an array");
  }

  const supabaseSecret = supabaseKeys.find(
    (candidate) => candidate?.type === "secret",
  )?.api_key;
  if (typeof supabaseSecret !== "string" || !supabaseSecret) {
    throw new Error("Supabase secret API key is missing");
  }

  const targetValues = new Map([
    ["SUPABASE_URL", `https://${projectRef}.supabase.co`],
    ["SUPABASE_SECRET_KEY", supabaseSecret],
    ["TWOFOLD_LOCAL_DOGFOOD", "true"],
    ["ALPACA_API_KEY_ID", alpacaKey],
    ["ALPACA_API_SECRET_KEY", alpacaSecret],
  ]);

  const output = [
    "# Local dogfood credentials. This file is gitignored; never commit it.",
    ...Array.from(targetValues, ([key, value]) => `${key}=${serializeValue(value)}`),
    "",
  ].join("\n");

  writeFileSync(targetPath, output, { encoding: "utf8", mode: 0o600 });
  chmodSync(targetPath, 0o600);

  console.log(`Configured ${targetValues.size} local variables; secret values were not printed.`);
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
