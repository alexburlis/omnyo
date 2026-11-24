import { usageRequestEligible } from "@omnyo/domain/usage-telemetry";
import { registerPreviewTransport } from "./services/previews/preview-transport.js";
import {
  previewStatus,
  requirePreview,
} from "./services/previews/managed-previews.js";
import { requireConnectedHostSession } from "./services/lib/entity-lookup.js";
import { registerPreviewRoutes } from "./routes/previews.js";
import { registerInboxRoutes } from "./routes/inbox.js";
import {
  registerThreadWorkRevisions,
  setThreadWorkContributorStates,
} from "./services/threads/thread-work.js";
import { WebUpdateService } from "./services/system/web-update.js";
import { registerWebUpdateRoutes } from "./routes/web-update.js";
import { isServerRestartDraining } from "./services/system/server-update-drain.js";
import { z } from "zod";
import {
  observeDirectProof,
  confirmDirectPrimary,
} from "./services/machines/direct-access-state.js";
import { getAuthenticatedDaemon } from "./internal/auth.js";
import {
  type ServerMaintenance,
  createServerMaintenance,
} from "./services/maintenance/server-maintenance.js";
import { registerServerMaintenanceRoutes } from "./routes/server-maintenance.js";
import { originAdoptionControlPathV1 } from "./services/maintenance/origin-adoption-v1.js";
import { createPluginUpdateJobs } from "./services/plugins/plugin-update-jobs.js";
import { registerPluginUpdateJobRoutes } from "./routes/plugin-update-jobs.js";
import { recheckEnvironmentProvisioning } from "./services/threads/thread-environment-providers.js";
import {
  enrolledInstallerScript,
  enrolledWindowsInstallerScript,
  windowsInstallerFailureScript,
} from "./services/machines/manual-enrollment-command.js";
import { reconnectBootstrapForCredential } from "./services/machines/reconnect.js";
import { readEnrollmentHeaderV1 } from "./services/machines/enrollment-header-v1.js";
import { getMachineEnrollmentService } from "./services/machines/machine-services.js";
import { withManualMachineProvider } from "./services/machines/manual-provider.js";
import { registerDesktopBrowserRoutes } from "./routes/desktop-browsers.js";
import {
  INSTALL_MACHINE_SCRIPT_PATH,
  INSTALL_MACHINE_WINDOWS_SCRIPT_PATH,
} from "./install-machine-asset.js";
import { createNodeWebSocket } from "@hono/node-ws";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { extname, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { terminalWebSocketQuerySchema } from "@omnyo/server-contract";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import type { ServerAppDeps } from "./types.js";
import { ApiError, createServerErrorHandler } from "./errors.js";
import { registerEnvironmentRoutes } from "./routes/environments.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerPrivateUpdateFeedRoutes } from "./routes/private-update-feed.js";
import { registerShortEnrollmentRoutes } from "./routes/short-enrollment.js";
import { registerHostRoutes } from "./routes/hosts.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerThreadSectionRoutes } from "./routes/thread-sections.js";
import { registerThreadGroupRoutes } from "./routes/thread-groups.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerWebErrorReportingRoutes } from "./routes/web-error-reporting.js";
import { registerBootRoutes } from "./routes/boot.js";
import { registerUiPreferenceRoutes } from "./routes/ui-preferences.js";
import { registerTerminalRoutes } from "./routes/terminals.js";
import { registerThreadRoutes } from "./routes/threads/index.js";
import { registerQueueRoutes } from "./routes/queue.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerPluginCatalogRoutes } from "./routes/plugin-catalog.js";
import { registerPluginInstallJobRoutes } from "./routes/plugin-install-jobs.js";
import { createPluginInstallJobs } from "./services/plugins/plugin-install-jobs.js";
import { registerPromptHistoryRoutes } from "./routes/prompt-history.js";
import { registerSkillsRegistryRoutes } from "./routes/skills-registry.js";
import {
  createPluginService,
  type PluginService,
} from "./services/plugins/plugin-service.js";
import { setPluginAgentContributions } from "./services/plugins/plugin-agent-contributions.js";
import { setPluginThreadEventEmitter } from "./services/plugins/plugin-thread-events.js";
import { setPluginHookProvider } from "./services/plugins/plugin-hook-registry.js";
import {
  setEnvironmentProviderRecheckHandler,
  setEnvironmentProvisioningRecheckHandler,
  setPluginEnvironmentProviderBridge,
} from "./services/plugins/plugin-environment-provider-registry.js";
import { recheckEnvironmentProviderCreations } from "./services/threads/thread-environment-providers.js";
import {
  setServerAccessBridge,
  setServerAccessRecheckHandler,
} from "./services/plugins/plugin-server-access-registry.js";
import { setPluginEventSourceBridge } from "./services/plugins/plugin-event-source-registry.js";
import { setPluginMachineProviderBridge } from "./services/plugins/plugin-machine-provider-registry.js";
import { invalidateEnvironmentProviderMachineAvailability } from "./services/environments/provider-machine-availability.js";
import { requestQueuedMessageDispatch } from "./services/threads/queued-message-dispatch.js";
import { registerInternalEventRoutes } from "./internal/events.js";
import { registerInternalHostRoutes } from "./internal/hosts.js";
import { registerInternalInteractiveRequestRoutes } from "./internal/interactive-requests.js";
import { registerInternalPluginHostArtifactRoutes } from "./internal/plugin-host-artifacts.js";
import { registerInternalSessionRoutes } from "./internal/session.js";
import { registerInternalSkillRoutes } from "./internal/skills.js";
import { registerInternalToolCallRoutes } from "./internal/tool-calls.js";
import {
  setAuthenticatedDaemon,
  verifyAuthenticatedDaemon,
} from "./internal/auth.js";
import {
  captureTrustedRemoteAddress,
  guardAnonymousGateRequests,
  getGateAuthKind,
} from "./request-context.js";
import { runEventLoopWork } from "./services/system/event-loop-work.js";
import { runWithUsageRequest } from "./services/system/telemetry.js";
import {
  onClientSocketClose,
  onClientSocketMessage,
  onClientSocketOpen,
} from "./ws/client-protocol.js";
import {
  onDaemonSocketClose,
  onDaemonSocketMessage,
  onDaemonSocketOpen,
  validateDaemonWebSocket,
} from "./ws/daemon-protocol.js";
import { roundDurationMs } from "@omnyo/process-utils";
import {
  onTerminalSocketClose,
  onTerminalSocketMessage,
  onTerminalSocketOpen,
} from "./ws/terminal-protocol.js";
import {
  createHostArtifactSignatureReader,
  createOmnyoAppArtifactService,
  type OmnyoAppArtifactService,
} from "./services/install/omnyo-app-artifact.js";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import {
  createPluginCatalogService,
  type PluginCatalogService,
} from "./services/plugin-catalog/plugin-catalog-service.js";
import {
  callHostOnlineRpc,
  callHostRetryableOnlineRpcForWork,
} from "./services/hosts/online-rpc.js";
import { requestMatchesEntityTag } from "./services/hosts/daemon-file-response.js";
import {
  allowedAppOrigins,
  browserRequestProblem,
  requestHostProblem,
  originAdoptionRequestUrlV1,
} from "./browser-request-guard.js";
import {
  callPluginHostRpc,
  disposePluginHostWorkers,
} from "./services/plugins/plugin-host-rpc.js";

const PLUGIN_WIRE_HTTP_PATH = /^\/api\/v1\/plugins\/[^/]+\/http(?:\/|$)/u;

import { rankAcceptedAssetEncodings } from "./asset-content-encoding.js";
import { apiJsonCompression } from "./api-response-compression.js";
import { APP_SURFACE_WEB, type AppSurface } from "@omnyo/config/app-surface";
import type { ServerBindHost } from "@omnyo/config/server";
import { registerServerMoveRoutes } from "./routes/server-move.js";
import {
  INTERNAL_SERVER_MOVE_PENDING_PATH,
  registerInternalServerMoveRoutes,
} from "./internal/server-move.js";
import {
  createServerMoveCoordinator,
  type ServerMoveCoordinator,
} from "./services/server-move/coordinator.js";
import { createDefaultServerMoveEnvironment } from "./services/server-move/environment.js";
import { readServerMoveHealth } from "./services/server-move/health.js";
import type { RestoredServerMoveRun } from "./services/server-move/reconcile.js";
import {
  serverMoveFreezeMiddleware,
  serverMoveWriteFreezeMiddleware,
} from "./services/server-move/freeze.js";
import { isServerMoveSnapshotFenced } from "./services/server-move/freeze-state.js";
import { hostDaemonEnrollRequestSchema } from "@omnyo/host-daemon-contract";
import { serverMovingError } from "./services/server-move/freeze-state.js";
import {
  createManualServerImportCompletion,
  type PendingServerMove,
} from "./services/server-move/pending-boot.js";
import { buildThreadListEntry } from "./services/threads/thread-runtime-display.js";

type CloseWebSockets = () => Promise<void>;

type NodeWebSocketServer = ReturnType<typeof createNodeWebSocket>["wss"];

type WebSocketCloseError = Error | undefined;

interface ServerApp {
  app: Hono;
  closeWebSockets: CloseWebSockets;
  injectWebSocket: ReturnType<typeof createNodeWebSocket>["injectWebSocket"];
  pluginService: PluginService;
  pluginCatalogService: PluginCatalogService;
  serverMove: ServerMoveCoordinator;
  maintenance: ServerMaintenance;
  webUpdate: WebUpdateService;
}

interface CloseWebSocketServerArgs {
  forceCloseAfterMs: number;
  reason: string;
  server: NodeWebSocketServer;
}

function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({ code: "unauthorized", message: "Unauthorized" }),
    {
      status: 401,
      headers: { "content-type": "application/json" },
    },
  );
}

