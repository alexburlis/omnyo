import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it, onTestFinished } from "vitest";
import {
  createServerTargetStore,
  SERVER_TARGET_FILE_NAME,
  type ServerTargetFs,
} from "../src/server-target.js";

async function createStoragePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnyo-server-target-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return join(directory, SERVER_TARGET_FILE_NAME);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

const firstUrl = "http://localhost:4001";

const secondUrl = "http://localhost:4002";

const thirdUrl = "http://localhost:4003";

const connectServer = {
  handle: "laptop",
  name: "Laptop",
  url: "https://laptop.example.test",
};

it("uses the private remote target only for a new client and preserves saved target choices", async () => {
  const storagePath = await createStoragePath();
  const defaultCustomServerUrl = "https://app.example.invalid";

  const fresh = createServerTargetStore({
    storagePath,
    defaultCustomServerUrl,
  });

  await fresh.load();
  expect(fresh.getTarget()).toEqual({
    kind: "custom",
    url: defaultCustomServerUrl,
  });
  await expect(readFile(storagePath, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });

  for (const target of ["builtin", "custom", "connect"] as const) {
    await writeFile(
      storagePath,
      JSON.stringify({
        target,
        customServerUrl: firstUrl,
        customServerUrls: [firstUrl],
        connectServer,
      }),
      "utf8",
    );

    const selected = createServerTargetStore({
      storagePath,
      defaultCustomServerUrl,
    });

    await selected.load();
    expect(selected.getTarget()).toEqual(
      target === "builtin"
        ? { kind: "builtin" }
        : target === "custom"
          ? { kind: "custom", url: firstUrl }
          : { kind: "connect", server: connectServer },
    );
  }

  await writeFile(storagePath, "malformed existing settings", "utf8");

  const invalid = createServerTargetStore({
    storagePath,
    defaultCustomServerUrl,
  });

  await expect(invalid.load()).rejects.toThrow(
    "Desktop server target settings are invalid",
  );
});

it("moves saved private direct URLs without selecting a different mode or changing historical adoption receipts", async () => {
  const storagePath = await createStoragePath();

  const historical = {
    toOrigin: "https://app.example.invalid",
    mappingSha256: "a".repeat(64),
  };

  const document = {
    target: "builtin",
    customServerUrl: "https://app.example.invalid",
    customServerUrls: [
      "https://app.example.invalid",
      "https://app.example.invalid/projects/example?view=chat",
      "https://app.example.invalid.example",
      firstUrl,
    ],
    connectServer,
    omnyoOriginAdoptionV1: historical,
  };

  await writeFile(storagePath, JSON.stringify(document), "utf8");
  const store = createServerTargetStore({ storagePath });
  await store.load();
  expect(store.getTarget()).toEqual({ kind: "builtin" });
  expect(store.getConnectServer()).toEqual(connectServer);
  expect(store.getCustomServerUrl()).toBe("https://app.example.invalid");
  expect(store.getCustomServerUrls()).toEqual([
    "https://app.example.invalid",
    "https://app.example.invalid/projects/example?view=chat",
    "https://app.example.invalid.example",
    firstUrl,
  ]);
  const migrated = await readFile(storagePath, "utf8");
  expect(JSON.parse(migrated).omnyoOriginAdoptionV1).toEqual(historical);
  const reloaded = createServerTargetStore({ storagePath });
  await reloaded.load();
  expect(await readFile(storagePath, "utf8")).toBe(migrated);
  expect(await reloaded.setTarget("custom")).toBe(true);
  expect(reloaded.getTarget()).toEqual({
    kind: "custom",
    url: "https://app.example.invalid",
  });
});

