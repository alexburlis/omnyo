// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import weeklyContentFeed from "../workflow-fixtures/weekly-content-feed.json" with { type: "json" };
import { WorkflowCopies } from "../workflow-panel.js";
import type { Copy } from "../workflow-panel-shared.js";
import { workflowPackageSchema } from "./workflow-package.js";
import type { workflowRpcContract } from "./workflow-contract.js";
import type { openSeoRpcContract } from "./openseo-contract.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const digest = (seed: string) => seed.repeat(32);

const weekly = workflowPackageSchema.parse(weeklyContentFeed);

const facts = Array.from(
  { length: 7 },
  (_, index) => `Fact number ${index + 1} about seed swaps.`,
).join("\n");

const keyword = {
  id: "kw_1",
  keyword: "neighborhood seed swap calendar",
  intent: null,
  volume: null,
};

const readId = "9ba85b4b-5332-48c3-bd6a-99791a7706a3";

const retrievedAt = "2026-11-21T10:00:00Z";

function copyOf(pkg: Copy["package"]): Copy {
  return {
    importId: "imp_1",
    projectId: "proj_1",
    graphId: "graph_1",
    graphVersion: 1,
    automationId: null,
    package: pkg,
    packageDigest: digest("a1"),
    executionDigest: digest("b2"),
    bindingRevision: 0,
    bindings: null,
    confirmation: null,
  };
}

