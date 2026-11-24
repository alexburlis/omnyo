import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE,
  desktopBrowserBrokerDescriptorSchema,
  desktopBrowserBrokerCommandRequestSchema,
  desktopBrowserBrokerResultSchemas,
} from "@omnyo/host-daemon-contract";
import type { DesktopBrowserBroker } from "./desktop-browser-broker.js";

export function isTrustedBrokerDescriptorFile(args: {
  isFile: boolean;
  mode: number;
  ownerUid: number;
  platform: NodeJS.Platform;
  processUid: number | undefined;
  size: number;
}): boolean {
  if (!args.isFile || args.size > 16384) {
    return false;
  }

  if (args.platform === "win32") {
    return true;
  }

  return (
    (args.mode & 0o077) === 0 &&
    (args.processUid === undefined || args.ownerUid === args.processUid)
  );
}

async function readBrokerDescriptor(dataDir: string) {
  const file = await open(
    join(dataDir, DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );

  try {
    const stat = await file.stat();

    if (
      !isTrustedBrokerDescriptorFile({
        isFile: stat.isFile(),
        mode: stat.mode,
        ownerUid: stat.uid,
        platform: process.platform,
        processUid: process.getuid?.(),
        size: stat.size,
      })
    )
      throw new Error("Invalid desktop broker descriptor permissions");

    return desktopBrowserBrokerDescriptorSchema.parse(
      JSON.parse(await file.readFile("utf8")),
    );
  } finally {
    await file.close();
  }
}

const SERVER_IDENTITY_MISS_MS = 60_000;

const serverHealthSchema = z.object({
  launchId: z.string().min(1).optional(),
});

export async function readServerLaunchId(
  origin: string,
): Promise<string | null> {
  const response = await fetch(new URL("/health", origin), {
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });

  if (response.status >= 500)
    throw new Error(`Server health returned ${response.status}`);

  if (!response.ok) return null;

  return serverHealthSchema.parse(await response.json()).launchId ?? null;
}

type BrokerDescriptor = Awaited<ReturnType<typeof readBrokerDescriptor>>;

type BrokerServerIdentity =
  | { descriptor: BrokerDescriptor; known: true; launchId: string | null }
  | { descriptor: BrokerDescriptor; known: false };

export async function readServerBrokerDescriptor(args: {
  dataDir: string;
  homeDir: string;
  serverOrigin: string;
  readLaunchId(origin: string): Promise<string | null>;
  differentServers: Map<string, number>;
}) {
  const serverHost = new URL(args.serverOrigin).host.replace(
    /[^a-zA-Z0-9.-]/gu,
    "-",
  );

  const dataDirs = new Set([
    args.dataDir,
    join(args.homeDir, ".omnyo-machines", serverHost),
    join(args.homeDir, ".bb-machines", serverHost),
  ]);

  const descriptors = (
    await Promise.allSettled([...dataDirs].map(readBrokerDescriptor))
  ).flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

  const sameOrigin = descriptors.find(
    (descriptor) => new URL(descriptor.serverUrl).origin === args.serverOrigin,
  );

  if (sameOrigin) return sameOrigin;

  const now = Date.now();

  const identityKey = (descriptor: BrokerDescriptor) =>
    JSON.stringify([args.serverOrigin, descriptor.serverUrl, descriptor.url]);

  const candidates = descriptors.filter(
    (descriptor) =>
      (args.differentServers.get(identityKey(descriptor)) ?? 0) <= now,
  );

  if (candidates.length > 0) {
    const [selectedLaunchId, identities] = await Promise.all([
      args.readLaunchId(args.serverOrigin),
      Promise.all(
        candidates.map((descriptor): Promise<BrokerServerIdentity> =>
          args.readLaunchId(new URL(descriptor.serverUrl).origin).then(
            (launchId) => ({ descriptor, known: true, launchId }),
            () => ({ descriptor, known: false }),
          ),
        ),
      ),
    ]);

    for (const identity of identities) {
      if (!identity.known) continue;

      if (selectedLaunchId !== null && identity.launchId === selectedLaunchId)
        return identity.descriptor;

      args.differentServers.set(
        identityKey(identity.descriptor),
        now + SERVER_IDENTITY_MISS_MS,
      );
    }
  }

  throw new Error("No desktop broker found for the selected server");
}

export function createDesktopBrowserBrokerClient(args: {
  broker: DesktopBrowserBroker;
  dataDir: string;
  homeDir: string;
  getServerUrl(): string;
}) {
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let generation = 0;
  let registryServerOrigin: string | null = null;
  const differentServers = new Map<string, number>();

  function disconnect(): void {
    generation += 1;
    const previous = socket;
    socket = null;
    previous?.terminate();
    args.broker.setHostId(null);
  }

  function schedule(): void {
    if (stopped || retry !== null) return;
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, 2000);
    retry.unref();
  }

  async function connect(): Promise<void> {
    if (stopped || socket !== null) return;
    const currentGeneration = generation;

    try {
      const serverUrl = args.getServerUrl();
      const serverOrigin = new URL(serverUrl).origin;

      if (
        registryServerOrigin !== null &&
        registryServerOrigin !== serverOrigin
      )
        args.broker.resetServer();
      registryServerOrigin = serverOrigin;

      const descriptor = await readServerBrokerDescriptor({
        dataDir: args.dataDir,
        homeDir: args.homeDir,
        serverOrigin,
        readLaunchId: readServerLaunchId,
        differentServers,
      });

      if (stopped || generation !== currentGeneration) return;

      if (new URL(args.getServerUrl()).origin !== serverOrigin) {
        schedule();

        return;
      }

      const connection = new WebSocket(descriptor.url, {
        headers: { authorization: `Bearer ${descriptor.token}` },
        maxPayload: 1024 * 1024,
        handshakeTimeout: 5000,
      });

      socket = connection;

      const sendRegistration = () => {
        if (connection.readyState !== WebSocket.OPEN) return;
        connection.send(
          JSON.stringify({
            type: "register",
            hostId: descriptor.hostId,
            serverUrl: descriptor.serverUrl,
            instances: args.broker.listInstances(),
          }),
        );
      };

      const offInstances = args.broker.subscribeInstances(sendRegistration);

      const offChanged = args.broker.subscribe((event) => {
        if (connection.readyState === WebSocket.OPEN)
          connection.send(JSON.stringify(event));
      });

      let requests = Promise.resolve();
      let pending = 0;
      connection.on("open", () => {
        if (
          stopped ||
          generation !== currentGeneration ||
          new URL(args.getServerUrl()).origin !== serverOrigin
        ) {
          connection.terminate();

          return;
        }

        sendRegistration();
        args.broker.setHostId(descriptor.hostId);
      });
      connection.on("message", (data, binary) => {
        let request;

        try {
          if (binary) throw new Error("Expected a JSON broker request");
          request = desktopBrowserBrokerCommandRequestSchema.parse(
            JSON.parse(data.toString()),
          );
        } catch {
          connection.terminate();

          return;
        }

        if (++pending > 64) {
          connection.terminate();

          return;
        }

        const parsed = request;
        requests = requests.then(async () => {
          if (connection.readyState !== WebSocket.OPEN) return;

          try {
            const result = desktopBrowserBrokerResultSchemas[
              parsed.command.type
            ].parse(await args.broker.execute(parsed.command));

            if (connection.readyState === WebSocket.OPEN)
              connection.send(
                JSON.stringify({
                  type: "result",
                  requestId: parsed.requestId,
                  result,
                }),
              );
          } catch (error) {
            if (connection.readyState === WebSocket.OPEN)
              connection.send(
                JSON.stringify({
                  type: "error",
                  requestId: parsed.requestId,
                  message:
                    error instanceof Error
                      ? error.message.slice(0, 8192)
                      : "Desktop browser operation failed",
                }),
              );
          } finally {
            pending -= 1;
          }
        });
      });
      connection.on("error", () => connection.terminate());
      connection.on("close", () => {
        offInstances();
        offChanged();

        if (socket !== connection) return;
        socket = null;
        args.broker.setHostId(null);
        schedule();
      });
    } catch {
      schedule();
    }
  }

  void connect();

  return {
    reconnect() {
      if (retry !== null) clearTimeout(retry);
      retry = null;
      disconnect();
      void connect();
    },
    stop() {
      stopped = true;

      if (retry !== null) clearTimeout(retry);
      retry = null;
      disconnect();
    },
  };
}
