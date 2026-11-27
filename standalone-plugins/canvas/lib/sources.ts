import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { OutgoingHttpHeaders } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PluginApi } from "@omnyo/plugin-sdk";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { linkedBoardKeys, publishProjectChange } from "./board-notifications.ts";
import {
  cloudflareGraphqlUrl,
  graphqlVariableNames,
  columnsSchema,
  datasetSchema,
  scalarSchema,
  scalarTypes,
  sourceJsonSchema,
  sourceInputSchema,
  sourceRecordSchema,
  sourceRealtimeChannel,
  type SourceJson,
  type Dataset,
  type DatasetPushInput,
  type SourceCredentialInput,
  type SourceInput,
  type SourceState,
} from "../source-contract";

export class SourceError extends Error {}

const run = promisify(execFile);

const maxBytes = 2 * 1024 * 1024;

const recordRow = z.object({ record_json: z.string(), dataset_json: z.string().nullable() });

const pollRow = z.object({ thread_id: z.string(), id: z.string() });

const resumeGapMs = 150000;

const objectSchema = z.record(z.string(), sourceJsonSchema);

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
  structuredContent: sourceJsonSchema.optional(),
  isError: z.boolean().optional(),
});

const gscEnvelope = z.object({
  ok: z.boolean(),
  data: z
    .object({
      rows: z
        .array(
          z.object({
            keys: z.array(z.string()).optional(),
            clicks: z.number(),
            impressions: z.number(),
            ctr: z.number(),
            position: z.number(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const posthogEnvelope = z.object({
  columns: z.array(z.string()),
  results: z.array(z.array(scalarSchema)),
});

const cloudflareEnvelope = z.object({
  data: z
    .object({ viewer: z.object({ zones: z.array(sourceJsonSchema) }) })
    .nullable()
    .optional(),
  errors: z
    .array(z.object({ message: z.string() }))
    .nullable()
    .optional(),
});

export type LoadedSource = Pick<Dataset, "columns" | "rows"> & {
  provenance?: Dataset["provenance"];
};

export interface SourceAccess {
  gscBroker: string;
  posthogOrigin: string;
  mcpOrigins: string[];
}

export type SourceLoader = (
  definition: SourceInput,
  authorization: string | null,
  signal: AbortSignal | undefined,
  access: SourceAccess,
) => Promise<LoadedSource>;

export type SourceBrokerRunner = (
  command: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;

function checkedSourceUrl(value: string, customPort: boolean): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new SourceError("Sources require a valid HTTPS URL");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (!customPort && url.port && url.port !== "443")
  )
    throw new SourceError(
      customPort
        ? "MCP sources require an HTTPS URL without credentials or fragments"
        : "Sources require an HTTPS URL without credentials, fragments or custom ports",
    );

  if (
    [...url.searchParams.keys()].some((key) =>
      /token|api[-_]?key|secret|password|authorization|signature/iu.test(key),
    )
  )
    throw new SourceError("Keep credentials in the protected source settings, not the source URL");

  return url;
}

export function publicSourceUrl(value: string): URL {
  return checkedSourceUrl(value, false);
}

export function parseMcpOrigins(value: string): string[] {
  return value
    .split(/[\s,]+/u)
    .filter(Boolean)
    .map((entry) => {
      const url = URL.canParse(entry) ? new URL(entry) : null;

      if (!url || url.protocol !== "https:" || entry.replace(/\/$/u, "") !== url.origin)
        throw new SourceError(
          "Canvas MCP origins must be exact HTTPS origins such as https://host.example:8443",
        );

      return url.origin;
    });
}

export function mcpSourceUrl(value: string, origins: readonly string[]): URL {
  const url = checkedSourceUrl(value, true);

  if (origins.length === 0)
    throw new SourceError(
      "MCP sources are off until the owner lists the server origin in Canvas settings (mcpOrigins)",
    );

  if (!origins.includes(url.origin))
    throw new SourceError(`MCP server origin ${url.origin} is not listed in Canvas settings`);

  return url;
}

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

const mcpRanges = new Set(["unicast", "private", "carrierGradeNat", "uniqueLocal"]);

const metadataAddresses = new Set(
  ["169.254.169.254", "100.100.100.200", "fd00:ec2::254"].map((address) =>
    ipaddr.parse(address).toNormalizedString(),
  ),
);

export function isMcpAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);

    return mcpRanges.has(parsed.range()) && !metadataAddresses.has(parsed.toNormalizedString());
  } catch {
    return false;
  }
}

export interface SourceAddress {
  address: string;
  family: number;
}

export interface SourceRequest {
  method: "GET" | "POST";
  headers: OutgoingHttpHeaders;
  body: string | null;
  address: SourceAddress;
  signal: AbortSignal;
}

export interface SourceResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: AsyncIterable<Buffer>;
  discard(): void;
}

export interface SourceTransport {
  lookup(hostname: string): Promise<SourceAddress[]>;
  request(url: URL, init: SourceRequest): Promise<SourceResponse>;
}

export const nodeTransport: SourceTransport = {
  lookup: (hostname) => lookup(hostname, { all: true }),
  request: (url, init) =>
    new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: init.method,
          headers: init.headers,
          family: init.address.family,
          lookup: (_host, _options, callback) =>
            callback(null, init.address.address, init.address.family),
          signal: init.signal,
        },
        (response) =>
          resolve({
            status: response.statusCode ?? 0,
            headers: Object.fromEntries(
              Object.entries(response.headers).map(([key, value]) => [
                key,
                Array.isArray(value) ? value[0] : value,
              ]),
            ),
            body: response,
            discard: () => response.destroy(),
          }),
      );

      req.on("error", reject);

      if (init.body !== null) req.write(init.body);
      req.end();
    }),
};

