import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { completeWorkflowCli } from "./workflow-cli.js";
import { workflowRequest, workflowResponse } from "./workflow-transport.js";
import type { PoolWorkflowInput } from "./workflow-contract.js";

import { syntheticStream } from "./fixtures/workflow-stream.js";

const nativeFixture = vi.hoisted(() => ({ url: "" }));

vi.mock("./native-workflow-eligibility.js", () => ({
  withNativeWorkflowAccount: async (
    _signal: AbortSignal,
    consume: (account: {
      headers: Headers;
      accountId: string;
      url: string;
    }) => Promise<unknown>,
  ) =>
    consume({
      headers: new Headers(),
      accountId: "fixture",
      url: nativeFixture.url,
    }),
}));

describe.skipIf(process.env.OMNYO_WORKFLOW_CLI_PROBE !== "1")(
  "installed workflow CLI protocol",
  () => {
    it("runs Codex through the text-only gateway without contacting a provider", async () => {
      const providerId = "codex";

      const input: PoolWorkflowInput = {
        hostId: "host-fixture",
        attemptId: "probe",
        providerId,
        model: "gpt-6.2-sol",
        prompt: "Reply only: Wire verified",
        timeoutMs: 10000,
        maxOutputBytes: 2000,
      };

      const received: {
        tools: unknown;
        input: unknown;
        system: unknown;
      }[] = [];

      const errors: unknown[] = [];

      const server = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];

          for await (const chunk of req) chunks.push(chunk);
          const headers = new Headers();

          for (const [name, value] of Object.entries(req.headers))
            if (value)
              headers.set(name, Array.isArray(value) ? value.join(",") : value);

          const source = new Request(`http://127.0.0.1${req.url}`, {
            method: "POST",
            headers,
            body: Buffer.concat(chunks),
          });

          const body = await workflowRequest(source, input);
          const parsed = JSON.parse(new TextDecoder().decode(body));
          received.push({
            tools: parsed.tools,
            input: parsed.input,
            system: parsed.system,
          });

          const filtered = await workflowResponse(
            new Response(syntheticStream(providerId), {
              headers: { "content-type": "text/event-stream" },
            }),
            input,
            new AbortController().signal,
          );

          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(await filtered.text());
        } catch (error) {
          errors.push(error);
          res.writeHead(400);
          res.end();
        }
      });

      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );

      try {
        const address = server.address();

        if (!address || typeof address === "string")
          throw new Error("No fixture port");

        const result = await completeWorkflowCli(
          {
            ...input,
            route: {
              kind: "pool",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              capability: "fixture",
            },
          },
          new AbortController().signal,
        );

        expect(errors).toEqual([]);
        expect(result).toEqual({
          ok: true,
          attemptId: "probe",
          text: "Wire verified",
        });
        expect(received).toHaveLength(1);
        expect(received[0]?.tools).toEqual([]);

        expect(JSON.stringify(received[0]?.input)).not.toContain(
          "additional_tools",
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }, 15000);
  },
);

it("reports a safe native provider failure without leaking the response body", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
    }

    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { param: "instructions", message: "PRIVATE ERROR CONTENT" },
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();

    if (!address || typeof address === "string")
      throw new Error("No fixture port");
    nativeFixture.url = `http://127.0.0.1:${address.port}/provider`;

    const result = await completeWorkflowCli(
      {
        hostId: "fixture",
        providerId: "codex",
        attemptId: "failure",
        model: "gpt-6.2-sol",
        prompt: "Private workflow prompt",
        timeoutMs: 12000,
        maxOutputBytes: 1000,
        route: { kind: "native" },
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      ok: false,
      message:
        "Workflow text failed at provider (HTTP 400; parameter=instructions).",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE ERROR CONTENT");
    expect(JSON.stringify(result)).not.toContain("Private workflow prompt");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 15000);
