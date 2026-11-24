const { app, safeStorage, session } = require("electron");

const { readFileSync, writeFileSync } = require("node:fs");

const { join, resolve } = require("node:path");

const { createHash } = require("node:crypto");

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));

app.setName(
  config.storageName ||
    config.applicationName ||
    "Omnyo Profile Continuity Fixture",
);

app.setActivationPolicy("prohibited");

app.commandLine.appendSwitch("disable-background-networking");

app.setPath("userData", resolve(config.profile));

if (!app.requestSingleInstanceLock()) app.exit(3);

app
  .whenReady()
  .then(async () => {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("protected storage unavailable");

    const partition = session.fromPartition(
      config.mode === "seed" ? "persist:bb-browser" : "persist:omnyo-browser",
    );

    const file = join(config.profile, "profile-protected-fixture.bin");

    if (config.mode === "seed") {
      writeFileSync(
        file,
        safeStorage.encryptString("synthetic profile continuity"),
        { mode: 0o600 },
      );
      await partition.cookies.set({
        url: "http://127.0.0.1/",
        name: "profile-fixture",
        value: "synthetic session continuity",
        expirationDate: 2000000000,
      });
      const unknown = session.fromPartition("persist:unknown-fixture");
      await unknown.cookies.set({
        url: "http://127.0.0.1/",
        name: "unknown-fixture",
        value: "synthetic unknown partition",
        expirationDate: 2000000000,
      });
      await unknown.cookies.flushStore();
      await partition.cookies.flushStore();
      partition.flushStorageData();
      writeFileSync(
        config.report,
        JSON.stringify({ seed: true, pid: process.pid }),
      );
    } else {
      if (!config.profile.endsWith("/profile-probe"))
        throw new Error("probe owner differs");

      const protectedStore =
        safeStorage.decryptString(readFileSync(file)) ===
        "synthetic profile continuity";

      const cookies = await partition.cookies.get({
        url: "http://127.0.0.1/",
        name: "profile-fixture",
      });

      const preserved =
        cookies.length === 1 &&
        cookies[0].value === "synthetic session continuity";

      await require(config.storageModule).initializeDesktopProfileStorageV1({
        storageName: config.storageName,
        applicationName: config.applicationName,
        encryption: safeStorage,
        async initializeCookies() {
          await partition.cookies.get({});
        },
        setDisplayName(value) {
          app.setName(value);
        },
      });

      const afterRename = await partition.cookies.get({
        url: "http://127.0.0.1/",
        name: "profile-fixture",
      });

      if (
        safeStorage.decryptString(readFileSync(file)) !==
          "synthetic profile continuity" ||
        afterRename.length !== 1 ||
        afterRename[0].value !== "synthetic session continuity"
      )
        throw new Error("protected owner changed after display rename");

      const unknownCookies = await session
        .fromPartition("persist:unknown-fixture")
        .cookies.get({ url: "http://127.0.0.1/", name: "unknown-fixture" });

      if (
        unknownCookies.length !== 1 ||
        unknownCookies[0].value !== "synthetic unknown partition"
      )
        throw new Error("unknown partition continuity differs");

      if (!protectedStore || !preserved)
        throw new Error("native continuity differs");
      writeFileSync(
        config.report,
        JSON.stringify({
          protectedStore: true,
          cookies: true,
          unknownCookies: true,
          executableSha256: createHash("sha256")
            .update(readFileSync(process.execPath))
            .digest("hex"),
          storageName: config.storageName,
          pid: process.pid,
        }),
      );
    }

    app.quit();
  })
  .catch(() => {
    writeFileSync(config.report, JSON.stringify({ failed: true }));
    app.exit(2);
  });
