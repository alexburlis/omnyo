import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installTestPluginRuntime } from "@omnyo/plugin-sdk/testing/app";
import { ProjectDrawer } from "../components/project-drawer";
import { CompactViewportOverrideProvider } from "../ui/components/ui/hooks/use-compact-viewport";

beforeEach(() => installTestPluginRuntime());

afterEach(cleanup);

it("delegates compact presentation and controlled dismissal to the host drawer", () => {
  const onOpenChange = vi.fn();

  const view = (open: boolean) => (
    <CompactViewportOverrideProvider isCompactViewport>
      <ProjectDrawer
        open={open}
        onOpenChange={onOpenChange}
        label="Contents"
        className="cnv-project-contents"
      >
        <input aria-label="Project content" defaultValue="Original" />
      </ProjectDrawer>
    </CompactViewportOverrideProvider>
  );

  const rendered = render(view(true));
  const drawer = screen.getByRole("dialog", { name: "Contents" });
  expect(drawer.className).toBe("min-h-0 overflow-hidden");
  const content = screen.getByLabelText("Project content").closest("aside");
  expect(content?.className).toBe("cnv-project-contents");
  expect(content?.style.position).toBe("relative");
  expect(content?.style.overflowY).toBe("auto");
  fireEvent.keyDown(drawer, { key: "Escape" });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(screen.getByRole("dialog", { name: "Contents" })).toBe(drawer);
  rendered.rerender(view(false));
  expect(drawer.hidden).toBe(true);
});

it("keeps desktop contents inline and removes them when closed", () => {
  const view = (open: boolean) => (
    <CompactViewportOverrideProvider isCompactViewport={false}>
      <ProjectDrawer
        open={open}
        onOpenChange={() => {}}
        label="Contents"
        className="cnv-project-contents"
      >
        <input aria-label="Project content" />
      </ProjectDrawer>
    </CompactViewportOverrideProvider>
  );

  const rendered = render(view(true));
  const content = screen.getByLabelText("Project content").closest("aside");
  expect(content?.getAttribute("aria-label")).toBe("Contents");
  expect(content?.style.position).toBe("");
  expect(screen.queryByRole("dialog")).toBeNull();
  rendered.rerender(view(false));
  expect(screen.queryByLabelText("Project content")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});
