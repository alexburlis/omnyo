import { cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import type { ProjectCanvas } from "../project-contract";
import { useProjectHistory } from "../components/project-history";

afterEach(cleanup);

function canvas(revision: number): ProjectCanvas {
  return {
    projectId: "proj_history",
    revision,
    homeViewId: null,
    archivedAt: null,
    sections: [],
    views: [],
    chats: [],
  };
}

function Remember({
  result,
  onChanged,
}: {
  result: ProjectCanvas | readonly ProjectCanvas[];
  onChanged?(project: ProjectCanvas): void;
}) {
  const remember = useProjectHistory(onChanged);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          void remember(result)
            .then(() => setChecked(true))
            .catch((reason) => setError(reason instanceof Error ? reason.message : "Undo failed"));
        }}
      >
        Remember saved change
      </button>
      {checked ? <p>Saved change checked</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

it("records the exact applied revision and replays its identity using freshly read revisions", async () => {
  const changed = vi.fn();
  let revision = 30;

  const view = renderSlot(
    { component: Remember },
    { result: canvas(12), onChanged: changed },
    {
      pluginId: "canvas",
      rpc: {
        "project.journal": () => [
          {
            id: "newer",
            revision: 20,
            label: "Somebody else's newer edit",
            actor: "human",
            state: "applied",
            createdAt: 99999,
          },
          {
            id: "undone",
            revision: 12,
            label: "Already undone",
            actor: "human",
            state: "undone",
            createdAt: 99998,
          },
          {
            id: "exact",
            revision: 12,
            label: "Move Deployment",
            actor: "human",
            state: "applied",
            createdAt: 1,
          },
        ],
        "project.get": () => canvas(revision),
        "project.undo": () => canvas(31),
        "project.redo": () => canvas(44),
      },
    },
  );

  fireEvent.click(view.getByRole("button", { name: "Remember saved change" }));
  await waitFor(() =>
    expect(view.experimental_actionHistory.undoLabels).toEqual(["Move Deployment"]),
  );
  expect(view.rpcCalls).toContainEqual({
    method: "project.journal",
    input: { projectId: "proj_history", revisions: [12] },
  });
  await act(async () => view.experimental_actionHistory.undo());
  expect(view.rpcCalls).toContainEqual({
    method: "project.undo",
    input: { projectId: "proj_history", changeId: "exact", actor: "human", expectedRevision: 30 },
  });
  expect(changed).toHaveBeenLastCalledWith(canvas(31));
  revision = 43;
  await act(async () => view.experimental_actionHistory.redo());
  expect(view.rpcCalls).toContainEqual({
    method: "project.redo",
    input: { projectId: "proj_history", changeId: "exact", actor: "human", expectedRevision: 43 },
  });
  expect(changed).toHaveBeenLastCalledWith(canvas(44));
  expect(view.rpcCalls.filter((call) => call.method === "project.journal")).toHaveLength(1);
});

it("does not invent an Undo entry when the saved result has no applied journal identity", async () => {
  const changed = vi.fn();

  const view = renderSlot(
    { component: Remember },
    { result: canvas(8), onChanged: changed },
    {
      pluginId: "canvas",
      rpc: {
        "project.journal": () => [
          {
            id: "other",
            revision: 7,
            label: "Other revision",
            actor: "human",
            state: "applied",
            createdAt: 999,
          },
        ],
      },
    },
  );

  fireEvent.click(view.getByRole("button", { name: "Remember saved change" }));
  await waitFor(() =>
    expect(view.rpcCalls).toContainEqual({
      method: "project.journal",
      input: { projectId: "proj_history", revisions: [8] },
    }),
  );
  await view.findByText("Saved change checked");
  expect(changed).toHaveBeenCalledWith(canvas(8));
  expect(view.experimental_actionHistory.undoLabels).toEqual([]);
});

it("reports journal transport failure as saved work with unavailable Undo", async () => {
  const changed = vi.fn();

  const view = renderSlot(
    { component: Remember },
    { result: canvas(15), onChanged: changed },
    {
      pluginId: "canvas",
      rpc: {
        "project.journal": () => {
          throw new Error("Database unavailable");
        },
      },
    },
  );

  fireEvent.click(view.getByRole("button", { name: "Remember saved change" }));
  expect(await view.findByRole("alert")).toHaveProperty(
    "textContent",
    "Change saved, but Undo could not be prepared.",
  );
  expect(changed).toHaveBeenCalledWith(canvas(15));
  expect(view.experimental_actionHistory.undoLabels).toEqual([]);
});

it("propagates a stale guard refusal without claiming the Undo succeeded", async () => {
  const changed = vi.fn();

  const view = renderSlot(
    { component: Remember },
    { result: canvas(50), onChanged: changed },
    {
      pluginId: "canvas",
      rpc: {
        "project.journal": () => [
          {
            id: "guarded",
            revision: 50,
            label: "Rename section",
            actor: "human",
            state: "applied",
            createdAt: 1,
          },
        ],
        "project.get": () => canvas(60),
        "project.undo": () => {
          throw new Error("Project canvas changed; read it again before editing");
        },
      },
    },
  );

  fireEvent.click(view.getByRole("button", { name: "Remember saved change" }));
  await waitFor(() =>
    expect(view.experimental_actionHistory.undoLabels).toEqual(["Rename section"]),
  );
  await expect(view.experimental_actionHistory.undo()).rejects.toThrow("Project canvas changed");
  expect(view.rpcCalls).toContainEqual({
    method: "project.undo",
    input: { projectId: "proj_history", changeId: "guarded", actor: "human", expectedRevision: 60 },
  });
  expect(changed).toHaveBeenCalledTimes(1);
});

it("groups reorder mutations into one action and reverses their exact identities for Undo", async () => {
  let revision = 100;

  const view = renderSlot(
    { component: Remember },
    { result: [canvas(12), canvas(13), canvas(14)] },
    {
      pluginId: "canvas",
      rpc: {
        "project.journal": () => [
          {
            id: "last",
            revision: 14,
            label: "Move section",
            actor: "human",
            state: "applied",
            createdAt: 3,
          },
          {
            id: "unrelated",
            revision: 90,
            label: "Unrelated edit",
            actor: "human",
            state: "applied",
            createdAt: 100,
          },
          {
            id: "first",
            revision: 12,
            label: "Reorder views",
            actor: "human",
            state: "applied",
            createdAt: 1,
          },
        ],
        "project.get": () => canvas(revision),
        "project.undo": () => canvas(++revision),
        "project.redo": () => canvas(++revision),
      },
    },
  );

  fireEvent.click(view.getByRole("button", { name: "Remember saved change" }));
  await waitFor(() =>
    expect(view.experimental_actionHistory.undoLabels).toEqual(["Reorder canvas contents"]),
  );
  await act(async () => view.experimental_actionHistory.undo());
  await act(async () => view.experimental_actionHistory.redo());
  expect(
    view.rpcCalls.filter(
      (call) => call.method === "project.undo" || call.method === "project.redo",
    ),
  ).toEqual([
    {
      method: "project.undo",
      input: { projectId: "proj_history", changeId: "last", actor: "human", expectedRevision: 100 },
    },
    {
      method: "project.undo",
      input: {
        projectId: "proj_history",
        changeId: "first",
        actor: "human",
        expectedRevision: 101,
      },
    },
    {
      method: "project.redo",
      input: {
        projectId: "proj_history",
        changeId: "first",
        actor: "human",
        expectedRevision: 102,
      },
    },
    {
      method: "project.redo",
      input: { projectId: "proj_history", changeId: "last", actor: "human", expectedRevision: 103 },
    },
  ]);
});
