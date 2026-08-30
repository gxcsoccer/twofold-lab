import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");

async function rewrite(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewrite(path);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const source = await readFile(path, "utf8");
    const output = source.replaceAll('"@twofold/core"', '"@twofold/core/serverless"');
    if (output !== source) await writeFile(path, output, "utf8");
  }
}

await rewrite(dist);

const serverlessProfile = join(dist, "serverless-profile");
await mkdir(serverlessProfile, { recursive: true });
await copyFile(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../node_modules/@deepseek-ai/dsh-base/cordis.patch.yml",
  ),
  join(serverlessProfile, "dsh-base.cordis.patch.yml"),
);