async function resolvePinned(
  url: URL,
  allowed: (address: string) => boolean,
  refusal: string,
  transport: SourceTransport,
): Promise<SourceAddress> {
  const addresses = await Promise.race([
    transport.lookup(url.hostname.replace(/^\[|\]$/gu, "")),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new SourceError("Source DNS lookup timed out")), 5000);
      timer.unref();
    }),
  ]).catch((error: Error) => {
    throw error instanceof SourceError ? error : new SourceError("Source host did not resolve");
  });

  if (addresses.length === 0 || addresses.some((item) => !allowed(item.address)))
    throw new SourceError(refusal);
  const address = addresses[0];

  if (!address) throw new SourceError("Source host did not resolve");

  return address;
}

async function send(
  transport: SourceTransport,
  url: URL,
  init: Omit<SourceRequest, "signal">,
  signal: AbortSignal | undefined,
): Promise<SourceResponse> {
  return transport
    .request(url, {
      ...init,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    })
    .catch((error: Error) => {
      throw error instanceof SourceError
        ? error
        : new SourceError("Source request failed or timed out");
    });
}

async function readBody(
  response: SourceResponse,
  complete?: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";

  try {
    for await (const chunk of response.body) {
      size += chunk.length;

      if (size > maxBytes) throw new SourceError("Source response exceeds the 2 MiB limit");
      text += decoder.decode(chunk, { stream: true });

      if (complete?.(text)) return text;
    }
  } catch (error) {
    throw error instanceof SourceError
      ? error
      : new SourceError("Source response could not be read or timed out");
  }

  return text + decoder.decode();
}

export async function readJson(
  urlValue: string,
  authorization: string | null,
  body: string | null,
  signal?: AbortSignal,
  transport: SourceTransport = nodeTransport,
): Promise<SourceJson> {
  const url = publicSourceUrl(urlValue);

  const address = await resolvePinned(
    url,
    isPublicAddress,
    "Source URLs must resolve only to public network addresses",
    transport,
  );

  const headers: OutgoingHttpHeaders = { Accept: "application/json", "User-Agent": "Omnyo-Canvas" };

  if (authorization) headers.Authorization = authorization;

  if (body !== null) headers["Content-Type"] = "application/json";

  const response = await send(
    transport,
    url,
    { method: body === null ? "GET" : "POST", headers, body, address },
    signal,
  );

  if (response.status < 200 || response.status >= 300) {
    response.discard();

    throw new SourceError(`Source returned HTTP ${response.status}; redirects are not followed`);
  }

  const text = await readBody(response);

  try {
    return sourceJsonSchema.parse(JSON.parse(text));
  } catch {
    throw new SourceError("Source did not return valid JSON");
  }
}

const mcpProtocolVersion = "2025-06-18";

const mcpProtocolVersions = new Set(["2025-03-26", mcpProtocolVersion, "2025-11-25"]);

const rpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: sourceJsonSchema.optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const initializeSchema = z.object({ protocolVersion: z.string() });

const toolsPageSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      annotations: z.object({ readOnlyHint: z.boolean().optional() }).nullish(),
    }),
  ),
  nextCursor: z.string().optional(),
});

function shortText(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

function rpcMatch(value: SourceJson, id: number): z.infer<typeof rpcResponseSchema> | undefined {
  for (const entry of Array.isArray(value) ? value : [value]) {
    const message = rpcResponseSchema.safeParse(entry);

    if (
      message.success &&
      message.data.id === id &&
      (message.data.result !== undefined || message.data.error)
    )
      return message.data;
  }

  return undefined;
}

function parseRpcJson(text: string): SourceJson {
  try {
    return sourceJsonSchema.parse(JSON.parse(text));
  } catch {
    throw new SourceError("MCP server sent invalid JSON");
  }
}

function sseMatch(event: string, id: number) {
  const data = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /u, ""))
    .join("\n");

  return data ? rpcMatch(parseRpcJson(data), id) : undefined;
}

