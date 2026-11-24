import { once } from "node:events";
import { Server } from "node:http";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { startHttpListener } from "./http-listener.js";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  truncate,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOmnyoSdk, createHttpTransport } from "@omnyo/sdk/browser";
import { webBuildSchema, type WebBuild } from "@omnyo/server-contract";
import { ApiError } from "./errors.js";
import { registerWebUpdateRoutes } from "./routes/web-update.js";
import { registerStaticAppRoutes } from "./server.js";
import { WebUpdateService } from "./services/system/web-update.js";

const compatibilityHash = "a".repeat(64);

let directory: string;

let app: Hono;

let service: WebUpdateService;

let sdk: ReturnType<typeof createOmnyoSdk>;

let publicationBlocked = false;

let observePublication = () => {};

function build(label: string) {
  const files = new Map([
    [
      "index.html",
      `<!doctype html><p>${label}</p><script src="/assets/${label}.js"></script>`,
    ],
    [`assets/${label}.js`, `globalThis.build = "${label}";`],
  ]);

  const descriptor: WebBuild = {
    schema: 1,
    sourceCommit: label.repeat(40),
    compatibilityHash,
    files: [...files].map(([path, bytes]) => ({
      path,
      size: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };

  return { files, descriptor };
}

async function stage(label: string) {
  const candidate = build(label);
  const status = await sdk.system.webUpdateStatus();
  const expectedActive = status.active?.id ?? null;

  const { uploadId } = await sdk.system.webUpdateBegin({
    build: candidate.descriptor,
    expectedActive,
  });

  for (const [path, bytes] of candidate.files)
    await sdk.system.webUpdateUpload({
      uploadId,
      path,
      content: Buffer.from(bytes).toString("base64"),
    });

  return { uploadId, expectedActive };
}

beforeEach(async () => {
  publicationBlocked = false;
  observePublication = () => {};

  directory = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-web-update-")),
  );
  const baseline = join(directory, "packaged");
  await mkdir(baseline);
  await writeFile(join(baseline, "index.html"), "packaged interface");
  await writeFile(
    join(baseline, "web-build.json"),
    JSON.stringify(build("a").descriptor),
  );
  service = new WebUpdateService(directory, baseline, () => {
    observePublication();

    return publicationBlocked;
  });
  app = new Hono();
  app.onError((error, context) =>
    context.json(
      { error: { code: "failed", message: error.message } },
      error instanceof ApiError ? error.status : 500,
    ),
  );
  const api = new Hono();
  registerWebUpdateRoutes(api, service);
  app.route("/api/v1", api);
  registerStaticAppRoutes(app, baseline, [], service);
  sdk = createOmnyoSdk({
    transport: createHttpTransport({
      baseUrl: "http://omnyo.test",
      runtime: "node",
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    }),
  });
});

afterEach(async () => rm(directory, { recursive: true, force: true }));

it("reuses validated packaged metadata across concurrent and warm static requests", async () => {
  const parse = vi.spyOn(webBuildSchema, "parse");

  try {
    const concurrent = await Promise.all(
      Array.from({ length: 20 }, () => app.request("/")),
    );

    const warm = await app.request("/");

    for (const response of [...concurrent, warm]) {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("packaged interface");
    }

    expect(parse).toHaveBeenCalledTimes(1);
  } finally {
    parse.mockRestore();
  }
});

it("rejects changed invalid packaged metadata and recovers without stale cached success", async () => {
  const path = join(directory, "packaged", "web-build.json");
  const bytes = JSON.stringify(build("a").descriptor);
  expect((await service.status()).supported).toBe(true);

  await writeFile(path, "{");
  await expect(service.status()).rejects.toThrow();
  await writeFile(path, bytes);
  expect((await service.status()).supported).toBe(true);

  await rm(path);
  expect((await service.status()).supported).toBe(false);
  await writeFile(path, bytes);
  expect((await service.status()).supported).toBe(true);

  const target = join(directory, "foreign-build.json");
  await writeFile(target, bytes);
  await rm(path);
  await symlink(target, path);
  await expect(service.status()).rejects.toThrow("Web update file is invalid");
  await rm(path);
  await writeFile(path, bytes);
  expect((await service.status()).supported).toBe(true);
});

it("switches the live HTTP shell without restart, revokes uploads, preserves old assets and rolls back", async () => {
  const oldEtag = (await app.request("/")).headers.get("etag");
  const first = await stage("b");
  expect(await (await app.request("/")).text()).toBe("packaged interface");
  const published = await sdk.system.webUpdateApply(first);

  const response = await app.request("/threads/current", {
    headers: { "if-none-match": oldEtag ?? "" },
  });

  expect(response.status).toBe(200);
  expect(await response.text()).toContain("<p>b</p>");
  expect(response.headers.get("x-omnyo-web-source")).toBe("b".repeat(40));
  await expect(
    sdk.system.webUpdateUpload({
      uploadId: first.uploadId,
      path: "index.html",
      content: "",
    }),
  ).rejects.toThrow();
  await sdk.system.webUpdateRollback({
    expectedActive: published.active?.id ?? null,
  });
  expect(await (await app.request("/")).text()).toBe("packaged interface");
  await sdk.system.webUpdateApply(await stage("c"));
  await sdk.system.webUpdateApply(await stage("d"));
  const retained = await app.request("/assets/b.js");
  expect(await retained.text()).toBe(build("b").files.get("assets/b.js"));
  expect(retained.headers.get("x-omnyo-web-source")).toBeNull();
  const current = await sdk.system.webUpdateStatus();
  await sdk.system.webUpdateRollback({
    expectedActive: current.active?.id ?? null,
  });
  expect(await (await app.request("/")).text()).toContain("<p>c</p>");
  expect(
    (
      await new WebUpdateService(
        directory,
        join(directory, "packaged"),
      ).status()
    ).active?.sourceCommit,
  ).toBe("c".repeat(40));
});

it("does not reserve an upload after the begin request disconnects during admission", async () => {
  const controller = new AbortController();
  const started = createDeferredPromise<void>();
  const resume = createDeferredPromise<void>();
  const status = await service.status();

  vi.spyOn(service, "status").mockImplementationOnce(async () => {
    started.resolve();
    await resume.promise;

    return status;
  });

  const server = startHttpListener({
    fetch: app.fetch,
    logger: { info: vi.fn() },
    serverConfig: { OMNYO_SERVER_BIND_HOST: "127.0.0.1", OMNYO_SERVER_PORT: 0 },
  });

  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();

    if (!address || typeof address === "string" || !(server instanceof Server))
      throw new Error("Expected a TCP listener");

    const closed = new Promise<void>((resolve) => {
      server.once("request", (_request, response) =>
        response.once("close", resolve),
      );
    });

    const response = fetch(
      `http://127.0.0.1:${address.port}/api/v1/system/web-update/begin`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedActive: null,
          build: build("b").descriptor,
        }),
        signal: controller.signal,
      },
    );

    await started.promise;
    controller.abort();
    await expect(response).rejects.toThrow();
    await closed;
    resume.resolve();
    await service.flush();

    const first = await stage("b");
    const second = await stage("c");
    expect(
      (await readdir(join(directory, "private-web-updates", "staging"))).sort(),
    ).toEqual([first.uploadId, second.uploadId].sort());
  } finally {
    controller.abort();
    resume.resolve();

    if (server instanceof Server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("rejects incomplete, changed, unsafe and incompatible uploads while retaining the previous shell", async () => {
  const candidate = build("b").descriptor;
  await expect(
    sdk.system.webUpdateBegin({
      build: { ...candidate, compatibilityHash: "c".repeat(64) },
      expectedActive: null,
    }),
  ).rejects.toThrow();

  const session = await sdk.system.webUpdateBegin({
    build: candidate,
    expectedActive: null,
  });

  await expect(
    sdk.system.webUpdateUpload({
      ...session,
      path: "index.html",
      content: Buffer.from("changed").toString("base64"),
    }),
  ).rejects.toThrow();
  await expect(
    sdk.system.webUpdateApply({ ...session, expectedActive: null }),
  ).rejects.toThrow();

  const response = await app.request("/api/v1/system/web-update/begin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      build: {
        ...candidate,
        files: [{ path: "../index.html", size: 1, sha256: "a".repeat(64) }],
      },
      expectedActive: null,
    }),
  });

  expect(response.status).toBe(400);
  await sdk.system.webUpdateAbort(session);
  expect(await (await app.request("/")).text()).toBe("packaged interface");
});

