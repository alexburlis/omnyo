import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  createConnection,
  createProject,
  createThread,
  insertEvents,
  migrate,
  noopNotifier,
  threads,
  upsertHost,
  type DbConnection,
} from "@omnyo/db";
import { turnScope, threadScope } from "@omnyo/domain";
import {
  commandProofLookupResponseSchema,
  type CommandProofLookupRequest,
} from "@omnyo/server-contract";
import { registerThreadCommandProofRoutes } from "../../src/routes/threads/command-proofs.js";

type InsertEventInput = Parameters<typeof insertEvents>[2][number];

async function fixture(
  run: (input: {
    db: DbConnection;
    app: Hono;
    threadId: string;
    projectId: string;
  }) => Promise<void>,
) {
  const db = createConnection(":memory:");
  migrate(db);

  try {
    const host = upsertHost(db, noopNotifier, { name: "Proof fixture" });

    const { project } = createProject(db, noopNotifier, {
      name: "Proof fixture",
      source: { type: "local_path", hostId: host.id, path: "/fixture" },
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: null,
      providerId: "codex",
    });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 0,
        scope: turnScope("proof-turn"),
        type: "turn/started",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        providerThreadId: "fixture-session",
        data: JSON.stringify({}),
      },
    ]);
    const app = new Hono();
    const api = new Hono();
    registerThreadCommandProofRoutes(api, { db });
    app.route("/api/v1", api);
    await run({ db, app, threadId: thread.id, projectId: project.id });
  } finally {
    db.$client.close();
  }
}

function command(
  threadId: string,
  sequence: number,
  text: string,
  output = `Result ${sequence}`,
  exitCode = 0,
): InsertEventInput {
  return {
    threadId,
    sequence,
    scope: turnScope("proof-turn"),
    type: "item/completed",
    itemId: `command-${sequence}`,
    itemKind: "commandExecution",
    parentToolCallId: null,
    providerThreadId: "fixture-session",
    data: JSON.stringify({
      item: {
        type: "commandExecution",
        id: `command-${sequence}`,
        command: text,
        cwd: "/fixture",
        status: exitCode === 0 ? "completed" : "failed",
        approvalStatus: null,
        exitCode,
        aggregatedOutput: output,
      },
    }),
  };
}

