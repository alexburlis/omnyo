const { app, safeStorage } = require("electron");

const { writeFileSync } = require("node:fs");

const { createHash } = require("node:crypto");

const { join, basename } = require("node:path");

const config = require("./selection.json");

const fence = require(join(process.resourcesPath, "keychain-ui-fence.node"));

if (
  config.protectedStoreCapability !== false ||
  !["synthetic-default-deny", "configured-name-default-deny-v1"].includes(
    config.purpose,
  ) ||
  (config.purpose === "configured-name-default-deny-v1" &&
    ((config.role === "legacy" && config.storageName !== "BB Private") ||
      (config.role === "target" && config.storageName !== "Omnyo Private") ||
      !["legacy", "target"].includes(config.role)))
)
  app.exit(7);

app.setName(config.storageName);

app.setActivationPolicy("prohibited");

app.setPath("userData", config.namespaceProfile);

app.commandLine.appendSwitch("disable-background-networking");

app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2");

const early = fence.fence();

const beforeReady = fence.queryGuard();

if (
  !beforeReady.defaultDeny ||
  beforeReady.forwarded !== 0 ||
  !early.interactionNotAllowed
)
  app.exit(8);

app
  .whenReady()
  .then(async () => {
    if (
      !app.isPackaged ||
      basename(process.execPath) !== config.storageName ||
      process.defaultApp === true ||
      process.argv.length !== 1
    )
      throw new Error("Actual packaged entry binding differs");
    const before = fence.queryGuard();

    if (
      !before.defaultDeny ||
      before.forwarded !== 0 ||
      app.commandLine.hasSwitch("use-mock-keychain")
    )
      throw new Error("Namespace query boundary changed");
    const synchronousAvailable = safeStorage.isEncryptionAvailable();
    const afterSync = fence.queryGuard();

    const asynchronousAvailable =
      await safeStorage.isAsyncEncryptionAvailable();

    const afterAsync = fence.queryGuard();
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    const reports = [beforeReady, before, afterSync, afterAsync];

    if (
      reports.some(
        (value) =>
          !value.defaultDeny ||
          value.writesAllowed ||
          !value.interactionNotAllowed ||
          value.processId !== process.pid ||
          value.forwarded !== 0 ||
          value.forwardedReads !== 0 ||
          value.forwardedMutations !== 0 ||
          value.denied !== value.observed,
      )
    )
      throw new Error("A configured namespace query escaped the deny boundary");

    const observedQueries = [afterSync, afterAsync].filter(
      (value) => value.observed > before.observed,
    );

    const helperNamespaceMatches =
      observedQueries.length > 0 &&
      observedQueries.every(
        (value) =>
          value.genericPassword &&
          value.defaultBackend &&
          value.serviceIsString &&
          value.accountIsString &&
          value.serviceSha256 === hash(config.storageName + " Safe Storage") &&
          value.accountSha256 === hash(config.storageName + " Key"),
      );

    writeFileSync(
      config.report,
      JSON.stringify({
        version: 1,
        phase: "default-deny-namespace-attestation",
        purpose: config.purpose,
        role: config.role,
        protectedStoreCapability: false,
        helperNamespaceMatches,
        protectedQueriesForwarded: 0,
        processId: process.pid,
        appNameMatches: app.getName() === config.storageName,
        isPackaged: app.isPackaged,
        executableBasenameMatches:
          basename(process.execPath) === config.storageName,
        defaultApp: process.defaultApp === true,
        entryArgumentCount: process.argv.length,
        mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"),
        synchronousAvailable,
        asynchronousAvailable,
        beforeReady,
        before,
        afterSync,
        afterAsync,
        networkServices: app
          .getAppMetrics()
          .filter(
            (entry) =>
              entry.type === "Utility" &&
              /network/iu.test(entry.serviceName || entry.name || ""),
          ).length,
      }),
      { mode: 0o600 },
    );

    if (
      synchronousAvailable ||
      afterAsync.forwarded !== 0 ||
      afterAsync.observed === 0
    )
      throw new Error(
        "Default-deny guard did not witness actual crypto queries",
      );
    app.exit(0);
  })
  .catch(() => app.exit(9));