it.each([
  {
    name: "legacy settings without a saved list",
    settings: { customServerUrl: firstUrl, target: "custom" },
    urls: [firstUrl, thirdUrl],
    connect: null,
  },
  {
    name: "unknown top-level settings",
    settings: {
      customServerUrl: firstUrl,
      customServerUrls: [firstUrl, secondUrl],
      target: "custom",
      futureSetting: true,
    },
    urls: [firstUrl, secondUrl, thirdUrl],
    connect: null,
  },
  {
    name: "unknown connect-server settings",
    settings: {
      connectServer: { ...connectServer, futureSetting: true },
      customServerUrl: firstUrl,
      customServerUrls: [firstUrl, secondUrl],
      target: "connect",
    },
    urls: [firstUrl, secondUrl, thirdUrl],
    connect: { ...connectServer, futureSetting: true },
  },
])(
  "preserves saved servers from $name when adding a server",
  async ({ settings, urls, connect }) => {
    const storagePath = await createStoragePath();
    await writeFile(storagePath, JSON.stringify(settings), "utf8");
    const store = createServerTargetStore({ storagePath });
    await store.load();
    expect(store.getTarget()).toEqual(
      connect === null
        ? { kind: "custom", url: firstUrl }
        : { kind: "connect", server: connect },
    );
    await store.setCustomServerUrl(thirdUrl);
    expect(JSON.parse(await readFile(storagePath, "utf8"))).toEqual({
      ...settings,
      connectServer: connect,
      customServerUrl: thirdUrl,
      customServerUrls: urls,
      target: "custom",
    });
    const reloaded = createServerTargetStore({ storagePath });
    await reloaded.load();
    expect(reloaded.getCustomServerUrls()).toEqual(urls);
    expect(reloaded.getTarget()).toEqual({ kind: "custom", url: thirdUrl });
  },
);

it.each([
  { customServerUrls: [42] },
  { target: "future-target" },
  { connectServer: { ...connectServer, handle: 42 } },
])("still rejects malformed known settings: %j", async (invalid) => {
  const storagePath = await createStoragePath();
  await writeFile(
    storagePath,
    JSON.stringify({
      customServerUrl: firstUrl,
      customServerUrls: [firstUrl, secondUrl],
      target: "custom",
      ...invalid,
    }),
    "utf8",
  );
  const store = createServerTargetStore({ storagePath });
  await store.load();
  expect(store.getCustomServerUrls()).toEqual([]);
  expect(store.getTarget()).toEqual({ kind: "builtin" });
});

it.each(["none", "mkdir", "writeFile"] as const)(
  "keeps the newest overlapping save after a delayed write with %s failure",
  async (failure) => {
    const storagePath = await createStoragePath();
    const entered = deferred();
    const release = deferred();
    let delayed = false;
    const directoryOperations: Promise<string | undefined>[] = [];
    let activeWrites = 0;
    let maximumActiveWrites = 0;

    const fs: ServerTargetFs = {
      async mkdir(path, options) {
        if (failure === "mkdir" && !delayed) {
          delayed = true;
          entered.resolve();
          await release.promise;
          throw new Error("mkdir failed");
        }

        const operation = mkdir(path, options);
        directoryOperations.push(operation);

        return operation;
      },
      readFile,
      async writeFile(path, data, encoding) {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);

        try {
          if (!delayed) {
            delayed = true;
            entered.resolve();
            await release.promise;

            if (failure === "writeFile") {
              throw new Error("writeFile failed");
            }
          }

          await writeFile(path, data, encoding);
        } finally {
          activeWrites -= 1;
        }
      },
    };

    const store = createServerTargetStore({ storagePath, fs });
    await store.load();
    const first = store.setCustomServerUrl(firstUrl);
    const firstResult = Promise.allSettled([first]);
    await entered.promise;
    const second = store.setCustomServerUrl(secondUrl);
    const third = store.setTarget("builtin");
    const laterResults = Promise.allSettled([second, third]);

    try {
      await Promise.all(directoryOperations);
      await setImmediate();
    } finally {
      release.resolve();
    }

    expect(await firstResult).toEqual([
      failure === "none"
        ? { status: "fulfilled", value: undefined }
        : { status: "rejected", reason: new Error(`${failure} failed`) },
    ]);
    expect(await laterResults).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: true },
    ]);
    expect(maximumActiveWrites).toBe(1);
    const reloaded = createServerTargetStore({ storagePath });
    await reloaded.load();
    expect(reloaded.getCustomServerUrls()).toEqual([firstUrl, secondUrl]);
    expect(reloaded.getCustomServerUrl()).toBe(secondUrl);
    expect(reloaded.getTarget()).toEqual({ kind: "builtin" });
  },
);

