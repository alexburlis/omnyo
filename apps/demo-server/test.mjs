import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL(".", import.meta.url));

const READ_ONLY_MESSAGE =
  "This is a read-only demo server, so it cannot do that.";

const THREAD = "thr_demo00000001";

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: DIR,
  env: { PORT: "0", HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "inherit"],
});

const exited = new Promise((resolve) => server.once("exit", resolve));

const timeout = setTimeout(
  () => fail(new Error("timed out after 20 s")),
  20_000,
);

function fail(error) {
  console.error(`FAIL: ${error.message}`);
  server.kill("SIGKILL");
  process.exit(1);
}

async function json(origin, path, init) {
  const response = await fetch(origin + path, init);

  return { status: response.status, body: await response.json() };
}

function ping(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "ping" }));
    });
    socket.addEventListener("message", (event) => {
      resolve(JSON.parse(event.data));
      socket.close();
    });
    socket.addEventListener("error", () => reject(new Error("/ws failed")));
  });
}

function upgrade(port, path, frame = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    let response = "";

    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
      socket.write(frame);
    });

    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
    });
    socket.on("close", () => resolve(response.split("\r\n")[0]));
    socket.on("error", reject);
  });
}

const OVERSIZED_PING = Buffer.concat([
  Buffer.from([0x89, 0x80 | 126, 0, 126]),
  Buffer.alloc(4 + 126),
]);