function normalizeInternalAuthPath(path: string): string {
  if (path === "/") {
    return path;
  }

  return path.replace(/\/+$/u, "");
}

export interface ServerMoveAppOptions {
  appSurface: AppSurface;
  bindHost: ServerBindHost | null;
  manualImportPending: boolean;
  pending: PendingServerMove | null;
  restoredRun: RestoredServerMoveRun | null;
  retireProcess(): void;
}

interface CreateAppOptions {
  appArtifactService?: OmnyoAppArtifactService;
  serverMove?: ServerMoveAppOptions;
  slowApiRequestLogThresholdMs?: number;
  performanceDiagnosticsEnabled?: () => boolean;
  staticDir?: string;
  retainedStaticDirs?: string[];
}

interface StaticResponseHeadersArgs {
  contentEncoding?: string;
  contentLength?: number;
  contentType: string;
  etag?: string;
  urlPath: string;
}

const STATIC_INDEX_CACHE_CONTROL = "no-cache";

const STATIC_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

const STATIC_PUBLIC_FILE_CACHE_CONTROL = "public, max-age=86400";

const WEB_SOCKET_SHUTDOWN_CODE = 1001;

const WEB_SOCKET_SHUTDOWN_FORCE_CLOSE_MS = 1_000;

const WEB_SOCKET_SHUTDOWN_REASON = "server-shutdown";

const SLOW_API_REQUEST_LOG_THRESHOLD_MS = 1_000;

const THREAD_EVENT_WAIT_PATH_PATTERN =
  /^\/api\/v1\/threads\/[^/]+\/events\/wait$/u;

const PLUGIN_APP_ASSET_PATH_PATTERN =
  /^\/api\/v1\/(?:plugins\/[^/]+\/assets|plugin-app-assets\/[a-f0-9]{16})\/app\.(?:js|css)$/u;

const PRECOMPRESSED_STATIC_FILES = [
  { encoding: "br", extension: ".br" },
  { encoding: "gzip", extension: ".gz" },
] as const;

interface ShouldLogSlowApiRequestArgs {
  durationMs: number;
  path: string;
  thresholdMs: number;
}

function shouldLogSlowApiRequest(args: ShouldLogSlowApiRequestArgs): boolean {
  if (args.durationMs < args.thresholdMs) {
    return false;
  }

  return !THREAD_EVENT_WAIT_PATH_PATTERN.test(args.path);
}

function staticCacheControlForPath(urlPath: string): string {
  if (urlPath.startsWith("/assets/")) {
    return STATIC_ASSET_CACHE_CONTROL;
  }

  if (urlPath.endsWith(".html")) {
    return STATIC_INDEX_CACHE_CONTROL;
  }

  return STATIC_PUBLIC_FILE_CACHE_CONTROL;
}

const APP_SHELL_FRAME_ANCESTORS = "frame-ancestors 'self'";

function createStaticResponseHeaders(args: StaticResponseHeadersArgs): Headers {
  const headers = new Headers();
  headers.set("content-type", args.contentType);
  headers.set("cache-control", staticCacheControlForPath(args.urlPath));

  if (args.contentType.startsWith("text/html")) {
    headers.set("content-security-policy", APP_SHELL_FRAME_ANCESTORS);
    headers.set("x-frame-options", "SAMEORIGIN");
  }

  if (args.etag !== undefined) {
    headers.set("etag", args.etag);
  }

  if (args.contentEncoding !== undefined) {
    headers.set("content-encoding", args.contentEncoding);
    headers.set("vary", "Accept-Encoding");
  }

  if (args.contentLength !== undefined) {
    headers.set("content-length", String(args.contentLength));
  }

  return headers;
}

const shellEtagCache = new Map<
  string,
  { etag: string; mtimeMs: number; size: number }
>();

