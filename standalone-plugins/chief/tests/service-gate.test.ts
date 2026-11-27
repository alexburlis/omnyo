import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { writeState } from "../lib/db.ts";
import { Chief, SuggestionsOffError, V1_SETTINGS, type ChiefSettings } from "../lib/service.ts";
import { memorySql } from "./sql.ts";

const EMPTY: ChiefSettings = { chiefProvider: "", chiefModel: "", judgeProvider: "", judgeModel: "" };

const openQuestion = {
  id: "question_a",
  threadId: "thr_a",
  revision: 1,
  state: "open",
  question: {
    prompt: "Which tests?",
    context: null,
    shortLabel: "Tests",
    mode: "optional",
    multiSelect: false,
    allowFreeText: false,
    delegable: true,
    options: [
      { value: "focused", label: "Focused", description: null, recommended: true },
      { value: "full", label: "Full", description: null, recommended: false },
    ],
  },
  answer: null,
  createdAt: 1_000,
};

interface SpawnArgs {
  providerId?: string;
  model?: string;
  experimental_idle?: boolean;
}

interface UpdateArgs {
  threadId: string;
  experimental_pluginHome: boolean;
}

interface ActionArgs {
  threadId: string;
}

interface CommandArgs {
  threadId: string;
  command?: {
    action: string;
    questions?: {
      prompt: string;
      context: string;
      shortLabel: string;
      options: { value: string; label: string }[];
    }[];
  };
}

interface FakeApi {
  sdk: object;
  log: Partial<PluginApi["log"]>;
}

function fakeApi(value: FakeApi): PluginApi {
  // SAFETY: the Chief paths under test only touch the sdk areas and log methods this fake implements.
  return value as PluginApi;
}

interface FakeThread {
  id: string;
  projectId: string;
  environmentId: string | null;
  status: string;
  deletedAt: number | null;
  pluginHome: boolean;
  title: string;
}

const thread = (threadId: string, overrides: Partial<FakeThread> = {}): FakeThread => ({
  id: threadId,
  projectId: "proj_personal",
  environmentId: "env_1",
  status: "idle",
  deletedAt: null,
  pluginHome: false,
  title: "Chat",
  ...overrides,
});

function harness(
  initial: ChiefSettings = EMPTY,
  getThread: (threadId: string) => Promise<FakeThread> = async (threadId) => thread(threadId),
) {
  const spawned: SpawnArgs[] = [];
  const archived: string[] = [];
  const unpinned: string[] = [];
  const updated: UpdateArgs[] = [];
  const commands: CommandArgs[] = [];
  const written: [string, string][] = [];
  let settings = initial;

  const sdk = {
    threads: {
      spawn: async (args: SpawnArgs) => {
        spawned.push(args);

        if (args.experimental_idle === true) return { id: "thr_new" };
        throw new Error("spawn is stubbed");
      },
      get: async ({ threadId }: { threadId: string }) => getThread(threadId),
      archive: async (args: ActionArgs) => {
        archived.push(args.threadId);
      },
      unpin: async (args: ActionArgs) => {
        unpinned.push(args.threadId);
      },
      update: async (args: UpdateArgs) => {
        updated.push(args);
      },
      stop: async () => {},
      delete: async () => {},
      send: async () => {},
    },
    projects: {
      get: async () => ({ name: "omnyo" }),
      defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-5" }),
    },
    providers: { list: async () => [{ id: "codex", displayName: "Codex" }] },
    experimental_attention: {
      snapshot: async () => ({ questions: [openQuestion] }),
      history: async () => ({ questions: [openQuestion] }),
      command: async (args: CommandArgs) => {
        commands.push(args);

        return { questions: [] };
      },
    },
    experimental_inbox: { snapshot: async () => ({ inbox: [] }) },
    plugins: { callRpc: async () => ({ text: null, status: "idle" }) },
    experimental_server: {
      maintenance: { status: async () => ({ runtime: { serverHostId: "host_1" } }) },
    },
  };

  const log = { warn: () => {}, info: () => {} };
  const api = fakeApi({ sdk, log });
  const db = memorySql();

  writeState(db, "chief.threadId", "thr_chief");

  const chief = new Chief(api, db, () => settings, {
    writeSetting: async (key, value) => {
      written.push([key, value]);
      settings = { ...settings, [key]: value };
    },
    changed: () => {},
  });

  return { chief, db, spawned, updated, commands, written, archived, unpinned };
}

