import { defineCli } from "@omnyo/plugin-sdk";
import { expect, it } from "vitest";
import { browserCommands, type CommandPort } from "../commands.js";
import { verifySchema } from "../requests.js";
import { type JsonPayload } from "../contracts.js";

const requirements = [
  {
    id: "persist",
    text: "Saved names persist",
    kind: "functional",
    required: true,
    origin: "caller",
  },
];

function fixture() {
  const calls: JsonPayload[] = [];

  const port: CommandPort = {
    async submit(caller, selectors, submission, requestId) {
      calls.push(JSON.parse(JSON.stringify({ caller, selectors, submission, requestId })));

      return { runId: "run-a", sessionId: "session-a", state: "accepted" };
    },
    async read() {
      return {
        runId: "run-a",
        state: "completed",
        result: { verdict: "FAILED", completion: "not_completed" },
      };
    },
  };

  const cli = defineCli({ name: "fastloop", summary: "test", commands: browserCommands(port) });

  return { cli, calls };
}

const args = [
  "verify",
  "--request-id",
  "request-a",
  "--url",
  "http://127.0.0.1:4173/settings",
  "--goal",
  "Verify persistence",
  "--requirements-json",
  JSON.stringify(requirements),
];

it("uses the registered SDK CLI and forwards caller-owned requirements and explicit change context", async () => {
  const f = fixture();

  const change = {
    changeId: "change-1",
    files: ["app.ts"],
    baseRef: "revision",
    buildId: "build-1",
  };

  const result = await f.cli.run(
    [
      ...args,
      "--session",
      "session-old",
      "--previous-run",
      "run-old",
      "--change-json",
      JSON.stringify(change),
    ],
    { threadId: "thread-a", projectId: "project-a" },
  );

  expect(result.exitCode).toBe(0);
  expect(f.calls).toMatchObject([
    {
      caller: { kind: "owner", inherited: { threadId: "thread-a" } },
      selectors: { threadId: "thread-a" },
      submission: {
        kind: "verify",
        request: { requirements, sessionId: "session-old", previousRunId: "run-old", change },
      },
    },
  ]);
  expect(f.cli.commands?.some((command) => command.usage.includes("--requirements-json"))).toBe(
    true,
  );
});

it("rejects inherited selector conflicts and invalid inline content before the command port", async () => {
  const f = fixture();
  const conflict = await f.cli.run([...args, "--thread", "thread-b"], { threadId: "thread-a" });
  expect(conflict.exitCode).not.toBe(0);

  for (const value of [
    "/caller/requirements.json",
    "[]",
    "[",
    JSON.stringify(requirements, null, 2),
    "x".repeat(16385),
  ]) {
    const bad = await f.cli.run([...args.slice(0, -1), value], { threadId: "thread-a" });
    expect(bad.exitCode).not.toBe(0);
  }

  expect(f.calls).toEqual([]);
});

it("keeps canonical failed results failed in the CLI exit status", async () => {
  const f = fixture();
  const result = await f.cli.run(["result", "--run", "run-a"], { threadId: "thread-a" });
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
    state: "completed",
    result: { verdict: "FAILED" },
  });
});

it("rejects selector fields and weakened required scope in the strict native request boundary", () => {
  const request = { url: "http://127.0.0.1:4173", goal: "Verify", requirements };
  expect(() => verifySchema.parse({ ...request, hostId: "forged" })).toThrow();
  expect(() =>
    verifySchema.parse({
      ...request,
      requirements: requirements.map((item) => ({ ...item, required: false })),
    }),
  ).toThrow();
});
