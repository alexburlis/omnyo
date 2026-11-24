const {
  app,
  BrowserWindow,
  safeStorage,
  session,
  ipcMain,
} = require("electron");

const { readFileSync, writeFileSync } = require("node:fs");

const { join, basename } = require("node:path");

const { createServer } = require("node:http");

const config = require("./selection.json");

const fence = require(join(process.resourcesPath, "keychain-ui-fence.node"));

const phase = process.argv.includes("--fixture-cleanup")
  ? "cleanup"
  : process.argv.includes("--fixture-seed")
    ? "seed"
    : process.argv.includes("--fixture-verify")
      ? "verify"
      : null;

const seedOwner = phase === "seed" || phase === "cleanup";

const namespaceOnly = process.argv.includes("--fixture-namespace-inspect");

const operationOnly = process.argv.includes("--fixture-operation-inspect");

const inspectionOnly = namespaceOnly || operationOnly;

if (
  (namespaceOnly && config.purpose !== "namespace-inspection-v5") ||
  (operationOnly && config.purpose !== "operation-inspection-v6") ||
  (namespaceOnly && operationOnly)
)
  app.exit(10);

if (phase === null) app.exit(4);

app.setName(config.storageName);

app.setActivationPolicy("prohibited");

app.commandLine.appendSwitch("disable-background-networking");

app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2");

app.setPath("userData", seedOwner ? config.sourceProfile : config.probeProfile);

if (
  !app.isPackaged ||
  basename(process.execPath) !== config.storageName ||
  process.defaultApp === true ||
  app.commandLine.hasSwitch("use-mock-keychain")
)
  app.exit(6);

let earlyGuard;

try {
  earlyGuard = fence.queryGuard();

  if (
    earlyGuard.defaultDeny !== namespaceOnly ||
    earlyGuard.processId !== process.pid ||
    (!inspectionOnly && earlyGuard.observed !== earlyGuard.matched) ||
    earlyGuard.writesAllowed !== (seedOwner && !inspectionOnly)
  )
    app.exit(7);
} catch {
  app.exit(7);
}

const earlyFence = fence.fence();

if (
  earlyFence.interactionNotAllowed !== true ||
  earlyFence.processId !== process.pid
)
  app.exit(5);

const networkServices = () =>
  app
    .getAppMetrics()
    .filter(
      (entry) =>
        entry.type === "Utility" &&
        /network/iu.test(entry.serviceName || entry.name || ""),
    );

let networkChildObserved = false;

app.on("child-process-gone", (_event, details) => {
  if (/network/iu.test(details.serviceName || details.name || ""))
    networkChildObserved = true;
});