it("rejects competing publication and leaves the winning generation active", async () => {
  const first = await stage("b");
  const second = await stage("c");
  await sdk.system.webUpdateApply(first);
  await expect(sdk.system.webUpdateApply(second)).rejects.toThrow();
  expect(await (await app.request("/")).text()).toContain("<p>b</p>");
  await sdk.system.webUpdateAbort({ uploadId: second.uploadId });
});

it("keeps delivered fixes while runtime restart fences queued and in-flight publication", async () => {
  await sdk.system.webUpdateApply(await stage("b"));
  const candidate = await stage("c");
  let started = () => {};

  const admitted = new Promise<void>((resolve) => {
    started = resolve;
  });

  observePublication = started;
  const applying = sdk.system.webUpdateApply(candidate);
  await admitted;
  publicationBlocked = true;
  const rejected = expect(applying).rejects.toThrow("runtime is restarting");
  await service.flush();
  await rejected;
  expect(await (await app.request("/")).text()).toContain("<p>b</p>");
  const status = await sdk.system.webUpdateStatus();
  await expect(
    sdk.system.webUpdateRollback({ expectedActive: status.active?.id ?? null }),
  ).rejects.toThrow("runtime is restarting");
  expect(await (await app.request("/")).text()).toContain("<p>b</p>");
  publicationBlocked = false;
  await sdk.system.webUpdateRollback({
    expectedActive: status.active?.id ?? null,
  });
  expect(await (await app.request("/")).text()).toBe("packaged interface");
});

