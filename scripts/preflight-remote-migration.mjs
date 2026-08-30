#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const [sourcePath, testPath] = process.argv.slice(2);
if (!sourcePath) {
  throw new Error(
    "Usage: preflight-remote-migration.mjs <migration.sql> [contract-test.sql]",
  );
}

const source = readFileSync(sourcePath, "utf8");
if (!/^begin;\s*$/im.test(source)) {
  throw new Error("Remote migration preflight requires an explicit BEGIN");
}
const commits = source.match(/^commit;\s*$/gim) ?? [];
if (commits.length !== 1 || !/\ncommit;\s*$/i.test(source)) {
  throw new Error("Remote migration preflight requires one trailing COMMIT");
}

let rollbackSource = source.replace(/\ncommit;\s*$/i, "\nrollback;\n");
if (testPath !== undefined) {
  const testSource = readFileSync(testPath, "utf8");
  const planOffset = testSource.search(/^select plan\(/m);
  if (planOffset < 0 || !/^begin;\s*$/im.test(testSource)) {
    throw new Error("The contract test requires BEGIN and a top-level plan()");
  }
  if (!/\nrollback;\s*$/i.test(testSource)) {
    throw new Error("The contract test requires one trailing ROLLBACK");
  }

  const testWithoutTransaction = testSource
    .replace(/^begin;\s*$/im, "")
    .replace(/\nrollback;\s*$/i, "\n");
  const adjustedPlanOffset = testWithoutTransaction.search(/^select plan\(/m);
  const prefix = testWithoutTransaction.slice(0, adjustedPlanOffset);
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
  const tests = testWithoutTransaction
    .slice(adjustedPlanOffset)
    .replace(
      /^select (?=(?:plan|has_table|has_column|is|isnt|ok|throws_ok)\s*\()/gm,
      "insert into pg_temp.twofold_tap_results (result)\nselect ",
    )
    .replace(
      /^select \* from finish\(\);/m,
      "insert into pg_temp.twofold_tap_results (result)\nselect * from finish();",
    );
  const assertion = [
    "do $twofold_preflight$",
    "declare",
    "  v_failures text;",
    "begin",
    "  if not exists (select 1 from pg_temp.twofold_tap_results)",
    "    or exists (",
    "      select 1 from pg_temp.twofold_tap_results",
    "       where result like 'not ok%'",
    "          or result like 'Bail out!%'",
    "          or result like '%Looks like you failed%'",
    "          or result like '%planned % tests but ran %'",
    "    )",
    "  then",
    "    select string_agg(result, E'\\n' order by seq)",
    "      into v_failures",
    "      from pg_temp.twofold_tap_results",
    "     where result like 'not ok%'",
    "        or result like 'Bail out!%'",
    "        or result like '%Looks like you failed%'",
    "        or result like '%planned % tests but ran %';",
    "    raise exception 'remote migration contract preflight failed'",
    "      using detail = coalesce(v_failures, 'no TAP rows were returned');",
    "  end if;",
    "end;",
    "$twofold_preflight$;",
    "rollback;",
    "",
  ].join("\n");

  rollbackSource = [
    source.replace(/\ncommit;\s*$/i, "\n"),
    prefix,
    setup,
    tests,
    assertion,
  ].join("\n");
}
const temporaryDirectory = mkdtempSync(join(tmpdir(), "twofold-migration-preflight-"));
const temporaryPath = join(temporaryDirectory, basename(sourcePath));

try {
  writeFileSync(temporaryPath, rollbackSource, { encoding: "utf8", mode: 0o600 });
  const output = execFileSync(
    "supabase",
    ["db", "query", "--linked", "--file", temporaryPath],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  process.stdout.write(output);
  if (testPath !== undefined) {
    process.stdout.write("Remote migration and contract preflight passed; all changes rolled back.\n");
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
