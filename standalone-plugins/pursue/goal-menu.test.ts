import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoalDialogStore, goalThreadAction, type ThreadGoal } from "./goal-menu.ts";

const goal: ThreadGoal = {
  objective: "Execute the implementation plan",
  iterations: 0,
  maxIterations: 12,
  status: "active",
  lastVerdict: null,
};

test("a thread without a goal has no menu action", () => {
  assert.equal(
    goalThreadAction(null, () => {}),
    null,
  );
  assert.equal(
    goalThreadAction(undefined, () => {}),
    null,
  );
});

test("an active goal shows progress and its objective, and runs the opener", () => {
  let opened = 0;
  const action = goalThreadAction(goal, () => void (opened += 1));

  assert.equal(action?.label, "Goal 0/12");
  assert.equal(action?.detail, "Execute the implementation plan");
  assert.equal(action?.icon, "Target");
  void action?.run({ requestRename: () => {} });
  assert.equal(opened, 1);
});

test("a stopped or met goal stays reachable with its status", () => {
  assert.equal(goalThreadAction({ ...goal, status: "stopped" }, () => {})?.label, "Goal stopped");
  assert.equal(goalThreadAction({ ...goal, status: "complete" }, () => {})?.label, "Goal met");
});

test("a long multi-line objective is collapsed and truncated", () => {
  const detail = goalThreadAction(
    { ...goal, objective: `first\n\nsecond ${"word ".repeat(40)}` },
    () => {},
  )?.detail;

  assert.ok(detail !== undefined);
  assert.ok(detail.length <= 80);
  assert.ok(detail.endsWith("…"));
  assert.ok(!detail.includes("\n"));
});

test("the dialog store notifies on change and ignores repeats", () => {
  const store = createGoalDialogStore();
  let notified = 0;
  const unsubscribe = store.subscribe(() => void (notified += 1));

  store.open("thr_1");
  store.open("thr_1");
  assert.equal(store.getSnapshot(), "thr_1");
  store.close();
  unsubscribe();
  store.open("thr_2");
  assert.equal(store.getSnapshot(), "thr_2");
  assert.equal(notified, 2);
});