async function readRpcResponse(response: SourceResponse, id: number): Promise<SourceJson> {
  const type = (response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  let message: z.infer<typeof rpcResponseSchema> | undefined;

  if (type === "text/event-stream") {
    let checked = 0;

    const text = await readBody(response, (received) => {
      const events = received.replace(/\r\n|\r(?!$)/gu, "\n").split("\n\n");
      events.pop();

      for (const event of events.slice(checked)) {
        message = sseMatch(event, id);

        if (message) return true;
      }

      checked = events.length;

      return false;
    });

    if (!message)
      message = sseMatch(
        text
          .replace(/\r\n|\r/gu, "\n")
          .split("\n\n")
          .at(-1) ?? "",
        id,
      );
  } else if (type === "application/json") {
    message = rpcMatch(parseRpcJson(await readBody(response)), id);
  } else {
    response.discard();

    throw new SourceError("MCP server returned an unsupported content type");
  }

  if (!message) throw new SourceError("MCP server sent no response to the request");

  if (message.error) throw new SourceError(`MCP server error: ${shortText(message.error.message)}`);

  if (message.result === undefined) throw new SourceError("MCP server sent no result");

  return message.result;
}

export async function readMcp(
  config: Extract<SourceInput, { provider: "mcp" }>["config"],
  authorization: string | null,
  signal: AbortSignal | undefined,
  origins: readonly string[],
  transport: SourceTransport = nodeTransport,
): Promise<SourceJson> {
  const url = mcpSourceUrl(config.url, origins);

  const address = await resolvePinned(
    url,
    isMcpAddress,
    "MCP servers must not resolve to loopback, link-local, multicast or metadata addresses",
    transport,
  );

  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]);

  const headers: OutgoingHttpHeaders = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": "Omnyo-Canvas",
  };

  if (authorization) headers.Authorization = authorization;
  let nextId = 0;

  const post = async (message: Record<string, SourceJson>) => {
    const response = await send(
      transport,
      url,
      { method: "POST", headers: { ...headers }, body: JSON.stringify(message), address },
      deadline,
    );

    if (response.status < 200 || response.status >= 300) {
      response.discard();

      throw new SourceError(
        `MCP server returned HTTP ${response.status}; redirects are not followed`,
      );
    }

    return response;
  };

  const call = async (method: string, params: Record<string, SourceJson>) => {
    nextId += 1;
    const id = nextId;
    const response = await post({ jsonrpc: "2.0", id, method, params });

    return { result: await readRpcResponse(response, id), headers: response.headers };
  };

  const initialized = await call("initialize", {
    protocolVersion: mcpProtocolVersion,
    capabilities: {},
    clientInfo: { name: "omnyo-canvas", version: "1" },
  });

  const version = initializeSchema.safeParse(initialized.result);

  if (!version.success || !mcpProtocolVersions.has(version.data.protocolVersion))
    throw new SourceError("MCP server does not support protocol version 2025-06-18");
  const session = initialized.headers["mcp-session-id"];

  if (session !== undefined) {
    if (!/^[\x21-\x7E]{1,1024}$/u.test(session))
      throw new SourceError("MCP server returned an invalid session ID");
    headers["Mcp-Session-Id"] = session;
  }

  headers["MCP-Protocol-Version"] = version.data.protocolVersion;
  (await post({ jsonrpc: "2.0", method: "notifications/initialized" })).discard();

  let cursor: string | undefined;
  let tool: z.infer<typeof toolsPageSchema>["tools"][number] | undefined;

  for (let page = 0; page < 10 && !tool; page += 1) {
    const listed = toolsPageSchema.safeParse(
      (await call("tools/list", cursor === undefined ? {} : { cursor })).result,
    );

    if (!listed.success) throw new SourceError("MCP server returned an invalid tool list");
    tool = listed.data.tools.find((item) => item.name === config.tool);
    cursor = listed.data.nextCursor;

    if (cursor === undefined) break;
  }

  if (!tool) throw new SourceError(`MCP server does not list the tool "${config.tool}"`);

  if (tool.annotations?.readOnlyHint !== true)
    throw new SourceError(
      "MCP tool is not marked read-only; Canvas calls only tools the server annotates with readOnlyHint",
    );

  const result = toolResultSchema.safeParse(
    (await call("tools/call", { name: config.tool, arguments: config.arguments })).result,
  );

  if (!result.success) throw new SourceError("MCP tool returned an unsupported result");
  const text = result.data.content.find((item) => item.type === "text")?.text;

  if (result.data.isError)
    throw new SourceError(
      text ? `MCP tool reported an error: ${shortText(text)}` : "MCP tool reported an error",
    );

  if (result.data.structuredContent !== undefined) return result.data.structuredContent;

  if (text === undefined) throw new SourceError("MCP tool returned no data");

  try {
    return sourceJsonSchema.parse(JSON.parse(text));
  } catch {
    throw new SourceError("MCP tool result is not JSON; return structuredContent or a JSON text");
  }
}

function atPath(value: SourceJson, path: readonly string[]): SourceJson {
  let current = value;

  for (const key of path) {
    const object = objectSchema.safeParse(current);

    if (!object.success || !Object.hasOwn(object.data, key))
      throw new SourceError("The configured JSON path was not found");
    const next = object.data[key];

    if (next === undefined) throw new SourceError("The configured JSON path was not found");
    current = next;
  }

  return current;
}

export function jsonDataset(
  value: SourceJson,
  definition: Extract<SourceInput, { provider: "json" | "mcp" | "cloudflare" }>,
): LoadedSource {
  const selected = atPath(value, definition.config.rowsPath);
  const selectedRows = Array.isArray(selected) ? selected : [selected];

  if (selectedRows.length > 2000)
    throw new SourceError("Source exceeds 2,000 rows; filter the API response first");

  const rows = selectedRows.map((entry) => {
    const row: Record<string, z.infer<typeof scalarSchema>> = {};

    for (const column of definition.config.columns) {
      const cell = scalarSchema.safeParse(atPath(entry, column.path ?? [column.key]));

      if (!cell.success)
        throw new SourceError("Source cells must be text, finite numbers, booleans or null");

      if (cell.data !== null && !scalarTypes[column.type].safeParse(cell.data).success)
        throw new SourceError(`Column ${column.label} has the wrong data type`);
      row[column.key] = cell.data;
    }

    return row;
  });

  return {
    columns: columnsSchema.parse(
      definition.config.columns.map(({ path: _path, ...column }) => column),
    ),
    rows,
  };
}

function bearer(token: string): string {
  return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
}

function toolPath(): string {
  return [join(homedir(), "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(
    ":",
  );
}

function expandHome(command: string): string {
  return command.startsWith("~/") ? join(homedir(), command.slice(2)) : command;
}

export function gscWindow(
  config: Extract<SourceInput, { provider: "gsc" }>["config"],
  now = Date.now(),
) {
  if (!config.rollingDays) return { startDate: config.startDate, endDate: config.endDate };

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const date = `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
  const end = new Date(`${date}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - (config.lagDays ?? 2));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - config.rollingDays + 1);

  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

export function cloudflareWindow(
  config: Extract<SourceInput, { provider: "cloudflare" }>["config"],
  now = Date.now(),
) {
  const unit = config.alignTo === "minute" ? 60000 : 3600000;
  const end = Math.floor(now / unit) * unit;
  const time = (value: number) => new Date(value).toISOString().replace(/\.\d{3}Z$/u, "Z");
  const start = time(end - config.rollingHours * 3600000);
  const finish = time(end);

  return { start, end: finish, startDate: start.slice(0, 10), endDate: finish.slice(0, 10) };
}

