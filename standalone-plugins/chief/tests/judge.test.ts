import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { Judges, type JudgeHost, type JudgeSpawn, type JudgeSubmission } from "../lib/judge.ts";
import { memorySql } from "./sql.ts";

interface FakeHost extends JudgeHost {
  spawned: JudgeSpawn[];
  stopped: string[];
  removed: string[];
  warnings: string[];
}

function fakeHost(onSpawn: (threadId: string) => void = () => {}): FakeHost {
  const host: FakeHost = {
    spawned: [],
    stopped: [],
    removed: [],
    warnings: [],
    spawn: async (args) => {
      const threadId = `thr_judge_${host.spawned.length + 1}`;

      host.spawned.push(args);
      onSpawn(threadId);

      return threadId;
    },
    stop: async (threadId) => {
      host.stopped.push(threadId);
    },
    remove: async (threadId) => {
      host.removed.push(threadId);
    },
    warn: (message) => {
      host.warnings.push(message);
    },
  };

  return host;
}

const home = async () => ({
  threadId: "thr_chief",
  projectId: "proj_personal",
  environmentId: "env_chief",
});

const model = () => ({ providerId: "claude-code", model: "claude-sonnet-5-5" });

const submission: JudgeSubmission = {
  verdicts: [
    {
      key: "question_a@1",
      recommendation: ["no"],
      reason: "Because.",
      confidence: "high",
      priority: "soon",
      authorityLike: false,
      duplicateOf: null,
      ruleIds: [],
    },
  ],
};

const statusRowSchema = z.object({ status: z.string() });

function status(db: ReturnType<typeof memorySql>, threadId: string): string | undefined {
  return statusRowSchema
    .optional()
    .parse(db.prepare("SELECT status FROM judges WHERE thread_id = ?").get(threadId))?.status;
}

test("a judge spawned under the Chief returns its submission, then is stopped and deleted", async () => {
  const db = memorySql();
  const host = fakeHost();
  const judges = new Judges(host, db, home, model);
  const running = judges.run("triage", "prompt", ["question_a@1"], null);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(judges.accepts("thr_judge_1", ["triage"]), true);
  judges.submit("thr_judge_1", submission);

  assert.deepEqual(await running, submission);
  assert.equal(host.spawned[0]?.parentThreadId, "thr_chief");
  assert.equal(host.spawned[0]?.environmentId, "env_chief");
  assert.deepEqual(host.stopped, ["thr_judge_1"]);
  assert.deepEqual(host.removed, ["thr_judge_1"]);
  assert.equal(status(db, "thr_judge_1"), "retired");
});

test("a submission that arrives before the judge is registered is not lost", async () => {
  const db = memorySql();
  let judges: Judges | null = null;
  const host = fakeHost((threadId) => judges?.submit(threadId, submission));

  judges = new Judges(host, db, home, model);

  assert.deepEqual(await judges.run("triage", "prompt", ["question_a@1"], null), submission);
});

test("tool calls are accepted only from running judges of the right kind", async () => {
  const db = memorySql();
  const judges = new Judges(fakeHost(), db, home, model);
  const running = judges.run("distill", "prompt", [], null);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(judges.accepts("thr_judge_1", ["distill"]), true);
  assert.equal(judges.accepts("thr_judge_1", ["triage", "eval"]), false);
  assert.equal(judges.accepts("thr_someone_else", ["distill"]), false);
  judges.submit("thr_judge_1", { proposals: [] });
  await running;
  assert.equal(judges.accepts("thr_judge_1", ["distill"]), false);
});

test("a failed judge rejects, records the reason and is still retired", async () => {
  const db = memorySql();
  const host = fakeHost();
  const judges = new Judges(host, db, home, model);
  const running = judges.run("triage", "prompt", [], null);

  await new Promise((resolve) => setImmediate(resolve));
  judges.fail("thr_judge_1", "The judge asked for a permission.");

  await assert.rejects(running, /asked for a permission/);
  assert.deepEqual(host.removed, ["thr_judge_1"]);
  const row = db.prepare("SELECT error FROM judges WHERE thread_id = ?").get("thr_judge_1");

  assert.equal(row?.error, "The judge asked for a permission.");
});

test("a silent judge times out and is retired", async () => {
  const db = memorySql();
  const host = fakeHost();
  const judges = new Judges(host, db, home, model, 20);

  await assert.rejects(judges.run("triage", "prompt", [], null), /did not answer/);
  assert.deepEqual(host.removed, ["thr_judge_1"]);
});

test("judges left over from an earlier load are retired at startup", async () => {
  const db = memorySql();

  db.prepare(
    "INSERT INTO judges (thread_id, kind, job_id, item_keys, status, created_at) VALUES ('thr_old', 'triage', NULL, '[]', 'running', 1)",
  ).run();
  const host = fakeHost();

  await new Judges(host, db, home, model).recover();
  assert.deepEqual(host.removed, ["thr_old"]);
  assert.equal(status(db, "thr_old"), "retired");
});
