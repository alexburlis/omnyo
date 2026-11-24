import type { DesktopRendererProfile } from "@omnyo/host-daemon-contract";
import type { WebContents } from "electron";
import { z } from "zod";

type ProfileContents = Pick<WebContents, "getURL" | "isDestroyed"> & {
  debugger: Pick<
    WebContents["debugger"],
    "attach" | "detach" | "isAttached" | "sendCommand"
  > & {
    on(event: "detach", listener: () => void): void;
    on(
      event: "message",
      listener: (_event: unknown, method: string, params: unknown) => void,
    ): void;
    off(event: "detach", listener: () => void): void;
    off(
      event: "message",
      listener: (_event: unknown, method: string, params: unknown) => void,
    ): void;
  };
  on(event: "did-start-navigation" | "destroyed", listener: () => void): void;
  off(event: "did-start-navigation" | "destroyed", listener: () => void): void;
};

const activeCaptures = new WeakSet<ProfileContents>();

const sampleIntervalUs = 1000;

const commandTimeoutMs = 1000;

const maxNodes = 20000;

const maxSamples = 20000;

const maxHotspots = 100;

const assetPathPattern = /^\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/u;

const profileSchema = z.object({
  profile: z.object({
    nodes: z.custom<unknown[]>(Array.isArray),
    samples: z.custom<unknown[]>(Array.isArray),
    startTime: z.number().finite().nonnegative(),
    endTime: z.number().finite().nonnegative(),
  }),
});

const nodeSchema = z.object({
  id: z.number().int().nonnegative(),
  callFrame: z.object({
    scriptId: z.string().max(128),
    functionName: z.string(),
    url: z.string().max(32768),
    lineNumber: z.number().int().min(-1).max(9999999),
    columnNumber: z.number().int().min(-1).max(9999999),
  }),
});

const scriptSchema = z.object({
  scriptId: z.string().min(1).max(128),
  url: z.string().max(32768),
  hasSourceURL: z.boolean().optional(),
});

type Hotspot = DesktopRendererProfile["hotspots"][number];

type Builtin = keyof DesktopRendererProfile["builtinSamples"];

type Attribution =
  | { kind: "asset"; hotspot: Omit<Hotspot, "hits"> }
  | { kind: "builtin"; bucket: Builtin };

function assetPath(value: string, origin: string): string | undefined {
  try {
    const url = new URL(value);

    if (
      url.origin === origin &&
      !url.username &&
      !url.password &&
      url.pathname.length <= 256 &&
      assetPathPattern.test(url.pathname)
    )
      return url.pathname;
  } catch {}

  return undefined;
}

function sanitizeProfile(
  value: unknown,
  resourceScripts: ReadonlyMap<string, string>,
  metadataTruncated: boolean,
  requestedDurationMs: number,
): DesktopRendererProfile {
  const parsed = profileSchema.safeParse(value);

  if (
    !parsed.success ||
    parsed.data.profile.endTime < parsed.data.profile.startTime ||
    parsed.data.profile.endTime - parsed.data.profile.startTime > 60000000 ||
    parsed.data.profile.samples.length > 1000000
  )
    throw new Error("Renderer profile data is invalid");

  const profile = parsed.data.profile;
  const nodes = new Map<number, Attribution | undefined>();
  const hotspots = new Map<string, Hotspot>();
  const builtinSamples = { idle: 0, program: 0, garbageCollection: 0 };
  const totalSamples = profile.samples.length;
  let omittedSamples = Math.max(0, totalSamples - maxSamples);

  let truncated =
    metadataTruncated ||
    profile.nodes.length > maxNodes ||
    totalSamples > maxSamples;

  for (
    let index = 0;
    index < Math.min(profile.nodes.length, maxNodes);
    index += 1
  ) {
    const parsedNode = nodeSchema.safeParse(profile.nodes[index]);

    if (!parsedNode.success) continue;
    const node = parsedNode.data;

    if (nodes.has(node.id)) throw new Error("Renderer profile data is invalid");
    const frame = node.callFrame;
    const path = resourceScripts.get(frame.scriptId);
    let attribution: Attribution | undefined;

    if (path && frame.lineNumber >= 0 && frame.columnNumber >= 0) {
      attribution = {
        kind: "asset",
        hotspot: {
          assetPath: path,
          line: frame.lineNumber + 1,
          column: frame.columnNumber + 1,
        },
      };
    } else if (frame.url === "") {
      const bucket =
        frame.functionName === "(idle)"
          ? "idle"
          : frame.functionName === "(program)"
            ? "program"
            : frame.functionName === "(garbage collector)"
              ? "garbageCollection"
              : undefined;

      if (bucket) attribution = { kind: "builtin", bucket };
    }

    nodes.set(node.id, attribution);
  }

  for (let index = 0; index < Math.min(totalSamples, maxSamples); index += 1) {
    const sample = profile.samples[index];

    const attribution =
      typeof sample === "number" && Number.isSafeInteger(sample)
        ? nodes.get(sample)
        : undefined;

    if (!attribution) {
      omittedSamples += 1;
    } else if (attribution.kind === "builtin") {
      builtinSamples[attribution.bucket] += 1;
    } else {
      const { hotspot } = attribution;
      const key = `${hotspot.assetPath}:${hotspot.line}:${hotspot.column}`;
      const previous = hotspots.get(key);

      if (previous) previous.hits += 1;
      else hotspots.set(key, { ...hotspot, hits: 1 });
    }
  }

  const sorted = [...hotspots.values()].sort(
    (a, b) =>
      b.hits - a.hits ||
      (a.assetPath < b.assetPath ? -1 : a.assetPath > b.assetPath ? 1 : 0) ||
      a.line - b.line ||
      a.column - b.column,
  );

  if (sorted.length > maxHotspots) {
    truncated = true;

    for (const hotspot of sorted.slice(maxHotspots))
      omittedSamples += hotspot.hits;
  }

  return {
    requestedDurationMs,
    actualDurationMs: (profile.endTime - profile.startTime) / 1000,
    sampleIntervalUs,
    totalSamples,
    omittedSamples,
    hotspots: sorted.slice(0, maxHotspots),
    builtinSamples,
    truncated,
  };
}