const admittedOrigin = {
  version: 1,
  adoptionId: "selected-origin-owner",
  fromOrigin: "https://bb.alexburlis.com",
  toOrigin: "https://app.example.invalid",
  serverHostId: "host-synthetic",
  runtimeId: "runtime-synthetic",
  selectedIds: ["a".repeat(64)],
  mappingSha256: "b".repeat(64),
  adoptionAccepted: true,
};

it("adopts only the fully admitted exact private origin and preserves opaque saved choices on the real filesystem", async () => {
  const storagePath = await createStoragePath();
  const unrelated = "https://custom.example/path?keep=1#opaque";

  const original = {
    target: "custom",
    customServerUrl: admittedOrigin.fromOrigin,
    customServerUrls: [admittedOrigin.fromOrigin, unrelated],
    connectServer: { ...connectServer, opaquePermission: { unchanged: true } },
    unknownWork: { stableIds: ["opaque-1", "opaque-2"], bytes: "unchanged" },
  };

  await writeFile(storagePath, JSON.stringify(original), "utf8");
  const store = createServerTargetStore({ storagePath });
  await store.load();
  expect(await store.adoptOriginV1(admittedOrigin)).toBe(true);
  expect(store.getTarget()).toEqual({
    kind: "custom",
    url: admittedOrigin.toOrigin,
  });
  expect(JSON.parse(await readFile(storagePath, "utf8"))).toEqual({
    ...original,
    customServerUrl: admittedOrigin.toOrigin,
    customServerUrls: [admittedOrigin.toOrigin, unrelated],
    omnyoOriginAdoptionV1: admittedOrigin,
  });
  await store.setCustomServerUrl("https://later-owner-choice.example");
  const later = await readFile(storagePath, "utf8");
  expect(await store.adoptOriginV1(admittedOrigin)).toBe(false);
  expect(await readFile(storagePath, "utf8")).toBe(later);
  expect(store.getTarget()).toEqual({
    kind: "custom",
    url: "https://later-owner-choice.example",
  });
});

it("refuses competing origins and unadmitted mappings before changing saved target bytes", async () => {
  const storagePath = await createStoragePath();

  const original = JSON.stringify({
    target: "custom",
    customServerUrl: admittedOrigin.fromOrigin,
    customServerUrls: [admittedOrigin.fromOrigin, admittedOrigin.toOrigin],
    opaque: "retain",
  });

  await writeFile(storagePath, original, "utf8");
  const store = createServerTargetStore({ storagePath });
  await store.load();
  const beforeAdoption = await readFile(storagePath, "utf8");
  await expect(
    store.adoptOriginV1({ ...admittedOrigin, adoptionAccepted: false }),
  ).rejects.toThrow();
  await expect(store.adoptOriginV1(admittedOrigin)).rejects.toThrow(
    "conflicts",
  );
  expect(await readFile(storagePath, "utf8")).toBe(beforeAdoption);
  expect(store.getTarget()).toEqual({
    kind: "custom",
    url: admittedOrigin.fromOrigin,
  });
});

it("migrates saved relay choices together and preserves unrelated targets and metadata", async () => {
  const storagePath = await createStoragePath();

  const saved = {
    target: "connect",
    connectServer: {
      handle: "alice",
      name: "Work",
      url: "https://alice.slashnew.com",
      extra: "kept",
    },
    customServerUrl: "https://second.stg.slashnew.com/path",
    customServerUrls: [
      "http://localhost:8080",
      "https://second.stg.slashnew.com/path",
      "https://a.slashnew.com.example",
    ],
    extra: "kept",
  };

  await writeFile(storagePath, JSON.stringify(saved));
  const store = createServerTargetStore({ storagePath });
  await store.load();
  expect(store.getTarget()).toEqual({
    kind: "connect",
    server: { ...saved.connectServer, url: "https://alice.omnyo.link" },
  });
  expect(store.getCustomServerUrls()).toEqual([
    "http://localhost:8080",
    "https://second.stg.omnyo.link/path",
    "https://a.slashnew.com.example",
  ]);
  const bytes = await readFile(storagePath, "utf8");
  expect(JSON.parse(bytes)).toMatchObject({
    extra: "kept",
    connectServer: { extra: "kept" },
  });
  await store.load();
  expect(await readFile(storagePath, "utf8")).toBe(bytes);
});