test("no judge spawns from any entry point until the owner says yes", async () => {
  for (const state of ["undecided", "off"] as const) {
    const { chief, db, spawned, commands } = harness();

    if (state === "off") chief.setSuggestions("off");
    assert.equal(chief.suggestions(), state);

    chief.requestTriage();
    await chief.triage();
    await chief.deck();
    await chief.delegate();
    assert.equal(await chief.distillDaily(), null);
    await assert.rejects(chief.distill(), SuggestionsOffError);
    assert.throws(() => chief.startEval("/dev/null", "2026-11-01"), SuggestionsOffError);
    await assert.rejects(chief.judges.run("triage", "p", ["k"], null), SuggestionsOffError);

    assert.equal(spawned.length, 0);
    assert.equal(commands.length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM triage").get()?.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM judges").get()?.n, 0);
  }
});

test("saying yes lets a judge run, with the Personal project's default agent", async () => {
  const { chief, spawned } = harness();

  chief.setSuggestions("on");
  await chief.triage();

  assert.equal(spawned.length, 1);
  assert.deepEqual([spawned[0]?.providerId, spawned[0]?.model], ["codex", "gpt-5"]);
  assert.deepEqual(await chief.agentView(), { providerId: "codex", label: "Codex", ready: true });
});

test("restoring a saved card preserves a newer save from another client", () => {
  const { chief, db } = harness();
  chief.snooze("question:test", 1000);
  chief.snooze("question:test", 2000);
  chief.unsnooze("question:test", 1000);

  const saved = db.prepare("SELECT until FROM snoozes WHERE card_key = ?");

  assert.equal(saved.get("question:test")?.until, 2000);
  chief.unsnooze("question:test", 2000);

  assert.equal(saved.get("question:test"), undefined);
});

test("turning suggestions off cancels answers still waiting to be sent", () => {
  const { chief, db } = harness();

  chief.setSuggestions("on");
  db.prepare(
    `INSERT INTO delegated_answers (id, thread_id, question_id, revision, answer, rule_id, rule_version, reason,
      state, send_at, created_at, updated_at) VALUES ('d1', 'thr_a', 'question_a', 1, '["focused"]', 'r1', 1, 'why', 'waiting', 9, 1, 1)`,
  ).run();
  chief.setSuggestions("off");

  assert.equal(db.prepare("SELECT state FROM delegated_answers WHERE id = 'd1'").get()?.state, "cancelled");
});

test("migration keeps v1 agents, turns suggestions on and tidies the chat away, once", async () => {
  const { chief, updated, written } = harness();

  await chief.migrate();
  await chief.migrate();

  assert.deepEqual(Object.fromEntries(written), V1_SETTINGS);
  assert.equal(chief.suggestions(), "on");
  assert.deepEqual(updated, [{ threadId: "thr_chief", experimental_pluginHome: true }]);
});

test("migration leaves explicit settings alone", async () => {
  const { chief, written } = harness({ ...EMPTY, judgeModel: "claude-haiku" });

  await chief.migrate();

  assert.equal(written.some(([key]) => key === "judgeModel"), false);
});

test("a fresh install's own home chat is never treated as an upgrade", async () => {
  const { chief, db, written, updated } = harness(EMPTY, async (threadId) =>
    thread(threadId, { pluginHome: true }),
  );

  db.prepare("DELETE FROM state WHERE key = 'chief.threadId'").run();
  assert.equal(await chief.ensureHome(), "thr_new");
  await chief.migrate();
  await chief.ensureHome();

  assert.deepEqual(written, []);
  assert.deepEqual(updated, []);
  assert.equal(chief.suggestions(), "undecided");
});

test("a rule question names its topic, splits When and Do, keeps options short and flags an overlap", async () => {
  const { chief, commands } = harness();

  chief.setSuggestions("on");
  await chief.openQuestions();

  const adopted = chief.rules.propose(
    {
      cue: "an agent cannot read a login because 1Password is locked",
      action: "unlock 1Password and approve the prompt",
      project: null,
      evidence: [],
      label: "1Password",
      related: null,
    },
    "learned",
    1,
  );

  chief.rules.bindQuestion(adopted.id, "question_old", 1, 2);
  chief.rules.applyAnswer(
    adopted.id,
    {
      questionRevision: 1,
      choice: "ask",
      ownerAttributed: true,
      coreSupportsAttribution: true,
      precision: null,
      replayMatches: 0,
    },
    3,
  );

  const candidate = chief.rules.propose(
    {
      cue: "an agent asks the owner to unlock 1Password.",
      action: "retry the 1Password prompt, not copying the item.",
      project: null,
      evidence: [],
      label: "1Password",
      related: null,
    },
    "learned",
    4,
  );

  await chief.askAboutRule(candidate, { ruleId: adopted.id, relation: "conflicts" });

  const question = commands.at(-1)?.command?.questions?.[0];

  assert.equal(question?.shortLabel, "1Password");
  assert.equal(
    question?.prompt,
    "When: An agent asks the owner to unlock 1Password\nDo: Retry the 1Password prompt, not copying the item",
  );
  assert.match(
    question?.context ?? "",
    /Conflicts with your adopted rule “1Password” \(all projects\)\nWhen:/u,
  );
  assert.match(question?.context ?? "", /\nDo:/u);
  assert.deepEqual(
    question?.options.map((option) => option.label),
    ["Suggest only", "Answer optional (10-min veto)", "Answer required too (10-min veto)", "Reject"],
  );
});

