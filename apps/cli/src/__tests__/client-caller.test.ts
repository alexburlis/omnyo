import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  INBOX_CALLER_AUTOMATION_HEADER,
  INBOX_CALLER_AUTOMATION_RUN_HEADER,
  INBOX_CALLER_THREAD_HEADER,
} from "@omnyo/domain";
import { afterEach, expect, it, vi } from "vitest";

const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function callerHeadersSeenByServer(
  env: Record<string, string>,
  operation: "waits" | "failures" | "acknowledgeFailure" = "waits",
): Promise<Record<string, string | undefined>> {
  const seen: IncomingHttpHeaders[] = [];

  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ waits: [] }));
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"])
    vi.stubEnv(name, "");

  for (const name of [
    "OMNYO_THREAD_ID",
    "OMNYO_AUTOMATION_ID",
    "OMNYO_AUTOMATION_RUN_ID",
  ])
    vi.stubEnv(name, env[name] ?? "");

  vi.resetModules();
  const { createCliOmnyoSdk } = await import("../client.js");
  const { port } = server.address() as AddressInfo;

  const inbox = createCliOmnyoSdk(
    `http://127.0.0.1:${port}`,
  ).experimental_inbox;

  if (operation === "acknowledgeFailure")
    await inbox.acknowledgeFailure({
      threadId: "thr_target",
      failureId: "failure_exact",
      turnId: "turn_stored",
      reason: "Completed elsewhere",
    });
  else await inbox[operation]({ threadId: "thr_target" });

  const headers = seen[0] ?? {};

  return Object.fromEntries(
    [
      INBOX_CALLER_THREAD_HEADER,
      INBOX_CALLER_AUTOMATION_HEADER,
      INBOX_CALLER_AUTOMATION_RUN_HEADER,
    ].map((name) => [name, headers[name]?.toString()]),
  );
}

it("identifies an agent's chat to the server", async () => {
  expect(
    await callerHeadersSeenByServer({ OMNYO_THREAD_ID: "thr_agent" }),
  ).toEqual({
    [INBOX_CALLER_THREAD_HEADER]: "thr_agent",
    [INBOX_CALLER_AUTOMATION_HEADER]: undefined,
    [INBOX_CALLER_AUTOMATION_RUN_HEADER]: undefined,
  });
});

it("identifies an automation run that has no chat", async () => {
  expect(
    await callerHeadersSeenByServer({
      OMNYO_AUTOMATION_ID: "auto_nightly",
      OMNYO_AUTOMATION_RUN_ID: "run_7",
    }),
  ).toEqual({
    [INBOX_CALLER_THREAD_HEADER]: undefined,
    [INBOX_CALLER_AUTOMATION_HEADER]: "auto_nightly",
    [INBOX_CALLER_AUTOMATION_RUN_HEADER]: "run_7",
  });
});

it("sends no caller identity from an owner's shell", async () => {
  expect(await callerHeadersSeenByServer({})).toEqual({
    [INBOX_CALLER_THREAD_HEADER]: undefined,
    [INBOX_CALLER_AUTOMATION_HEADER]: undefined,
    [INBOX_CALLER_AUTOMATION_RUN_HEADER]: undefined,
  });
});

it.each(["failures", "acknowledgeFailure"] as const)(
  "preserves actual agent caller headers for %s",
  async (operation) => {
    expect(
      await callerHeadersSeenByServer(
        { OMNYO_THREAD_ID: "thr_parent" },
        operation,
      ),
    ).toEqual({
      [INBOX_CALLER_THREAD_HEADER]: "thr_parent",
      [INBOX_CALLER_AUTOMATION_HEADER]: undefined,
      [INBOX_CALLER_AUTOMATION_RUN_HEADER]: undefined,
    });
  },
);
