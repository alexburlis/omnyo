import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { vi } from "vitest";

const FAKE_NPM = `#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const args = process.argv.slice(2);

if (args[0] === "view") {
  const marker = process.env.OMNYO_TEST_NPM_VIEW_MARKER;
  if (marker) writeFileSync(marker, "unexpected public registry query");
  process.stderr.write("Unexpected public SDK registry lookup\\n");
  process.exit(1);
}

if (process.env.OMNYO_TEST_NPM_INSTALL === "fail") {
  process.stderr.write("npm error code EPERM\\nnpm error syscall open\\nnpm error Your cache folder contains root-owned files\\n");
  process.exit(1);
}

if (process.env.OMNYO_TEST_NPM_INSTALL === "fail-noisy-stdout") {
  process.stderr.write("npm error code EPERM\\nnpm error syscall open\\n");
  for (let line = 1; line <= 9; line += 1) {
    process.stdout.write("progress line " + line + "\\n");
  }
  process.exit(1);
}

const omitDev =
  process.env.OMNYO_TEST_NPM_ALWAYS_OMIT_DEV === "1" ||
  (process.env.NODE_ENV === "production" && !args.includes("--include=dev"));
const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const installed = {
  ...manifest.dependencies,
  ...(omitDev ? {} : manifest.devDependencies),
};
const installRoot = process.env.OMNYO_TEST_NPM_HOIST_TO ?? process.cwd();
for (const name of Object.keys(installed)) {
  mkdirSync(join(installRoot, "node_modules", ...name.split("/")), {
    recursive: true,
  });
}
`;

export async function installFakeNpm(workDir: string): Promise<string> {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "npm"), FAKE_NPM, { mode: 0o755 });

  if (process.platform === "win32") {
    await writeFile(
      join(binDir, "npm.cmd"),
      `@"${process.execPath}" "%~dp0npm" %*\r\n`,
    );
  }

  vi.stubEnv("PATH", `${binDir}${delimiter}${process.env.PATH ?? ""}`);

  return binDir;
}