export function cloudflareVariables(
  config: Extract<SourceInput, { provider: "cloudflare" }>["config"],
  now = Date.now(),
): Record<string, string> {
  const values = { zoneTag: config.zoneTag, ...cloudflareWindow(config, now) };

  const declared = new Set(graphqlVariableNames(config.query));

  return Object.fromEntries(Object.entries(values).filter(([name]) => declared.has(name)));
}

export const loadSource = async (
  definition: SourceInput,
  authorization: string | null,
  signal: AbortSignal | undefined,
  access: SourceAccess,
  broker: SourceBrokerRunner = run,
  transport: SourceTransport = nodeTransport,
): Promise<LoadedSource> => {
  switch (definition.provider) {
    case "manual":
      throw new SourceError("This source is updated by an agent or by pasting a dataset");
    case "json":
      return jsonDataset(
        await readJson(definition.config.url, authorization, null, signal, transport),
        definition,
      );
    case "mcp":
      return jsonDataset(
        await readMcp(definition.config, authorization, signal, access.mcpOrigins, transport),
        definition,
      );
    case "cloudflare": {
      if (!authorization)
        throw new SourceError(
          "Approve a Cloudflare API token for this source in Canvas plugin settings first",
        );

      const now = Date.now();

      const response = cloudflareEnvelope.safeParse(
        await readJson(
          cloudflareGraphqlUrl,
          authorization,
          JSON.stringify({
            query: definition.config.query,
            variables: cloudflareVariables(definition.config, now),
          }),
          signal,
          transport,
        ),
      );

      if (!response.success) throw new SourceError("Cloudflare returned an unsupported result");
      const failure = response.data.errors?.[0]?.message;

      if (failure) throw new SourceError(`Cloudflare rejected the query: ${shortText(failure)}`);
      const zone = response.data.data?.viewer.zones[0];

      if (zone === undefined)
        throw new SourceError(
          "Cloudflare returned no zone; check the zone ID and that the token can read its analytics",
        );
      const window = cloudflareWindow(definition.config, now);

      return {
        ...jsonDataset(zone, definition),
        provenance: {
          ...definition.provenance,
          timezone: "UTC",
          windowLabel: `${window.start.slice(0, 16).replace("T", " ")}–${window.end.slice(0, 16).replace("T", " ")} UTC`,
        },
      };
    }

    case "posthog": {
      if (!authorization)
        throw new SourceError("Add a PostHog personal API key in Canvas settings first");

      const response = posthogEnvelope.safeParse(
        await readJson(
          `${publicSourceUrl(access.posthogOrigin).origin}/api/projects/${definition.config.projectId}/query/`,
          authorization,
          JSON.stringify({ query: { kind: "HogQLQuery", query: definition.config.query } }),
          signal,
          transport,
        ),
      );

      if (!response.success) throw new SourceError("PostHog returned an unsupported query result");
      const { columns, results } = response.data;

      const types = columns.map(
        (_column, index) => results.find((row) => row[index] !== null)?.[index],
      );

      return {
        columns: columns.map((key, index) => ({
          key,
          label: key,
          type: scalarTypes.number.safeParse(types[index]).success
            ? "number"
            : scalarTypes.boolean.safeParse(types[index]).success
              ? "boolean"
              : "string",
        })),
        rows: results.map((cells) =>
          Object.fromEntries(columns.map((key, index) => [key, cells[index] ?? null])),
        ),
      };
    }

    case "gsc": {
      if (!access.gscBroker.trim())
        throw new SourceError(
          "Search Console sources need a broker command in Canvas plugin settings",
        );

      const window = gscWindow(definition.config);

      const parameters = {
        siteUrl: definition.config.siteUrl,
        dimensions: definition.config.dimensions,
        limit: definition.config.limit,
        ...window,
      };

      const output = await broker(
        expandHome(access.gscBroker.trim()),
        ["gsc", "gsc.query_search_analytics", JSON.stringify(parameters), "--json"],
        {
          encoding: "utf8",
          timeout: 20000,
          maxBuffer: maxBytes,
          signal,
          env: {
            HOME: homedir(),
            PATH: toolPath(),
          },
        },
      ).catch((error: Error) => {
        const failure = z
          .object({
            code: z.union([z.string(), z.number().int()]).optional(),
            killed: z.boolean().optional(),
          })
          .safeParse(error);

        const code = failure.success ? failure.data.code : undefined;
        const numericCode = z.number().int().safeParse(code);

        throw new SourceError(
          code === "ENOENT"
            ? "The Search Console broker command in Canvas settings was not found"
            : failure.success && failure.data.killed
              ? "Search Console broker stopped or timed out"
              : numericCode.success
                ? `Search Console broker failed (exit ${numericCode.data}); check its runtime and connection`
                : "Search Console broker could not run; check its runtime and connection",
        );
      });

      const result = toolResultSchema.safeParse(JSON.parse(output.stdout));

      if (!result.success || result.data.isError)
        throw new SourceError("Search Console broker rejected the query");
      const text = result.data.content.find((item) => item.type === "text")?.text;

      if (!text) throw new SourceError("Search Console broker returned no result");
      const envelope = gscEnvelope.safeParse(JSON.parse(text));

      if (!envelope.success || !envelope.data.ok || !envelope.data.data)
        throw new SourceError("Search Console is unavailable or rate limited");

      const dimensionLabels = {
        date: "Date",
        query: "Query",
        page: "Page",
        country: "Country",
        device: "Device",
      };

      const dimensionColumns = definition.config.dimensions.map((key) => ({
        key,
        label: dimensionLabels[key],
        type: "string" as const,
      }));

      return {
        columns: [
          ...dimensionColumns,
          { key: "clicks", label: "Clicks", type: "number" },
          { key: "impressions", label: "Impressions", type: "number" },
          { key: "ctr", label: "Click-through rate", type: "number", format: "percent" },
          { key: "position", label: "Avg. position", type: "number" },
        ],
        rows: (envelope.data.data.rows ?? []).map((row) => ({
          ...Object.fromEntries(
            definition.config.dimensions.map((key, index) => [key, row.keys?.[index] ?? ""]),
          ),
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        })),
        provenance: {
          ...definition.provenance,
          timezone: "America/Los_Angeles",
          windowLabel: `${window.startDate}–${window.endDate}`,
        },
      };
    }
  }
};

