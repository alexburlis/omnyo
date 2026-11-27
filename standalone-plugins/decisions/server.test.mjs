import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@omnyo/plugin-sdk/testing";
import plugin from "./server.ts";

const THREAD = "thread-test";

const question = {
  id: "question-fixture",
  threadId: THREAD,
  revision: 3,
  state: "open",
  answer: null,
  queuedMessageId: null,
  createdAt: 1,
  updatedAt: 1,
  question: {
    key: "D1",
    prompt: "Which direction?",
    context: "Proceed with Compact",
    shortLabel: "D1",
    mode: "optional",
    multiSelect: false,
    allowFreeText: true,
    additiveNotes: true,
    options: [
      { value: "a", label: "Compact", description: null, preview: null, recommended: true },
      { value: "b", label: "Detailed", description: null, preview: null, recommended: false },
    ],
  },
};

async function setup(
  t,
  command = async () => ({
    questions: [question],
    callbacks: [],
    cleared: false,
    callbackMarker: null,
  }),
) {
  const host = createFakePluginHost({
    pluginId: "decisions",
    experimental_declaredIconNames: ["signpost"],
    sdk: {
      experimental_attention: {
        adopt: async () => ({ imported: false }),
        snapshot: async () => ({ questions: [question], callbacks: [] }),
        history: async () => ({ questions: [question], callbacks: [] }),
        command,
      },
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({ id: threadId, environmentId: "env-invoking" }),
      },
      environments: { get: async () => ({ hostId: "host-invoking" }) },
      files: { read: async ({ path }) => ({ content: await readFile(path, "utf8") }) },
    },
  });

  t.after(() => host.harness.lifecycle.dispose());
  await plugin(host.api);

  return host.harness;
}

test("legacy tools open native optional questions with additive notes and no plugin form", async (t) => {
  const harness = await setup(t);
  await harness.behavior.callAgentTool("decisions_open", {
    decisions: [
      { key: "D2", question: "Choose?", options: [{ label: "First" }, { label: "Second" }] },
    ],
  });
  assert.deepEqual(harness.inspection.sdk.callsTo("experimental_attention.adopt"), [
    [{ pluginId: "decisions" }],
  ]);

  const [[{ threadId, command }]] = harness.inspection.sdk.callsTo(
    "experimental_attention.command",
  );

  assert.equal(threadId, THREAD);
  assert.equal(command.action, "open");
  assert.equal(command.questions[0].mode, "optional");
  assert.equal(command.questions[0].additiveNotes, true);
  assert.deepEqual(
    command.questions[0].options.map(({ value }) => value),
    ["a", "b"],
  );
  assert.equal(harness.inspection.sdk.callsTo("threads.send").length, 0);
});

test("legacy answers preserve revision, choice and note through the native durable channel", async (t) => {
  const harness = await setup(t);

  const result = await harness.behavior.callRpc("answer", {
    threadId: THREAD,
    answers: [
      { decisionId: question.id, revision: 3, optionIds: ["a"], text: "Keep details available" },
    ],
  });

  assert.deepEqual(result, { answered: 1, delivery: "queued" });
  assert.deepEqual(harness.inspection.sdk.callsTo("experimental_attention.command"), [
    [
      {
        threadId: THREAD,
        command: {
          action: "answer",
          id: question.id,
          revision: 3,
          answer: { selected: ["a"], freeText: "Keep details available" },
        },
      },
    ],
  ]);
  assert.equal(harness.inspection.sdk.callsTo("threads.send").length, 0);
  await assert.rejects(
    harness.behavior.callRpc("answer", {
      threadId: THREAD,
      answers: [{ decisionId: question.id, revision: 2, optionIds: ["a"], text: null }],
    }),
    /changed/,
  );
  assert.equal(harness.inspection.sdk.callsTo("experimental_attention.command").length, 1);
});

test("native acceptance failures remain visible and skip never sends a message", async (t) => {
  const harness = await setup(t, async ({ command }) => {
    if (command.action === "answer") throw new Error("Native queue unavailable");

    return { questions: [], callbacks: [], cleared: false, callbackMarker: null };
  });

  await assert.rejects(
    harness.behavior.callRpc("answer", {
      threadId: THREAD,
      answers: [{ decisionId: question.id, revision: 3, optionIds: ["a"], text: null }],
    }),
    /Native queue unavailable/,
  );
  assert.deepEqual(
    await harness.behavior.callRpc("skip", { threadId: THREAD, decisionId: question.id }),
    { skipped: 1 },
  );
  assert.equal(harness.inspection.sdk.callsTo("threads.send").length, 0);
  assert.equal(
    harness.inspection.sdk.callsTo("experimental_attention.command").at(-1)[0].command.action,
    "skip",
  );
});

test("CLI updates retain invoking-machine JSON reads and delegate revision checks to core", async (t) => {
  const harness = await setup(t, async ({ command }) => ({
    questions: [{ ...question, revision: 4, question: command.question }],
    callbacks: [],
    cleared: false,
    callbackMarker: null,
  }));

  const directory = await mkdtemp(join(tmpdir(), "decisions-native-"));
  t.after(() => rm(directory, { recursive: true }));
  const path = join(directory, "patch.json");
  await writeFile(path, JSON.stringify({ question: "Updated through the CLI?", context: null }));

  const result = await harness.behavior.runCli(
    ["update", "D1", "--chat", THREAD, "--file", path, "--json"],
    { threadId: THREAD },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const { decision } = JSON.parse(result.stdout);
  assert.equal(decision.id, question.id);
  assert.equal(decision.question, "Updated through the CLI?");
  assert.equal(decision.revision, 4);
  assert.equal(harness.inspection.sdk.callsTo("files.read")[0][0].hostId, "host-invoking");
  const [[{ command }]] = harness.inspection.sdk.callsTo("experimental_attention.command");
  assert.equal(command.revision, 3);
  assert.equal(command.question.context, null);
});
