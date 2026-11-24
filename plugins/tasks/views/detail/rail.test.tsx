// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@omnyo/plugin-sdk/testing/app";
import { makeTask, rpcInput } from "../../test-fixtures.js";

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

installTestPluginRuntime();

const { PropertiesRail } = await import("./rail");

const { TasksRefreshProvider } = await import("../../shell/refresh");

function RailHarness(props: ComponentProps<typeof PropertiesRail>) {
  return (
    <TasksRefreshProvider>
      <PropertiesRail {...props} />
    </TasksRefreshProvider>
  );
}

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";

const OMNYO_PROJECT_ID = "proj_omnyo0000000000000000001";

function projectRow(linkedAppProjectId: string | null) {
  return {
    id: PROJECT_ID,
    name: "Tasks Plugin",
    prefix: "TSK",
    nextTaskNumber: 6,
    color: "blue",
    folderId: null,
    linkedAppProjectId: linkedAppProjectId,
    createdAt: "2026-07-15T00:00:00.000Z",
  };
}

const task = makeTask({
  id: "01HZZZZZZZZZZZZZZZZZZZZZT5",
  projectId: PROJECT_ID,
  number: 5,
  key: "TSK-5",
  title: "Ship the rail",
  position: 1,
});

const HOME_PROJECT = {
  ...projectRow(null),
  id: "01HZZZZZZZZZZZZZZZZZZZZZP2",
  name: "Home",
  prefix: "HOME",
  color: "purple",
};

function railProps(
  linkedAppProjectId: string | null,
  onMoveToProject: (projectId: string) => void = () => {},
) {
  const project = projectRow(linkedAppProjectId);

  return {
    task,
    project,
    projects: [project, HOME_PROJECT],
    labels: [],
    threads: [],
    presets: [],
    onUpdate: () => {},
    onMoveToProject,
    onError: () => {},
  };
}

describe("project rail control", () => {
  it("moves the task only when a different project is picked", async () => {
    const moves: string[] = [];

    const slot = renderSlot(
      { component: RailHarness },
      railProps(null, (projectId) => moves.push(projectId)),
      { rpc: { listAppProjects: () => ({ appProjects: [] }) } },
    );

    fireEvent.click(slot.getByRole("button", { name: "Move to project" }));
    fireEvent.click(await slot.findByRole("option", { name: /Tasks Plugin/ }));
    expect(moves).toEqual([]);

    fireEvent.click(slot.getByRole("button", { name: "Move to project" }));
    fireEvent.click(await slot.findByRole("option", { name: /Home/ }));
    expect(moves).toEqual([HOME_PROJECT.id]);
  });
});

describe("dispatch target rail control", () => {
  it("links a discovered Omnyo project", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];

    const slot = renderSlot({ component: RailHarness }, railProps(null), {
      rpc: {
        listAppProjects: () => ({
          appProjects: [{ id: OMNYO_PROJECT_ID, name: "omnyo monorepo" }],
        }),
        updateProject: (raw: unknown) => {
          const input = rpcInput(raw);
          updateCalls.push(input);

          return {
            project: {
              ...projectRow(input.linkedAppProjectId as string | null),
            },
          };
        },
      },
    });

    fireEvent.click(
      slot.getByRole("button", { name: "Change where agents start" }),
    );
    fireEvent.click(await slot.findByLabelText("Linked Omnyo project"));
    fireEvent.click(
      await slot.findByRole("option", { name: "omnyo monorepo" }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toEqual({
      projectId: PROJECT_ID,
      linkedAppProjectId: OMNYO_PROJECT_ID,
    });
  });

  it("shows the linked Omnyo project's name and unlinks it", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];

    const slot = renderSlot(
      { component: RailHarness },
      railProps(OMNYO_PROJECT_ID),
      {
        rpc: {
          listAppProjects: () => ({
            appProjects: [{ id: OMNYO_PROJECT_ID, name: "omnyo monorepo" }],
          }),
          updateProject: (raw: unknown) => {
            const input = rpcInput(raw);
            updateCalls.push(input);

            return {
              project: {
                ...projectRow(input.linkedAppProjectId as string | null),
              },
            };
          },
        },
      },
    );

    const trigger = slot.getByRole("button", {
      name: "Change where agents start",
    });

    await slot.findByText("omnyo monorepo");

    fireEvent.click(trigger);
    fireEvent.click(await slot.findByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toEqual({
      projectId: PROJECT_ID,
      linkedAppProjectId: null,
    });
  });
});
