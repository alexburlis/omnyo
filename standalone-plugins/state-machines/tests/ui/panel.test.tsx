import {
  loadPluginApp,
  type PluginRpcTestHandlers,
  type RenderedSlot,
  renderSlot,
} from "@omnyo/plugin-sdk/testing/app";
import type { PluginNavPanelProps, PluginPendingInteractionProps } from "@omnyo/plugin-sdk/app";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CompactViewportOverrideProvider } from "../../components/omnyo/components/ui/hooks/use-compact-viewport.js";
import { stateMachinesRpc } from "../../src/contracts/rpc.js";
import { attentionView, createStateMachineRpcHandlers } from "../../src/rpc.js";
import { createLocalCheckLoop, createReleaseLoopDraft } from "../../templates/index.js";
import { publish, setup, signal } from "../runtime-fixtures.js";

type Fixture = ReturnType<typeof setup>;

const fixtures: Fixture[] = [];

const ENVIRONMENT = {
  environmentId: "environment",
  label: "Release Mac",
  hostId: "host_test",
  available: true,
  persistent: true,
};

afterEach(() => {
  cleanup();

  for (const fixture of fixtures.splice(0)) fixture.database.close();
});

function fixture(): Fixture {
  const created = setup();

  fixtures.push(created);

  return created;
}