export async function profileDesktopRenderer({
  webContents,
  durationMs,
}: {
  webContents: ProfileContents;
  durationMs: number;
}): Promise<DesktopRendererProfile> {
  if (webContents.isDestroyed())
    throw new Error("Renderer target is unavailable");

  if (activeCaptures.has(webContents))
    throw new Error("Renderer profiling is busy");
  const debuggerApi = webContents.debugger;

  if (debuggerApi.isAttached())
    throw new Error("Renderer debugger is already attached");

  let origin: string;

  try {
    const url = new URL(webContents.getURL());

    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
    origin = url.origin;
  } catch {
    throw new Error("Renderer app origin is unavailable");
  }

  activeCaptures.add(webContents);
  let ownsAttachment = false;
  let needsStop = false;
  let invalidated = false;
  const resourceScripts = new Map<string, string>();
  let metadataCount = 0;
  let metadataTruncated = false;
  let resolveInvalidation: () => void = () => {};

  const invalidation = new Promise<void>((resolve) => {
    resolveInvalidation = resolve;
  });

  const invalidate = () => {
    invalidated = true;
    resolveInvalidation();
  };

  const detached = () => {
    ownsAttachment = false;
    invalidate();
  };

  const scriptParsed = (_event: unknown, method: string, params: unknown) => {
    if (method !== "Debugger.scriptParsed" || !ownsAttachment || invalidated)
      return;
    metadataCount += 1;

    if (metadataCount > maxNodes) {
      metadataTruncated = true;

      return;
    }

    const parsed = scriptSchema.safeParse(params);

    if (!parsed.success) return;
    const script = parsed.data;
    resourceScripts.delete(script.scriptId);

    if (script.hasSourceURL === true) return;
    const path = assetPath(script.url, origin);

    if (path) resourceScripts.set(script.scriptId, path);
  };

  const requireCurrent = () => {
    if (
      invalidated ||
      webContents.isDestroyed() ||
      !ownsAttachment ||
      !debuggerApi.isAttached()
    )
      throw new Error("Renderer target changed during profiling");
  };

  async function command(
    method: string,
    params?: Record<string, number | boolean>,
    cleanup = false,
  ): Promise<unknown> {
    const requireOwnership = () => {
      if (
        !ownsAttachment ||
        webContents.isDestroyed() ||
        !debuggerApi.isAttached()
      )
        throw new Error("Renderer target changed during profiling");

      if (!cleanup) requireCurrent();
    };

    requireOwnership();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const result = await Promise.race([
        Promise.resolve()
          .then(() => {
            requireOwnership();

            return debuggerApi.sendCommand(method, params);
          })
          .catch(() => {
            throw new Error("Renderer profiler command failed");
          }),
        ...(cleanup
          ? []
          : [
              invalidation.then(() => {
                throw new Error("Renderer target changed during profiling");
              }),
            ]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Renderer profiler command timed out")),
            commandTimeoutMs,
          );
        }),
      ]);

      requireOwnership();

      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  webContents.on("did-start-navigation", invalidate);
  webContents.on("destroyed", invalidate);
  debuggerApi.on("detach", detached);
  debuggerApi.on("message", scriptParsed);

  try {
    try {
      debuggerApi.attach("1.3");
      ownsAttachment = true;
    } catch {
      throw new Error("Renderer profiler attachment failed");
    }

    await command("Debugger.setSkipAllPauses", { skip: true });
    await command("Debugger.enable");
    await command("Profiler.enable");
    await command("Profiler.setSamplingInterval", {
      interval: sampleIntervalUs,
    });
    needsStop = true;
    await command("Profiler.start");
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, durationMs);
        }),
        invalidation,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    requireCurrent();
    needsStop = false;
    const result = await command("Profiler.stop");

    return sanitizeProfile(
      result,
      resourceScripts,
      metadataTruncated,
      durationMs,
    );
  } finally {
    try {
      if (
        needsStop &&
        ownsAttachment &&
        !webContents.isDestroyed() &&
        debuggerApi.isAttached()
      ) {
        await command("Profiler.stop", undefined, true);
      }
    } finally {
      try {
        if (
          ownsAttachment &&
          !webContents.isDestroyed() &&
          debuggerApi.isAttached()
        ) {
          try {
            debuggerApi.detach();
          } catch {
            throw new Error("Renderer profiler cleanup failed");
          }
        }
      } finally {
        debuggerApi.off("detach", detached);
        debuggerApi.off("message", scriptParsed);
        webContents.off("did-start-navigation", invalidate);
        webContents.off("destroyed", invalidate);
        activeCaptures.delete(webContents);
      }
    }
  }
}