async function shellEtag(filePath: string): Promise<string | undefined> {
  try {
    const fileStat = await stat(filePath);
    const cached = shellEtagCache.get(filePath);

    if (
      cached !== undefined &&
      cached.size === fileStat.size &&
      cached.mtimeMs === fileStat.mtimeMs
    ) {
      return cached.etag;
    }

    const digest = createHash("sha256")
      .update(await readFile(filePath))
      .digest("hex");

    const etag = `W/"${digest.slice(0, 32)}"`;
    shellEtagCache.set(filePath, {
      etag,
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
    });

    return etag;
  } catch {
    return undefined;
  }
}

const STATIC_MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".map": "application/json",
};

const originBundleRootV1 = fileURLToPath(
  new URL("./assets/origin-adoption-v1/", import.meta.url),
);

const originBundleManifestSchemaV1 = z
  .object({
    version: z.literal(1),
    files: z
      .array(
        z
          .object({
            path: z.string(),
            file: z
              .string()
              .regex(
                /^(?:origin-adoption-v1\.html|assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js)$/u,
              ),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            bytes: z
              .number()
              .int()
              .positive()
              .max(2 * 1024 * 1024),
          })
          .strict(),
      )
      .min(2)
      .max(16),
  })
  .strict();

async function originBundleManifestV1(directory: string) {
  const manifestPath = join(directory, "manifest.json");

  const [rootInfo, assetsInfo, manifestInfo] = await Promise.all([
    lstat(directory),
    lstat(join(directory, "assets")),
    lstat(manifestPath),
  ]);

  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    !assetsInfo.isDirectory() ||
    assetsInfo.isSymbolicLink() ||
    !manifestInfo.isFile() ||
    manifestInfo.isSymbolicLink() ||
    manifestInfo.size > 16384
  )
    throw new Error("Neutral origin bundle filesystem owner changed");

  const manifest = originBundleManifestSchemaV1.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );

  if (
    new Set(manifest.files.map((value) => value.path)).size !==
      manifest.files.length ||
    manifest.files.filter((value) => value.file === "origin-adoption-v1.html")
      .length !== 1 ||
    manifest.files.some(
      (value) =>
        value.path !==
        (value.file === "origin-adoption-v1.html"
          ? "/" + value.file
          : "/origin-adoption-v1/" + value.file),
    )
  )
    throw new Error(
      "Neutral origin bundle manifest does not match its finite owner",
    );

  return manifest;
}

export function registerOriginAdoptionStaticRoutesV1(
  app: Hono,
  owner: ServerMaintenance["originAdoption"],
  directory = originBundleRootV1,
) {
  const serve = async (
    context: Parameters<typeof originAdoptionRequestUrlV1>[0],
  ) => {
    const url = originAdoptionRequestUrlV1(context);

    if (
      url === null ||
      !(await owner.permitsRequest(
        url,
        context.req.method,
        context.req.header("origin"),
      ))
    )
      throw new ApiError(
        403,
        "origin_adoption_origin",
        "The selected held origin transfer is unavailable",
      );
    const target = new URL(url);
    const manifest = await originBundleManifestV1(directory);

    const selected = manifest.files.find(
      (value) => value.path === target.pathname,
    );

    if (selected === undefined)
      throw new ApiError(
        404,
        "not_found",
        "The origin transfer asset is unlisted",
      );
    const path = join(directory, selected.file);
    const info = await lstat(path);
    const bytes = await readFile(path);

    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== selected.bytes ||
      bytes.length !== selected.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== selected.sha256
    )
      throw new ApiError(
        409,
        "origin_adoption_asset",
        "The selected origin transfer asset changed",
      );

    return new Response(bytes, {
      headers: {
        "content-type": selected.file.endsWith(".html")
          ? "text/html; charset=utf-8"
          : "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  };

  app.get("/origin-adoption-v1.html", serve);
  app.get("/origin-adoption-v1/*", serve);
}

export function registerStaticAppRoutes(
  app: Hono,
  staticDir: string,
  retainedStaticDirs: string[] = [],
  webUpdate?: WebUpdateService,
  threadBootstrapAssetUrls?: () => readonly string[],
): void {
  const root = resolve(staticDir);

  const serveStaticAppFile = async (args: {
    acceptEncodingHeader: string | undefined;
    contentType: string;
    filePath: string;
    ifNoneMatchHeader: string | undefined;
    urlPath: string;
  }): Promise<Response> => {
    const etag =
      args.contentType === "text/html"
        ? await shellEtag(args.filePath)
        : undefined;

    if (
      etag !== undefined &&
      requestMatchesEntityTag(args.ifNoneMatchHeader, etag)
    ) {
      const headers = new Headers();
      headers.set("cache-control", staticCacheControlForPath(args.urlPath));
      headers.set("etag", etag);

      return new Response(null, { status: 304, headers });
    }

    const precompressedFile = await findPrecompressedStaticFile({
      acceptEncodingHeader: args.acceptEncodingHeader,
      contentType: args.contentType,
      filePath: args.filePath,
    });

    if (precompressedFile !== null) {
      const content = await readFile(precompressedFile.filePath);

      return new Response(content, {
        headers: createStaticResponseHeaders({
          contentEncoding: precompressedFile.encoding,
          contentLength: precompressedFile.contentLength,
          contentType: args.contentType,
          etag,
          urlPath: args.urlPath,
        }),
      });
    }

    const content = await readFile(args.filePath);

    return new Response(content, {
      headers: createStaticResponseHeaders({
        contentType: args.contentType,
        etag,
        urlPath: args.urlPath,
      }),
    });
  };

  if (webUpdate)
    app.post("/_omnyo/web-client/:id/release", async (context) => {
      await webUpdate.releaseClient(context.req.param("id"));

      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store" },
      });
    });

  const bindClient = async (
    response: Response,
    lease: string | null | undefined,
  ): Promise<Response> => {
    if (!lease) return response;

    if (!(response.headers.get("content-type") ?? "").startsWith("text/html")) {
      await webUpdate?.releaseClient(lease);

      return response;
    }

    const content = await response.text();
    const script = `<script>addEventListener("pagehide",function(e){if(!e.persisted)navigator.sendBeacon("/_omnyo/web-client/${lease}/release","")})</script>`;
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("etag");
    headers.set("content-length", String(Buffer.byteLength(content + script)));
    headers.set("cache-control", "private, no-store");

    return new Response(content + script, { status: response.status, headers });
  };

  app.get("*", async (context) => {
    const urlPath = context.req.path === "/" ? "/index.html" : context.req.path;

    const web = await webUpdate?.roots(
      !urlPath.startsWith("/assets/") &&
        (extname(urlPath) === ".html" || extname(urlPath) === ""),
    );

    const shellRoot = web?.shell ?? root;

    const roots = urlPath.startsWith("/assets/")
      ? [
          shellRoot,
          ...(web ? [web.assets] : []),
          root,
          ...retainedStaticDirs.map((directory) => resolve(directory)),
        ]
      : [shellRoot];

    for (const assetRoot of roots) {
      const filePath = join(assetRoot, urlPath);

      if (!filePath.startsWith(`${assetRoot}${sep}`)) return context.notFound();

      try {
        const fileStat = await stat(filePath);

        if (fileStat.isFile()) {
          const response = await serveStaticAppFile({
            acceptEncodingHeader: web?.clientLease
              ? undefined
              : context.req.header("accept-encoding"),
            contentType:
              STATIC_MIME_TYPES[extname(filePath)] ??
              "application/octet-stream",
            filePath,
            ifNoneMatchHeader: web?.clientLease
              ? undefined
              : context.req.header("if-none-match"),
            urlPath,
          });

          if (web?.sourceCommit && extname(filePath) === ".html")
            response.headers.set("x-omnyo-web-source", web.sourceCommit);

          return bindClient(response, web?.clientLease);
        }
      } catch (cause) {
        if (
          !z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) }).safeParse(cause)
            .success
        )
          throw cause;
      }
    }

    if (urlPath.startsWith("/assets/")) {
      return context.notFound();
    }

    const response = await serveStaticAppFile({
      acceptEncodingHeader: web?.clientLease
        ? undefined
        : context.req.header("accept-encoding"),
      contentType: "text/html",
      filePath: join(shellRoot, "index.html"),
      ifNoneMatchHeader: web?.clientLease
        ? undefined
        : context.req.header("if-none-match"),
      urlPath: "/index.html",
    });

    if (web?.sourceCommit)
      response.headers.set("x-omnyo-web-source", web.sourceCommit);

    if (/^\/(?:projects\/[^/]+\/)?threads\/[^/]+\/?$/u.test(context.req.path)) {
      for (const url of threadBootstrapAssetUrls?.() ?? []) {
        response.headers.append(
          "link",
          `<${url}>; rel=modulepreload; crossorigin=anonymous`,
        );
      }
    }

    return bindClient(response, web?.clientLease);
  });
}

