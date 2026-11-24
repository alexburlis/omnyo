import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo, Server as NetServer, Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { type SecureContext, TLSSocket, createSecureContext } from "node:tls";
import { pathToFileURL } from "node:url";
import { getRequestListener } from "@hono/node-server";
import {
  CERTIFICATE_DIRECTORY,
  type CertificateIssuer,
  type CertificateIssuerSetup,
  type CertificateManager,
  type CertificateMaterial,
  type CertificateStore,
  type StoredCertificate,
  certificateDomains,
  createCertificateManager,
  createFileCertificateStore,
} from "./acme.js";
import { createCloudflareAcmeIssuer } from "./acme-issuer.js";
import { startCertificateRenewal } from "./acme-renewal.js";
import { createAccountApp } from "./account/routes.js";
import { createRelayAuth } from "./auth/index.js";
import { BACKUP_DIRECTORY, startBackupSchedule } from "./backup.js";
import { findLabelViolations, runRelayCommand } from "./cli.js";
import { type RelayConfig, parseRelayConfig } from "./config.js";
import {
  type ClientIpSource,
  RELAY_RESTART_CLOSE_CODE,
  RELAY_RESTART_CLOSE_REASON,
  type RelayDeps,
  type RelayLogger,
} from "./contracts.js";
import { openRelayDatabase } from "./db.js";
import { EGRESS_FLUSH_INTERVAL_MS, createEgressCounter } from "./egress.js";
import { type Gate, createGate } from "./gate/gate.js";
import { AUTHORIZE_PATH } from "./gate/handshake.js";
import { classifyHost } from "./gate/host.js";
import { createGateNodeHandlers } from "./gate/node.js";
import { gateErrorPage } from "./gate/pages.js";
import {
  createRevocationJournal,
  replayRevocationJournal,
  revocationJournalPath,
  startJournalMaintenance,
} from "./gate/revocation.js";

import { createJsonLogger } from "./log.js";
import {
  type MigrationDirectories,
  bundledMigrationDirectories,
} from "./migrations.js";
import {
  createClientIpSource,
  prepareIncomingClientIp,
} from "./net/client-ip.js";
import {
  type ConnectionBounds,
  DEFAULT_CONNECTION_BOUNDS,
  boundHttpConnections,
  boundTlsHandshake,
  createClientConnectionLimit,
  throttledCount,
} from "./net/connection-bounds.js";
import {
  type EdgeRequest,
  type EdgeResponse,
  type PlainResponse,
  RelayServerResponse,
  writeBadRequest,
} from "./net/edge-responses.js";
import { EDGE_ALPN_PROTOCOLS, createHttp2Edge } from "./net/http2.js";
import {
  bindProxiedClient,
  createProxyProtocolServer,
} from "./net/proxy-protocol.js";
import { startPruneJob } from "./prune.js";
import { createRelayRateLimiters } from "./rate-limit.js";
import { createTunnelRegistry } from "./tunnel/registry.js";

export { REVOCATION_JOURNAL_FILE } from "./gate/revocation.js";

export { RelayServerResponse } from "./net/edge-responses.js";

export const HEALTH_PATH = "/healthz";

export const LOCK_FILE = "relay.lock";

export const SHUTDOWN_GRACE_MS = 2_000;

const CONNECTION_REFUSAL_LOG_INTERVAL_MS = 60_000;

const LOCK_BUSY_EXIT_CODE = 75;

const LOCK_PROBE_TIMEOUT_MS = 5_000;

const HEALTH_HOST = "127.0.0.1";

const IN_MEMORY_DATABASE = ":memory:";

export type RelayHealthState = "starting" | "live" | "stopping";

export interface SingleWriterLock {
  verify(): Promise<void>;
}

export class RelayStartupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RelayStartupError";
  }
}

function probeExitCode(
  command: string,
  args: readonly string[],
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      timeout: LOCK_PROBE_TIMEOUT_MS,
    });

    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

export function flockSingleWriterLock(lockPath: string): SingleWriterLock {
  return {
    async verify() {
      let status: number | null;

      try {
        status = await probeExitCode("flock", [
          "--nonblock",
          "--conflict-exit-code",
          String(LOCK_BUSY_EXIT_CODE),
          lockPath,
          "true",
        ]);
      } catch (error) {
        throw new RelayStartupError(
          `Cannot check the single-writer lock ${lockPath} with flock`,
          { cause: error },
        );
      }

      if (status === LOCK_BUSY_EXIT_CODE) return;

      if (status === 0) {
        throw new RelayStartupError(
          `${lockPath} is not held. Start the relay as: flock -F -n ${lockPath} node dist/main.js`,
        );
      }

      throw new RelayStartupError(
        `The flock check of ${lockPath} exited with status ${String(status)}`,
      );
    },
  };
}