function contentSignature(
  columns: Dataset["columns"],
  rows: Dataset["rows"],
  provenance: Dataset["provenance"],
): string {
  return JSON.stringify([
    columns.map((column) => [column.key, column.label, column.type, column.format ?? null]),
    rows.map((row) => Object.entries(row).sort(([left], [right]) => left.localeCompare(right))),
    [
      provenance.windowLabel ?? null,
      provenance.timezone ?? null,
      provenance.cohort ?? null,
      provenance.unit ?? null,
    ],
  ]);
}

const POSTHOG_SECTION = {
  title: "PostHog",
  description: "Chart product analytics on boards with a read-only PostHog key.",
};

const SEARCH_CONSOLE_SECTION = {
  title: "Google Search Console",
  description: "Chart search clicks and impressions through an MCP broker command.",
};

const MCP_SECTION = {
  title: "MCP servers",
  description: "Chart data from MCP servers you trust. Canvas calls only read-only tools.",
};

const API_SECTION_DESCRIPTION =
  "Read JSON from one HTTPS API, such as Cloudflare's, with a bearer token sent only to that address.";

const API_SECTIONS = [
  { title: "Custom API 1", description: API_SECTION_DESCRIPTION },
  { title: "Custom API 2", description: API_SECTION_DESCRIPTION },
] as const;

const API_ORIGIN_DESCRIPTION = "Scheme and host only, without a path";

const ONE_PASSWORD_REFERENCE_DESCRIPTION =
  "Lets agents fill in the key from this exact 1Password item; they never see it";

