import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadWaitConditions, threadWaits } from "@omnyo/db";
import {
  INBOX_CALLER_THREAD_HEADER,
  inboxEventCheckResponseSchema,
  type InboxEventCheckResponse,
} from "@omnyo/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitForHostConnected } from "../helpers/assertions.js";
import {
  createProjectFixture,
  createReadyHostThread,
} from "../helpers/fixtures.js";
import { withHarness, type IntegrationHarness } from "../helpers/harness.js";
import { DEFAULT_TIMEOUT_MS } from "./smoke/shared.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnyo-wait-sources-it-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function check(
  harness: IntegrationHarness,
  key: string,
): Promise<InboxEventCheckResponse> {
  const response = await fetch(
    `${harness.serverUrl}/api/v1/inbox/events/check`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    },
  );

  expect(response.status).toBe(200);

  return inboxEventCheckResponseSchema.parse(await response.json());
}

async function registerWait(
  harness: IntegrationHarness,
  threadId: string,
  body: { key: string; for: string; events: string[] },
  caller: "owner" | "agent",
): Promise<Response> {
  return fetch(`${harness.serverUrl}/api/v1/threads/${threadId}/waits`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(caller === "agent" ? { [INBOX_CALLER_THREAD_HEADER]: threadId } : {}),
    },
    body: JSON.stringify(body),
  });
}

function eventCondition(harness: IntegrationHarness, key: string) {
  return harness.db
    .select({
      state: threadWaitConditions.state,
      result: threadWaitConditions.result,
      status: threadWaits.status,
      proposalKind: threadWaits.proposalKind,
    })
    .from(threadWaitConditions)
    .innerJoin(threadWaits, eq(threadWaits.id, threadWaitConditions.waitId))
    .where(eq(threadWaitConditions.target, key))
    .get();
}

async function statusServer(): Promise<{
  server: Server;
  url: string;
  requests: () => number;
  setBody: (body: string) => void;
}> {
  let body = "starting";
  let requests = 0;

  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();

  if (address === null || typeof address === "string")
    throw new Error("status server has no port");

  return {
    server,
    url: `http://127.0.0.1:${address.port}/status`,
    requests: () => requests,
    setBody: (next) => {
      body = next;
    },
  };
}

describe.sequential("wait sources on the real server and host daemon", () => {
  it("checks http, file and command keys through the bundled plugin", () =>
    withHarness({ builtinPlugins: ["wait-sources"] }, async (harness) => {
      const host = await waitForHostConnected(harness.api, DEFAULT_TIMEOUT_MS);
      const status = await statusServer();

      try {
        const httpKey = `http:${status.url}#ready`;

        expect(await check(harness, httpKey)).toMatchObject({
          valid: true,
          kind: "poll",
          approval: "owner",
          fired: false,
          error: null,
        });
        status.setBody("build is ready");
        expect(await check(harness, httpKey)).toMatchObject({
          fired: true,
          result: `${status.url} answered 200 and contains "ready".`,
        });
        expect(status.requests()).toBe(2);
      } finally {
        status.server.close();
      }

      const marker = join(directory, "done.txt");
      const fileKey = `file:${host.id}:${marker}`;

      expect(await check(harness, fileKey)).toMatchObject({
        valid: true,
        approval: "none",
        fired: false,
        error: null,
      });
      await writeFile(marker, "ok");

      const found = await check(harness, fileKey);

      expect(found.fired).toBe(true);
      expect(found.result).toMatch(
        new RegExp(
          `^${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} exists on ${host.id} \\(file, 2 bytes, modified `,
        ),
      );

      expect(
        await check(
          harness,
          `command:${host.id}:test -f '${marker}' && echo found`,
        ),
      ).toMatchObject({
        fired: true,
        result: `\`test -f '${marker}' && echo found\` succeeded on ${host.id}.\nfound`,
      });
      expect(await check(harness, `command:${host.id}:exit 3`)).toMatchObject({
        fired: false,
        error: null,
      });
      expect(
        await check(
          harness,
          `command:${host.id}:omnyo-wait-sources-no-such-tool`,
        ),
      ).toMatchObject({
        fired: false,
        error: "the command was not found (exit 127)",
      });
      expect(
        await check(harness, "file:host_missing_machine:/tmp/anything"),
      ).toMatchObject({
        fired: false,
        error: "no machine host_missing_machine",
      });
    }));

  it("resumes a waiting chat when its file appears and runs a command only once the owner waits on it", () =>
    withHarness({ builtinPlugins: ["wait-sources"] }, async (harness) => {
      const host = await waitForHostConnected(harness.api, DEFAULT_TIMEOUT_MS);

      const project = await createProjectFixture(harness, {
        name: "wait-sources",
      });

      const { thread } = await createReadyHostThread(harness, {
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: { type: "unmanaged", path: harness.repoDir },
      });

      const present = join(directory, "present.txt");
      const missing = join(directory, "missing.txt");
      const ran = join(directory, "ran.txt");
      const presentKey = `file:${host.id}:${present}`;
      const missingKey = `file:${host.id}:${missing}`;
      const commandKey = `command:${host.id}:touch '${ran}'`;

      await writeFile(present, "ready");

      for (const [key, events] of [
        ["present", [presentKey]],
        ["missing", [missingKey]],
      ] as const)
        expect(
          (
            await registerWait(
              harness,
              thread.id,
              { key, for: `${key} file appears`, events: [...events] },
              "owner",
            )
          ).status,
        ).toBe(200);

      expect(
        (
          await registerWait(
            harness,
            thread.id,
            {
              key: "agent-command",
              for: "the marker is written",
              events: [commandKey],
            },
            "agent",
          )
        ).status,
      ).toBe(200);
      expect(eventCondition(harness, commandKey)).toMatchObject({
        status: "proposed",
        proposalKind: "watch",
      });

      await harness.server.pollEventSources();

      expect(eventCondition(harness, presentKey)).toMatchObject({
        state: "met",
      });
      expect(eventCondition(harness, presentKey)?.status).not.toBe("live");
      expect(eventCondition(harness, missingKey)).toMatchObject({
        state: "pending",
        status: "live",
      });
      expect(await exists(ran)).toBe(false);

      expect(
        (
          await registerWait(
            harness,
            thread.id,
            {
              key: "owner-command",
              for: "the marker is written",
              events: [commandKey],
            },
            "owner",
          )
        ).status,
      ).toBe(200);

      await harness.server.pollEventSources();

      expect(await exists(ran)).toBe(true);
      expect(
        harness.db
          .select({ state: threadWaitConditions.state })
          .from(threadWaitConditions)
          .innerJoin(
            threadWaits,
            eq(threadWaits.id, threadWaitConditions.waitId),
          )
          .where(eq(threadWaits.key, "owner-command"))
          .get(),
      ).toEqual({ state: "met" });
    }));
});