async function read(
  app: Hono,
  threadId: string,
  input: CommandProofLookupRequest,
) {
  const response = await app.request(
    `/api/v1/threads/${threadId}/command-proofs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );

  expect(response.status, await response.clone().text()).toBe(200);

  return commandProofLookupResponseSchema.parse(await response.json());
}

describe("compact command proofs", () => {
  it("matches only unique exact normalized commands and preserves selected failure facts", async () =>
    fixture(async ({ db, app, threadId, projectId }) => {
      const other = createThread(db, noopNotifier, {
        projectId,
        environmentId: null,
        providerId: "codex",
      });

      insertEvents(db, noopNotifier, [
        command(other.id, 3, "pnpm test", "Foreign output", 0),
      ]);
      insertEvents(db, noopNotifier, [
        command(threadId, 1, "echo 'pnpm test'"),
        command(threadId, 2, "pnpm test"),
        command(threadId, 3, "pnpm test", "Failure output", 1),
        command(threadId, 4, "printf 'two  spaces'"),
        command(threadId, 5, "\u2003printf 'line'\r\nnext\u00a0"),
      ]);

      const result = await read(app, threadId, {
        selectors: [
          { kind: "command", command: "pnpm test" },
          { kind: "event", eventSeq: 3 },
          { kind: "command", command: "echo" },
          { kind: "command", command: "printf 'two spaces'" },
          { kind: "command", command: "printf 'line'\nnext" },
        ],
      });

      expect(result.proofs.map((proof) => proof.status)).toEqual([
        "ambiguous",
        "matched",
        "missing",
        "missing",
        "matched",
      ]);
      expect(result.proofs[1]).toEqual({
        status: "matched",
        execution: {
          eventSeq: 3,
          command: "pnpm test",
          cwd: "/fixture",
          status: "failed",
          exitCode: 1,
          excerpt: "Failure output",
        },
      });
      expect(result.proofs[4]).toMatchObject({
        status: "matched",
        execution: { eventSeq: 5 },
      });
      expect(
        (
          await read(app, threadId, {
            selectors: [{ kind: "event", eventSeq: 999 }],
          })
        ).proofs,
      ).toEqual([{ status: "missing" }]);
    }));

  it("bounds searches to 500 completed events and lets an explicit sequence select older commands", async () =>
    fixture(async ({ db, app, threadId }) => {
      const rows = [command(threadId, 1, "old command")];

      for (let sequence = 2; sequence <= 501; sequence++)
        rows.push({
          threadId,
          sequence,
          scope: turnScope("proof-turn"),
          type: "item/completed",
          itemId: `reply-${sequence}`,
          itemKind: "agentMessage",
          parentToolCallId: null,
          providerThreadId: "fixture-session",
          data: JSON.stringify({
            item: {
              type: "agentMessage",
              id: `reply-${sequence}`,
              text: "Completed reply",
            },
          }),
        });
      insertEvents(db, noopNotifier, rows);

      const result = await read(app, threadId, {
        selectors: [
          { kind: "command", command: "old command" },
          { kind: "event", eventSeq: 1 },
          { kind: "event", eventSeq: 501 },
        ],
      });

      expect(result.proofs.map((proof) => proof.status)).toEqual([
        "missing",
        "matched",
        "missing",
      ]);
    }));

  it("does not hydrate irrelevant oversized command output", async () =>
    fixture(async ({ db, app, threadId }) => {
      insertEvents(db, noopNotifier, [
        command(threadId, 1, "irrelevant", "X".repeat(9 * 1024 * 1024)),
        command(threadId, 2, "selected", "Selected result"),
      ]);

      const result = await read(app, threadId, {
        selectors: [{ kind: "command", command: "selected" }],
      });

      expect(result.proofs).toEqual([
        {
          status: "matched",
          execution: {
            eventSeq: 2,
            command: "selected",
            cwd: "/fixture",
            status: "completed",
            exitCode: 0,
            excerpt: "Selected result",
          },
        },
      ]);
    }));

  it("redacts before command matching and excerpts, including retained output", async () =>
    fixture(async ({ db, app, threadId }) => {
      const privateValue = ["proof", "fixture", "private"].join("-");
      insertEvents(db, noopNotifier, [
        {
          threadId,
          sequence: 1,
          scope: threadScope(),
          type: "provider.env-resolved",
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          providerThreadId: "fixture-session",
          data: JSON.stringify({
            providerThreadId: "fixture-session",
            entries: [
              {
                name: "FIXTURE_TOKEN",
                value: privateValue,
                source: "shell",
                reason: "Fixture",
              },
            ],
          }),
        },
        command(
          threadId,
          2,
          `echo ${privateValue}`,
          `H${privateValue}`.repeat(10_000),
        ),
      ]);

      const result = await read(app, threadId, {
        selectors: [{ kind: "command", command: "echo [REDACTED]" }],
      });

      const proof = result.proofs[0];
      expect(proof?.status).toBe("matched");

      if (proof?.status !== "matched")
        throw new Error("Expected selected execution");
      expect(proof.execution.command).toBe("echo [REDACTED]");
      expect(proof.execution.excerpt).not.toContain(privateValue);
      expect(proof.execution.excerpt).toHaveLength(3000);
      expect(proof.execution.excerpt).toContain("\n…\n");
    }));

  it.each([
    {
      name: "short output",
      output: "All checks passed\n",
      expected: "All checks passed\n",
    },
    {
      name: "exactly3000characters",
      output: "H".repeat(1500) + "T".repeat(1500),
      expected: "H".repeat(1500) + "T".repeat(1500),
    },
    {
      name: "3001characters",
      output: "H".repeat(1500) + "x" + "T".repeat(1500),
      expected: "H".repeat(1499) + "\n…\n" + "T".repeat(1498),
    },
    {
      name: "alreadyredacted",
      output: "token: [REDACTED]\nChecks passed",
      expected: "token: [REDACTED]\nChecks passed",
    },
  ])(
    "returns the bounded redacted excerpt for$name",
    async ({ output, expected }) =>
      fixture(async ({ db, app, threadId }) => {
        insertEvents(db, noopNotifier, [
          command(threadId, 1, "selected", output),
        ]);

        const result = await read(app, threadId, {
          selectors: [{ kind: "event", eventSeq: 1 }],
        });

        expect(result.proofs[0]).toMatchObject({
          status: "matched",
          execution: { eventSeq: 1, excerpt: expected },
        });
      }),
  );

  it("validates even an empty lookup and refuses deleted or missing threads", async () =>
    fixture(async ({ db, app, threadId }) => {
      expect(await read(app, threadId, { selectors: [] })).toEqual({
        threadId,
        proofs: [],
      });

      const request = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selectors: [] }),
      };

      expect(
        (await app.request("/api/v1/threads/missing/command-proofs", request))
          .status,
      ).toBe(404);
      db.update(threads)
        .set({ deletedAt: Date.now() })
        .where(eq(threads.id, threadId))
        .run();
      expect(
        (
          await app.request(
            `/api/v1/threads/${threadId}/command-proofs`,
            request,
          )
        ).status,
      ).toBe(404);
    }));
});