export interface StartRelayOptions {
  env: Readonly<Record<string, string | undefined>>;
  migrations: MigrationDirectories;
  lock(lockPath: string): SingleWriterLock;
  certificates(directory: string): CertificateStore;
  certificateIssuer?(setup: CertificateIssuerSetup): CertificateIssuer;
  log: RelayLogger;
  now?: () => number;
  connectionBounds?: Readonly<ConnectionBounds>;
}

export interface RunningRelay {
  config: RelayConfig;
  publicPort: number;
  healthPort: number;
  state(): RelayHealthState;
  setCertificate(material: CertificateMaterial): void;
  shutdown(): Promise<void>;
}

function listen(
  server: NetServer,
  port: number,
  host?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ port, host }, () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();

      return;
    }

    server.close(() => resolve());
  });
}

function pathOf(rawTarget: string | undefined): string {
  const target = rawTarget ?? "/";
  const query = target.indexOf("?");

  return query === -1 ? target : target.slice(0, query);
}

function healthBody(state: RelayHealthState): { status: number; body: string } {
  return state === "live"
    ? { status: 200, body: "live\n" }
    : { status: 503, body: `${state}\n` };
}

function writeHealth(
  request: Pick<IncomingMessage, "method">,
  response: PlainResponse,
  state: RelayHealthState,
): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD", connection: "close" });
    response.end();

    return;
  }

  const { status, body } = healthBody(state);
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });

  if (request.method === "HEAD") response.end();
  else response.end(body);
}

function createHealthServer(state: () => RelayHealthState): Server {
  return createServer((request, response) => {
    if (pathOf(request.url) !== HEALTH_PATH) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");

      return;
    }

    writeHealth(request, response, state());
  });
}

export function signInUrlFor(appUrl: string, returnTo: string): string {
  const origin = new URL(appUrl).origin;
  const target = new URL(returnTo);

  if (target.origin !== origin) {
    throw new RelayStartupError("Sign-in can only return to the relay apex");
  }

  return `${origin}/sign-in?next=${encodeURIComponent(`${target.pathname}${target.search}`)}`;
}

interface PublicHandlers {
  request(incoming: EdgeRequest, outgoing: EdgeResponse): void;
  upgrade(incoming: IncomingMessage, socket: Duplex, head: Buffer): void;
}

function createPublicHandlers(input: {
  config: RelayConfig;
  gate: Gate;
  accountFetch: (request: Request) => Response | Promise<Response>;
  clientIp: ClientIpSource;
  log: RelayLogger;
  state: () => RelayHealthState;
}): PublicHandlers {
  const { config, clientIp, log } = input;
  const gateHandlers = createGateNodeHandlers(input.gate, clientIp, log);

  const accountListener = getRequestListener(
    (request) => input.accountFetch(request),
    {
      errorHandler: (error) => {
        log.error("apex.failure", {
          error: error instanceof Error ? error.name : "unknown",
        });

        return gateErrorPage();
      },
    },
  );

  function isApex(incoming: EdgeRequest): boolean {
    return (
      classifyHost(incoming.headers.host ?? "", {
        baseDomain: config.baseDomain,
        appUrl: config.appUrl,
      }).kind === "apex"
    );
  }

  return {
    request(incoming, outgoing) {
      const path = pathOf(incoming.url);

      if (!isApex(incoming) || path === AUTHORIZE_PATH) {
        gateHandlers.request(incoming, outgoing);

        return;
      }

      if (path === HEALTH_PATH) {
        writeHealth(incoming, outgoing, input.state());

        return;
      }

      if (prepareIncomingClientIp(incoming, clientIp) === null) {
        log.warn("apex.client_ip_missing", { mode: clientIp.mode });
        writeBadRequest(outgoing);

        return;
      }

      void accountListener(incoming, outgoing);
    },
    upgrade(incoming, socket, head) {
      gateHandlers.upgrade(incoming, socket, head);
    },
  };
}

function trackSockets(server: NetServer, sockets: Set<Socket>): void {
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
}

