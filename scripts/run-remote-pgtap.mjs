#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const [sourcePath] = process.argv.slice(2);
if (!sourcePath) {
  throw new Error("Usage: run-remote-pgtap.mjs <test.sql>");
}

const source = readFileSync(sourcePath, "utf8");
const planOffset = source.search(/^select plan\(/m);
if (planOffset < 0) throw new Error("The pgTAP test has no top-level plan()");

const setup = [
  "create temporary table pg_temp.twofold_tap_results (",
  "  seq bigint generated always as identity primary key,",
  "  result text not null",
  ") on commit drop;",
  "grant insert, select on pg_temp.twofold_tap_results",
  "  to anon, authenticated, service_role;",
  "grant usage, select on sequence pg_temp.twofold_tap_results_seq_seq",
  "  to anon, authenticated, service_role;",
  "",
].join("\n");

const prefix = source.slice(0, planOffset);
const tests = source
  .slice(planOffset)
  .replace(
    /^select (?=(?:plan|has_table|has_column|is|isnt|ok|throws_ok)\s*\()/gm,
    "insert into pg_temp.twofold_tap_results (result)\nselect ",
  )
  .replace(
    /^select \* from finish\(\);/m,
    [
      "insert into pg_temp.twofold_tap_results (result)",
      "select * from finish();",
      "select seq, result from pg_temp.twofold_tap_results order by seq;",
    ].join("\n"),
  );

const temporaryDirectory = mkdtempSync(join(tmpdir(), "twofold-pgtap-"));
const transformedPath = join(temporaryDirectory, basename(sourcePath));

try {
  writeFileSync(transformedPath, prefix + setup + tests, {
    encoding: "utf8",
    mode: 0o600,
  });
  const output = execFileSync(
    "supabase",
    ["db", "query", "--linked", "--file", transformedPath],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  process.stdout.write(output);

  const response = JSON.parse(output);
  const results = Array.isArray(response?.rows)
    ? response.rows.map((row) => String(row?.result ?? ""))
    : [];
  const failed = results.some(
    (result) =>
      result.startsWith("not ok") ||
      result.startsWith("Bail out!") ||
      result.includes("Looks like you failed"),
  );

  if (results.length === 0 || failed) {
    process.exitCode = 1;
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
