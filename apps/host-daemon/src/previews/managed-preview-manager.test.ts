import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedPreviewLaunch } from "@omnyo/host-daemon-contract";
import { ManagedPreviewManager } from "./managed-preview-manager.js";
import * as listeners from "./listeners.js";

const managers: ManagedPreviewManager[] = [];

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
          server.closeAllConnections();
        }),
    ),
  );
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListening) =>
    server.listen(0, "127.0.0.1", resolveListening),
  );
  const address = server.address();

  if (address === null || typeof address === "string")
    throw new Error("No fixture port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));

  return address.port;
}

function fixture(port: number): ManagedPreviewLaunch {
  const source = `
const { createServer } = require('node:http');
let ready = true;
let readinessChecks = 0;
const server = createServer((request, response) => {
  if (request.url === '/__checks') { response.end(JSON.stringify(readinessChecks)); return; }
  if (request.url.startsWith('/compare/')) readinessChecks++;
  if (request.url === '/__stop') {
    response.end('stopping');
    server.close(() => process.exit(0));
    server.closeAllConnections();
    return;
  }
  if (request.url === '/__fail') { ready = false; response.end('failed'); return; }
  response.statusCode = ready ? 200 : 500;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ cwd: process.cwd(), path: request.url, unapproved: 'PREVIEW_UNAPPROVED' in process.env }));
});
server.listen(${port}, '127.0.0.1');
`;

  return {
    id: `prv_fixture_${port}`,
    projectId: "proj_fixture",
    environmentId: "env_fixture",
    cwd: realpathSync(tmpdir()),
    argv: [process.execPath, "-e", source],
    protocol: "http:",
    hostname: "127.0.0.1",
    port,
    readinessPath: "/compare/superwhisper?fixture=1",
  };
}

function manager() {
  const active: string[] = [];
  const retained = new Set<string>();

  const instance = new ManagedPreviewManager({
    shellEnv: () => ({
      PATH: process.env.PATH,
      PREVIEW_UNAPPROVED: "not-forwarded",
    }),
    markActive: (_environmentId, id) => {
      active.push(id);
      retained.add(id);
    },
    markInactive: (_environmentId, id) => {
      retained.delete(id);
    },
  });

  managers.push(instance);

  return { instance, active, retained };
}

