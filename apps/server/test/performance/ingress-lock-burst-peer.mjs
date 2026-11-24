import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const port = parentPort;

const require = createRequire(import.meta.url);

if (workerData.kind === "lock") {
  const Database = require(workerData.sqliteModule);
  const database = new Database(workerData.databasePath, { timeout: 1000 });
  database.exec("BEGIN IMMEDIATE");
  port.postMessage({ type: "locked", at: Date.now() });

  setTimeout(() => {
    database.exec("ROLLBACK");
    database.close();
    port.postMessage({ type: "released", at: Date.now() });
    port.close();
  }, workerData.holdMs);
} else {
  const WebSocket = require(workerData.wsModule);
  const health = [];
  const pongs = [];
  const pendingPings = [];
  const errors = [];
  const timers = [];
  const requests = new Set();
  let closed = false;

  const sampleHealth = () => {
    const at = Date.now();
    const startedAt = performance.now();

    const request = fetch(workerData.healthUrl, {
      signal: AbortSignal.timeout(7000),
    })
      .then(async (response) => {
        const body = await response.json();
        health.push({
          at,
          durationMs: performance.now() - startedAt,
          ok: response.ok && body.ok === true,
        });
      })
      .catch(() =>
        health.push({
          at,
          durationMs: performance.now() - startedAt,
          ok: false,
        }),
      )
      .finally(() => requests.delete(request));

    requests.add(request);
  };

  const socket = new WebSocket(workerData.websocketUrl, {
    origin: workerData.origin,
  });

  const ping = () => {
    pendingPings.push({ at: Date.now(), startedAt: performance.now() });
    socket.send(JSON.stringify({ type: "ping" }));
  };

  socket.on("message", (data) => {
    const message = JSON.parse(String(data));

    if (message.type !== "pong") return;
    const sent = pendingPings.shift();

    if (sent === undefined) errors.push("unexpected pong");
    else
      pongs.push({
        at: sent.at,
        durationMs: performance.now() - sent.startedAt,
      });
  });
  socket.on("error", () => errors.push("browser websocket error"));
  socket.on("close", () => {
    if (!closed)
      errors.push("browser websocket closed before measurement ended");
  });
  socket.once("open", () => {
    sampleHealth();
    ping();
    timers.push(
      setInterval(sampleHealth, workerData.intervalMs),
      setInterval(ping, workerData.intervalMs),
    );
    port.postMessage({ type: "ready" });
  });

  port.once("message", async () => {
    for (const timer of timers) clearInterval(timer);
    await Promise.all([...requests]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    closed = true;
    socket.close();
    await new Promise((resolve) => socket.once("close", resolve));
    port.postMessage({
      type: "observed",
      health,
      pongs,
      unanswered: pendingPings.length,
      errors,
    });
    port.close();
  });
}
