import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { WebBuild } from "@omnyo/server-contract";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { registerStaticAppRoutes } from "./server.js";
import { WebUpdateService } from "./services/system/web-update.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();

  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

function build(label: string) {
  const files = new Map([
    ["index.html", `<!doctype html><p>${label}</p>`],
    [`assets/${label}.js`, `globalThis.build = "${label}";`],
  ]);

  const descriptor: WebBuild = {
    schema: 1,
    sourceCommit: label.repeat(40),
    compatibilityHash: "a".repeat(64),
    files: [...files].map(([path, content]) => ({
      path,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  };

  return { files, descriptor };
}

it("serves published assets during a held upload while serializing new browser leases", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-static-reads-")),
  );

  const baseline = join(directory, "packaged");
  const packaged = build("a");
  const releaseWrite = createDeferredPromise<void>();
  let uploading: Promise<unknown> | null = null;
  let shell: Promise<Response> | null = null;
  let asset: Promise<Response> | null = null;

  try {
    for (const [path, content] of packaged.files) {
      const destination = join(baseline, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }

    await writeFile(
      join(baseline, "web-build.json"),
      JSON.stringify(packaged.descriptor),
    );

    const service = new WebUpdateService(directory, baseline);
    const app = new Hono();
    registerStaticAppRoutes(app, baseline, [], service);

    async function stage(label: string) {
      const candidate = build(label);
      const expectedActive = (await service.status()).active?.id ?? null;

      const session = await service.begin({
        build: candidate.descriptor,
        expectedActive,
      });

      for (const [path, content] of candidate.files)
        await service.upload({
          ...session,
          path,
          content: Buffer.from(content).toString("base64"),
        });

      return { ...session, expectedActive };
    }

    const published = await service.apply(await stage("b"));

    const session = await service.begin({
      build: build("c").descriptor,
      expectedActive: published.active?.id ?? null,
    });

    const writeStarted = createDeferredPromise<void>();

    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );

    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      writeStarted.resolve();
      await releaseWrite.promise;
      await actual.writeFile(...args);
    });

    uploading = service.upload({
      ...session,
      path: "index.html",
      content: Buffer.from(build("c").files.get("index.html") ?? "").toString(
        "base64",
      ),
    });
    await writeStarted.promise;
    let shellSettled = false;

    shell = Promise.resolve(app.request("/threads/current")).then(
      (response) => {
        shellSettled = true;

        return response;
      },
    );

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      asset = Promise.resolve(app.request("/assets/b.js"));

      const response = await Promise.race([
        asset,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Static read waited for the held upload")),
            1500,
          );
        }),
      ]);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(build("b").files.get("assets/b.js"));
      expect(shellSettled).toBe(false);
    } finally {
      clearTimeout(timer);
      releaseWrite.resolve();
    }

    await uploading;
    expect(await (await shell).text()).toContain("<p>b</p>");
    await service.abort(session.uploadId);

    const next = await service.apply(await stage("d"));
    expect(await (await app.request("/threads/current")).text()).toContain(
      "<p>d</p>",
    );
    await service.rollback({ expectedActive: next.active?.id ?? null });
    expect(await (await app.request("/threads/current")).text()).toContain(
      "<p>b</p>",
    );
    expect(await (await app.request("/assets/d.js")).text()).toBe(
      build("d").files.get("assets/d.js"),
    );
    expect(await readFile(join(baseline, "index.html"), "utf8")).toBe(
      packaged.files.get("index.html"),
    );
  } finally {
    releaseWrite.resolve();
    await Promise.allSettled([uploading, shell, asset]);
    vi.mocked(writeFile).mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
