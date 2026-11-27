import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { ProjectCanvasHeader } from "../components/project-header";
import { CompactViewportOverrideProvider } from "../ui/components/ui/hooks/use-compact-viewport";

afterEach(cleanup);

function Header({ compact }: { compact: boolean }) {
  return (
    <CompactViewportOverrideProvider isCompactViewport={compact}>
      <ProjectCanvasHeader subPath="proj_header/s/sec_live" />
    </CompactViewportOverrideProvider>
  );
}

function render(compact: boolean) {
  const actions: string[] = [];

  const listen = (event: Event) => {
    if (event instanceof CustomEvent) actions.push(String(event.detail?.action));
  };

  window.addEventListener("canvas-project-action", listen);

  const view = renderSlot(
    { component: Header },
    { compact },
    {
      pluginId: "canvas",
      rpc: { "project.info": () => ({ name: "Acme" }) },
    },
  );

  return { view, actions, stop: () => window.removeEventListener("canvas-project-action", listen) };
}

it.each([
  [true, ["Contents", "Project changes", "Sources"], ["jump", "contents", "changes", "sources"]],
  [
    false,
    ["Contents", "Save view", "Project changes", "Sources", "Full screen"],
    ["jump", "contents", "save", "changes", "sources", "fullscreen"],
  ],
])(
  "keeps every header action reachable in keyboard order when compact is %s",
  async (compact, names, dispatched) => {
    const test = render(compact);

    try {
      const toolbar = test.view.getByRole("toolbar", { name: "Canvas tools" });
      expect(toolbar.dataset.compact).toBe(String(compact));
      await waitFor(() =>
        expect(within(toolbar).getAllByRole("button")[1]?.getAttribute("aria-label")).toBe(
          "Acme canvas. Jump to a section or view",
        ),
      );
      const buttons = within(toolbar).getAllByRole("button");
      expect(buttons[0]?.getAttribute("aria-label")).toBe("Canvas overview");
      expect(buttons.slice(2).map((button) => button.getAttribute("aria-label"))).toEqual(names);

      for (const button of buttons) {
        expect(button.hasAttribute("disabled")).toBe(false);
        expect(button.tabIndex).toBe(0);
        fireEvent.click(button);
      }

      expect(test.actions).toEqual(dispatched);
      expect(test.view.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "p" });
    } finally {
      test.stop();
    }
  },
);
