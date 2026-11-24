import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CertificateMaterial } from "./acme.js";
import type { LogFieldValue, RelayLogger } from "./contracts.js";

const run = promisify(execFile);

export async function selfSignedCertificate(
  domains: readonly string[],
  days: number,
  existingKey?: string,
): Promise<CertificateMaterial> {
  const directory = mkdtempSync(join(tmpdir(), "relay-acme-cert-"));

  const keyArguments =
    existingKey === undefined
      ? ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"]
      : ["-new", "-key", join(directory, "key.pem")];

  try {
    if (existingKey !== undefined) {
      writeFileSync(join(directory, "key.pem"), existingKey, { mode: 0o600 });
    }

    await run("openssl", [
      "req",
      "-x509",
      ...keyArguments,
      "-nodes",
      "-days",
      String(days),
      "-subj",
      `/CN=${domains[0] ?? "relay.test"}`,
      "-addext",
      `subjectAltName=${domains.map((domain) => `DNS:${domain}`).join(",")}`,
      ...(existingKey === undefined
        ? ["-keyout", join(directory, "key.pem")]
        : []),
      "-out",
      join(directory, "cert.pem"),
    ]);

    return {
      key: readFileSync(join(directory, "key.pem"), "utf8"),
      cert: readFileSync(join(directory, "cert.pem"), "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export interface LoggedEvent {
  level: "info" | "warn" | "error";
  event: string;
  fields: Readonly<Record<string, LogFieldValue>>;
}

export function recordingLogger(): { log: RelayLogger; events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];

  const at =
    (level: LoggedEvent["level"]) =>
    (event: string, fields: Readonly<Record<string, LogFieldValue>> = {}) => {
      events.push({ level, event, fields });
    };

  return {
    log: { info: at("info"), warn: at("warn"), error: at("error") },
    events,
  };
}

export interface CloudflareRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

export interface FakeCloudflare {
  apiBaseUrl: string;
  zoneId: string;
  token: string;
  records: Map<string, { name: string; content: string }>;
  requests: CloudflareRequest[];
  failCreates: number;
  failDeletes: number;
  createErrorMessage: string;
  served(name: string): string[];
  close(): Promise<void>;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");

  return text === "" ? null : (JSON.parse(text) as unknown);
}

export async function startFakeCloudflare(
  zoneId: string,
  token: string,
): Promise<FakeCloudflare> {
  let nextId = 1;
  const records = new Map<string, { name: string; content: string }>();
  const requests: CloudflareRequest[] = [];
  const prefix = `/client/v4/zones/${zoneId}/dns_records`;

  const server: Server = createServer(async (request, response) => {
    const body = await readJson(request);
    const path = request.url ?? "/";
    requests.push({
      method: request.method ?? "",
      path,
      authorization: request.headers.authorization,
      body,
    });

    const reply = (status: number, payload: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    const failure = (status: number, code: number, message: string) =>
      reply(status, {
        success: false,
        errors: [{ code, message }],
        messages: [],
        result: null,
      });

    if (request.headers.authorization !== `Bearer ${token}`) {
      failure(403, 10000, "Authentication error");

      return;
    }

    if (request.method === "POST" && path === prefix) {
      if (fake.failCreates > 0) {
        fake.failCreates -= 1;
        failure(400, 81057, fake.createErrorMessage);

        return;
      }

      const input = body as { name: string; content: string };
      const id = `record${nextId}`;
      nextId += 1;
      records.set(id, { name: input.name, content: input.content });
      reply(200, {
        success: true,
        errors: [],
        messages: [],
        result: { id, type: "TXT", ...input },
      });

      return;
    }

    if (request.method === "DELETE" && path.startsWith(`${prefix}/`)) {
      const id = path.slice(prefix.length + 1);

      if (fake.failDeletes > 0) {
        fake.failDeletes -= 1;
        failure(500, 10001, "Internal error");

        return;
      }

      if (!records.delete(id)) {
        failure(404, 81044, "Record does not exist.");

        return;
      }

      reply(200, { success: true, errors: [], messages: [], result: { id } });

      return;
    }

    failure(404, 7003, "No route for that URI");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  const fake: FakeCloudflare = {
    apiBaseUrl: `http://127.0.0.1:${port}/client/v4`,
    zoneId,
    token,
    records,
    requests,
    failCreates: 0,
    failDeletes: 0,
    createErrorMessage: "Invalid TXT record",
    served(name) {
      return [...records.values()]
        .filter((record) => record.name === name)
        .map((record) => record.content);
    },
    async close() {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    },
  };

  return fake;
}
