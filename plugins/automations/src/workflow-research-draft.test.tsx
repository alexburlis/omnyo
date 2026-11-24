// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import weeklyContentFeed from "../workflow-fixtures/weekly-content-feed.json" with { type: "json" };
import { WorkflowCopies } from "../workflow-panel";
import type { Copy } from "../workflow-panel-shared";
import type { openSeoRpcContract } from "./openseo-contract";
import type { workflowRpcContract } from "./workflow-contract";
import { workflowPackageSchema } from "./workflow-package";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const keyword = {
  id: "kw_1",
  keyword: "neighborhood seed swaps",
  intent: null,
  volume: null,
};

const readId = "9ba85b4b-5332-48c3-bd6a-99791a7706a3";

const retrievedAt = "2026-11-21T10:00:00Z";

const connection = { site: "example.com", openSeoProjectId: "research" };

const initial: Copy = {
  projectId: "proj_draft",
  importId: "imp_draft",
  graphId: "graph_1",
  graphVersion: 1,
  automationId: null,
  package: workflowPackageSchema.parse(weeklyContentFeed),
  packageDigest: "a".repeat(64),
  executionDigest: "b".repeat(64),
  bindingRevision: 1,
  confirmation: null,
  bindings: {
    hostId: "host_mac",
    providerId: "codex",
    model: "test",
    inputs: {
      startup: "Seed swap",
      audience: "Volunteers",
      "product-facts": "Members record seed names.",
    },
  },
  source: {
    kind: "openseo",
    site: connection.site,
    retrievedAt,
    keywords: [keyword],
  },
};

function mount(
  copy = initial,
  activeConnection = connection,
  getConnection = async () => activeConnection,
) {
  return renderSlot<
    { projectId?: string; importId?: string },
    Pick<typeof workflowRpcContract, "workflow_options" | "workflow_list"> &
      Pick<
        typeof openSeoRpcContract,
        | "workflow_openseo_status"
        | "workflow_openseo_projects"
        | "workflow_openseo_keywords"
      >
  >(
    { component: WorkflowCopies },
    { projectId: copy.projectId, importId: copy.importId },
    {
      rpc: {
        workflow_options: ({ hostId }) => ({
          projects: [],
          hosts: [{ id: "host_mac", name: "Mac" }],
          models: hostId
            ? [
                {
                  id: "codex:test",
                  name: "Codex",
                  providerId: "codex",
                  model: "test",
                },
              ]
            : [],
        }),
        workflow_list: () => [copy],
        workflow_openseo_status: async () => ({
          kind: "connected",
          keyConfigured: true,
          connection: await getConnection(),
        }),
        workflow_openseo_projects: () => ({ kind: "empty" }),
        workflow_openseo_keywords: () => ({
          kind: "ready",
          readId,
          retrievedAt,
          keywords: [keyword],
        }),
      },
    },
  );
}

async function edit() {
  fireEvent.click(await screen.findByRole("button", { name: "Edit brief" }));
  await screen.findByRole("button", { name: "Load saved keywords" });
}

function previewButton() {
  return screen.getByRole("button", { name: /preview week/i });
}

it("requires an explicit decision before previewing old research after a failed domain replacement", async () => {
  const { rpcCalls } = mount();
  await edit();
  fireEvent.change(screen.getByLabelText("Site domain"), {
    target: { value: "other.example" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Find projects" }));
  await screen.findByText("No OpenSEO projects match this domain.");
  expect(previewButton()).toHaveProperty("disabled", true);
  expect(rpcCalls).not.toContainEqual(
    expect.objectContaining({ method: "workflow_bind" }),
  );

  fireEvent.click(screen.getByRole("button", { name: /keep saved research/i }));
  expect(screen.getByLabelText("Site domain")).toHaveProperty(
    "value",
    "example.com",
  );
  await waitFor(() =>
    expect(previewButton()).toHaveProperty("disabled", false),
  );
});

it.each([
  {
    label: "the same project",
    projectId: connection.openSeoProjectId,
    preselected: true,
  },
  {
    label: "a different project on the same site",
    projectId: "other-project",
    preselected: false,
  },
])(
  "retains pending research across source choices and reopens with $label",
  async ({ projectId, preselected }) => {
    const first = mount();
    await edit();
    fireEvent.click(
      screen.getByRole("button", { name: "Load saved keywords" }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /neighborhood seed swaps/ }),
    );
    fireEvent.click(
      screen.getByRole("radio", { name: "Start with product notes" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /import keywords/i }));
    expect(
      await screen.findByRole("checkbox", { name: /neighborhood seed swaps/ }),
    ).toHaveProperty("checked", true);
    fireEvent.change(screen.getByLabelText("Audience"), {
      target: { value: "Draft audience" },
    });
    first.unmount();

    const stored = Object.values(window.localStorage).join("");
    expect(stored).not.toContain(readId);
    expect(stored).not.toContain(keyword.keyword);

    const reopened = mount(initial, {
      ...connection,
      openSeoProjectId: projectId,
    });

    const load = await screen.findByRole("button", {
      name: "Load saved keywords",
    });

    expect(screen.getByLabelText("Audience")).toHaveProperty(
      "value",
      "Draft audience",
    );
    expect(previewButton()).toHaveProperty("disabled", true);
    expect(reopened.rpcCalls).not.toContainEqual(
      expect.objectContaining({ method: "workflow_openseo_keywords" }),
    );
    fireEvent.click(load);

    const choice = await screen.findByRole("checkbox", {
      name: /neighborhood seed swaps/,
    });

    expect(choice).toHaveProperty("checked", preselected);
    expect(previewButton()).toHaveProperty("disabled", true);

    if (preselected) {
      fireEvent.click(
        screen.getByRole("button", { name: "Use selected keywords" }),
      );
    } else {
      fireEvent.click(choice);
    }

    await waitFor(() =>
      expect(previewButton()).toHaveProperty("disabled", false),
    );
  },
);

it.each([true, false])(
  "rechecks the active project before preview after a source toggle (unchanged: %s)",
  async (unchanged) => {
    let calls = 0;
    let resolveStatus!: (value: typeof connection) => void;

    const nextStatus = new Promise<typeof connection>((resolve) => {
      resolveStatus = resolve;
    });

    mount(initial, connection, async () =>
      ++calls === 1 ? connection : nextStatus,
    );
    await edit();
    fireEvent.click(
      screen.getByRole("button", { name: "Load saved keywords" }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /neighborhood seed swaps/ }),
    );
    await waitFor(() =>
      expect(previewButton()).toHaveProperty("disabled", false),
    );
    fireEvent.click(
      screen.getByRole("radio", { name: "Start with product notes" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /import keywords/i }));
    await screen.findByText("Checking OpenSEO…");
    expect(previewButton()).toHaveProperty("disabled", true);
    resolveStatus(
      unchanged
        ? connection
        : { ...connection, openSeoProjectId: "different-project" },
    );
    await screen.findByText("Connected to example.com");
    expect(previewButton()).toHaveProperty("disabled", !unchanged);
  },
);

it("keeps newer saved bindings ahead of an older local draft", async () => {
  const first = mount();
  await edit();
  fireEvent.change(screen.getByLabelText("Audience"), {
    target: { value: "Draft audience" },
  });
  first.unmount();
  mount({
    ...initial,
    bindingRevision: initial.bindingRevision + 1,
    bindings: {
      hostId: "host_mac",
      providerId: "codex",
      model: "test",
      inputs: { audience: "New saved audience" },
    },
  });

  expect(await screen.findByText("New saved audience")).toBeTruthy();
  expect(screen.queryByDisplayValue("Draft audience")).toBeNull();
});