async function drainSockets(
  sockets: Set<Socket>,
  graceMs: number,
): Promise<void> {
  const deadline = Date.now() + graceMs;

  while (sockets.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  for (const socket of sockets) socket.destroy();
}

export async function startRelay(
  options: StartRelayOptions,
): Promise<RunningRelay> {
  const { log } = options;
  const now = options.now ?? Date.now;
  const bounds = options.connectionBounds ?? DEFAULT_CONNECTION_BOUNDS;
  const config = parseRelayConfig(options.env);

  if (config.databasePath === IN_MEMORY_DATABASE) {
    throw new RelayStartupError(
      "DATABASE_PATH must name a file on the data volume",
    );
  }

  const dataDirectory = dirname(config.databasePath);
  let state: RelayHealthState = "starting";
  const health = createHealthServer(() => state);
  const healthPort = await listen(health, config.healthPort, HEALTH_HOST);

  const cleanup: Array<() => void | Promise<void>> = [
    () => closeServer(health),
  ];

  async function unwind(): Promise<void> {
    for (const step of cleanup.splice(0).reverse()) await step();
  }

  try {
    await options.lock(join(dataDirectory, LOCK_FILE)).verify();

    const database = openRelayDatabase(
      config.databasePath,
      options.migrations,
      now,
    );

    cleanup.push(() => database.close());
    log.info("relay.migrations_applied", {
      connectDb: database.applied.connectDb.length,
      relayLocal: database.applied.relayLocal.length,
    });

    const journal = createRevocationJournal(
      revocationJournalPath(config.databasePath),
    );

    const replay = replayRevocationJournal(database.db, journal);

    log.info("relay.journal_replayed", { ...replay });
    cleanup.push(
      startJournalMaintenance({ db: database.db, journal, log, now }),
    );

    const unanswered = findLabelViolations(database.sqlite).filter(
      (violation) => !violation.answers,
    );

    if (unanswered.length > 0) {
      log.warn("relay.reserved_labels_held", {
        count: unanswered.length,
        labels: unanswered.map((violation) => violation.label).join(","),
      });
    }

    cleanup.push(startPruneJob({ db: database.db, log, now }));
    cleanup.push(
      startBackupSchedule({
        sqlite: database.sqlite,
        directory: join(dataDirectory, BACKUP_DIRECTORY),
        pushUrl: config.backupPushUrl,
        log,
        now,
      }),
    );

    let secureContext: SecureContext | null = null;

    let certificates: {
      manager: CertificateManager;
      current: StoredCertificate;
    } | null = null;

    if (config.edge.clientIpSource === "proxy-protocol") {
      const store = options.certificates(
        join(dataDirectory, CERTIFICATE_DIRECTORY),
      );

      const issuer = (options.certificateIssuer ?? createCloudflareAcmeIssuer)({
        store,
        acme: config.edge.acme,
        log,
      });

      const manager = createCertificateManager({
        store,
        domains: certificateDomains(config.baseDomain),
        directoryUrl: config.edge.acme.directoryUrl,
        issuer,
        log,
        now,
        redactions: [config.edge.acme.cloudflareDnsToken],
      });

      const current = await manager.ensure();
      secureContext = createSecureContext(current.material);
      certificates = { manager, current };
    }

    const swapCertificate = (material: CertificateMaterial) => {
      secureContext = createSecureContext(material);
    };

    const tunnels = createTunnelRegistry({
      database,
      log,
      maxBufferedBytes: config.maxBufferedBytes,
      now,
    });

    const egress = createEgressCounter({
      sqlite: database.sqlite,
      capBytes: config.userEgressBytesPerMonth,
      now,
    });

    const egressTimer = setInterval(
      () => egress.flush(),
      EGRESS_FLUSH_INTERVAL_MS,
    );

    egressTimer.unref();
    cleanup.push(() => {
      clearInterval(egressTimer);
      egress.flush();
    });

    const relayAuth = createRelayAuth(config, database);
    const clientIp = createClientIpSource(config.edge);
    const rateLimits = createRelayRateLimiters(now);

    const deps: RelayDeps = {
      config,
      database,
      tunnels,
      clientIp,
      rateLimits,
      egress,
      auth: relayAuth.service,
      log,
      now,
    };

    const gate = createGate({
      deps,
      journal,
      signInUrl: (returnTo) => signInUrlFor(config.appUrl, returnTo),
    });

    const account = createAccountApp({
      recordShareRevocation: (entry) => journal.append(entry),
      config,
      database,
      tunnels,
      revocations: {
        record(revocation) {
          journal.append({ ...revocation, at: now() });
          gate.sweep();
        },
      },
      rateLimits,
      auth: relayAuth.service,
      log,
      now,
    });

    const handlers = createPublicHandlers({
      config,
      gate,
      accountFetch: (request) => account.fetch(request),
      clientIp,
      log,
      state: () => state,
    });

    const sockets = new Set<Socket>();

    const publicServer = createServer(
      { ServerResponse: RelayServerResponse },
      handlers.request,
    );

    publicServer.on("upgrade", handlers.upgrade);
    const activity = boundHttpConnections(publicServer, bounds);
    trackSockets(publicServer, sockets);
    const http2Edge = createHttp2Edge({ request: handlers.request, bounds });

    const reportRefusals = (reason: string) =>
      throttledCount({
        now,
        intervalMs: CONNECTION_REFUSAL_LOG_INTERVAL_MS,
        report: (refused) =>
          log.warn("edge.connection_rejected", { reason, refused }),
      });

    let listener: NetServer = publicServer;
    let listenerCapacity = bounds.maxConnections;
    const refusedOverall = reportRefusals("connection-limit");

    if (config.edge.clientIpSource === "proxy-protocol") {
      const perClient = createClientConnectionLimit(
        bounds.maxConnectionsPerClient,
        bounds.maxConnections,
      );

      listenerCapacity = bounds.maxConnections + bounds.maxConnectionsPerClient;
      const refusedPerClient = reportRefusals("client-connection-limit");
      listener = createProxyProtocolServer({
        proxyCidr: config.edge.proxyCidr,
        onSocket(socket, client) {
          if (secureContext === null) {
            socket.destroy();

            return;
          }

          let wrapped: TLSSocket | null = null;

          const admission = perClient.admit(
            socket,
            client.address,
            () =>
              wrapped === null ||
              (activity.idle(wrapped) && http2Edge.idle(wrapped)),
          );

          if (admission !== "admitted") {
            if (admission === "client-limit") refusedPerClient();
            else refusedOverall();
            socket.destroy();

            return;
          }

          const secure = new TLSSocket(socket, {
            isServer: true,
            secureContext,
            ALPNProtocols: [...EDGE_ALPN_PROTOCOLS],
          });

          wrapped = secure;
          bindProxiedClient(secure, client);
          secure.on("error", () => secure.destroy());
          boundTlsHandshake(secure, bounds.tlsHandshakeTimeoutMs);
          secure.once("secure", () => {
            if (secure.alpnProtocol === "h2") http2Edge.attach(secure, client);
            else publicServer.emit("connection", secure);
          });
        },
        onReject(reason, peer) {
          log.warn("edge.connection_rejected", { reason, peer });
        },
      });
      trackSockets(listener, sockets);
    }

    listener.maxConnections = listenerCapacity;
    listener.on("drop", () => refusedOverall());

    const publicPort = await listen(listener, config.port);
    const stopSweep = gate.startRevocationSweep();
    state = "live";
    log.info("relay.live", {
      clientIpSource: config.edge.clientIpSource,
      publicPort,
      healthPort,
    });

    if (certificates !== null) {
      const { manager } = certificates;

      const renewal = startCertificateRenewal({
        current: certificates.current,
        renew: () => manager.renew(),
        apply: swapCertificate,
        log,
        now,
      });

      cleanup.push(() => renewal.stop());
      void renewal.check();
    }

    let stopping: Promise<void> | null = null;

    async function shutdown(): Promise<void> {
      state = "stopping";
      stopSweep();
      tunnels.closeAll(RELAY_RESTART_CLOSE_CODE, RELAY_RESTART_CLOSE_REASON);
      listener.close();

      if (listener !== publicServer) publicServer.close();
      publicServer.closeIdleConnections();
      http2Edge.close();
      await drainSockets(sockets, SHUTDOWN_GRACE_MS);
      await unwind();
      log.info("relay.stopped", {});
    }

    return {
      config,
      publicPort,
      healthPort,
      state: () => state,
      setCertificate: swapCertificate,
      shutdown() {
        stopping ??= shutdown();

        return stopping;
      },
    };
  } catch (error) {
    await unwind();
    throw error;
  }
}

function isEntryPoint(moduleUrl: string): boolean {
  const script = process.argv[1];

  if (script === undefined) return false;

  try {
    return pathToFileURL(realpathSync(script)).href === moduleUrl;
  } catch {
    return false;
  }
}

async function runCli(): Promise<void> {
  const log = createJsonLogger((line) => process.stdout.write(line));
  let relay: RunningRelay;

  try {
    relay = await startRelay({
      env: process.env,
      migrations: bundledMigrationDirectories(import.meta.url),
      lock: flockSingleWriterLock,
      certificates: createFileCertificateStore,
      log,
    });
  } catch (error) {
    log.error("relay.startup_failed", {
      error: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  const stop = (signal: string) => {
    log.info("relay.stopping", { signal });
    relay.shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        log.error("relay.shutdown_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
        process.exit(1);
      },
    );
  };

  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

if (isEntryPoint(import.meta.url)) {
  const commandExitCode = await runRelayCommand(process.argv.slice(2), {
    env: process.env,
    stdin: process.stdin,
    stdinIsTerminal: process.stdin.isTTY === true,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    migrations: bundledMigrationDirectories(import.meta.url),
  });

  if (commandExitCode === null) await runCli();
  else process.exitCode = commandExitCode;
}