class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

test("a transient read error never replaces the Chief's chat", async () => {
  const { chief, db, spawned } = harness(EMPTY, async () => {
    throw new HttpError(503);
  });

  writeState(db, "migration.v2", "fresh");

  await assert.rejects(chief.ensureHome(), /HTTP 503/u);
  await chief.keepHomeAlive();
  assert.equal(spawned.length, 0);
  assert.equal(db.prepare("SELECT value FROM state WHERE key = 'chief.threadId'").get()?.value, "thr_chief");
});

test("a deleted Chief chat is recreated once, even when starts overlap", async () => {
  const { chief, db, spawned } = harness(EMPTY, async (threadId) => {
    if (threadId === "thr_chief") throw new HttpError(404);

    return thread(threadId, { pluginHome: true });
  });

  writeState(db, "migration.v2", "fresh");

  const [first, second] = await Promise.all([chief.ensureHome(), chief.ensureHome()]);

  assert.equal(first, "thr_new");
  assert.equal(second, "thr_new");
  assert.equal(spawned.length, 1);
});

test("the Chief's chat is marked as its home chat again after the plugin was turned off and on", async () => {
  const { chief, db, updated, spawned } = harness();

  writeState(db, "migration.v2", "fresh");
  assert.equal(await chief.ensureHome(), "thr_chief");
  assert.deepEqual(updated, [{ threadId: "thr_chief", experimental_pluginHome: true }]);
  assert.equal(spawned.length, 0);
});

test("the background tick recreates a missing chat but never an errored one", async () => {
  const errored = harness(EMPTY, async (threadId) =>
    thread(threadId, { status: "error", environmentId: null, pluginHome: true }),
  );

  writeState(errored.db, "migration.v2", "fresh");
  await errored.chief.keepHomeAlive();
  assert.equal(errored.spawned.length, 0);

  const missing = harness();

  missing.db.prepare("DELETE FROM state WHERE key = 'chief.threadId'").run();
  writeState(missing.db, "migration.v2", "fresh");
  await missing.chief.keepHomeAlive();
  assert.equal(missing.spawned.length, 1);
});

test("the daily rule check skips within 20 hours, so the old loop and the schedule run it once a day", async () => {
  const { chief, db } = harness();

  chief.setSuggestions("on");
  writeState(db, "distill.lastRun", String(Date.now() - 60_000));

  assert.equal(await chief.distillDaily(), null);
});

test("Try again on a broken chat the Chief made replaces it once and archives the old one", async () => {
  const broken = (threadId: string) =>
    thread(threadId, { status: "error", environmentId: null, pluginHome: true });

  const { chief, db, spawned, archived, unpinned, updated } = harness(EMPTY, async (threadId) =>
    threadId === "thr_chief" ? broken(threadId) : thread(threadId, { pluginHome: true }),
  );

  writeState(db, "migration.v2", "fresh");
  writeState(db, "home.idleCreated", "thr_chief");

  assert.equal(await chief.start(), "thr_new");
  assert.equal(spawned.length, 1);
  assert.deepEqual(unpinned, ["thr_chief"]);
  assert.deepEqual(archived, ["thr_chief"]);
  assert.deepEqual(updated, []);
});

test("Try again on a broken chat the Chief did not make keeps it and shows it again", async () => {
  const { chief, db, archived, updated } = harness(EMPTY, async (threadId) =>
    threadId === "thr_chief"
      ? thread(threadId, { status: "error", environmentId: null, pluginHome: true })
      : thread(threadId, { pluginHome: true }),
  );

  writeState(db, "migration.v2", "fresh");

  assert.equal(await chief.start(), "thr_new");
  assert.deepEqual(archived, []);
  assert.deepEqual(updated, [{ threadId: "thr_chief", experimental_pluginHome: false }]);
});