async function run() {
  if (DIR === "/app/") assert.equal(process.getuid(), 65532);

  const port = await new Promise((resolve, reject) => {
    exited.then((code) => reject(new Error(`server exited with ${code}`)));
    server.stdout.on("data", (chunk) => {
      const match = /listening on (\d+)/u.exec(String(chunk));

      if (match) resolve(Number(match[1]));
    });
  });

  const origin = `http://127.0.0.1:${port}`;

  assert.deepEqual((await json(origin, "/health")).body, { ok: true });

  for (const path of ["/", `/threads/${THREAD}`]) {
    const response = await fetch(origin + path, {
      headers: { "accept-encoding": "br" },
    });

    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-encoding"), "br", path);
    assert.match(response.headers.get("content-type"), /^text\/html/u, path);
    assert.match(await response.text(), /<div id="root">/u, path);
  }

  assert.equal((await fetch(`${origin}/assets/missing.js`)).status, 404);

  const config = await json(origin, "/api/v1/system/config");

  assert.equal(config.body.serverUrl, origin);
  assert.notEqual(config.body.generalSettings.onboardingCompletedAt, null);

  const proxied = await json(origin, "/api/v1/system/config", {
    headers: { "x-forwarded-proto": "https" },
  });

  assert.equal(proxied.body.serverUrl, `https://127.0.0.1:${port}`);

  const sidebar = await json(origin, "/api/v1/sidebar-bootstrap");

  assert.equal(sidebar.body.projects[0].threads.length, 3);

  assert.deepEqual(
    config.body.generalSettings.modelPermissionModes,
    {},
    "generalSettings.modelPermissionModes",
  );

  const boot = await json(origin, "/api/v1/boot");

  assert.equal(boot.status, 200);
  assert.equal(boot.body.version, 1);
  assert.equal(Object.keys(boot.body.parts).length, 14);

  for (const [name, part] of Object.entries(boot.body.parts))
    assert.equal(part.status, 200, `boot part ${name}`);

  assert.equal(boot.body.parts.sidebarBootstrap.body.projects.length, 1);

  const bootParts = await json(
    origin,
    "/api/v1/boot?parts=systemConfig,hosts,shelvedThreads",
  );

  assert.deepEqual(Object.keys(bootParts.body.parts), [
    "systemConfig",
    "hosts",
    "shelvedThreads",
  ]);
  assert.equal(bootParts.body.parts.systemConfig.body.serverUrl, origin);

  assert.equal(
    (await json(origin, "/api/v1/boot?parts=systemConfig,unknown")).status,
    400,
  );

  const reads = {
    "/api/v1/preferences/ui": (body) =>
      body.preferences["sidebar.organizationMode"].revision === 0,
    "/api/v1/system/usage": (body) => body.count.effective === false,
    "/api/v1/submissions/contract": (body) => body.version === 1,
    "/api/v1/server/move": (body) => body.move === null,
    "/api/v1/server/runtime": (body) => body.runtimeId.startsWith("demo-"),
    "/api/v1/system/app-update": (body) => body.support.kind === "unsupported",
    "/api/v1/system/version": (body) => body.updateAvailable === false,
    "/api/v1/system/providers": (body) => body.length === 0,
    "/api/v1/system/providers/catalog": (body) => body.length === 0,
    "/api/v1/system/providers/state": (body) => body.providers.length === 0,
    "/api/v1/system/environment-providers?projectId=proj_personal": (body) =>
      body.providers.length === 0,
    "/api/v1/system/machine-providers": (body) => body.providers.length === 0,
    "/api/v1/hosts?includeCreating=false": (body) => body.length === 0,
    "/api/v1/plugins/install-jobs": (body) => body.jobs.length === 0,
    "/api/v1/plugins/update-jobs": (body) => body.jobs.length === 0,
    "/api/v1/plugins/safe-mode": (body) => body.enabled === false,
    "/api/v1/plugins/contributions": (body) => body.cliCommands.length === 0,
    "/api/v1/inbox": (body) => body.counts.inbox === 0,
    "/api/v1/projects/proj_personal/prompt-history": (body) =>
      body.length === 0,
    [`/api/v1/threads/${THREAD}/default-execution-options`]: (body) =>
      body === null,
    [`/api/v1/threads/${THREAD}/conversation-outline?role=user`]: (body) =>
      body.items.length === 1 && body.items[0].role === "user",
    [`/api/v1/threads/${THREAD}/waits`]: (body) => body.waits.length === 0,
    [`/api/v1/threads/${THREAD}/interactions`]: (body) => body.length === 0,
    [`/api/v1/threads/${THREAD}/queued-messages`]: (body) => body.length === 0,
    [`/api/v1/threads/${THREAD}/prompt-history`]: (body) => body.length === 0,
  };

  for (const [path, check] of Object.entries(reads)) {
    const response = await json(origin, path);

    assert.equal(response.status, 200, path);
    assert.ok(check(response.body), path);
  }

  const timeline = await json(origin, `/api/v1/threads/${THREAD}/timeline`);

  assert.ok(timeline.body.rows.length > 0);

  const plugins = await json(origin, "/api/v1/plugins");
  const bundle = await fetch(origin + plugins.body.plugins[0].app.bundle.jsUrl);

  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get("content-type"), /^text\/javascript/u);

  const send = await json(origin, `/api/v1/threads/${THREAD}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "Hello" }),
  });

  assert.equal(send.status, 501);
  assert.equal(send.body.error.message, READ_ONLY_MESSAGE);

  const storedTabs = await json(origin, `/api/v1/threads/${THREAD}/tabs`);

  assert.notEqual(storedTabs.body.revision, 0);

  const tabs = await json(origin, `/api/v1/threads/${THREAD}/tabs`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 0, tabs: [] }),
  });

  assert.equal(tabs.status, 501);
  assert.equal(tabs.body.error.message, READ_ONLY_MESSAGE);

  const preference = await json(
    origin,
    "/api/v1/preferences/ui/sidebar.organizationMode",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, value: "projects" }),
    },
  );

  assert.equal(preference.status, 501);
  assert.equal(preference.body.error.message, READ_ONLY_MESSAGE);

  const search = await json(origin, "/api/v1/threads/search?query=dark");

  assert.equal(search.status, 501);
  assert.equal(search.body.error.message, READ_ONLY_MESSAGE);

  assert.deepEqual(await ping(port), { type: "pong" });

  assert.equal(await upgrade(port, "//a%20b/ws"), "HTTP/1.1 400 Bad Request");

  assert.equal(
    await upgrade(port, "/ws", OVERSIZED_PING),
    "HTTP/1.1 101 Switching Protocols",
  );

  assert.deepEqual((await json(origin, "/health")).body, { ok: true });

  server.kill("SIGTERM");
  assert.equal(await exited, 0);
}

run().then(
  () => {
    clearTimeout(timeout);
    console.log("PASS");
  },
  (error) => fail(error),
);