it("deactivates incompatible overlays on a core update and refuses machine credentials", async () => {
  await sdk.system.webUpdateApply(await stage("b"));
  await writeFile(
    join(directory, "packaged", "web-build.json"),
    JSON.stringify({
      ...build("a").descriptor,
      sourceCommit: "e".repeat(40),
    }),
  );
  expect((await sdk.system.webUpdateStatus()).inactiveReason).toContain(
    "runtime changed",
  );
  expect(await (await app.request("/")).text()).toBe("packaged interface");
  expect((await app.request("/assets/b.js")).status).toBe(200);

  const response = await app.request("/api/v1/system/web-update", {
    headers: { "x-omnyo-gate-auth": "machine" },
  });

  expect(response.status).toBe(403);
});

it("retires an owned abandoned upload after a coordinator restart", async () => {
  const abandoned = await sdk.system.webUpdateBegin({
    build: build("b").descriptor,
    expectedActive: null,
  });

  const recovered = new WebUpdateService(
    directory,
    join(directory, "packaged"),
  );

  const next = await recovered.begin({
    build: build("c").descriptor,
    expectedActive: null,
  });

  await expect(
    stat(join(directory, "private-web-updates", "staging", abandoned.uploadId)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await recovered.abort(next.uploadId);
});

it("emits a canonical versioned upload owner in the existing reserved journal", async () => {
  const session = await sdk.system.webUpdateBegin({
    build: build("b").descriptor,
    expectedActive: null,
  });

  const markerPath = join(
    directory,
    "private-web-updates/staging",
    session.uploadId,
    ".upload.json",
  );

  const raw = await readFile(markerPath, "utf8");
  const marker = JSON.parse(raw);
  expect(marker).toEqual({
    schema: 1,
    owner: "omnyo-private-web-upload",
    uploadId: session.uploadId,
    createdAt: expect.any(Number),
  });
  expect(raw).toBe(JSON.stringify(marker));
  await sdk.system.webUpdateAbort(session);
});

it("preflights every upload owner before retiring abandoned staging or inactive generations", async () => {
  const first = await sdk.system.webUpdateApply(await stage("b"));
  await app.request("/threads/retention-client");
  await sdk.system.webUpdateApply(await stage("c"));
  const active = await sdk.system.webUpdateApply(await stage("d"));

  const abandoned = await sdk.system.webUpdateBegin({
    build: build("e").descriptor,
    expectedActive: active.active?.id ?? null,
  });

  const canonical = await sdk.system.webUpdateBegin({
    build: build("f").descriptor,
    expectedActive: active.active?.id ?? null,
  });

  const stagingRoot = join(directory, "private-web-updates/staging");
  const abandonedPath = join(stagingRoot, abandoned.uploadId, ".upload.json");
  const canonicalPath = join(stagingRoot, canonical.uploadId, ".upload.json");
  const abandonedRaw = await readFile(abandonedPath, "utf8");
  const canonicalRaw = await readFile(canonicalPath, "utf8");

  const foreignRaw = JSON.stringify({
    owner: "foreign-web-upload",
    createdAt: JSON.parse(abandonedRaw).createdAt,
  });

  await writeFile(canonicalPath, foreignRaw);
  const statePath = join(directory, "private-web-updates/active.json");
  const state = await readFile(statePath);

  const oldGeneration = join(
    directory,
    "private-web-updates/generations",
    first.active?.id ?? "missing",
  );

  const recovered = new WebUpdateService(
    directory,
    join(directory, "packaged"),
  );

  const nextInput = {
    build: build("b").descriptor,
    expectedActive: active.active?.id ?? null,
  };

  await expect(recovered.begin(nextInput)).rejects.toThrow();
  expect(await readFile(abandonedPath, "utf8")).toBe(abandonedRaw);
  expect(await readFile(canonicalPath, "utf8")).toBe(foreignRaw);
  expect(await readFile(statePath)).toEqual(state);
  expect((await stat(oldGeneration)).isDirectory()).toBe(true);
  await writeFile(canonicalPath, canonicalRaw);
  const next = await recovered.begin(nextInput);
  await expect(
    stat(join(stagingRoot, abandoned.uploadId)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    stat(join(stagingRoot, canonical.uploadId)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(statePath)).toEqual(state);
  await recovered.abort(next.uploadId);
});

it.each(["malformed", "foreign", "version", "id", "time"])(
  "refuses %s journal ownership before upload, apply or abort writes",
  async (kind) => {
    const candidate = build("b");

    const session = await sdk.system.webUpdateBegin({
      build: candidate.descriptor,
      expectedActive: null,
    });

    const staging = join(
      directory,
      "private-web-updates/staging",
      session.uploadId,
    );

    const markerPath = join(staging, ".upload.json");
    const originalRaw = await readFile(markerPath, "utf8");
    const marker = JSON.parse(originalRaw);

    const invalid =
      kind === "malformed"
        ? "{"
        : kind === "foreign"
          ? JSON.stringify({
              owner: "foreign-web-upload",
              createdAt: marker.createdAt,
            })
          : kind === "version"
            ? JSON.stringify({ ...marker, schema: 2 })
            : kind === "id"
              ? JSON.stringify({
                  ...marker,
                  uploadId: "00000000-0000-4000-8000-000000000001",
                })
              : JSON.stringify({
                  ...marker,
                  createdAt: marker.createdAt + 1,
                });

    await writeFile(markerPath, invalid);
    await expect(
      sdk.system.webUpdateUpload({
        uploadId: session.uploadId,
        path: "index.html",
        content: Buffer.from(candidate.files.get("index.html") ?? "").toString(
          "base64",
        ),
      }),
    ).rejects.toThrow(/marker|ownership/u);
    expect(await readdir(staging)).toEqual([".upload.json"]);
    await expect(
      sdk.system.webUpdateApply({ ...session, expectedActive: null }),
    ).rejects.toThrow(/marker|ownership/u);
    await expect(sdk.system.webUpdateAbort(session)).rejects.toThrow(
      /marker|ownership/u,
    );
    expect(await readFile(markerPath, "utf8")).toBe(invalid);
    expect(await (await app.request("/")).text()).toBe("packaged interface");
    await writeFile(markerPath, originalRaw);
    await sdk.system.webUpdateAbort(session);
  },
);

it("keeps a browser generation across restarts until its explicit client release", async () => {
  await sdk.system.webUpdateApply(await stage("b"));
  const response = await app.request("/threads/client");
  const shell = await response.text();

  const releasePath = /\/_omnyo\/web-client\/[a-f0-9-]+\/release/u.exec(
    shell,
  )?.[0];

  expect(releasePath).toBeDefined();
  await sdk.system.webUpdateApply(await stage("c"));
  await sdk.system.webUpdateApply(await stage("d"));

  const recovered = new WebUpdateService(
    directory,
    join(directory, "packaged"),
  );

  const lease = await recovered.begin({
    build: build("e").descriptor,
    expectedActive: (await recovered.status()).active?.id ?? null,
  });

  await recovered.abort(lease.uploadId);
  expect((await app.request("/assets/b.js")).status).toBe(200);

  if (!releasePath) throw new Error("The browser lease was not issued");
  expect((await app.request(releasePath, { method: "POST" })).status).toBe(204);

  const next = await recovered.begin({
    build: build("e").descriptor,
    expectedActive: (await recovered.status()).active?.id ?? null,
  });

  await recovered.abort(next.uploadId);
  expect((await app.request("/assets/b.js")).status).toBe(404);
  expect((await app.request("/assets/c.js")).status).toBe(200);
});

it.each([
  { path: "assets/unknown.js" },
  { sha256: "0".repeat(64) },
  { size: 0 },
])(
  "checks every owned asset against its generation manifest before staging",
  async (change) => {
    const { active } = await sdk.system.webUpdateApply(await stage("b"));

    if (!active) throw new Error("Expected a published generation");
    const root = join(directory, "private-web-updates");

    const marker = join(
      root,
      "generations",
      active.id,
      ".generation-owner.json",
    );

    const record = JSON.parse(await readFile(marker, "utf8"));
    Object.assign(record.assets[0], change);
    await writeFile(marker, JSON.stringify(record));

    await expect(stage("c")).rejects.toThrow(
      "asset ownership differs from its build manifest",
    );
    expect(await readdir(join(root, "staging"))).toEqual([]);
    expect(await readFile(join(root, "public", "assets/b.js"), "utf8")).toBe(
      build("b").files.get("assets/b.js"),
    );
  },
);

it("protects legacy assets and blocks allocation at its finite store budget", async () => {
  const assets = join(directory, "private-web-updates", "public", "assets");
  await mkdir(assets, { recursive: true });
  const legacy = join(assets, "legacy.dat");
  await writeFile(legacy, "unknown historical client");
  await sdk.system.webUpdateApply(await stage("b"));
  await sdk.system.webUpdateApply(await stage("c"));
  await sdk.system.webUpdateApply(await stage("d"));
  const next = await stage("e");
  await sdk.system.webUpdateAbort({ uploadId: next.uploadId });
  expect(await readFile(legacy, "utf8")).toBe("unknown historical client");
  const link = join(assets, "foreign-link");
  await symlink(legacy, link);
  await expect(stage("e")).rejects.toThrow("unknown symbolic link");
  expect(await readFile(link, "utf8")).toBe("unknown historical client");
  await rm(link);
  await truncate(legacy, 4 * 1024 ** 3);
  await expect(stage("e")).rejects.toThrow("storage is full");
  expect(
    await readdir(join(directory, "private-web-updates", "staging")),
  ).toEqual([]);
});