async function mount(
  subPath: string,
  f: Fixture,
  options: {
    compact?: boolean;
    wrap?: (
      rpc: PluginRpcTestHandlers<typeof stateMachinesRpc>,
    ) => PluginRpcTestHandlers<typeof stateMachinesRpc>;
  } = {},
): Promise<RenderedSlot> {
  const app = await loadPluginApp(() => import("../../app.js"));
  const panel = app.navPanels[0];

  if (panel === undefined) throw new Error("navPanel is not registered");

  const Panel = panel.component;

  const component =
    options.compact === true
      ? (props: PluginNavPanelProps) => (
          <CompactViewportOverrideProvider isCompactViewport>
            <Panel {...props} />
          </CompactViewportOverrideProvider>
        )
      : Panel;

  const handlers = createStateMachineRpcHandlers(f.service, {
    listEnvironments: async () => [ENVIRONMENT],
  });

  const rpc: PluginRpcTestHandlers<typeof stateMachinesRpc> = {
    sm_machine_list: async (input) =>
      stateMachinesRpc.sm_machine_list.output.parse(
        await handlers.sm_machine_list(stateMachinesRpc.sm_machine_list.input.parse(input)),
      ),
    sm_machine_create: async (input) =>
      stateMachinesRpc.sm_machine_create.output.parse(
        await handlers.sm_machine_create(stateMachinesRpc.sm_machine_create.input.parse(input)),
      ),
    sm_machine_draft_get: async (input) =>
      stateMachinesRpc.sm_machine_draft_get.output.parse(
        await handlers.sm_machine_draft_get(
          stateMachinesRpc.sm_machine_draft_get.input.parse(input),
        ),
      ),
    sm_machine_draft_save: async (input) =>
      stateMachinesRpc.sm_machine_draft_save.output.parse(
        await handlers.sm_machine_draft_save(
          stateMachinesRpc.sm_machine_draft_save.input.parse(input),
        ),
      ),
    sm_machine_validate: async (input) =>
      stateMachinesRpc.sm_machine_validate.output.parse(
        await handlers.sm_machine_validate(stateMachinesRpc.sm_machine_validate.input.parse(input)),
      ),
    sm_machine_publish: async (input) =>
      stateMachinesRpc.sm_machine_publish.output.parse(
        await handlers.sm_machine_publish(stateMachinesRpc.sm_machine_publish.input.parse(input)),
      ),
    sm_machine_versions: async (input) =>
      stateMachinesRpc.sm_machine_versions.output.parse(
        await handlers.sm_machine_versions(stateMachinesRpc.sm_machine_versions.input.parse(input)),
      ),
    sm_machine_version_get: async (input) =>
      stateMachinesRpc.sm_machine_version_get.output.parse(
        await handlers.sm_machine_version_get(
          stateMachinesRpc.sm_machine_version_get.input.parse(input),
        ),
      ),
    sm_machine_export: async (input) =>
      stateMachinesRpc.sm_machine_export.output.parse(
        await handlers.sm_machine_export(stateMachinesRpc.sm_machine_export.input.parse(input)),
      ),
    sm_instance_list: async (input) =>
      stateMachinesRpc.sm_instance_list.output.parse(
        await handlers.sm_instance_list(stateMachinesRpc.sm_instance_list.input.parse(input)),
      ),
    sm_instance_start: async (input) =>
      stateMachinesRpc.sm_instance_start.output.parse(
        await handlers.sm_instance_start(stateMachinesRpc.sm_instance_start.input.parse(input)),
      ),
    sm_instance_inspect: async (input) =>
      stateMachinesRpc.sm_instance_inspect.output.parse(
        await handlers.sm_instance_inspect(stateMachinesRpc.sm_instance_inspect.input.parse(input)),
      ),
    sm_instance_control: async (input) =>
      stateMachinesRpc.sm_instance_control.output.parse(
        await handlers.sm_instance_control(stateMachinesRpc.sm_instance_control.input.parse(input)),
      ),
    sm_instance_signal: async (input) =>
      stateMachinesRpc.sm_instance_signal.output.parse(
        await handlers.sm_instance_signal(stateMachinesRpc.sm_instance_signal.input.parse(input)),
      ),
    sm_attention_list: async (input) =>
      stateMachinesRpc.sm_attention_list.output.parse(
        await handlers.sm_attention_list(stateMachinesRpc.sm_attention_list.input.parse(input)),
      ),
    sm_attention_resolve: async (input) =>
      stateMachinesRpc.sm_attention_resolve.output.parse(
        await handlers.sm_attention_resolve(
          stateMachinesRpc.sm_attention_resolve.input.parse(input),
        ),
      ),
    sm_history_list: async (input) =>
      stateMachinesRpc.sm_history_list.output.parse(
        await handlers.sm_history_list(stateMachinesRpc.sm_history_list.input.parse(input)),
      ),
    sm_state_history: async (input) =>
      stateMachinesRpc.sm_state_history.output.parse(
        await handlers.sm_state_history(stateMachinesRpc.sm_state_history.input.parse(input)),
      ),
    sm_events_catalog: async (input) =>
      stateMachinesRpc.sm_events_catalog.output.parse(
        await handlers.sm_events_catalog(stateMachinesRpc.sm_events_catalog.input.parse(input)),
      ),
    sm_log_read: async (input) =>
      stateMachinesRpc.sm_log_read.output.parse(
        await handlers.sm_log_read(stateMachinesRpc.sm_log_read.input.parse(input)),
      ),
    sm_environment_list: async (input) =>
      stateMachinesRpc.sm_environment_list.output.parse(
        await handlers.sm_environment_list(stateMachinesRpc.sm_environment_list.input.parse(input)),
      ),
  };

  return renderSlot<PluginNavPanelProps, typeof stateMachinesRpc>(
    { component },
    { subPath },
    {
      rpc: options.wrap === undefined ? rpc : options.wrap(rpc),
      context: { projectId: "project" },
    },
  );
}

function lastPanelPath(slot: RenderedSlot): string | undefined {
  const call = slot.inspection.navigateCalls
    .filter((item) => item.method === "toPluginPanel")
    .at(-1);

  return call?.method === "toPluginPanel" ? call.options?.subPath : undefined;
}

function rpcInputs(slot: RenderedSlot, method: string) {
  return slot.inspection.rpcCalls
    .filter((call) => call.method === method)
    .map((call) => call.input);
}

function machineWithDraft(f: Fixture) {
  const machine = f.service.createMachine({
    projectId: "project",
    name: "Fixture",
    requestId: "create-fixture",
  });

  f.service.saveDraft({
    machineId: machine.machineId,
    expectedRevision: 0,
    document: createLocalCheckLoop({ machineId: machine.machineId, environmentId: "environment" }),
    requestId: "save-fixture",
  });

  return machine;
}

async function runningCheck(f: Fixture) {
  const published = await publish(f);

  signal(f.service, published.instance.instanceId);
  await f.service.tick();

  return published;
}