export class SourceService {
  private readonly active = new Map<string, Promise<SourceState>>();
  private readonly controller = new AbortController();
  private readonly controllers = new Map<string, AbortController>();
  private readonly settings;
  private lastPollAt: number | undefined;
  constructor(
    private readonly api: PluginApi,
    private readonly loader: SourceLoader = loadSource,
  ) {
    api.onDispose(async () => {
      this.controller.abort();
      await Promise.allSettled(this.active.values());
    });
    this.settings = api.settings.define({
      posthogToken: {
        type: "string",
        label: "Personal API key",
        description: "From PostHog → Settings → Personal API keys, with Query read access",
        secret: true,
        experimental_placeholder: "phx_…",
        experimental_section: POSTHOG_SECTION,
      },
      posthogOrigin: {
        type: "string",
        label: "PostHog address",
        description: "Use https://us.posthog.com for the US cloud, or your own PostHog address",
        default: "https://eu.posthog.com",
        experimental_placeholder: "https://eu.posthog.com",
        experimental_section: POSTHOG_SECTION,
      },
      posthogReference: {
        type: "string",
        label: "1Password reference (optional)",
        description: ONE_PASSWORD_REFERENCE_DESCRIPTION,
        default: "",
        experimental_placeholder: "op://Vault/PostHog/credential",
        experimental_section: POSTHOG_SECTION,
      },
      gscBroker: {
        type: "string",
        label: "Broker command",
        description: "Canvas runs: <command> gsc gsc.query_search_analytics <query> --json",
        default: "",
        experimental_placeholder: "/usr/local/bin/mcp-call",
        experimental_section: SEARCH_CONSOLE_SECTION,
      },
      mcpOrigins: {
        type: "string",
        label: "Allowed servers",
        description:
          "One HTTPS address per line, with its port if it has one. Private and tailnet addresses work.",
        experimental_multiline: true,
        experimental_placeholder: "https://mcp.example.com:8443",
        experimental_section: MCP_SECTION,
        experimental_schema: z.string().refine(
          (value) => {
            try {
              parseMcpOrigins(value);

              return true;
            } catch {
              return false;
            }
          },
          { message: "List exact HTTPS origins such as https://host.example:8443" },
        ),
        default: "",
      },
      apiOrigin1: {
        type: "string",
        label: "API address",
        description: API_ORIGIN_DESCRIPTION,
        default: "",
        experimental_placeholder: "https://api.cloudflare.com",
        experimental_section: API_SECTIONS[0],
      },
      apiToken1: {
        type: "string",
        label: "Bearer token",
        secret: true,
        experimental_section: API_SECTIONS[0],
      },
      apiReference1: {
        type: "string",
        label: "1Password reference (optional)",
        description: ONE_PASSWORD_REFERENCE_DESCRIPTION,
        default: "",
        experimental_placeholder: "op://Vault/Item/credential",
        experimental_section: API_SECTIONS[0],
      },
      apiOrigin2: {
        type: "string",
        label: "API address",
        description: API_ORIGIN_DESCRIPTION,
        default: "",
        experimental_placeholder: "https://api.example.com",
        experimental_section: API_SECTIONS[1],
      },
      apiToken2: {
        type: "string",
        label: "Bearer token",
        secret: true,
        experimental_section: API_SECTIONS[1],
      },
      apiReference2: {
        type: "string",
        label: "1Password reference (optional)",
        description: ONE_PASSWORD_REFERENCE_DESCRIPTION,
        default: "",
        experimental_placeholder: "op://Vault/Item/credential",
        experimental_section: API_SECTIONS[1],
      },
    });
  }
  private database() {
    return this.api.storage.database();
  }
  get(threadId: string, id: string): SourceState | null {
    const value = this.database()
      .prepare("SELECT record_json,dataset_json FROM canvas_sources WHERE thread_id=? AND id=?")
      .get(threadId, id);

    if (!value) return null;
    const row = recordRow.parse(value);

    return {
      source: sourceRecordSchema.parse(JSON.parse(row.record_json)),
      dataset: row.dataset_json ? datasetSchema.parse(JSON.parse(row.dataset_json)) : null,
    };
  }
  list(threadId: string): SourceState[] {
    const rows = this.database()
      .prepare("SELECT id FROM canvas_sources WHERE thread_id=? ORDER BY id")
      .all(threadId);

    return rows.map((row) => {
      const { id } = z.object({ id: z.string() }).parse(row);
      const state = this.get(threadId, id);

      if (!state) throw new SourceError("Source disappeared");

      return state;
    });
  }
  private save(threadId: string, state: SourceState): SourceState {
    const definition = state.source.definition;
    this.database()
      .prepare(
        "INSERT INTO canvas_sources(thread_id,id,definition_json,record_json,dataset_json,next_refresh_at) VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id,id) DO UPDATE SET definition_json=excluded.definition_json,record_json=excluded.record_json,dataset_json=excluded.dataset_json,next_refresh_at=excluded.next_refresh_at",
      )
      .run(
        threadId,
        definition.id,
        JSON.stringify(definition),
        JSON.stringify(state.source),
        state.dataset ? JSON.stringify(state.dataset) : null,
        state.source.nextRefreshAt,
      );
    let keys = new Set([threadId]);

    const projects = this.database()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canvas_board_aliases'")
      .get();

    if (projects !== undefined) {
      keys = linkedBoardKeys(this.database(), threadId);
      publishProjectChange(this.api, threadId);
    }

    for (const key of keys)
      this.api.realtime.publish(sourceRealtimeChannel, {
        threadId: key,
        sourceId: definition.id,
        revision: state.dataset?.revision ?? 0,
      });

    return state;
  }
  upsert(threadId: string, input: SourceInput): SourceState {
    const definition = sourceInputSchema.parse(input);

    if (definition.provider === "json") publicSourceUrl(definition.config.url);

    if (definition.provider === "mcp") checkedSourceUrl(definition.config.url, true);

    if (definition.provider === "gsc" && definition.config.startDate > definition.config.endDate)
      throw new SourceError("The source date window is reversed");
    const existing = this.get(threadId, definition.id);

    if (!existing && this.list(threadId).length >= 30)
      throw new SourceError("A board supports up to 30 data sources");

    return this.database().transaction(() => {
      const result = this.save(threadId, {
        source: {
          definition,
          status: "idle",
          error: null,
          lastAttemptAt: existing?.source.lastAttemptAt ?? null,
          lastSuccessAt: existing?.source.lastSuccessAt ?? null,
          failures: 0,
          nextRefreshAt:
            !definition.paused && definition.intervalSeconds
              ? Date.now() + definition.intervalSeconds * 1000
              : null,
        },
        dataset: existing?.dataset ?? null,
      });

      this.database()
        .prepare("UPDATE canvas_sources SET generation=generation+1 WHERE thread_id=? AND id=?")
        .run(threadId, definition.id);

      return result;
    })();
  }
  push(threadId: string, input: DatasetPushInput): SourceState {
    const state = this.get(threadId, input.sourceId);

    if (!state) throw new SourceError("Source not found");

    if (state.source.definition.provider !== "manual")
      throw new SourceError("Agent dataset pushes require a manual source");

    const dataset = datasetSchema.parse({
      ...input,
      sourceId: input.sourceId,
      revision: this.dataRevision(
        state.dataset,
        input.columns,
        input.rows,
        input.provenance ?? state.source.definition.provenance,
      ),
      capturedAt: input.capturedAt ?? Date.now(),
      provenance: input.provenance ?? state.source.definition.provenance,
    });

    this.validateDataset(dataset);

    return this.save(threadId, {
      source: {
        ...state.source,
        status: "ready",
        error: null,
        lastAttemptAt: Date.now(),
        lastSuccessAt: Date.now(),
        failures: 0,
      },
      dataset,
    });
  }
  pause(threadId: string, id: string, paused: boolean): SourceState {
    const state = this.get(threadId, id);

    if (!state) throw new SourceError("Source not found");

    const definition = { ...state.source.definition, paused };

    return this.database().transaction(() => {
      const result = this.save(threadId, {
        ...state,
        source: {
          ...state.source,
          definition,
          nextRefreshAt:
            !paused && definition.intervalSeconds
              ? Date.now() + definition.intervalSeconds * 1000
              : null,
        },
      });

      this.database()
        .prepare("UPDATE canvas_sources SET generation=generation+1 WHERE thread_id=? AND id=?")
        .run(threadId, id);

      return result;
    })();
  }
  invalidate(threadId: string): void {
    for (const [key, controller] of this.controllers)
      if (key.startsWith(`${threadId}:`)) controller.abort();
    this.database()
      .prepare("UPDATE canvas_sources SET generation=generation+1,lease_until=0 WHERE thread_id=?")
      .run(threadId);

    for (const state of this.list(threadId))
      if (state.source.status === "refreshing")
        this.save(threadId, {
          ...state,
          source: {
            ...state.source,
            status: state.dataset === null ? "idle" : "ready",
            error: null,
          },
        });
  }