function canServePrecompressedStaticFile(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/javascript" ||
    contentType === "application/json" ||
    contentType === "application/manifest+json" ||
    contentType === "application/wasm" ||
    contentType === "application/xml" ||
    contentType === "image/svg+xml"
  );
}

async function findPrecompressedStaticFile(args: {
  acceptEncodingHeader: string | undefined;
  contentType: string;
  filePath: string;
}): Promise<{
  contentLength: number;
  encoding: string;
  filePath: string;
} | null> {
  if (!canServePrecompressedStaticFile(args.contentType)) {
    return null;
  }

  for (const candidate of rankAcceptedAssetEncodings(
    args.acceptEncodingHeader,
    PRECOMPRESSED_STATIC_FILES,
  )) {
    const encodedFilePath = `${args.filePath}${candidate.extension}`;

    try {
      const encodedStat = await stat(encodedFilePath);

      if (encodedStat.isFile()) {
        return {
          contentLength: encodedStat.size,
          encoding: candidate.encoding,
          filePath: encodedFilePath,
        };
      }
    } catch {}
  }

  return null;
}

function closeWebSocketServer(args: CloseWebSocketServerArgs): Promise<void> {
  for (const client of args.server.clients) {
    client.close(WEB_SOCKET_SHUTDOWN_CODE, args.reason);
  }

  return new Promise<void>((resolvePromise, reject) => {
    const forceCloseTimeout = setTimeout(() => {
      for (const client of args.server.clients) {
        client.terminate();
      }
    }, args.forceCloseAfterMs);

    forceCloseTimeout.unref();

    args.server.close((error: WebSocketCloseError) => {
      clearTimeout(forceCloseTimeout);

      if (error) {
        reject(error);

        return;
      }

      resolvePromise();
    });
  });
}

