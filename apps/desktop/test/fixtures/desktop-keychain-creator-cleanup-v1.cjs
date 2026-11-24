const { writeFileSync } = require("node:fs");

const { join, basename, dirname } = require("node:path");

const config = require("./selection.json");

function stage(phase) {
  writeFileSync(
    config.report,
    JSON.stringify({ version: 4, phase, noQuery: true }),
    { mode: 0o600 },
  );
}

stage("entry-before-electron");

const { app } = require("electron");

stage("electron-binding-loaded-no-query");

const fence = require(join(process.resourcesPath, "keychain-ui-fence.node"));

app.setActivationPolicy("prohibited");

app.setName(config.storageName);

app.setPath("userData", config.profile);

app.commandLine.appendSwitch("disable-background-networking");

function run() {
  stage("before-UI-fence-no-query");
  const early = fence.fence();
  const before = fence.queryGuard();

  if (
    process.platform !== "darwin" ||
    basename(process.execPath) !== "Electron" ||
    basename(dirname(dirname(dirname(process.execPath)))) !==
      config.appBundleName ||
    process.argv.length !== 1 ||
    app.isReady() ||
    app.commandLine.hasSwitch("use-mock-keychain") ||
    early.processId !== process.pid ||
    !early.interactionNotAllowed ||
    !before.defaultDeny ||
    before.forwarded !== 0
  )
    return 8;

  stage("capability-verified-no-query");

  if (config.mode === "preflight") return 0;

  if (config.mode !== "cleanup") return 8;
  stage("before-cleanup-addon-no-query");

  const cleanup = require(
    join(process.resourcesPath, "fixture-creator-cleanup.node"),
  );

  stage("before-one-owned-item-cleanup");
  const result = cleanup.cleanupSyntheticOwnedItemV1();
  const after = fence.queryGuard();

  const proof = {
    version: 1,
    phase: "original-creator-cleanup-beforeReady",
    processId: process.pid,
    beforeReady: !app.isReady(),
    originalExecutableBasename: basename(process.execPath) === "Electron",
    appNameMatches: app.getName() === config.storageName,
    interactionNotAllowed: early.interactionNotAllowed,
    cleanupExitCode: result,
    before,
    after,
    noElectronCryptoOrBrowserApiInvoked: true,
  };

  writeFileSync(config.report, JSON.stringify(proof), { mode: 0o600 });

  return result === 0 && after.forwarded === 0 ? 0 : 9;
}

let status;

try {
  status = run();
} catch {
  status = 8;
  writeFileSync(
    config.report,
    JSON.stringify({
      version: 1,
      phase: "creator-cleanup-capability-refused",
      noFurtherOperation: true,
    }),
    { mode: 0o600 },
  );
}

app.exit(status);
