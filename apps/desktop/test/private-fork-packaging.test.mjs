import { execFileSync, spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const cleanEnv = { ...process.env };

const desktopVersion = JSON.parse(
  readFileSync(resolve(desktopRoot, "package.json"), "utf8"),
).version.replace(/\+private\.\d+$/u, "");

for (const name of [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "OMNYO_DESKTOP_RELEASE_CHANNEL",
]) {
  delete cleanEnv[name];
}

test("selected Mac packaging derives the final Omnyo identity without building or publishing", () => {
  const config = JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/run-electron-builder.mjs", "--mac", "--print-config"],
      { cwd: desktopRoot, env: cleanEnv, encoding: "utf8" },
    ),
  );

  assert.equal(config.appId, "dev.omnyo.private");
  assert.equal(config.productName, "Omnyo");
  assert.equal(config.extraMetadata?.productName, "Omnyo");
  assert.equal(
    config.artifactName,
    `omnyo-private-${desktopVersion}-\${arch}.\${ext}`,
  );
  assert.deepEqual(config.publish, []);
});

test("private packaging refuses an accidental inherited publish command", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/run-electron-builder.mjs",
      "--publish",
      "always",
      "--print-config",
    ],
    { cwd: desktopRoot, env: cleanEnv, encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Private fork publication is disabled/);
});

test("documented desktop builds stay usable without public publication", () => {
  const desktop = JSON.parse(
    readFileSync(resolve(desktopRoot, "package.json"), "utf8"),
  );

  for (const name of [
    "desktop:build",
    "desktop:build:linux",
    "desktop:build:win",
  ]) {
    assert.doesNotMatch(desktop.scripts[name], /--publish/);
  }

  const runtime = JSON.parse(
    readFileSync(
      resolve(desktopRoot, "../../packages/omnyo-app/package.json"),
      "utf8",
    ),
  );

  assert.equal(runtime.private, true);
  assert.equal(runtime.publishConfig, undefined);
});

test("Windows packaging uses the Omnyo identity and installer names without building", () => {
  const config = JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/run-electron-builder.mjs", "--win", "--print-config"],
      { cwd: desktopRoot, env: cleanEnv, encoding: "utf8" },
    ),
  );

  assert.equal(config.appId, "dev.omnyo.private");
  assert.equal(config.extraMetadata.name, "omnyo-private");
  assert.equal(
    config.artifactName,
    `omnyo-private-${desktopVersion}-\${arch}.\${ext}`,
  );
  assert.equal(config.nsis.guid, "11c43a4e-5f09-59c3-a447-6f25f5982512");
  assert.deepEqual(config.publish, []);
});
