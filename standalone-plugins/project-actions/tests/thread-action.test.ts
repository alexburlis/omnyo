import assert from "node:assert/strict";
import { test } from "node:test";
import type { Action, Run } from "../contract";
import type { Snapshot } from "../state";
import { projectActionsThreadAction, type ThreadActionData } from "../thread-action";

const build: Action = {
  id: "build",
  label: "Build",
  kind: "command",
  hostId: "mac",
  cwd: "/repo",
  argv: ["make"],
  timeoutMs: 60000,
};

const docs: Action = { id: "docs", label: "Docs", kind: "url", url: "https://example.com" };

function run(overrides: Partial<Run>): Run {
  return {
    id: "build",
    status: "succeeded",
    detail: "",
    url: null,
    startedAt: null,
    activity: null,
    ...overrides,
  };
}

function data(snapshot: Partial<Snapshot>, overrides: Partial<ThreadActionData> = {}) {
  const calls: string[] = [];

  const value: ThreadActionData = {
    projectId: "prj_1",
    snapshot: { revision: 1, actions: [build, docs], runs: [], states: [], ...snapshot },
    confirmingStop: null,
    armStop(id) {
      calls.push(`arm ${id}`);
    },
    async execute(projectId, id) {
      calls.push(`run ${projectId} ${id}`);

      return run({ id });
    },
    async stop(projectId, id) {
      calls.push(`stop ${projectId} ${id}`);
    },
    ...overrides,
  };

  return { value, calls };
}

const thread = { projectId: "prj_1" };

test("a project without actions, or another project's thread, has no menu action", () => {
  const empty = data({ actions: [] });
  const other = data({});

  assert.equal(
    projectActionsThreadAction({
      thread,
      data: empty.value,
      openUrl: () => true,
      notifyError: () => {},
    }),
    null,
  );

  assert.equal(
    projectActionsThreadAction({
      thread: { projectId: "prj_2" },
      data: other.value,
      openUrl: () => true,
      notifyError: () => {},
    }),
    null,
  );

  assert.equal(
    projectActionsThreadAction({
      thread,
      data: { ...other.value, projectId: null },
      openUrl: () => true,
      notifyError: () => {},
    }),
    null,
  );
});

test("each action is a choice and running ones are disabled with their status", () => {
  const { value } = data({
    runs: [run({ status: "running", activity: { text: "2/4 Building", progress: null } })],
  });

  const action = projectActionsThreadAction({
    thread,
    data: value,
    openUrl: () => true,
    notifyError: () => {},
  });

  assert.equal(action?.label, "Project actions");
  assert.equal(action?.detail, "1 running");

  assert.deepEqual(action?.choices?.items, [
    { id: "build", label: "Build · 2/4 Building", disabled: true },
    { id: "stop:build", label: "Force quit Build" },
    { id: "docs", label: "Docs", disabled: false },
  ]);
});

test("a failed run and a status check show beside the label", () => {
  const { value } = data({
    runs: [run({ status: "failed", detail: "exit 2" })],
    states: [{ id: "docs", tone: "on", text: "Up to date", checkedAt: 1 }],
  });

  const action = projectActionsThreadAction({
    thread,
    data: value,
    openUrl: () => true,
    notifyError: () => {},
  });

  assert.equal(action?.detail, "Last run failed");
  assert.equal(action?.choices?.items[0]?.label, "Build · Failed");
  assert.equal(action?.choices?.items[1]?.label, "Docs · Up to date");
});

test("picking a choice runs that action and opens its URL", async () => {
  const { value, calls } = data(
    {},
    {
      async execute(projectId, id) {
        calls.push(`run ${projectId} ${id}`);

        return run({ id, url: id === "docs" ? "https://example.com" : null });
      },
    },
  );

  const opened: string[] = [];

  const action = projectActionsThreadAction({
    thread,
    data: value,
    openUrl: (url) => {
      opened.push(url);

      return true;
    },
    notifyError: () => {},
  });

  await action?.run({ value: "build", requestRename: () => {} });
  await action?.run({ value: "docs", requestRename: () => {} });
  assert.deepEqual(calls, ["run prj_1 build", "run prj_1 docs"]);
  assert.deepEqual(opened, ["https://example.com"]);
});

test("a failed run, a thrown run and a refused URL reach the user", async () => {
  const errors: string[] = [];
  const notifyError = (message: string) => void errors.push(message);

  const failing = data(
    {},
    { execute: async (_projectId, id) => run({ id, status: "failed", detail: "exit 2" }) },
  );

  const failed = projectActionsThreadAction({
    thread,
    data: failing.value,
    openUrl: () => true,
    notifyError,
  });

  await failed?.run({ value: "build", requestRename: () => {} });

  const throwing = data(
    {},
    {
      async execute() {
        throw new Error("rpc down");
      },
    },
  );

  const thrown = projectActionsThreadAction({
    thread,
    data: throwing.value,
    openUrl: () => true,
    notifyError,
  });

  await thrown?.run({ value: "build", requestRename: () => {} });

  const linking = data(
    {},
    { execute: async (_projectId, id) => run({ id, url: "https://x.test" }) },
  );

  const refused = projectActionsThreadAction({
    thread,
    data: linking.value,
    openUrl: () => false,
    notifyError,
  });

  await refused?.run({ value: "docs", requestRename: () => {} });

  assert.deepEqual(errors, [
    "Build: exit 2",
    "Could not run Build.",
    "Omnyo could not open the URL.",
  ]);
});

test("force quit needs a second, confirming pick", async () => {
  const running = [run({ status: "running" })];
  const first = data({ runs: running });

  const unarmed = projectActionsThreadAction({
    thread,
    data: first.value,
    openUrl: () => true,
    notifyError: () => {},
  });

  assert.equal(unarmed?.choices?.items[1]?.label, "Force quit Build");
  await unarmed?.run({ value: "stop:build", requestRename: () => {} });
  assert.deepEqual(first.calls, ["arm build"]);

  const second = data({ runs: running }, { confirmingStop: "build" });

  const armed = projectActionsThreadAction({
    thread,
    data: second.value,
    openUrl: () => true,
    notifyError: () => {},
  });

  assert.deepEqual(armed?.choices?.items[1], {
    id: "confirm-stop:build",
    label: "Confirm force quit Build",
  });

  await armed?.run({ value: "confirm-stop:build", requestRename: () => {} });
  assert.deepEqual(second.calls, ["stop prj_1 build"]);
});

test("a stale confirmation for another action stops nothing", async () => {
  const { value, calls } = data({ runs: [run({ status: "running" })] }, { confirmingStop: null });

  const action = projectActionsThreadAction({
    thread,
    data: value,
    openUrl: () => true,
    notifyError: () => {},
  });

  await action?.run({ value: "confirm-stop:build", requestRename: () => {} });
  assert.deepEqual(calls, []);
});

test("a failing stop is reported", async () => {
  const errors: string[] = [];

  const { value } = data(
    { runs: [run({ status: "running" })] },
    {
      confirmingStop: "build",
      async stop() {
        throw new Error("rpc down");
      },
    },
  );

  const action = projectActionsThreadAction({
    thread,
    data: value,
    openUrl: () => true,
    notifyError: (message) => void errors.push(message),
  });

  await action?.run({ value: "confirm-stop:build", requestRename: () => {} });
  assert.deepEqual(errors, ["Could not force quit Build."]);
});