export function createApp(
  deps: ServerAppDeps,
  options?: CreateAppOptions,
): ServerApp {
  const app = new Hono();

  registerThreadWorkRevisions(deps.db, deps.hub);

  deps.hub.setThreadListEntryResolver((threadId) =>
    buildThreadListEntry(deps, threadId),
  );

  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({
    app,
  });

  const slowApiRequestLogThresholdMs =
    options?.slowApiRequestLogThresholdMs ?? SLOW_API_REQUEST_LOG_THRESHOLD_MS;

  const omnyoAppArtifactService =
    options?.appArtifactService ??
    createOmnyoAppArtifactService({
      dataDir: deps.config.dataDir,
      serverEntryUrl: import.meta.url,
    });

  const hostArtifactSignatures = createHostArtifactSignatureReader({
    dataDir: deps.config.dataDir,
    logger: deps.logger,
  });

  const serverMoveOptions: ServerMoveAppOptions = options?.serverMove ?? {
    appSurface: APP_SURFACE_WEB,
    bindHost: null,
    manualImportPending: false,
    pending: null,
    restoredRun: null,
    retireProcess: () => {
      deps.logger.warn(
        {},
        "Server move finished, but this server has no process retire hook",
      );
    },
  };

  const pendingServerMove = serverMoveOptions.pending;

  app.post("/api/v1/threads/:id/shelve", async (context, next) => {
    const startedAt = performance.now();
    await next();

    if (context.res.ok) {
      const durationMs = roundDurationMs(performance.now() - startedAt);
      context.res.headers.append(
        "server-timing",
        `omnyo_shelve;dur=${durationMs};desc="${randomUUID()}"`,
      );
    }
  });
  app.use("*", async (context, next) => {
    const signal = context.req.raw.signal;
    await next();

    if (signal.aborted) await context.res.body?.cancel(signal.reason);
  });
  app.use("*", guardAnonymousGateRequests);
  app.use("*", async (context, next) => {
    const problem = requestHostProblem(context, deps);

    if (problem !== null) {
      const migrationUrl = originAdoptionRequestUrlV1(context);

      if (
        migrationUrl === null ||
        !(await maintenance.originAdoption.permitsRequest(
          migrationUrl,
          context.req.method,
          context.req.header("origin"),
        ))
      )
        throw new ApiError(problem.status, "forbidden_host", problem.error);
    }

    return next();
  });
  app.use("*", async (context, next) => {
    captureTrustedRemoteAddress(context);

    return runWithUsageRequest(
      {
        proof: context.req.header("x-omnyo-analytics-consent"),
        activity:
          context.req.method === "POST" &&
          (context.req.path === "/api/v1/threads" ||
            /^\/api\/v1\/threads\/[^/]+\/(send|queued-messages)$/.test(
              context.req.path,
            )),
        interactive:
          usageRequestEligible(context.req.path, context.req.method) &&
          context.req.header("x-omnyo-user-activity") === "1" &&
          !context.req.header("x-omnyo-caller-thread-id") &&
          !context.req.header("x-omnyo-automation-id") &&
          !context.req.header("x-omnyo-automation-run-id") &&
          !context.req.header("x-omnyo-caller-plugin") &&
          getGateAuthKind(context) !== "machine",
      },
      async () => {
        const operation =
          context.req.method === "POST" &&
          context.req.path === "/api/v1/threads"
            ? "new_chat"
            : context.req.method === "POST" &&
                /^\/api\/v1\/threads\/[^/]+\/(send|queued-messages)$/.test(
                  context.req.path,
                )
              ? "message"
              : null;

        const startedAt = performance.now();

        try {
          await next();
        } finally {
          if (operation) {
            const elapsed = performance.now() - startedAt;
            deps.telemetry.capture({
              name: "operation_finished",
              properties: {
                operation,
                outcome: context.res.status < 400 ? "accepted" : "failed",
                latency:
                  elapsed < 1000
                    ? "under_1s"
                    : elapsed < 5000
                      ? "1_to_5s"
                      : elapsed < 30000
                        ? "5_to_30s"
                        : "over_30s",
              },
            });
          }
        }
      },
    );
  });
  app.use("*", async (context, next) => {
    const path = context.req.path;

    if (!path.startsWith("/api/v1/") && !path.startsWith("/internal/")) {
      return next();
    }

    return runEventLoopWork(`${context.req.method} ${path}`, next);
  });

  const appCors = cors({
    origin: (origin, context) => {
      if (context.req.path === "/health") {
        return "*";
      }

      const allowedCorsOrigins = allowedAppOrigins(deps);
      const requestOrigin = new URL(context.req.url).origin;

      if (origin === requestOrigin || allowedCorsOrigins.has(origin)) {
        return origin;
      }

      return null;
    },
  });

  const assetCors = cors({ origin: "*", allowMethods: ["GET", "HEAD"] });

  app.use("*", (context, next) => {
    if (context.req.path.startsWith("/preview-content/")) return next();

    return (context.req.path.startsWith("/assets/") ? assetCors : appCors)(
      context,
      next,
    );
  });
  const compressResponse = compress();
  const compressApiJson = apiJsonCompression();
  app.use("*", (context, next) => {
    if (PLUGIN_APP_ASSET_PATH_PATTERN.test(context.req.path)) {
      return next();
    }

    return compressResponse(context, async () => {
      await compressApiJson(context, next);
    });
  });
  app.onError(createServerErrorHandler(deps.logger));
  app.get("/health", async (context) => {
    const serverMove = await readServerMoveHealth({
      dataDir: deps.config.dataDir,
      pending: pendingServerMove,
    });

    return context.json({
      ok: true,
      ...(deps.config.launchId === undefined
        ? {}
        : { launchId: deps.config.launchId }),
      ...(serverMove === null ? {} : { serverMove }),
    });
  });
  app.get("/install.sh", async (context) => {
    const enrollment = readEnrollmentHeaderV1(context.req.raw.headers);

    if (enrollment.kind === "invalid") {
      return new Response(
        "echo 'This enrollment command has already been used, replaced, or expired. Generate a new command in Omnyo.' >&2\nexit 1\n",
        {
          status: 403,
          headers: {
            "cache-control": "no-store",
            "content-type": "text/x-shellscript; charset=utf-8",
          },
        },
      );
    }

    const script = await readFile(INSTALL_MACHINE_SCRIPT_PATH, "utf8");

    const credential =
      enrollment.kind === "credential" ? enrollment.credential : undefined;

    let bootstrap =
      credential === undefined
        ? null
        : await getMachineEnrollmentService(deps).pendingBootstrapForCredential(
            credential,
          );

    if (credential !== undefined && bootstrap === null) {
      try {
        bootstrap = await reconnectBootstrapForCredential(deps, credential);
      } catch (error) {
        deps.logger.warn({ error }, "Could not refresh machine access");

        return new Response(
          "echo 'Could not refresh machine access. Run the command again, or generate a new one in Omnyo.' >&2\nexit 1\n",
          {
            status: 503,
            headers: {
              "cache-control": "no-store",
              "content-type": "text/x-shellscript; charset=utf-8",
            },
          },
        );
      }
    }

    if (credential !== undefined && bootstrap === null) {
      return new Response(
        "echo 'This enrollment command has already been used, replaced, or expired. Generate a new command in Omnyo.' >&2\nexit 1\n",
        {
          status: 403,
          headers: {
            "cache-control": "no-store",
            "content-type": "text/x-shellscript; charset=utf-8",
          },
        },
      );
    }

    return new Response(
      bootstrap === null ? script : enrolledInstallerScript(script, bootstrap),
      {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/x-shellscript; charset=utf-8",
        },
      },
    );
  });
  app.get("/install.ps1", async (context) => {
    const headers = {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    };

    const enrollment = readEnrollmentHeaderV1(context.req.raw.headers);

    if (enrollment.kind === "invalid") {
      return new Response(
        windowsInstallerFailureScript(
          "This enrollment command has already been used, replaced, or expired. Generate a new command in Omnyo.",
        ),
        { headers },
      );
    }

    const credential =
      enrollment.kind === "credential" ? enrollment.credential : undefined;

    if (credential === undefined) {
      return new Response(
        windowsInstallerFailureScript(
          "This installer needs an enrollment command. Generate one in Omnyo under Settings, Machines.",
        ),
        { headers },
      );
    }

    let bootstrap =
      await getMachineEnrollmentService(deps).pendingBootstrapForCredential(
        credential,
      );

    if (bootstrap === null) {
      try {
        bootstrap = await reconnectBootstrapForCredential(deps, credential);
      } catch (error) {
        deps.logger.warn({ error }, "Could not refresh machine access");

        return new Response(
          windowsInstallerFailureScript(
            "Could not refresh machine access. Run the command again, or generate a new one in Omnyo.",
          ),
          { headers },
        );
      }
    }

    if (bootstrap === null) {
      return new Response(
        windowsInstallerFailureScript(
          "This enrollment command has already been used, replaced, or expired. Generate a new command in Omnyo.",
        ),
        { headers },
      );
    }

    return new Response(
      enrolledWindowsInstallerScript(
        await readFile(INSTALL_MACHINE_WINDOWS_SCRIPT_PATH, "utf8"),
        bootstrap,
      ),
      { headers },
    );
  });
  registerShortEnrollmentRoutes(app, deps, {
    shell: () => readFile(INSTALL_MACHINE_SCRIPT_PATH, "utf8"),
    windows: () => readFile(INSTALL_MACHINE_WINDOWS_SCRIPT_PATH, "utf8"),
  });
  registerPrivateUpdateFeedRoutes(app, deps.config.dataDir, deps.logger);
  app.get("/install/version", async (context) => {
    const [version, artifact] = await Promise.all([
      omnyoAppArtifactService.getVersion(),
      omnyoAppArtifactService.getArtifact(),
    ]);

    const signature = await hostArtifactSignatures.read({
      version,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      digest: artifact.digest,
    });

    return context.json({
      version,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      artifactDigest: artifact.digest,
      artifactSignature: signature?.signature ?? null,
      artifactSignatureKeyId: signature?.keyId ?? null,
    });
  });
  app.get("/install/omnyo-app.tgz", async (context) => {
    try {
      const [version, artifact] = await Promise.all([
        omnyoAppArtifactService.getVersion(),
        omnyoAppArtifactService.getArtifact(),
      ]);

      const signature = await hostArtifactSignatures.read({
        version,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        digest: artifact.digest,
      });

      const etag = `"sha256-${artifact.digest}"`;

      const headers = {
        "cache-control": "public, max-age=300",
        "content-type": "application/gzip",
        etag,
        "x-omnyo-artifact-sha256": artifact.digest,
        ...(signature === null
          ? {}
          : {
              "x-omnyo-artifact-signature": signature.signature,
              "x-omnyo-artifact-signature-key-id": signature.keyId,
            }),
      };

      if (context.req.header("if-none-match") === etag) {
        return new Response(null, { headers, status: 304 });
      }

      const tarball = await readFile(artifact.path);

      return new Response(tarball, {
        headers: { ...headers, "content-length": String(artifact.size) },
      });
    } catch (error) {
      const diagnosticId = randomUUID();

      const code =
        error instanceof Error && "code" in error ? error.code : undefined;

      const reason =
        code === "ENOENT"
          ? "A required server package file or packaging tool is missing."
          : code === "EACCES" || code === "EPERM"
            ? "The server lacks permission to prepare or read the host package."
            : code === "ENOSPC"
              ? "The server ran out of disk space while preparing the host package."
              : "The server could not build or read its host package.";

      deps.logger.error(
        { err: error, diagnosticId },
        "Host package download failed",
      );

      return context.json(
        {
          code: "host_package_unavailable",
          message: `${reason} Check the server logs for diagnostic ID ${diagnosticId}, then retry installation.`,
          diagnosticId,
        },
        500,
        { "cache-control": "no-store" },
      );
    }
  });
  app.get("/install/*", (context) =>
    context.json(
      {
        code: "install_route_not_served",
        message:
          "This Omnyo server does not serve this install path. Machines download /install/omnyo-app.tgz.",
      },
      410,
      { "cache-control": "no-store" },
    ),
  );
  app.use("/api/v1/*", async (context, next) => {
    const startedAt = performance.now();
    await next();
    const durationMs = performance.now() - startedAt;
    const path = context.req.path;

    const diagnosticsEnabled =
      options?.performanceDiagnosticsEnabled?.() ?? false;

    if (
      shouldLogSlowApiRequest({
        durationMs,
        path,
        thresholdMs: diagnosticsEnabled ? 100 : slowApiRequestLogThresholdMs,
      })
    ) {
      const log = diagnosticsEnabled
        ? deps.logger.info.bind(deps.logger)
        : deps.logger.debug.bind(deps.logger);

      log(
        {
          durationMs: roundDurationMs(durationMs),
          method: context.req.method,
          path,
          status: context.res.status,
        },
        "Slow API request",
      );
    }
  });
  app.use("/internal/*", async (context, next) => {
    const normalizedPath = normalizeInternalAuthPath(context.req.path);

    if (normalizedPath === "/internal/hosts/enroll-key") {
      return next();
    }

    if (normalizedPath === "/internal/hosts/enroll") {
      return next();
    }

    if (normalizedPath === "/internal/ws") {
      return next();
    }

    if (normalizedPath === INTERNAL_SERVER_MOVE_PENDING_PATH) {
      return next();
    }

    try {
      const daemon = await verifyAuthenticatedDaemon(
        deps,
        context.req.header("authorization"),
      );

      setAuthenticatedDaemon(context, daemon);
    } catch {
      return unauthorizedResponse();
    }

    return next();
  });

  const pluginService = createPluginService({
    machineEnrollments: getMachineEnrollmentService(deps),
    db: deps.db,
    hub: deps.hub,
    logger: deps.logger,
    telemetry: deps.telemetry,
    pendingInteractions: deps.pendingInteractions,
    dataDir: deps.config.dataDir,
    vault: deps.vault,
    appVersion: deps.config.appVersion,
    getAppUrl: () => deps.config.appUrl ?? null,
    sharedPorts: deps.sharedPorts,
    providerRegistry: deps.providerRegistry,
    pluginHostArtifacts: deps.pluginHostArtifacts,
    aiServices: deps.aiServices,
    ensureSharedPortTunnel: (hostId) =>
      deps.sharedPorts.ensureTunnelIdentity(hostId, () =>
        callHostRetryableOnlineRpcForWork(deps, {
          command: { type: "connect-tunnel.ensure-identity" },
          hostId,
          timeoutMs: 30_000,
        }),
      ),
    callPluginHost: (args) => callPluginHostRpc(deps, args),
    disposePluginHost: (args) => disposePluginHostWorkers(deps, args),
    onSettingsChanged: (pluginId) => {
      deps.providerNativeRoots.invalidate(pluginId);
      deps.providerRegistry.forgetAllInstalled();
    },
    onPluginUnregistered: (pluginId) => {
      requestQueuedMessageDispatch(deps, {
        kind: "plugin-unregistered",
        pluginId,
      });
    },

    requestQueueDrain: () => {
      requestQueuedMessageDispatch(deps, { kind: "plugin-recheck" });
    },
    watchBuiltinPluginSources:
      process.env.OMNYO_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD === "1",
  });

  deps.pendingInteractions.setThreadInteractionSettledListener((threadId) => {
    requestQueuedMessageDispatch(deps, {
      kind: "interaction-settled",
      threadId,
    });
  });
  setThreadWorkContributorStates(deps.db, () =>
    pluginService.getThreadWorkContributorStates(),
  );

  setPluginThreadEventEmitter(pluginService.events);

  setPluginHookProvider(pluginService.hooks);
  setPluginEnvironmentProviderBridge(pluginService.environmentProviders);
  setEnvironmentProvisioningRecheckHandler((threadId) =>
    recheckEnvironmentProvisioning(deps, threadId),
  );
  setPluginMachineProviderBridge(
    withManualMachineProvider(
      pluginService.machineProviders,
      getMachineEnrollmentService(deps),
    ),
  );
  setServerAccessBridge(pluginService.serverAccessProviders);
  setPluginEventSourceBridge(pluginService.eventSources);
  setServerAccessRecheckHandler(() => {
    deps.hub.notifySystem(["config-changed"]);
  });
  setEnvironmentProviderRecheckHandler((pluginId) => {
    invalidateEnvironmentProviderMachineAvailability();
    deps.hub.notifySystem(["config-changed"]);
    void recheckEnvironmentProviderCreations(deps, pluginId);
  });

  setPluginAgentContributions(pluginService);

  const serverMove = createServerMoveCoordinator(
    createDefaultServerMoveEnvironment({
      appSurface: serverMoveOptions.appSurface,
      bindHost: serverMoveOptions.bindHost,
      deps,
      env: process.env,
      pluginService,
      retireProcess: serverMoveOptions.retireProcess,
      serverEntryUrl: import.meta.url,
    }),
  );

  if (serverMoveOptions.restoredRun !== null) {
    serverMove.restore(serverMoveOptions.restoredRun);
  }

  const maintenance = createServerMaintenance(deps, pluginService, {
    originAdoptionAssets: async () =>
      (await originBundleManifestV1(originBundleRootV1)).files.map(
        (value) => value.path,
      ),
  });

  registerOriginAdoptionStaticRoutesV1(app, maintenance.originAdoption);

  if (
    pendingServerMove !== null ||
    serverMoveOptions.manualImportPending ||
    serverMove.isFrozen() ||
    maintenance.isHeld()
  ) {
    pluginService.reconcileFrozenBoot();
  }

  const serverMoveFreezeState = {
    isFrozen: () =>
      pendingServerMove !== null ||
      serverMove.isFrozen() ||
      maintenance.isHeld(),
  };

  const daemonWriteFreezeState = {
    isFrozen: () =>
      pendingServerMove !== null ||
      isServerMoveSnapshotFenced(deps.db) ||
      maintenance.isHeld(),
  };

  app.use("/api/v1/*", serverMoveFreezeMiddleware(serverMoveFreezeState));

  app.use(
    "/internal/hosts/enroll-key",
    serverMoveWriteFreezeMiddleware(serverMoveFreezeState),
  );
  app.use("/internal/hosts/enroll", async (context, next) => {
    if (!serverMoveFreezeState.isFrozen()) return next();

    const payload = hostDaemonEnrollRequestSchema.safeParse(
      await context.req.raw
        .clone()
        .json()
        .catch(() => null),
    );

    if (
      pendingServerMove !== null ||
      !payload.success ||
      !maintenance.canEnrollStartupTarget(payload.data.hostId)
    )
      throw serverMovingError();

    const releaseAdmission = maintenance.reserveStartupEnrollment(
      payload.data.hostId,
    );

    try {
      await next();
    } finally {
      releaseAdmission();
    }
  });

  for (const path of [
    "/internal/session/events",
    "/internal/session/tool-call",
    "/internal/session/interactive-request",
    "/internal/session/interactive-request/interrupt",
  ]) {
    app.use(path, serverMoveWriteFreezeMiddleware(daemonWriteFreezeState));
  }

  const publicApi = new Hono();
  publicApi.use("*", async (context, next) => {
    if (PLUGIN_WIRE_HTTP_PATH.test(context.req.path)) {
      return next();
    }

    const problem = browserRequestProblem(context, deps);

    if (problem !== null) {
      const migrationUrl = originAdoptionRequestUrlV1(context);

      const migrationControl =
        context.req.method === "POST" &&
        context.req.path === originAdoptionControlPathV1 &&
        context.req
          .header("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() === "application/json" &&
        migrationUrl !== null &&
        (await maintenance.originAdoption.permitsRequest(
          migrationUrl,
          context.req.method,
          context.req.header("origin"),
        ));

      if (!migrationControl)
        throw new ApiError(problem.status, "forbidden_origin", problem.error);
    }

    return next();
  });

  const pluginCatalogService = createPluginCatalogService({
    db: deps.db,
    appVersion: deps.config.appVersion,
    dataDir: deps.config.dataDir,
    plugins: pluginService,
    consolidatedInto: (id) => pluginService.consolidatedInto(id),
    notifyCatalogChanged: () => deps.hub.notifySystem(["plugins-changed"]),
    warn: (message) => deps.logger.warn(message),
  });

  registerProjectRoutes(publicApi, deps);
  registerPromptHistoryRoutes(publicApi, deps);
  registerThreadSectionRoutes(publicApi, deps);
  registerThreadGroupRoutes(publicApi, deps);
  registerFileRoutes(publicApi, deps);
  registerHostRoutes(publicApi, deps, pluginService);
  registerDesktopBrowserRoutes(publicApi, deps);
  registerTerminalRoutes(publicApi, deps);
  registerPreviewRoutes(publicApi, deps);
  registerEnvironmentRoutes(publicApi, deps);
  registerThreadRoutes(publicApi, deps, maintenance, pluginService);
  registerQueueRoutes(publicApi, deps);
  registerInboxRoutes(publicApi, deps);
  registerSystemRoutes(publicApi, deps, pluginService);
  registerWebErrorReportingRoutes(publicApi, deps);
  registerBootRoutes(publicApi, {
    dataDir: deps.config.dataDir,
    dispatch: (request, env) => app.fetch(request, env),
  });

  const webUpdate = new WebUpdateService(
    deps.config.dataDir,
    options?.staticDir,
    () => isServerRestartDraining(deps.db),
    () => deps.hub.notifySystem(["web-generation-changed"]),
  );

  registerWebUpdateRoutes(publicApi, webUpdate);
  registerUiPreferenceRoutes(publicApi, deps);

  const pluginInstallJobs = createPluginInstallJobs({
    notifyChanged: () => deps.hub.notifySystem(["plugin-install-jobs-changed"]),
  });

  const pluginUpdateJobs = createPluginUpdateJobs({
    notifyChanged: () => deps.hub.notifySystem(["plugin-update-jobs-changed"]),
  });

  registerPluginUpdateJobRoutes(publicApi, pluginUpdateJobs);
  registerPluginInstallJobRoutes(publicApi, pluginInstallJobs);
  registerPluginCatalogRoutes(
    publicApi,
    pluginCatalogService,
    pluginInstallJobs,
  );
  registerPluginRoutes(
    publicApi,
    deps,
    pluginService,
    pluginInstallJobs,
    pluginUpdateJobs,
    upgradeWebSocket,
  );
  registerSkillsRegistryRoutes(publicApi, deps);
  registerServerMoveRoutes(publicApi, deps, serverMove);
  registerServerMaintenanceRoutes(publicApi, maintenance);

  const previewTransport = registerPreviewTransport(
    app,
    {
      logger: deps.logger,
      resolveBinding: async (id) => {
        const row = requirePreview(deps, id);
        const state = await previewStatus(deps, id);

        if (state.state !== "online" || state.runId === null) {
          deps.logger.warn(
            {
              previewId: id,
              hostId: row.hostId,
              runId: state.runId,
              state: state.state,
              detailCategory:
                state.detail ===
                "Server process ownership could not be checked."
                  ? "ownership"
                  : state.detail ===
                      "Could not check the preview on its computer"
                    ? "host-rpc"
                    : state.state,
            },
            "Preview binding not ready",
          );
          throw new ApiError(
            503,
            "preview_not_ready",
            state.detail ?? "The preview is not running",
          );
        }

        return {
          id: row.id,
          hostId: row.hostId,
          sessionId: requireConnectedHostSession(deps, row.hostId).id,
          runId: state.runId,
          localUrl: row.url,
        };
      },
      validateBinding: async (expected) => {
        const row = requirePreview(deps, expected.id);
        const session = requireConnectedHostSession(deps, row.hostId);

        if (
          row.hostId !== expected.hostId ||
          session.id !== expected.sessionId ||
          new URL(row.url).origin !== new URL(expected.localUrl).origin
        )
          throw new ApiError(
            409,
            "preview_run_changed",
            "The preview server changed. Reopen the preview from Omnyo.",
            false,
          );
      },
      call: async (binding, command, timeoutMs) => {
        const startedAt = performance.now();

        try {
          return await callHostOnlineRpc(deps, {
            hostId: binding.hostId,
            command,
            timeoutMs,
          });
        } catch (error) {
          deps.logger.warn(
            {
              previewId: binding.id,
              runId: binding.runId,
              hostId: binding.hostId,
              expectedSessionId: binding.sessionId,
              liveSessionId: deps.hub.getDaemonSessionIdForHost(binding.hostId),
              commandType: command.type,
              connectionId:
                "connectionId" in command ? command.connectionId : null,
              elapsedMs: Math.round(performance.now() - startedAt),
              errorCode:
                error instanceof ApiError ? error.body.code : "unexpected",
            },
            "Preview host RPC failed",
          );
          throw error;
        }
      },
      browserProblem: (context) =>
        browserRequestProblem(context, deps, { requireJsonForMutation: true }),
    },
    upgradeWebSocket,
  );

  app.route("/api/v1", publicApi);
  app.use("/api/v1/*", () => {
    throw new ApiError(404, "not_found", "Not found");
  });

  const internalApi = new Hono();
  registerInternalHostRoutes(internalApi, deps);
  registerInternalSessionRoutes(internalApi, deps, pluginService, {
    movedTo: () => serverMove.movedTo(),
    pendingMoveId: () => pendingServerMove?.moveId ?? null,
    sessionOpened: createManualServerImportCompletion({
      deps,
      pending: serverMoveOptions.manualImportPending,
    }),
  });
  registerInternalServerMoveRoutes(internalApi, deps, {
    pending: pendingServerMove,
    serverMove,
  });
  registerInternalSkillRoutes(internalApi, deps);
  registerInternalPluginHostArtifactRoutes(internalApi, deps);
  registerInternalEventRoutes(internalApi, deps);
  registerInternalToolCallRoutes(internalApi, deps);
  registerInternalInteractiveRequestRoutes(internalApi, deps);
  app.route("/internal", internalApi);

  const assertBrowserWebSocketAllowed = (
    context: Parameters<typeof browserRequestProblem>[0],
  ): void => {
    const problem = browserRequestProblem(context, deps);

    if (problem !== null) {
      throw new ApiError(
        problem.status,
        "forbidden_origin",
        problem.error,
        false,
      );
    }
  };

  app.get(
    "/ws",
    upgradeWebSocket((context) => {
      assertBrowserWebSocketAllowed(context);

      return {
        onOpen: (_event, socket) => onClientSocketOpen(deps.hub, socket),
        onMessage: (event, socket) =>
          onClientSocketMessage(deps, socket, event.data),
        onClose: (_event, socket) => onClientSocketClose(deps, socket),
      };
    }),
  );

  app.get(
    "/ws/terminals/:terminalId",
    upgradeWebSocket((context) => {
      assertBrowserWebSocketAllowed(context);
      const terminalId = z.string().parse(context.req.param("terminalId"));

      const query = terminalWebSocketQuerySchema.safeParse({
        outputAcks: context.req.query("outputAcks"),
        sinceSeq: context.req.query("sinceSeq"),
      });

      if (!query.success) {
        throw new ApiError(
          400,
          "invalid_terminal_socket_query",
          "Terminal websocket sinceSeq must be a non-negative integer and outputAcks must be 0 or 1",
        );
      }

      return {
        onOpen: (_event, socket) =>
          onTerminalSocketOpen(deps, {
            outputAcks: query.data.outputAcks,
            socket,
            sinceSeq: query.data.sinceSeq,
            terminalId,
          }),
        onMessage: (event, socket) =>
          onTerminalSocketMessage(deps, {
            raw: event.data,
            socket,
            terminalId,
          }),
        onClose: (_event, socket) =>
          onTerminalSocketClose(deps, {
            socket,
            terminalId,
          }),
      };
    }),
  );

  app.post("/internal/server-access/direct-proof", async (context) => {
    const input = z
      .object({ challenge: z.string().min(1), instanceId: z.string().min(1) })
      .strict()
      .parse(await context.req.json());

    return context.json(
      observeDirectProof(
        deps,
        {
          ...getAuthenticatedDaemon(context),
          challenge: input.challenge,
          instanceId: input.instanceId,
        },
        "http",
      ),
    );
  });
  app.get(
    "/internal/server-access/direct-proof/ws",
    upgradeWebSocket((context) => {
      const input = {
        ...getAuthenticatedDaemon(context),
        challenge: context.req.query("challenge") ?? "",
        instanceId: context.req.query("instanceId") ?? "",
      };

      return {
        onOpen: (_event, socket) => {
          try {
            const receipt = observeDirectProof(deps, input, "ws");
            socket.send(JSON.stringify(receipt));
            socket.close(1000);
          } catch {
            socket.close(1008, "direct-proof-refused");
          }
        },
      };
    }),
  );

  app.get(
    "/internal/ws",
    upgradeWebSocket(async (context) => {
      const websocketContext = await validateDaemonWebSocket(deps, {
        authorizationHeader: context.req.header("authorization"),
        protocolHeader: context.req.header("sec-websocket-protocol"),
        sessionId: context.req.query("sessionId") ?? null,
      });

      return {
        onOpen: (_event, socket) => {
          confirmDirectPrimary(
            deps,
            websocketContext.hostId,
            websocketContext.sessionId,
            context.req.header("x-omnyo-direct-proof"),
          );
          onDaemonSocketOpen(deps, { ...websocketContext, socket });
        },
        onMessage: (event, socket) =>
          onDaemonSocketMessage(
            deps,
            {
              hostId: websocketContext.hostId,
              raw: event.data,
              sessionId: websocketContext.sessionId,
              socket,
            },
            pluginService,
            serverMove,
          ),
        onClose: () => onDaemonSocketClose(deps, websocketContext.sessionId),
      };
    }),
  );

  if (options?.staticDir) {
    registerStaticAppRoutes(
      app,
      options.staticDir,
      options.retainedStaticDirs,
      webUpdate,
      () => pluginService.getThreadBootstrapAssetUrls(),
    );
  } else {
    app.get("/", (context) => context.text("Omnyo server"));
  }

  return {
    app,
    closeWebSockets: async () => {
      await previewTransport.dispose();
      await closeWebSocketServer({
        forceCloseAfterMs: WEB_SOCKET_SHUTDOWN_FORCE_CLOSE_MS,
        reason: WEB_SOCKET_SHUTDOWN_REASON,
        server: wss,
      });
    },
    injectWebSocket,
    pluginService,
    maintenance,
    pluginCatalogService,
    serverMove,
    webUpdate,
  };
}
