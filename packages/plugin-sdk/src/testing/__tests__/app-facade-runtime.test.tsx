// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  definePluginApp,
  experimental_Icon,
  experimental_usePluginId,
  experimental_useQuestionFormHost,
  experimental_useAppContext,
  experimental_useVisibleAppContext,
  usePluginResource,
} from "../../app.js";
import {
  installTestPluginResourceRuntime,
  installTestPluginRuntime,
  loadPluginApp,
  renderSlot,
} from "../app.js";

interface RuntimeHost {
  __omnyoPluginRuntime?: unknown;
}

const host = globalThis as RuntimeHost;

const runtimeAtImport = host.__omnyoPluginRuntime;

const Icon = experimental_Icon;

afterEach(() => {
  cleanup();
  host.__omnyoPluginRuntime = runtimeAtImport;
});

function ContextProbe() {
  const context = experimental_useAppContext();

  return (
    <p>
      <Icon name="Folder" aria-label="folder" />
      {context.projectId}
    </p>
  );
}

describe("@omnyo/plugin-sdk/app without a runtime at import time", () => {
  it("supports standalone resource fixtures with the real shared cache", async () => {
    const runtime = installTestPluginResourceRuntime();
    let reads = 0;

    function ResourceProbe() {
      const resource = usePluginResource({
        key: ["fixture"],
        load: async () => {
          reads += 1;

          return "loaded resource";
        },
      });

      return <p>{resource.data ?? "pending"}</p>;
    }

    const first = render(<ResourceProbe />);
    await screen.findByText("loaded resource");
    first.unmount();
    const second = render(<ResourceProbe />);
    expect(screen.getByText("loaded resource")).toBeTruthy();
    expect(reads).toBe(1);
    second.unmount();
    runtime.dispose();
    expect(host.__omnyoPluginRuntime).toBe(runtimeAtImport);
  });

  it("loaded before any runtime was installed", () => {
    expect(runtimeAtImport).toBeUndefined();
  });

  it("defines a plugin app without a runtime", async () => {
    const definition = definePluginApp((app) => {
      app.slots.homepageSection({
        id: "probe",
        title: "Probe",
        component: ContextProbe,
      });
    });

    expect(definition.__omnyoPluginApp).toBe(true);
    const app = await loadPluginApp(definition);
    expect(app.homepageSections.map((section) => section.id)).toEqual([
      "probe",
    ]);
  });

  it("renders statically imported components and hooks once a runtime is installed", () => {
    const slot = renderSlot(
      { component: ContextProbe },
      {},
      { context: { projectId: "proj_1" } },
    );

    expect(slot.getByText("proj_1")).toBeTruthy();
    expect(slot.getByLabelText("folder").getAttribute("data-icon")).toBe(
      "Folder",
    );
  });

  it("forwards the semantic visible context from the test runtime", () => {
    function VisibleContextProbe() {
      return (
        <output>{JSON.stringify(experimental_useVisibleAppContext())}</output>
      );
    }

    const context = {
      view: "settings",
      projectId: null,
      threadId: null,
      panel: null,
    } as const;

    const slot = renderSlot(
      { component: VisibleContextProbe },
      {},
      { visibleContext: context },
    );

    expect(slot.getByRole("status").textContent).toBe(JSON.stringify(context));
  });

  it("names the missing runtime when a hook runs without one", () => {
    host.__omnyoPluginRuntime = undefined;
    expect(() => render(<ContextProbe />)).toThrow(
      /experimental_useAppContext needs the Omnyo app's plugin runtime/,
    );
  });

  it("reports the renderSlot plugin id, test-plugin by default", () => {
    function PluginIdProbe() {
      return <p>{experimental_usePluginId()}</p>;
    }

    expect(
      renderSlot({ component: PluginIdProbe }, {}).getByText("test-plugin"),
    ).toBeTruthy();
    expect(
      renderSlot(
        { component: PluginIdProbe },
        {},
        { pluginId: "my-sidebar" },
      ).getByText("my-sidebar"),
    ).toBeTruthy();
  });

  it("gives a form rendered outside a pending interaction no answer shortcuts", () => {
    const chosen: number[] = [];

    function QuestionShortcutProbe() {
      const host = experimental_useQuestionFormHost();
      host.registerChoiceHandler((index) => {
        chosen.push(index);

        return true;
      })();

      return <p>{`${host.shortcuts.size} shortcuts`}</p>;
    }

    expect(
      renderSlot({ component: QuestionShortcutProbe }, {}).getByText(
        "0 shortcuts",
      ),
    ).toBeTruthy();
    expect(chosen).toEqual([]);
  });

  it("renders a component through the runtime's React", () => {
    installTestPluginRuntime();
    render(<Icon name="Zap" aria-label="zap" />);
    expect(screen.getByLabelText("zap").getAttribute("data-icon")).toBe("Zap");
  });
});