  move(from: string, to: string): number {
    const existing = z
      .object({ count: z.number() })
      .parse(
        this.database()
          .prepare("SELECT COUNT(*) AS count FROM canvas_sources WHERE thread_id=?")
          .get(to),
      );

    if (existing.count > 0)
      throw new SourceError(
        "This chat already has Canvas sources; move a board only into a chat without any",
      );

    this.invalidate(from);

    return this.database()
      .prepare(
        "UPDATE canvas_sources SET thread_id=?, generation=generation+1, lease_until=0 WHERE thread_id=?",
      )
      .run(to, from).changes;
  }

  remove(threadId: string): void {
    for (const [key, controller] of this.controllers)
      if (key.startsWith(`${threadId}:`)) controller.abort();
    this.database().prepare("DELETE FROM canvas_sources WHERE thread_id=?").run(threadId);
  }

  private dataRevision(
    previous: Dataset | null,
    columns: Dataset["columns"],
    rows: Dataset["rows"],
    provenance: Dataset["provenance"],
  ): number {
    if (
      previous &&
      contentSignature(previous.columns, previous.rows, previous.provenance) ===
        contentSignature(columns, rows, provenance)
    )
      return previous.revision;

    return (previous?.revision ?? 0) + 1;
  }

  private validateDataset(dataset: Dataset): void {
    if (JSON.stringify(dataset).length > maxBytes)
      throw new SourceError("Dataset exceeds the 2 MiB limit");

    for (const row of dataset.rows)
      for (const column of dataset.columns) {
        const value = row[column.key];

        if (
          value === undefined ||
          (value !== null && !scalarTypes[column.type].safeParse(value).success)
        )
          throw new SourceError(`Dataset column ${column.label} has the wrong data type`);
      }
  }
  async importCredential(
    threadId: string,
    input: SourceCredentialInput,
  ): Promise<{ slot: string; configured: boolean }> {
    const settings = await this.settings.get();

    const expectedReference =
      input.slot === "posthogToken"
        ? settings.posthogReference
        : input.slot === "apiToken1"
          ? settings.apiReference1
          : settings.apiReference2;

    const allowedOrigin =
      input.slot === "posthogToken"
        ? settings.posthogOrigin
        : input.slot === "apiToken1"
          ? settings.apiOrigin1
          : settings.apiOrigin2;

    if (!expectedReference || input.reference !== expectedReference || !allowedOrigin)
      throw new SourceError(
        "Set this source's address and 1Password reference in Canvas settings first",
      );

    const origin = checkedSourceUrl(
      allowedOrigin,
      input.slot !== "posthogToken" && parseMcpOrigins(settings.mcpOrigins).includes(allowedOrigin),
    ).origin;

    if (allowedOrigin !== origin || (input.origin && input.origin !== origin))
      throw new SourceError("Credential origin does not match the approved source origin");
    let token: string;

    try {
      const result = await run("op", ["read", input.reference], {
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 8000,
        env: {
          PATH: toolPath(),
          HOME: homedir(),
          OMNYO_THREAD_ID: threadId,
        },
      });

      token = result.stdout.trim();
    } catch {
      throw new SourceError(
        "The 1Password CLI could not read the approved reference; check that op is installed and signed in",
      );
    }

    if (!token || /[\r\n]/u.test(token))
      throw new SourceError("The saved credential is not a single-line API credential");
    await this.settings.experimental_set({ [input.slot]: token });

    return { slot: input.slot, configured: true };
  }
  private async authorization(definition: SourceInput): Promise<string | null> {
    const settings = await this.settings.get();

    if (definition.provider === "posthog")
      return settings.posthogToken ? bearer(settings.posthogToken) : null;

    const target =
      definition.provider === "cloudflare"
        ? { url: cloudflareGraphqlUrl, customPort: false }
        : definition.provider === "json" || definition.provider === "mcp"
          ? { url: definition.config.url, customPort: definition.provider === "mcp" }
          : null;

    if (target === null || !("credential" in definition.config) || !definition.config.credential)
      return null;
    const slot = definition.config.credential;
    const allowedOrigin = slot === "apiToken1" ? settings.apiOrigin1 : settings.apiOrigin2;
    const token = slot === "apiToken1" ? settings.apiToken1 : settings.apiToken2;

    if (!allowedOrigin || checkedSourceUrl(target.url, target.customPort).origin !== allowedOrigin)
      throw new SourceError("This credential is not approved for the source origin");

    if (!token) throw new SourceError("This source credential has not been configured");

    return bearer(token);
  }
  refresh(threadId: string, id: string, signal?: AbortSignal): Promise<SourceState> {
    const key = `${threadId}:${id}`;
    const active = this.active.get(key);

    if (active) return active;

    if (this.active.size >= 3)
      return Promise.reject(new SourceError("At most three sources can refresh at once"));

    const controller = new AbortController();
    this.controllers.set(key, controller);

    const combined = AbortSignal.any([
      controller.signal,
      this.controller.signal,
      ...(signal ? [signal] : []),
    ]);

    const job = this.performRefresh(threadId, id, combined).finally(() => {
      this.active.delete(key);
      this.controllers.delete(key);
    });

    this.active.set(key, job);

    return job;
  }
  private archived(threadId: string): boolean {
    if (
      this.database()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canvas_regions'")
        .get() === undefined
    )
      return false;

    const row = this.database()
      .prepare(
        "SELECT r.archived_at,p.archived_at AS project_archived_at FROM canvas_regions r JOIN canvas_projects p ON p.project_id=r.project_id WHERE r.id=?",
      )
      .get(threadId);

    if (row === undefined) return false;

    const state = z
      .object({ archived_at: z.number().nullable(), project_archived_at: z.number().nullable() })
      .parse(row);

    return state.archived_at !== null || state.project_archived_at !== null;
  }

