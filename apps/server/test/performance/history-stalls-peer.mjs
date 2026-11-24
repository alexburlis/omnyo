import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const port = parentPort;

const require = createRequire(import.meta.url);

const Database = require(workerData.sqliteModule);

if (workerData.kind === "lock") {
  const database = new Database(workerData.databasePath, { timeout: 1000 });
  database.exec("BEGIN IMMEDIATE");

  if (workerData.surface === "primary")
    database
      .prepare(
        "INSERT INTO thread_timeline_records (key,thread_id,kind,body,byte_size,created_at) VALUES (?,?,'root','{}',2,0)",
      )
      .run("inert-primary-lock", workerData.threadId);
  else
    database
      .prepare(
        "INSERT INTO history_cache_records (key,thread_id,source_identity,rewrite_epoch,kind,body,byte_size,created_at,expires_at,sequence,last_accessed_at) VALUES (?,?,?,?,'root','{}',2,0,NULL,0,0)",
      )
      .run(
        "inert-cache-lock",
        workerData.threadId,
        workerData.sourceIdentity,
        workerData.rewriteEpoch,
      );

  const acquiredAt = performance.now();
  port.postMessage({
    type: "locked",
    acquiredAt,
    inTransaction: database.inTransaction,
  });
  const timeout = setTimeout(release, 80_000);

  function release() {
    clearTimeout(timeout);

    if (database.inTransaction) database.exec("ROLLBACK");
    database.close();
    port.postMessage({
      type: "released",
      heldMs: performance.now() - acquiredAt,
    });
    port.close();
  }

  port.once("message", release);
} else {
  const WebSocket = require(workerData.wsModule);

  const database = new Database(workerData.databasePath, {
    readonly: true,
    timeout: 1000,
  });

  const lease = database.prepare(
    "SELECT status, lease_expires_at AS leaseExpiresAt FROM host_daemon_sessions WHERE id=?",
  );

  const pending = [];
  const acknowledgements = [];
  const health = [];
  const leases = [];
  const errors = [];
  const timers = [];
  const requests = new Set();
  let socket = null;
  let closed = false;
  let sent = 0;

  const sampleHealth = () => {
    const startedAt = performance.now();

    const request = fetch(workerData.healthUrl, {
      signal: AbortSignal.timeout(7000),
    })
      .then(async (response) => {
        const body = await response.json();
        health.push({
          startedAt,
          durationMs: performance.now() - startedAt,
          ok: response.ok && body.ok === true,
        });
      })
      .catch(() =>
        health.push({
          startedAt,
          durationMs: performance.now() - startedAt,
          ok: false,
        }),
      )
      .finally(() => requests.delete(request));

    requests.add(request);
  };

  const sampleLease = () => {
    const row = lease.get(workerData.sessionId);
    leases.push({
      observedAt: Date.now(),
      status: row?.status ?? "missing",
      remainingMs: (row?.leaseExpiresAt ?? 0) - Date.now(),
    });
  };

  const heartbeat = () => {
    pending.push(performance.now());
    sent++;
    socket.send(JSON.stringify({ type: "heartbeat" }));
  };

  if (workerData.sessionId !== null) {
    socket = new WebSocket(workerData.websocketUrl, workerData.protocols, {
      headers: { authorization: workerData.authorization },
    });
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));

      if (message.type === "heartbeat-ack") {
        const sentAt = pending.shift();
        const acknowledgedAt = performance.now();

        if (sentAt === undefined)
          errors.push("unexpected heartbeat acknowledgement");
        else
          acknowledgements.push({
            sentAt,
            acknowledgedAt,
            latencyMs: acknowledgedAt - sentAt,
          });
      } else if (message.type === "session-close")
        errors.push("daemon session closed");
    });
    socket.on("error", () => errors.push("daemon websocket error"));
    socket.on("close", () => {
      if (!closed)
        errors.push("daemon websocket closed before measurement ended");
    });
    socket.once("open", () => {
      heartbeat();
      sampleLease();
      timers.push(setInterval(heartbeat, 5000), setInterval(sampleLease, 1000));
      sampleHealth();
      timers.push(setInterval(sampleHealth, 2000));
      port.postMessage({ type: "ready" });
    });
  } else {
    sampleHealth();
    timers.push(setInterval(sampleHealth, 2000));
    port.postMessage({ type: "ready" });
  }

  port.once("message", async () => {
    closed = true;

    for (const timer of timers) clearInterval(timer);
    await Promise.all([...requests]);

    if (socket !== null) {
      socket.close();
      await new Promise((resolve) => socket.once("close", resolve));
    }

    database.close();
    port.postMessage({
      type: "observed",
      health,
      leases,
      sent,
      acknowledgements,
      unacknowledged: pending.length,
      errors,
    });
    port.close();
  });

  process.on("uncaughtException", () => {
    if (!closed)
      port.postMessage({
        type: "failed",
        message: "independent observation failed",
      });
    process.exitCode = 1;
  });
}