function mount(
  initial: Copy,
  extraModels: {
    id: string;
    name: string;
    providerId: "claude-code";
    model: string;
  }[] = [],
  keyConfigured = false,
  connected = true,
) {
  let copy = initial;
  let connection: { site: string; openSeoProjectId: string } | null = null;

  return renderSlot<
    { projectId?: string; importId?: string },
    Pick<
      typeof workflowRpcContract,
      | "workflow_options"
      | "workflow_list"
      | "workflow_bind"
      | "workflow_preview"
      | "workflow_confirm"
    > &
      typeof openSeoRpcContract
  >(
    { component: WorkflowCopies },
    { projectId: initial.projectId, importId: initial.importId },
    {
      rpc: {
        workflow_options: (input) => ({
          projects: [{ id: "proj_1", name: "Mosslight" }],
          hosts: connected ? [{ id: "host_mac", name: "MacBook Pro" }] : [],
          models: input.hostId
            ? [
                {
                  id: "codex:test-model",
                  name: "Codex · Test model",
                  providerId: "codex",
                  model: "test-model",
                },
                ...extraModels,
              ]
            : [],
        }),
        workflow_list: () => [copy],
        workflow_bind: (input) => {
          const { source, ...bindings } = input.bindings;
          copy = {
            ...copy,
            bindings,
            ...(source?.kind === "openseo"
              ? {
                  source: {
                    kind: "openseo",
                    site: "example.com",
                    retrievedAt,
                    keywords: [keyword],
                  },
                }
              : source
                ? { source }
                : {}),
            bindingRevision: copy.bindingRevision + 1,
            confirmation: null,
          };

          return copy;
        },
        workflow_preview: () => ({ copy, example: "Example preview text" }),
        workflow_confirm: () => {
          copy = { ...copy, confirmation: digest("c3") };

          return copy;
        },
        workflow_openseo_status: () => ({
          kind: connection ? "connected" : "disconnected",
          keyConfigured,
          connection,
        }),
        workflow_openseo_projects: ({ site }) =>
          site === "example.com"
            ? {
                kind: "ready",
                projects: [{ id: "research", name: "Seed swaps", site }],
              }
            : { kind: "empty" },
        workflow_openseo_connect: ({ site, openSeoProjectId }) => {
          connection = { site, openSeoProjectId };

          return { kind: "connected" };
        },
        workflow_openseo_disconnect: () => {
          connection = null;

          return { kind: "disconnected", keyConfigured, connection };
        },
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

async function enterBrief(productFacts = facts) {
  const name = await screen.findByLabelText("Startup name");
  const audience = screen.getByLabelText("Audience");
  const evidence = screen.getByLabelText("Product facts from your notes");

  expect(name).toHaveProperty("value", "");
  expect(audience).toHaveProperty("value", "");
  expect(evidence).toHaveProperty("value", "");
  fireEvent.change(name, { target: { value: "My seed swap" } });
  fireEvent.change(audience, { target: { value: "Neighborhood volunteers" } });
  fireEvent.change(evidence, { target: { value: productFacts } });
}

async function chooseGenerationModel(option = "Codex · Test model") {
  fireEvent.change(screen.getByLabelText("Device"), {
    target: { value: "host_mac" },
  });

  const model = await screen.findByRole<HTMLOptionElement>("option", {
    name: option,
  });

  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: model.value },
  });
}

describe("WorkflowCopies setup", () => {
  it("previews the recipient's own notes and requires approval before offering a run", async () => {
    const { rpcCalls } = mount(copyOf(weekly));

    const notes = await screen.findByRole("radio", {
      name: "Start with product notes",
    });

    expect(notes).toHaveProperty("checked", true);
    expect(screen.getByRole("textbox", { name: "Startup name" })).toBeTruthy();
    expect(
      rpcCalls.some((call) => call.method.startsWith("workflow_openseo_")),
    ).toBe(false);
    await enterBrief();
    expect(screen.getByText("Your startup brief")).toBeTruthy();
    expect(
      screen.getByText("References, style and delivery").closest("details")
        ?.open,
    ).toBe(false);

    expect(screen.queryByLabelText("Device")).toBeNull();
    expect(screen.queryByLabelText("Model")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("7 facts");

    fireEvent.click(screen.getByRole("button", { name: "Preview week" }));

    const days = await screen.findAllByText(/^Initial candidate \d focus$/);
    expect(days).toHaveLength(7);
    expect(screen.getByText("Fact number 7 about seed swaps.")).toBeTruthy();
    expect(screen.getAllByText("Thu").length).toBeGreaterThan(0);

    expect(rpcCalls).not.toContainEqual(
      expect.objectContaining({
        method: "workflow_options",
        input: { hostId: "host_mac" },
      }),
    );
    expect(
      rpcCalls.some((call) =>
        ["workflow_bind", "workflow_preview", "workflow_confirm"].includes(
          call.method,
        ),
      ),
    ).toBe(false);

    const approval = screen.getByRole("button", {
      name: "Approve inputs for generation",
    });

    expect(approval).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
    await chooseGenerationModel();
    expect(approval).toHaveProperty("disabled", false);
    fireEvent.click(approval);

    await screen.findByRole("button", { name: "Run now" });
    expect(
      screen.getByRole("button", { name: "Enable schedule" }),
    ).toBeTruthy();
    expect(rpcCalls).not.toContainEqual(
      expect.objectContaining({ method: "workflow_run" }),
    );
    expect(rpcCalls).not.toContainEqual(
      expect.objectContaining({ method: "workflow_enable" }),
    );
    const bind = rpcCalls.find((call) => call.method === "workflow_bind");
    expect(bind?.input).toMatchObject({
      expectedRevision: 0,
      bindings: {
        hostId: "host_mac",
        model: "test-model",
        providerId: "codex",
        source: { kind: "notes" },
        inputs: {
          startup: "My seed swap",
          audience: "Neighborhood volunteers",
          "product-facts": facts,
          terminology: "",
          exclusions: "",
          "delivery-weekday": 4,
          timezone: "America/Toronto",
        },
      },
    });

    expect(
      rpcCalls.find((call) => call.method === "workflow_confirm")?.input,
    ).toMatchObject({ expectedRevision: 1, executionDigest: digest("b2") });
  });

  it("reopens the local preview with no connected device and requires a fresh preview after editing", async () => {
    const initial = copyOf(weekly);
    const first = mount(initial, [], false, false);
    await enterBrief();
    fireEvent.click(screen.getByRole("button", { name: "Preview week" }));
    expect(
      await screen.findByText(
        "Connect a device to choose a model for generation.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approve inputs for generation" }),
    ).toHaveProperty("disabled", true);
    first.unmount();
    const { rpcCalls } = mount(initial);
    expect(
      await screen.findByText("Fact number 7 about seed swaps."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit brief" }));
    fireEvent.change(screen.getByLabelText("Product facts from your notes"), {
      target: { value: "Only the updated note." },
    });
    expect(
      screen.queryByRole("button", { name: "Approve inputs for generation" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview week" }));
    expect(await screen.findByText("Only the updated note.")).toBeTruthy();
    expect(screen.queryByText("Fact number 7 about seed swaps.")).toBeNull();
    expect(screen.getAllByText("Topic chosen at generation")).toHaveLength(7);
    expect(rpcCalls.some((call) => call.method === "workflow_bind")).toBe(
      false,
    );
  });

  it("loads and opts in to dated keyword evidence separately from product facts", async () => {
    const { rpcCalls } = mount(copyOf(weekly), [], true);
    fireEvent.click(
      await screen.findByRole("radio", {
        name: "Import keywords I already have in OpenSEO",
      }),
    );
    const site = await screen.findByRole("textbox", { name: "Site domain" });
    await enterBrief("Members can record seed names.");

    const preview = screen.getByRole("button", {
      name: "Preview week",
    });

    expect(preview).toHaveProperty("disabled", true);
    expect(rpcCalls).not.toContainEqual(
      expect.objectContaining({ method: "workflow_openseo_projects" }),
    );
    fireEvent.change(site, { target: { value: "other.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Find projects" }));
    await screen.findByRole("alert", { name: "" });
    fireEvent.change(site, { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Find projects" }));
    fireEvent.change(
      await screen.findByRole("combobox", { name: "OpenSEO project" }),
      {
        target: { value: "research" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect this copy" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Load saved keywords" }),
    );

    const keywordChoice = await screen.findByRole("checkbox", {
      name: /neighborhood seed swap calendar/,
    });

    expect(keywordChoice).toHaveProperty("checked", false);
    expect(screen.getByText("Metrics unavailable")).toBeTruthy();
    expect(preview).toHaveProperty("disabled", true);
    fireEvent.click(keywordChoice);
    fireEvent.click(preview);

    expect(
      await screen.findByText(
        "The writer uses these facts to support drafts focused on your selected keywords.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Initial candidate 1 focus").parentElement?.textContent,
    ).toContain(keyword.keyword);
    expect(screen.getAllByText("Topic chosen at generation")).toHaveLength(6);
    expect(
      screen.getByRole("region", { name: "Saved OpenSEO research" })
        .textContent,
    ).toContain("2026-11-21 UTC");
    await chooseGenerationModel();
    fireEvent.click(
      screen.getByRole("button", { name: "Approve inputs for generation" }),
    );
    await screen.findByRole("button", { name: "Run now" });
    expect(
      rpcCalls.find((call) => call.method === "workflow_bind")?.input,
    ).toMatchObject({
      bindings: {
        inputs: { "product-facts": "Members can record seed names." },
        source: { kind: "openseo", readId, keywordIds: ["kw_1"] },
      },
    });
  });

  it("offers protected settings and lets recipients return to notes", async () => {
    const { rpcCalls } = mount(copyOf(weekly));
    fireEvent.click(
      await screen.findByRole("radio", {
        name: "Import keywords I already have in OpenSEO",
      }),
    );
    expect(
      await screen.findByRole("link", { name: "Open Automations settings" }),
    ).toHaveProperty("pathname", "/settings/plugins/automations");
    expect(screen.queryByLabelText(/workspace API key/)).toBeNull();
    fireEvent.click(
      screen.getByRole("radio", { name: "Start with product notes" }),
    );
    await enterBrief();
    expect(rpcCalls).not.toContainEqual(
      expect.objectContaining({ method: "workflow_openseo_connect" }),
    );
  });

  it("restores the unsaved brief and site only in the copy returning from settings", async () => {
    const initial = copyOf(weekly);
    const first = mount(initial);

    fireEvent.click(
      await screen.findByRole("radio", {
        name: "Import keywords I already have in OpenSEO",
      }),
    );
    await enterBrief("Use this unsaved note.");
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Site domain" }),
      {
        target: { value: "retained.example" },
      },
    );

    const settings = await screen.findByRole("link", {
      name: "Open Automations settings",
    });

    settings.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    fireEvent.click(settings);
    first.unmount();

    const other = mount({ ...initial, importId: "imp_other" });

    expect(
      await screen.findByRole("radio", {
        name: "Import keywords I already have in OpenSEO",
      }),
    ).toHaveProperty("checked", false);
    other.unmount();

    const returning = mount(initial);

    expect(
      await screen.findByRole("textbox", { name: "Site domain" }),
    ).toHaveProperty("value", "retained.example");
    expect(
      screen.getByLabelText("Product facts from your notes"),
    ).toHaveProperty("value", "Use this unsaved note.");
    returning.unmount();
    mount(initial);

    expect(
      await screen.findByRole("textbox", { name: "Site domain" }),
    ).toHaveProperty("value", "retained.example");
  });

  it("binds the selected Claude CLI and rejects non-text files", async () => {
    const { rpcCalls } = mount(copyOf(weekly), [
      {
        id: "claude-code:claude-test",
        name: "Claude Code · Test",
        providerId: "claude-code",
        model: "claude-test",
      },
    ]);

    fireEvent.click(
      await screen.findByRole("radio", { name: "Start with product notes" }),
    );
    await enterBrief();
    fireEvent.change(
      screen.getByLabelText("Product facts from your notes text file"),
      {
        target: {
          files: [
            new File(["<script>bad</script>"], "script.html", {
              type: "text/html",
            }),
          ],
        },
      },
    );
    expect(
      await screen.findByText("Choose a text file no larger than 32 KiB."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview week" }));
    await chooseGenerationModel("Claude Code · Test");
    fireEvent.click(
      screen.getByRole("button", { name: "Approve inputs for generation" }),
    );
    await waitFor(() =>
      expect(
        rpcCalls.find((call) => call.method === "workflow_bind")?.input,
      ).toMatchObject({
        bindings: { providerId: "claude-code", model: "claude-test" },
      }),
    );
  });

  it("prefills retained inputs without confirming a retired model", async () => {
    mount({
      ...copyOf(weekly),
      draftInputs: {
        startup: "Retained startup",
        "product-facts": facts,
        exclusions: "Never invent claims",
        timezone: "America/Toronto",
      },
    });
    expect(await screen.findByDisplayValue("Retained startup")).toBeTruthy();
    expect(
      screen.getByLabelText("Product facts from your notes"),
    ).toHaveProperty("value", facts);
    expect(screen.getByDisplayValue("Never invent claims")).toBeTruthy();
    expect(screen.queryByText("Setup confirmed")).toBeNull();
  });

  it("keeps every input of a generic workflow in the main form", async () => {
    mount(
      copyOf({
        ...weekly,
        title: "Juniper Calendar",
        inputs: [
          { id: "topic", label: "Topic", type: "text" },
          { id: "count", label: "Count", type: "integer", default: 3 },
        ],
        flow: { kind: "prompt", prompt: "Write about the topic." },
      }),
    );

    expect(await screen.findByText("Make it yours")).toBeTruthy();
    expect(screen.getByLabelText("Topic")).toBeTruthy();
    expect(screen.getByLabelText("Count")).toHaveProperty("required", true);
    expect(screen.getByLabelText("Topic text file")).toBeTruthy();
    expect(screen.queryByText("References, style and delivery")).toBeNull();
  });
});
