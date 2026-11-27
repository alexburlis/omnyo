import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { create } from "react-test-renderer";
import { useProjectActions, type Snapshot } from "../state";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });

const saved: Snapshot = {
  revision: 1,
  actions: [{ id: "launch", label: "Launch Mac", kind: "url", url: "https://example.com" }],
  runs: [],
  states: [],
};

function View({ projectId, load }: { projectId: string; load: (id: string) => Promise<Snapshot> }) {
  const { snapshot, loadError } = useProjectActions(projectId, load);

  return createElement(
    "span",
    null,
    snapshot.actions.map((action) => action.label).join(","),
    loadError,
  );
}

test("returning to a project retains labels while revalidation is unresolved", async () => {
  let hold = false;
  const load = () => (hold ? new Promise<Snapshot>(() => {}) : Promise.resolve(saved));
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(View, { projectId: "demo", load }));
  });
  assert.match(JSON.stringify(root!.toJSON()), /Launch Mac/);
  await act(async () => {
    root!.unmount();
  });
  hold = true;
  await act(async () => {
    root = create(createElement(View, { projectId: "demo", load }));
  });
  assert.match(JSON.stringify(root!.toJSON()), /Launch Mac/);
  await act(async () => {
    root!.unmount();
  });
});

test("project switch never shows another project; late responses update only their project", async () => {
  let release: ((value: Snapshot) => void) | undefined;

  const pending = new Promise<Snapshot>((resolve) => {
    release = resolve;
  });

  const load = (id: string): Promise<Snapshot> =>
    id === "slow-a"
      ? pending
      : Promise.resolve({
          ...saved,
          actions: [
            { id: "landing", label: "Other landing", kind: "url", url: "https://example.com" },
          ],
        });

  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(View, { projectId: "slow-a", load }));
  });
  await act(async () => {
    root!.update(createElement(View, { projectId: "other-b", load }));
  });
  assert.match(JSON.stringify(root!.toJSON()), /Other landing/);
  await act(async () => {
    release?.(saved);
  });
  assert.doesNotMatch(JSON.stringify(root!.toJSON()), /Launch Mac/);
  await act(async () => {
    root!.update(createElement(View, { projectId: "slow-a", load }));
  });
  assert.match(JSON.stringify(root!.toJSON()), /Launch Mac/);
  await act(async () => {
    root!.unmount();
  });
});

test("same-project headers share updates and failed refresh preserves labels visibly", async () => {
  let failing = false;
  const load = () => (failing ? Promise.reject(new Error("offline")) : Promise.resolve(saved));
  let first: ReturnType<typeof create>;
  let second: ReturnType<typeof create>;
  await act(async () => {
    first = create(createElement(View, { projectId: "shared", load }));
  });
  failing = true;
  await act(async () => {
    second = create(createElement(View, { projectId: "shared", load }));
  });

  for (const root of [first!, second!]) {
    assert.match(JSON.stringify(root.toJSON()), /Launch Mac/);
    assert.match(JSON.stringify(root.toJSON()), /Could not refresh/);
  }

  await act(async () => {
    first!.unmount();
    second!.unmount();
  });
});

test("invalidation during pending load queues a fresh response for every same-project header", async () => {
  let release: ((value: Snapshot) => void) | undefined;

  const pending = new Promise<Snapshot>((resolve) => {
    release = resolve;
  });

  let calls = 0;

  const latest: Snapshot = {
    ...saved,
    revision: 2,
    actions: [{ id: "new", label: "Latest label", kind: "url", url: "https://example.com" }],
  };

  const load = () => (++calls === 1 ? pending : Promise.resolve(latest));
  let first: ReturnType<typeof create>;
  let second: ReturnType<typeof create>;
  let third: ReturnType<typeof create>;
  await act(async () => {
    first = create(createElement(View, { projectId: "queued", load }));
  });
  await act(async () => {
    second = create(createElement(View, { projectId: "queued", load }));
    third = create(createElement(View, { projectId: "queued", load }));
  });
  await act(async () => {
    release?.(saved);
  });
  assert.equal(calls, 2);

  for (const root of [first!, second!, third!])
    assert.match(JSON.stringify(root.toJSON()), /Latest label/);
  await act(async () => {
    first!.unmount();
    second!.unmount();
    third!.unmount();
  });
});