describe("ManagedPreviewManager", () => {
  it("starts the exact command and cwd once for concurrent desktop and phone requests", async () => {
    const preview = fixture(await freePort());
    const { instance, active, retained } = manager();
    expect((await instance.status(preview)).state).toBe("stopped");

    const desktop = instance.ensure(preview, []);
    const phone = instance.ensure(preview, []);
    const admitted = instance.activityCount();
    const retainedDuringStart = retained.has(preview.id);
    const results = await Promise.all([desktop, phone]);
    expect(admitted).toBe(1);
    expect(retainedDuringStart).toBe(true);

    expect(results.map((result) => result.state)).toEqual(["online", "online"]);
    expect(results[0]?.runId).toBe(results[1]?.runId);
    expect(active).toEqual([preview.id]);
    expect(instance.activityCount()).toBe(1);

    const response = await fetch(
      `http://127.0.0.1:${preview.port}/compare/superwhisper?fixture=1`,
    );

    expect(await response.json()).toEqual({
      cwd: realpathSync(tmpdir()),
      path: "/compare/superwhisper?fixture=1",
      unapproved: false,
    });
  });

  it("coalesces live readiness for concurrent assets without caching later checks", async () => {
    const preview = fixture(await freePort());
    const { instance } = manager();
    const started = await instance.ensure(preview, []);
    expect(started.state).toBe("online");
    const runId = started.runId;

    if (runId === null) throw new Error("Missing owned fixture run");

    const checks = async () => {
      const response = await fetch(`http://127.0.0.1:${preview.port}/__checks`);

      return Number(await response.json());
    };

    const before = await checks();
    const pending = instance.status(preview);

    const targets = await Promise.all(
      Array.from({ length: 8 }, () =>
        instance.resolveTarget(preview.id, runId),
      ),
    );

    await instance.validateSocketOwner(preview.id, runId);
    expect((await pending).state).toBe("online");
    expect(targets).toHaveLength(8);
    expect(await checks()).toBe(before + 1);
    await instance.resolveTarget(preview.id, runId);
    expect(await checks()).toBe(before + 2);
    await fetch(`http://127.0.0.1:${preview.port}/__fail`);

    await expect(instance.resolveTarget(preview.id, runId)).rejects.toThrow(
      "not available",
    );
  });

  it("rejects socket use when listener inspection is unknown and checks fresh on the next call", async () => {
    const preview = fixture(await freePort());
    const { instance } = manager();
    const started = await instance.ensure(preview, []);
    expect(started.state).toBe("online");

    if (started.runId === null) throw new Error("Missing owned fixture run");

    const inspector = vi
      .spyOn(listeners, "inspectPreviewListeners")
      .mockRejectedValueOnce(
        new listeners.PreviewInspectionError("parents", 1000, "timeout"),
      );

    try {
      await expect(
        instance.validateSocketOwner(preview.id, started.runId),
      ).rejects.toThrow("ownership could not be checked");
    } finally {
      inspector.mockRestore();
    }

    await instance.validateSocketOwner(preview.id, started.runId);
  });

  it("restores the same port and path after its owned fixture exits", async () => {
    const preview = fixture(await freePort());
    const { instance, active } = manager();
    const before = await instance.ensure(preview, []);
    expect(before.state).toBe("online");
    await fetch(`http://127.0.0.1:${preview.port}/__stop`).catch(
      () => undefined,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    expect((await instance.status(preview)).state).toBe("stopped");
    const after = await instance.ensure(preview, []);
    expect(after.state).toBe("online");
    expect(after.runId).not.toBe(before.runId);
    await expect(
      instance.validateSocketOwner(preview.id, before.runId ?? "missing"),
    ).rejects.toThrow("not available");
    await instance.validateSocketOwner(preview.id, after.runId ?? "missing");
    expect(active).toEqual([preview.id, preview.id]);
    await expect(
      instance.resolveTarget(preview.id, before.runId ?? "missing"),
    ).rejects.toThrow("not available");
  });

  it("leaves an unrelated process on the port untouched", async () => {
    const server = createServer((_request, response) =>
      response.end("foreign"),
    );

    servers.push(server);
    await new Promise<void>((resolveListening) =>
      server.listen(0, "127.0.0.1", resolveListening),
    );
    const address = server.address();

    if (address === null || typeof address === "string")
      throw new Error("No fixture port");
    const preview = fixture(address.port);
    const { instance, retained } = manager();
    expect((await instance.status(preview)).state).toBe("conflict");
    expect((await instance.ensure(preview, [])).state).toBe("conflict");
    expect(instance.activityCount()).toBe(0);
    expect(retained.size).toBe(0);
    expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe(
      "foreign",
    );
  });

  it("does not adopt a live process after the daemon loses its ChildProcess identity", async () => {
    const preview = fixture(await freePort());
    const owner = manager();
    const first = await owner.instance.ensure(preview, []);
    expect(first.state).toBe("online");
    const reloaded = manager();
    expect((await reloaded.instance.status(preview)).state).toBe("conflict");
    expect((await reloaded.instance.ensure(preview, [])).state).toBe(
      "conflict",
    );
    expect(reloaded.instance.activityCount()).toBe(0);
    expect(reloaded.retained.size).toBe(0);
    expect((await owner.instance.status(preview)).state).toBe("online");
  });

  it("rejects a changed launch recipe while preserving the current owned run", async () => {
    const preview = fixture(await freePort());
    const { instance } = manager();
    const before = await instance.ensure(preview, []);
    expect(before.state).toBe("online");

    const altered = {
      ...preview,
      argv: [process.execPath, "-e", "process.exit(99)"],
    };

    expect((await instance.ensure(altered, [])).state).toBe("error");
    expect((await instance.status(preview)).runId).toBe(before.runId);
    expect((await instance.status(preview)).state).toBe("online");
  });

  it("rejects a foreign replacement after its owned process exits", async () => {
    const preview = fixture(await freePort());
    const { instance } = manager();
    const before = await instance.ensure(preview, []);
    expect(before.state).toBe("online");
    await fetch(`http://127.0.0.1:${preview.port}/__stop`).catch(
      () => undefined,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));

    const replacement = createServer((_request, response) =>
      response.end("replacement"),
    );

    servers.push(replacement);
    await new Promise<void>((resolveListening) =>
      replacement.listen(preview.port, "127.0.0.1", resolveListening),
    );
    expect((await instance.status(preview)).state).toBe("conflict");
    expect((await instance.ensure(preview, [])).state).toBe("conflict");
    await expect(
      instance.resolveTarget(preview.id, before.runId ?? "missing"),
    ).rejects.toThrow("not available");
    await expect(
      instance.validateSocketOwner(preview.id, before.runId ?? "missing"),
    ).rejects.toThrow("not available");
    await instance.shutdown();
    expect(
      await (
        await fetch(`http://127.0.0.1:${preview.port}/original-path`)
      ).text(),
    ).toBe("replacement");
  });

  it("restarts only its exact owned run after a readiness error", async () => {
    const preview = fixture(await freePort());
    const { instance } = manager();
    const before = await instance.ensure(preview, []);
    expect(before.state).toBe("online");
    await fetch(`http://127.0.0.1:${preview.port}/__fail`);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);

    try {
      expect((await instance.status(preview)).state).toBe("error");
      const after = await instance.ensure(preview, []);
      expect(after.state).toBe("online");
      expect(after.runId).not.toBe(before.runId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds readiness even when a server trickles an unfinished response", async () => {
    const preview = fixture(await freePort());
    preview.argv = [
      process.execPath,
      "-e",
      `
const { createServer } = require('node:net');
const server = createServer((socket) => {
  socket.on('error', () => {});
  socket.write('HTTP/1.1 200 OK\\r\\nX-Slow: ');
  const timer = setInterval(() => socket.write('x'), 50);
  socket.on('close', () => clearInterval(timer));
});
server.listen(${preview.port}, '127.0.0.1');
`,
    ];
    const { instance } = manager();
    const startedAt = performance.now();
    const result = await instance.ensure(preview, []);
    expect(result.state).toBe("starting");
    expect(performance.now() - startedAt).toBeLessThan(12_000);
  });

  it("reports command exit before readiness instead of treating spawn as success", async () => {
    const preview = fixture(await freePort());
    preview.argv = [process.execPath, "-e", "process.exit(17)"];
    const { instance } = manager();
    const result = await instance.ensure(preview, []);
    expect(result.state).toBe("error");
    expect(result.detail).toContain("17");
    expect(instance.activityCount()).toBe(0);
  });
});
