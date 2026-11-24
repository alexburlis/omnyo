// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { afterEach, expect, it } from "vitest";
import weeklyContentFeed from "../workflow-fixtures/weekly-content-feed.json" with { type: "json" };
import { WorkflowIntake } from "../workflow-panel.js";
import type { workflowRpcContract } from "./workflow-contract.js";
import { workflowPackageSchema } from "./workflow-package.js";

afterEach(cleanup);

it("keeps the pending review and saves into the first project added from it", async () => {
  const workflow = workflowPackageSchema.parse(weeklyContentFeed);
  const packageDigest = "a1".repeat(32);
  const executionDigest = "b2".repeat(32);

  const project = { id: "proj_first", name: "First project" };
  const importId = "imp_first";

  let finishCreation: ((created: typeof project) => void) | undefined;

  const { navigateCalls, rpcCalls } = renderSlot<
    { shareId?: string },
    Pick<
      typeof workflowRpcContract,
      "workflow_inspect" | "workflow_options" | "workflow_install"
    >
  >(
    { component: WorkflowIntake },
    {},
    {
      openProjectCreator: (onCreated) => {
        finishCreation = onCreated;

        return true;
      },
      rpc: {
        workflow_options: () => ({
          projects: [],
          hosts: [{ id: "host_mac", name: "Mac" }],
          models: [],
        }),
        workflow_inspect: () => ({
          reviewId: "review_first",
          package: workflow,
          packageDigest,
          executionDigest,
          capabilities: [],
          source: "template",
        }),
        workflow_install: ({ projectId }) => ({
          projectId,
          importId,
          graphId: null,
          graphVersion: null,
          automationId: null,
          package: workflow,
          packageDigest,
          executionDigest,
          bindingRevision: 0,
          bindings: null,
          confirmation: null,
        }),
      },
    },
  );

  fireEvent.click(
    screen.getByRole("button", { name: "Review Weekly Content Feed" }),
  );

  const save = await screen.findByRole("button", {
    name: "Save copy and choose sources",
  });

  expect(save).toHaveProperty("disabled", true);
  fireEvent.click(await screen.findByRole("button", { name: "Add a project" }));
  expect(save).toHaveProperty("disabled", true);
  expect(navigateCalls).toEqual([
    { method: "experimental_openProjectCreator" },
  ]);
  expect(finishCreation).toBeTypeOf("function");

  act(() => finishCreation?.(project));

  expect(screen.getByRole("heading", { name: workflow.title })).toBeTruthy();
  expect(screen.getByLabelText("Recipient project")).toHaveProperty(
    "value",
    project.id,
  );

  fireEvent.click(save);

  await waitFor(() =>
    expect(navigateCalls).toEqual([
      { method: "experimental_openProjectCreator" },
      {
        method: "toPluginPanel",
        path: "automations",
        options: { subPath: `copies/${project.id}/${importId}` },
      },
    ]),
  );

  expect(rpcCalls).toContainEqual({
    method: "workflow_install",
    input: {
      projectId: project.id,
      reviewId: "review_first",
      packageDigest,
      requestId: expect.any(String),
    },
  });
});