if (phase === "cleanup") {
  try {
    if (
      app.isReady() ||
      !config.storageName.endsWith(" Legacy") ||
      process.argv.length !== 2
    )
      throw new Error("The exact original synthetic creator is required");

    const result = require(
      join(process.resourcesPath, "fixture-creator-cleanup.node"),
    ).cleanupSyntheticOwnedItemV2();

    const after = fence.queryGuard();
    writeFileSync(
      config.creatorCleanupReport,
      JSON.stringify({
        version: 2,
        beforeReady: !app.isReady(),
        processId: process.pid,
        executableBasenameMatches:
          basename(process.execPath) === config.storageName,
        noElectronCryptoOrBrowserApiInvoked: true,
        result,
        queryGuard: after,
      }),
      { mode: 0o600 },
    );
    app.exit(
      result.exactAttributes &&
        result.interactionNotAllowed &&
        result.afterOsStatus === -25300 &&
        (result.deleteOsStatus === 0 || result.deleteOsStatus === -25300)
        ? 0
        : 9,
    );
  } catch {
    app.exit(9);
  }
} else
  app
    .whenReady()
    .then(async () => {
      const readyFence = fence.fence();

      if (
        readyFence.interactionNotAllowed !== true ||
        networkServices().length !== 0 ||
        networkChildObserved
      )
        throw new Error("Native querying process ownership differs");

      const server = createServer((request, response) => {
        if (request.url === "/") {
          response.setHeader("content-type", "text/html");
          response.end(
            '<!doctype html><title>Synthetic preserved window</title><script src="/fixture.js"></script>',
          );
        } else if (request.url === "/fixture.js") {
          response.setHeader("content-type", "text/javascript");
          response.end(readFileSync(join(__dirname, "renderer.js")));
        } else {
          config.unexpectedRequests += 1;
          response.writeHead(404).end();
        }
      });

      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, "127.0.0.1", resolve);
      });

      ipcMain.handle("bb-desktop:get-window-state", () => ({
        isFullScreen: false,
      }));
      const windows = [];
      const windowProof = [];
      let legacyWindowBoundaryWorking = false;
      let oldPreloadNoNativeStateKey = false;

      for (let index = 0; index < 2; index += 1) {
        const window = new BrowserWindow({
          show: false,
          webPreferences: {
            contextIsolation: true,
            sandbox: true,
            ...(phase === "seed"
              ? { preload: join(__dirname, "legacy-preload.cjs") }
              : {}),
          },
        });

        windows.push(window);
        await window.loadURL(`http://127.0.0.1:${config.port}/`);

        if (phase === "seed") {
          const state = await window.webContents.executeJavaScript(
            "window.bbDesktop.getWindowState()",
          );

          legacyWindowBoundaryWorking =
            state.isFullScreen === false && Object.keys(state).length === 1;
          oldPreloadNoNativeStateKey =
            await window.webContents.executeJavaScript(
              "!('getWindowStateKey' in window.bbDesktop) && !('stateKey' in window.bbDesktop)",
            );

          if (!legacyWindowBoundaryWorking || !oldPreloadNoNativeStateKey)
            throw new Error("Actual installed legacy preload boundary differs");
          await window.webContents.executeJavaScript(
            `window.omnyoProfileFixture.initialize(${index})`,
          );
        }
      }

      for (const [index, window] of windows.entries())
        windowProof.push(
          await window.webContents.executeJavaScript(
            `window.omnyoProfileFixture.${phase === "seed" ? "stage" : "restore"}(${index})`,
          ),
        );

      const browser = session.fromPartition(
        phase === "seed" ? "persist:bb-browser" : "persist:omnyo-browser",
      );

      const unknown = session.fromPartition("persist:unknown-fixture");
      const partitions = [session.defaultSession, browser, unknown];

      const file = join(
        app.getPath("userData"),
        "synthetic-encrypted-store.bin",
      );

      const url = `http://127.0.0.1:${config.port}/`;
      const beforeQueries = fence.fence();
      const queryGuardBefore = fence.queryGuard();

      if (inspectionOnly) {
        writeFileSync(
          config.report,
          JSON.stringify({
            version: operationOnly ? 6 : 5,
            phase,
            namespaceOnly,
            operationOnly,
            protectedMutationsAllowed: false,
            protectedQueriesForwarded: queryGuardBefore.forwarded,
            noSafeStorageApiInvoked: true,
            isPackaged: app.isPackaged,
            defaultApp: process.defaultApp === true,
            executableBasenameMatches:
              basename(process.execPath) === config.storageName,
            earlyFence,
            readyFence,
            currentFence: beforeQueries,
            earlyGuard,
            queryGuard: queryGuardBefore,
            networkServices: networkServices().length,
            networkChildObserved,
          }),
          { mode: 0o600 },
        );

        for (const window of windows) window.destroy();
        await new Promise((resolve) => server.close(resolve));
        app.exit(
          queryGuardBefore.defaultDeny === namespaceOnly &&
            queryGuardBefore.forwardedMutations === 0 &&
            (!namespaceOnly || queryGuardBefore.forwarded === 0)
            ? 0
            : 11,
        );

        return;
      }

      if (
        queryGuardBefore.defaultDeny ||
        queryGuardBefore.observed !== queryGuardBefore.matched ||
        queryGuardBefore.denied !== 0 ||
        !queryGuardBefore.interactionNotAllowed
      )
        throw new Error("Exact synthetic namespace query fence changed");

      if (
        beforeQueries.interactionNotAllowed !== true ||
        networkServices().length !== 0 ||
        networkChildObserved
      )
        throw new Error("Native querying process fence changed");

      if (!safeStorage.isEncryptionAvailable())
        throw new Error("Native fixture protected storage unavailable");
      const cookies = [];

      if (phase === "seed") {
        writeFileSync(
          file,
          safeStorage.encryptString("synthetic sealed native continuity"),
          { mode: 0o600 },
        );

        for (const [index, partition] of partitions.entries()) {
          await partition.cookies.set({
            url,
            name: "native-continuity",
            value: `synthetic-partition-${index}`,
            expirationDate: 2000000000,
          });
          await partition.cookies.flushStore();
          partition.flushStorageData();
        }
      } else {
        if (
          safeStorage.decryptString(readFileSync(file)) !==
          "synthetic sealed native continuity"
        )
          throw new Error(
            "New native identity did not decrypt protected storage",
          );

        for (const [index, partition] of partitions.entries()) {
          const values = await partition.cookies.get({
            url,
            name: "native-continuity",
          });

          cookies.push(
            values.length === 1 &&
              values[0].value === `synthetic-partition-${index}`,
          );
        }

        if (!cookies.every(Boolean))
          throw new Error(
            "New native identity did not preserve every selected cookie partition",
          );
      }

      const finalFence = fence.fence();
      const queryGuardAfter = fence.queryGuard();

      if (
        queryGuardAfter.defaultDeny ||
        queryGuardAfter.observed !== queryGuardAfter.matched ||
        queryGuardAfter.denied !== 0 ||
        !queryGuardAfter.interactionNotAllowed
      )
        throw new Error("Native fixture queried an unselected protected item");

      if (
        finalFence.interactionNotAllowed !== true ||
        networkServices().length !== 0 ||
        networkChildObserved
      )
        throw new Error("Native fixture queried from an unbound process");
      writeFileSync(
        config.report,
        JSON.stringify({
          phase,
          pid: process.pid,
          electronVersion: process.versions.electron,
          isPackaged: app.isPackaged,
          defaultApp: process.defaultApp === true,
          executableBasenameMatches:
            basename(process.execPath) === config.storageName,
          queryGuardBefore,
          queryGuardAfter,
          storageName: config.storageName,
          earlyFence,
          readyFence,
          finalFence,
          networkServices: networkServices().length,
          networkChildObserved,
          protectedStore: true,
          cookies,
          windowProof,
          legacyWindowBoundaryWorking,
          oldPreloadNoNativeStateKey,
          unexpectedRequests: config.unexpectedRequests,
        }),
        { mode: 0o600 },
      );

      for (const window of windows) window.destroy();
      const serverClosed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await serverClosed;
      app.quit();
    })
    .catch((error) => {
      writeFileSync(
        config.report,
        JSON.stringify({
          phase,
          failed: true,
          queryGuard: fence.queryGuard(),
          processFence: fence.fence(),
          noSafeStorageApiInvoked: inspectionOnly,
          reason:
            error instanceof Error ? error.message : "Native fixture failed",
        }),
        { mode: 0o600 },
      );
      app.exit(2);
    });