  private async performRefresh(
    threadId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<SourceState> {
    const initial = this.get(threadId, id);

    if (!initial) throw new SourceError("Source not found");

    if (this.archived(threadId))
      throw new SourceError("This source belongs to an archived Canvas section or project");

    const initialGeneration = z
      .object({ generation: z.number() })
      .parse(
        this.database()
          .prepare("SELECT generation FROM canvas_sources WHERE thread_id=? AND id=?")
          .get(threadId, id),
      ).generation;

    const lease = this.database()
      .prepare(
        "UPDATE canvas_sources SET lease_until=? WHERE thread_id=? AND id=? AND lease_until<=?",
      )
      .run(Date.now() + 45000, threadId, id, Date.now());

    if (lease.changes !== 1) throw new SourceError("This source is already refreshing");
    this.save(threadId, {
      ...initial,
      source: { ...initial.source, status: "refreshing", error: null, lastAttemptAt: Date.now() },
    });

    try {
      const [authorization, settings] = await Promise.all([
        this.authorization(initial.source.definition),
        this.settings.get(),
      ]);

      const loaded = await this.loader(initial.source.definition, authorization, signal, {
        gscBroker: settings.gscBroker,
        posthogOrigin: settings.posthogOrigin,
        mcpOrigins:
          initial.source.definition.provider === "mcp" ? parseMcpOrigins(settings.mcpOrigins) : [],
      });

      const current = this.get(threadId, id);

      if (!current) throw new SourceError("Source disappeared during refresh");

      if (
        initialGeneration !==
        z
          .object({ generation: z.number() })
          .parse(
            this.database()
              .prepare("SELECT generation FROM canvas_sources WHERE thread_id=? AND id=?")
              .get(threadId, id),
          ).generation
      )
        throw new SourceError("Source changed during refresh; refresh the updated configuration");

      const dataset = datasetSchema.parse({
        sourceId: id,
        columns: loaded.columns,
        rows: loaded.rows,
        revision: this.dataRevision(
          current.dataset,
          loaded.columns,
          loaded.rows,
          loaded.provenance ?? current.source.definition.provenance,
        ),
        capturedAt: Date.now(),
        provenance: loaded.provenance ?? current.source.definition.provenance,
      });

      this.validateDataset(dataset);
      const definition = current.source.definition;

      return this.save(threadId, {
        source: {
          ...current.source,
          status: "ready",
          error: null,
          lastSuccessAt: Date.now(),
          failures: 0,
          nextRefreshAt:
            !definition.paused && definition.intervalSeconds
              ? Date.now() + definition.intervalSeconds * 1000
              : null,
        },
        dataset,
      });
    } catch (error) {
      const current = this.get(threadId, id);

      if (!current) throw new SourceError("Source removed during refresh");

      const generation = z
        .object({ generation: z.number() })
        .parse(
          this.database()
            .prepare("SELECT generation FROM canvas_sources WHERE thread_id=? AND id=?")
            .get(threadId, id),
        ).generation;

      const failed: SourceState = {
        ...current,
        source: {
          ...current.source,
          status: "error",
          error:
            error instanceof SourceError
              ? error.message.slice(0, 400)
              : "Source refresh failed; check the connection and declared columns",
        },
      };

      if (generation !== initialGeneration) return failed;
      const failures = current.source.failures + 1;
      const definition = current.source.definition;

      return this.save(threadId, {
        ...failed,
        source: {
          ...failed.source,
          failures,
          nextRefreshAt:
            !definition.paused && definition.intervalSeconds
              ? Date.now() +
                Math.min(3600000, definition.intervalSeconds * 1000 * 2 ** Math.min(6, failures))
              : null,
        },
      });
    } finally {
      this.database()
        .prepare(
          "UPDATE canvas_sources SET lease_until=0 WHERE thread_id=? AND id=? AND generation=?",
        )
        .run(threadId, id, initialGeneration);
    }
  }
  private retryAfterResume(now: number): void {
    const rows = this.database()
      .prepare("SELECT thread_id,id FROM canvas_sources WHERE next_refresh_at>?")
      .all(now);

    for (const value of rows) {
      const row = pollRow.parse(value);
      const state = this.get(row.thread_id, row.id);

      if (state?.source.status === "error")
        this.save(row.thread_id, {
          ...state,
          source: { ...state.source, failures: 0, nextRefreshAt: now },
        });
    }
  }
  async poll(signal?: AbortSignal): Promise<void> {
    const now = Date.now();

    if (this.lastPollAt !== undefined && now - this.lastPollAt > resumeGapMs)
      this.retryAfterResume(now);
    this.lastPollAt = now;

    const projectTables = this.database()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canvas_regions'")
      .get();

    const archiveFilter =
      projectTables === undefined
        ? ""
        : " AND NOT EXISTS (SELECT 1 FROM canvas_regions r JOIN canvas_projects p ON p.project_id=r.project_id WHERE r.id=s.thread_id AND (r.archived_at IS NOT NULL OR p.archived_at IS NOT NULL))";

    const rows = this.database()
      .prepare(
        `SELECT s.thread_id,s.id FROM canvas_sources s JOIN canvas_threads t ON t.thread_id=s.thread_id AND t.enabled=1 WHERE next_refresh_at IS NOT NULL AND next_refresh_at<=? AND lease_until<=?${archiveFilter} ORDER BY next_refresh_at LIMIT 5`,
      )
      .all(now, now);

    for (const value of rows) {
      if (signal?.aborted) return;
      const row = pollRow.parse(value);

      if (this.archived(row.thread_id)) continue;
      await this.refresh(row.thread_id, row.id, signal);
    }
  }
}
