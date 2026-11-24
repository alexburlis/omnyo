import { z } from "zod";
import { openSeoKeyword, openSeoSite } from "./openseo-contract.js";

const endpoint = "https://app.openseo.so/mcp";

const protocol = "2025-06-18";

const maxBytes = 512 * 1024;

const version = z.object({ protocolVersion: z.literal(protocol) });

const envelope = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  result: z.unknown(),
});

const toolResult = z.object({
  isError: z.literal(false).optional(),
  structuredContent: z.unknown(),
});

const projects = z.object({
  projects: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        name: z.string().max(256),
        domain: z.string().nullish(),
      }),
    )
    .max(1000),
});

const keywords = z.object({
  rows: z
    .array(
      z.object({
        id: openSeoKeyword.shape.id,
        keyword: openSeoKeyword.shape.keyword,
        intent: openSeoKeyword.shape.intent,
        searchVolume: openSeoKeyword.shape.volume,
      }),
    )
    .max(50),
});

type Request =
  | {
      method: "initialize";
      id: 1;
      params: {
        protocolVersion: typeof protocol;
        capabilities: object;
        clientInfo: { name: string; version: string };
      };
    }
  | { method: "notifications/initialized" }
  | {
      method: "tools/call";
      id: 2;
      params:
        | { name: "list_projects"; arguments: Record<string, never> }
        | {
            name: "list_saved_keywords";
            arguments: { projectId: string; limit: 50 };
          };
    };

export class OpenSeoRequestError extends Error {
  constructor(readonly kind: "expired" | "budget-blocked" | "failed") {
    super("OpenSEO saved evidence request did not complete.");
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();

  if (!reader) throw new OpenSeoRequestError("failed");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      bytes += value.byteLength;

      if (bytes > maxBytes) throw new OpenSeoRequestError("failed");
      text += decoder.decode(value, { stream: true });
    }

    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function openSeoRead(apiKey: string, signal: AbortSignal) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);

  async function request(message: Request): Promise<unknown> {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${apiKey}`,
        "MCP-Protocol-Version": protocol,
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
      signal: requestSignal,
    });

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new OpenSeoRequestError("expired");
    }

    if (response.status === 402) {
      await response.body?.cancel();
      throw new OpenSeoRequestError("budget-blocked");
    }

    if (!response.ok || response.headers.has("Mcp-Session-Id")) {
      await response.body?.cancel();
      throw new OpenSeoRequestError("failed");
    }

    if (message.method === "notifications/initialized") {
      await response.body?.cancel();

      if (response.status !== 202) throw new OpenSeoRequestError("failed");

      return;
    }

    if (!response.headers.get("content-type")?.startsWith("application/json")) {
      await response.body?.cancel();
      throw new OpenSeoRequestError("failed");
    }

    const parsed = envelope.parse(await boundedJson(response));

    if (parsed.id !== message.id) throw new OpenSeoRequestError("failed");

    return parsed.result;
  }

  version.parse(
    await request({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: protocol,
        capabilities: {},
        clientInfo: { name: "Omnyo", version: "1" },
      },
    }),
  );
  await request({ method: "notifications/initialized" });

  async function read(
    params: Extract<Request, { method: "tools/call" }>["params"],
  ) {
    const { structuredContent } = toolResult.parse(
      await request({ id: 2, method: "tools/call", params }),
    );

    return structuredContent;
  }

  return {
    async projects(site: string) {
      const data = projects.parse(
        await read({ name: "list_projects", arguments: {} }),
      );

      return data.projects
        .flatMap(({ id, name, domain }) => {
          const normalized = openSeoSite.safeParse(domain);

          return normalized.success &&
            normalized.data === site &&
            !id.includes(apiKey) &&
            !name.includes(apiKey)
            ? [{ id, name, site }]
            : [];
        })
        .slice(0, 100);
    },
    async keywords(projectId: string) {
      const data = keywords.parse(
        await read({
          name: "list_saved_keywords",
          arguments: { projectId, limit: 50 },
        }),
      );

      return data.rows.flatMap(({ searchVolume, ...row }) =>
        [row.id, row.keyword, row.intent].some((value) =>
          value?.includes(apiKey),
        )
          ? []
          : [{ ...row, volume: searchVolume }],
      );
    },
  };
}