describe("machines list", () => {
  test("shows the empty state with both creation actions", async () => {
    const slot = await mount("", fixture());

    expect(await slot.findByText("No state machines yet")).toBeTruthy();
    expect(slot.getAllByRole("button", { name: "New machine" }).length).toBeGreaterThan(0);
    expect(slot.getByRole("button", { name: "Start from Release loop template" })).toBeTruthy();
  });

  test("creates a machine with a request id and opens its draft", async () => {
    const f = fixture();
    const slot = await mount("new", f);
    const user = userEvent.setup();

    await user.type(slot.getByLabelText("Title"), "Release loop");
    await user.click(slot.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(lastPanelPath(slot)).toMatch(/^m\/mch_[A-Za-z0-9_-]+\/draft$/));

    const [input] = rpcInputs(slot, "sm_machine_create");

    expect(input).toMatchObject({ projectId: "project", name: "Release loop", template: "blank" });
    expect(JSON.stringify(input)).toMatch(/"requestId":"req_/);
  });
});

describe("draft editor", () => {
  test("autosaves an added state with the expected revision and a request id", async () => {
    const f = fixture();
    const machine = machineWithDraft(f);
    const slot = await mount(`m/${machine.machineId}/draft`, f);
    const user = userEvent.setup();

    expect(await slot.findByText("Saved")).toBeTruthy();
    await user.click(slot.getByRole("button", { name: "Add state" }));
    await user.click(
      within(slot.getByRole("menu", { name: "Add state" })).getByRole("menuitem", {
        name: /Choice/,
      }),
    );

    await waitFor(() => expect(rpcInputs(slot, "sm_machine_draft_save")).toHaveLength(1), {
      timeout: 4000,
    });

    const [save] = rpcInputs(slot, "sm_machine_draft_save");

    expect(save).toMatchObject({ machineId: machine.machineId, expectedRevision: 1 });
    expect(JSON.stringify(save)).toMatch(/"requestId":"req_/);
    await waitFor(() =>
      expect(
        f.service
          .getDraft({ machineId: machine.machineId })
          .document.states.some((state) => state.kind === "choice"),
      ).toBe(true),
    );
  });

  test("defaults agent permissions to Full access and saves an override", async () => {
    const f = fixture();

    const machine = f.service.createMachine({
      projectId: "project",
      name: "Release fixture",
      template: "release-loop",
      requestId: "create-release-fixture",
    });

    const agent = machine.document.states.find((state) => state.kind === "agent");

    if (agent === undefined) throw new Error("Missing agent step in release template");
    agent.action.execution = { providerId: "codex", model: "gpt-6", reasoningLevel: "high" };
    f.service.saveDraft({
      machineId: machine.machineId,
      expectedRevision: 0,
      document: machine.document,
      requestId: "configure-agent",
    });

    const path = `m/${machine.machineId}/draft/@state:${agent.id}`;
    const slot = await mount(path, f);
    const user = userEvent.setup();
    const picker = await slot.findByRole("combobox", { name: "Permission mode" });

    expect(picker).toHaveProperty("value", "full");
    await user.selectOptions(picker, "auto");
    await waitFor(() =>
      expect(f.service.getDraft({ machineId: machine.machineId }).document.states).toContainEqual(
        expect.objectContaining({
          id: agent.id,
          action: expect.objectContaining({ permissionMode: "auto" }),
        }),
      ),
    );
  });

  test("shows the conflict banner and reapplies local edits onto the newer draft", async () => {
    const f = fixture();
    const machine = machineWithDraft(f);
    const slot = await mount(`m/${machine.machineId}/draft`, f);
    const user = userEvent.setup();

    expect(await slot.findByText("Saved")).toBeTruthy();

    const current = f.service.getDraft({ machineId: machine.machineId });

    f.service.saveDraft({
      machineId: machine.machineId,
      expectedRevision: current.revision,
      document: { ...current.document, description: "Changed elsewhere" },
      requestId: "save-elsewhere",
    });

    await user.click(slot.getByRole("button", { name: "Add state" }));
    await user.click(
      within(slot.getByRole("menu", { name: "Add state" })).getByRole("menuitem", { name: /End/ }),
    );

    expect(
      await slot.findByText("This draft was changed somewhere else.", {}, { timeout: 4000 }),
    ).toBeTruthy();
    await user.click(slot.getByRole("button", { name: "Reapply my changes" }));

    await waitFor(
      () => {
        const saved = f.service.getDraft({ machineId: machine.machineId }).document;

        expect(saved.description).toBe("Changed elsewhere");
        expect(saved.states.some((state) => state.kind === "end")).toBe(true);
      },
      { timeout: 4000 },
    );
  });

  test("after a lost save reply it resends the identical request before saving later edits", async () => {
    const f = fixture();
    const machine = machineWithDraft(f);
    let saves = 0;

    const slot = await mount(`m/${machine.machineId}/draft`, f, {
      wrap: (rpc) => ({
        ...rpc,
        sm_machine_draft_save: async (input) => {
          saves += 1;

          const result = await rpc.sm_machine_draft_save(input);

          if (saves === 1) throw new Error("connection reset");

          return result;
        },
      }),
    });

    const user = userEvent.setup();

    expect(await slot.findByText("Saved")).toBeTruthy();
    await user.click(slot.getByRole("button", { name: "Add state" }));
    await user.click(
      within(slot.getByRole("menu", { name: "Add state" })).getByRole("menuitem", {
        name: /Choice/,
      }),
    );
    expect(await slot.findByText("Not saved — retrying", {}, { timeout: 4000 })).toBeTruthy();
    await user.click(slot.getByRole("button", { name: "Undo" }));
    await user.click(slot.getByRole("button", { name: "Add state" }));
    await user.click(
      within(slot.getByRole("menu", { name: "Add state" })).getByRole("menuitem", { name: /End/ }),
    );

    await waitFor(
      () => expect(rpcInputs(slot, "sm_machine_draft_save").length).toBeGreaterThanOrEqual(3),
      { timeout: 8000 },
    );

    const [first, retry, next] = rpcInputs(slot, "sm_machine_draft_save");

    expect(retry).toEqual(first);
    expect(next).toMatchObject({ expectedRevision: 2 });
    expect(JSON.stringify(next)).not.toContain(
      JSON.stringify(first).match(/"requestId":"[^"]+"/)?.[0] ?? "missing",
    );
    await waitFor(() => {
      const saved = f.service.getDraft({ machineId: machine.machineId }).document;

      expect(saved.states.some((state) => state.kind === "end")).toBe(true);
      expect(saved.states.some((state) => state.kind === "choice")).toBe(false);
    });
  });

  test("shows the authority notice for an external-write step and offers no approval control", async () => {
    const f = fixture();

    const machine = f.service.createMachine({
      projectId: "project",
      name: "Release",
      requestId: "create-release",
    });

    f.service.saveDraft({
      machineId: machine.machineId,
      expectedRevision: 0,
      document: createReleaseLoopDraft({ machineId: machine.machineId }),
      requestId: "save-release",
    });

    const slot = await mount(`m/${machine.machineId}/draft/@state:testflight-build`, f);

    expect(await slot.findByText(/need an approval Omnyo can verify came from you/)).toBeTruthy();
    expect(slot.queryByRole("button", { name: /Allow/ })).toBeNull();
    expect(slot.queryByRole("button", { name: /Grant/ })).toBeNull();
  });
});

describe("live instance", () => {
  test("pauses with the expected control revision and a request id", async () => {
    const f = fixture();
    const { machine, instance } = await publish(f);
    const slot = await mount(`m/${machine.machineId}/i/${instance.instanceId}`, f);
    const user = userEvent.setup();

    await user.click(await slot.findByRole("button", { name: "Pause" }));

    await waitFor(() =>
      expect(f.service.inspectInstance({ instanceId: instance.instanceId }).lifecycle).toBe(
        "paused",
      ),
    );

    const [control] = rpcInputs(slot, "sm_instance_control");

    expect(control).toMatchObject({
      instanceId: instance.instanceId,
      expectedControlRevision: instance.controlRevision,
      operation: { kind: "pause" },
    });
    expect(JSON.stringify(control)).toMatch(/"requestId":"req_/);
    expect(await slot.findByText("Paused", { selector: ".stm-pill span" })).toBeTruthy();
  });

  test("stays Stopping while a step is confirmed live and hides Mark outcome unknown", async () => {
    const f = fixture();
    const { machine, instance } = await runningCheck(f);
    const slot = await mount(`m/${machine.machineId}/i/${instance.instanceId}`, f);
    const user = userEvent.setup();

    await user.click(await slot.findByRole("button", { name: "More run controls" }));
    await user.click(slot.getByRole("menuitem", { name: /Stop/ }));
    await user.click(await slot.findByRole("button", { name: "Stop instance" }));

    await waitFor(() =>
      expect(f.service.inspectInstance({ instanceId: instance.instanceId }).lifecycle).toBe(
        "stopping",
      ),
    );
    expect(await slot.findByText("Stopping…", { selector: ".stm-pill span" })).toBeTruthy();
    expect(slot.queryByText("Stopped", { selector: ".stm-pill span" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Mark outcome unknown…" })).toBeNull();
  });

  test("outline marks the current state for assistive technology", async () => {
    const f = fixture();
    const { machine, instance } = await publish(f);
    const slot = await mount(`m/${machine.machineId}/i/${instance.instanceId}/outline`, f);
    const tree = await slot.findByRole("tree");

    const current = within(tree)
      .getAllByRole("treeitem")
      .find((item) => item.getAttribute("aria-current") === "step");

    expect(current?.textContent).toContain("Waiting for the next check");
  });

  test("graph nodes expose names with status text and one tab stop", async () => {
    const f = fixture();
    const { machine, instance } = await publish(f);
    const slot = await mount(`m/${machine.machineId}/i/${instance.instanceId}`, f);
    const group = await slot.findByRole("group", { name: /graph, 3 states/ });
    const nodes = within(group).getAllByRole("button", { name: /transitions? out/ });

    expect(nodes.filter((node) => node.tabIndex === 0)).toHaveLength(1);
    expect(
      nodes
        .find((node) => node.getAttribute("aria-current") === "step")
        ?.getAttribute("aria-label"),
    ).toMatch(/Current/);
  });

  test("compact view defaults to the outline and opens the inspector in the persistent drawer without hiding the app", async () => {
    const f = fixture();
    const { machine, instance } = await publish(f);

    const slot = await mount(
      `m/${machine.machineId}/i/${instance.instanceId}/outline/@state:waiting`,
      f,
      { compact: true },
    );

    expect(await slot.findByRole("tree")).toBeTruthy();
    expect(await slot.findByText("Recent visits", {}, { timeout: 2000 })).toBeTruthy();
    expect(document.querySelector("[inert]")).toBeNull();
    expect(slot.container.closest('[aria-hidden="true"]')).toBeNull();
  });
});

describe("machine hub", () => {
  test("overview stays on the machine, shows section tabs and opens an instance from its card", async () => {
    const f = fixture();
    const { machine, instance } = await publish(f);
    const slot = await mount(`m/${machine.machineId}`, f);
    const user = userEvent.setup();

    const tabs = await slot.findByRole("navigation", { name: "Machine sections" });

    expect(
      within(tabs).getByRole("button", { name: "Overview" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(slot.getByRole("button", { name: "Start instance" })).toBeTruthy();

    const card = await slot.findByRole("button", { name: /^Open instance / });

    expect(lastPanelPath(slot)).toBeUndefined();

    await user.click(card);

    expect(lastPanelPath(slot)).toBe(`m/${machine.machineId}/i/${instance.instanceId}`);

    await user.click(within(tabs).getByRole("button", { name: "Edit draft" }));

    expect(lastPanelPath(slot)).toBe(`m/${machine.machineId}/draft`);
  });

  test("an unpublished machine leads with editing, not starting", async () => {
    const f = fixture();
    const machine = machineWithDraft(f);
    const slot = await mount(`m/${machine.machineId}`, f);

    expect(await slot.findByText("Get started")).toBeTruthy();
    expect(slot.getAllByRole("button", { name: "Edit draft" }).length).toBeGreaterThan(0);
    expect(slot.queryByRole("button", { name: "Start instance" })).toBeNull();
  });
});

describe("canvas", () => {
  test("a plain wheel zooms around the pointer instead of scrolling or panning", async () => {
    const f = fixture();
    const { machine, instance } = await publish(f);
    const slot = await mount(`m/${machine.machineId}/i/${instance.instanceId}`, f);
    const group = await slot.findByRole("group", { name: /graph, 3 states/ });
    const zoom = () => slot.container.querySelector(".stm-zoom")?.textContent ?? "";

    const transform = () =>
      slot.container.querySelector<HTMLElement>(".stm-canvas-world")?.style.transform ?? "";

    const before = zoom();

    const event = new WheelEvent("wheel", {
      deltaY: -200,
      clientX: 0,
      clientY: 0,
      bubbles: true,
      cancelable: true,
    });

    group.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(zoom()).not.toBe(before));
    expect(Number.parseInt(zoom(), 10)).toBeGreaterThan(Number.parseInt(before, 10));
    expect(transform()).toMatch(/scale\(/);
  });
});

describe("graph workspace", () => {
  test("the live graph has no persistent side column; Details opens and closes a floating panel", async () => {
    const f = fixture();
    const { machine, instance } = await publish(f);
    const slot = await mount(`m/${machine.machineId}/i/${instance.instanceId}`, f);
    const user = userEvent.setup();

    expect(await slot.findByRole("group", { name: /graph, 3 states/ })).toBeTruthy();
    expect(slot.queryByRole("complementary", { name: "Inspector" })).toBeNull();

    await user.click(slot.getByRole("button", { name: "Details" }));

    const panel = await slot.findByRole("complementary", { name: "Inspector" });

    expect(within(panel).getByText("This instance")).toBeTruthy();

    await user.click(within(panel).getByRole("button", { name: "Close inspector" }));

    expect(slot.queryByRole("complementary", { name: "Inspector" })).toBeNull();
  });

  test("the draft editor opens the floating inspector for a selected state only", async () => {
    const f = fixture();
    const machine = machineWithDraft(f);
    const empty = await mount(`m/${machine.machineId}/draft`, f);

    expect(await empty.findByRole("group", { name: /graph/ })).toBeTruthy();
    expect(empty.queryByRole("complementary", { name: "Inspector" })).toBeNull();

    cleanup();

    const selected = await mount(`m/${machine.machineId}/draft/@state:waiting`, f);

    expect(await selected.findByRole("complementary", { name: "Inspector" })).toBeTruthy();
  });
});

describe("grouped transitions", () => {
  test("each transition on a shared line keeps its own selectable label and destination", async () => {
    const f = fixture();
    const { machine, instance } = await publish(f);
    const slot = await mount(`m/${machine.machineId}/i/${instance.instanceId}`, f);
    const user = userEvent.setup();
    const group = await slot.findByRole("group", { name: /graph, 3 states/ });
    const labels = group.querySelectorAll(".stm-edge-label");

    const lines = new Set(
      Array.from(group.querySelectorAll(".stm-edge-line"), (path) => path.getAttribute("d")),
    );

    expect(labels).toHaveLength(8);
    expect(lines.size).toBeLessThan(labels.length);

    for (const trigger of ["failed", "timed out", "cancelled"])
      expect(
        within(group).getByRole("button", {
          name: new RegExp(`^From Check workspace to Needs a person on ${trigger}\\.`),
        }),
      ).toBeTruthy();

    await user.click(
      within(group).getByRole("button", {
        name: /^From Check workspace to Needs a person on timed out\./,
      }),
    );

    expect(lastPanelPath(slot)).toBe(
      `m/${machine.machineId}/i/${instance.instanceId}/@tr:tr_check_timeout`,
    );
  });
});

describe("compact instance", () => {
  test("the Graph toggle shows the graph even without a selection", async () => {
    const f = fixture();
    const { machine, instance } = await publish(f);

    const slot = await mount(`m/${machine.machineId}/i/${instance.instanceId}`, f, {
      compact: true,
    });

    expect(await slot.findByRole("tree")).toBeTruthy();

    await userEvent.setup().click(slot.getByRole("button", { name: "Graph" }));

    expect(await slot.findByRole("group", { name: /graph, 3 states/ })).toBeTruthy();
    expect(slot.queryByRole("tree")).toBeNull();
  });
});

describe("attention", () => {
  async function gate(f: Fixture) {
    const published = await runningCheck(f);
    const invocation = f.adapter.starts[0];

    if (invocation === undefined) throw new Error("check step did not start");

    f.adapter.settle(invocation, {
      status: "quiescent",
      confirmedLive: false,
      result: { type: "failed", payload: {} },
    });
    f.advance(2000);
    await f.service.tick();
    await f.service.tick();

    return published;
  }

  test("the home chat sends a routine choice directly and keeps a failed answer available", async () => {
    const f = fixture();
    await gate(f);
    const [attention] = f.service.listAttention();

    if (!attention) throw new Error("run did not open a decision");

    const app = await loadPluginApp(() => import("../../app.js"));
    const registration = app.pendingInteractions.find((slot) => slot.id === "run-decision");

    if (!registration) throw new Error("home chat decision is not registered");

    const view = attentionView(f.service, attention);
    const submit = vi.fn<PluginPendingInteractionProps["submit"]>();

    let rejectAnswer: (reason: Error) => void = () => {};

    submit.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectAnswer = reject;
        }),
    );
    submit.mockResolvedValue(undefined);

    const slot = renderSlot<PluginPendingInteractionProps>(registration, {
      interaction: {
        id: "interaction",
        threadId: "home-chat",
        title: view.title,
        payload: {
          ...view,
          lastError: null,
          decisions: view.decisions.map((option) => ({
            ...option,
            evidenceRequired: false,
            acknowledgement: option.name === "retry-check" ? null : "I checked the prior step.",
          })),
        },
        createdAt: view.createdAt,
        expiresAt: null,
      },
      submit,
      cancel: async () => {},
    });

    const retry = slot.getByRole("button", { name: "Retry check" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(submit).toHaveBeenCalledExactlyOnceWith({ decision: "retry-check", evidence: "" });
    expect(slot.getByRole("status").textContent).toBe("Recording decision…");
    rejectAnswer(new Error("Connection lost"));
    expect((await slot.findByRole("alert")).textContent).toBe("Connection lost");

    const user = userEvent.setup();
    await user.click(slot.getByRole("button", { name: "Resume waiting" }));
    const resume = slot.getByRole("button", { name: "Resume waiting" });
    expect(resume.hasAttribute("disabled")).toBe(true);
    await user.click(slot.getByRole("checkbox", { name: "I checked the prior step." }));
    await user.click(resume);

    expect(submit).toHaveBeenLastCalledWith({ decision: "resume-waiting", evidence: "" });
    expect(await slot.findByText("Recorded: Resume waiting")).toBeTruthy();
  });

  test("requires a decision and its evidence before confirming, then sends the exact entry and revision", async () => {
    const f = fixture();
    const { instance } = await gate(f);
    const slot = await mount("attention", f);
    const user = userEvent.setup();
    await user.click(await slot.findByRole("button", { name: "Retry check" }));
    const confirm = slot.getByRole("button", { name: "Retry check" });

    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(slot.getByLabelText(/What confirms the previous step ended/), {
      target: { value: "Receipt shows exit 1; process ended." },
    });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    await user.click(confirm);

    await waitFor(() => expect(rpcInputs(slot, "sm_attention_resolve")).toHaveLength(1));

    const [resolve] = rpcInputs(slot, "sm_attention_resolve");

    await f.service.tick();

    const view = f.service.inspectInstance({ instanceId: instance.instanceId });

    expect(resolve).toMatchObject({
      instanceId: instance.instanceId,
      decision: "retry-check",
      evidence: "Receipt shows exit 1; process ended.",
    });
    expect(JSON.stringify(resolve)).toMatch(/"entryId":"ent_/);
    expect(view.stateId).not.toBe("needs-person");
  });
});
