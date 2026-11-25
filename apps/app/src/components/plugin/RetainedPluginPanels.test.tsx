// @vitest-environment jsdom
import { Activity, useState } from "react";
import { createPortal } from "react-dom";
import * as Dialog from "@radix-ui/react-dialog";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePortalScopeProps } from "@omnyo/shared-ui/lib/portal-scope";
import {
  createPluginPortal,
  createPluginPortalRetention,
  PluginPortalRetentionBoundary,
  scopePluginPortalComponents,
  PluginChromePortalContent,
} from "@/lib/plugin-portal-retention";
import { RetainedPluginPanels } from "./RetainedPluginPanels";
import type { PaneContent } from "@/lib/split-layout";

vi.mock("@/lib/plugin-slots", () => ({
  usePluginSlots: () => ({
    navPanels: [{ pluginId: "demo", path: "page", generation: 1 }],
  }),
}));

afterEach(cleanup);

const panel = {
  kind: "plugin-panel",
  pluginId: "demo",
  panelPath: "page",
  subPath: "",
} satisfies PaneContent;

const other = { kind: "new-thread" } satisfies PaneContent;

function DirectPage() {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);

  return (
    <>
      <input
        aria-label="draft"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button onClick={() => setOpen(true)}>Open portal</button>
      {open &&
        createPluginPortal(<button>External portal</button>, document.body)}
    </>
  );
}

const ScopedDialog = scopePluginPortalComponents(Dialog);

function ModalContent() {
  return (
    <ScopedDialog.Portal>
      <ScopedDialog.Overlay />
      <ScopedDialog.Content>
        <Dialog.Title>Actual modal</Dialog.Title>
        <Dialog.Description>Test focus ownership</Dialog.Description>
        <button>Modal action</button>
      </ScopedDialog.Content>
    </ScopedDialog.Portal>
  );
}

function ModalPage() {
  return (
    <Dialog.Root>
      <Dialog.Trigger>Open modal</Dialog.Trigger>
      <ModalContent />
    </Dialog.Root>
  );
}

function Harness({
  content,
  modal = false,
}: {
  content: PaneContent;
  modal?: boolean;
}) {
  return (
    <RetainedPluginPanels
      content={content}
      renderPanel={() => (modal ? <ModalPage /> : <DirectPage />)}
    >
      <button>Other page</button>
    </RetainedPluginPanels>
  );
}

describe("retained plugin portal ownership", () => {
  it("keeps external host chrome independent from page retention", () => {
    const retention = createPluginPortalRetention();

    const tree = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <PluginPortalRetentionBoundary retention={retention}>
          <div>
            {createPortal(
              <PluginChromePortalContent>
                <button>Owned chrome</button>
              </PluginChromePortalContent>,
              document.body,
            )}
          </div>
        </PluginPortalRetentionBoundary>
      </Activity>
    );

    const view = render(tree("visible"));
    expect(retention.canRetain()).toBe(true);
    view.rerender(tree("hidden"));
    expect(screen.queryByRole("button", { name: "Owned chrome" })).toBeNull();
    view.rerender(tree("visible"));
    expect(screen.getByRole("button", { name: "Owned chrome" })).toBeTruthy();
    expect(retention.canRetain()).toBe(true);
  });

  it("blocks late asynchronous portal openings while hidden and resumes them on return", async () => {
    let openLater = () => {};

    function LatePage() {
      const [open, setOpen] = useState(false);
      openLater = () => setOpen(true);

      return open ? (
        createPluginPortal(<button>Late portal</button>, document.body)
      ) : (
        <p>Waiting</p>
      );
    }

    const tree = (content: PaneContent) => (
      <RetainedPluginPanels content={content} renderPanel={() => <LatePage />}>
        <button>Other page</button>
      </RetainedPluginPanels>
    );

    const view = render(tree(panel));
    view.rerender(tree(other));
    await act(async () => openLater());
    expect(screen.queryByText("Late portal")).toBeNull();
    view.rerender(tree(panel));
    await screen.findByText("Late portal");
  });

  it("tracks actual shared helper portals across nested settings and pane boundaries", () => {
    const outer = createPluginPortalRetention();
    const inner = createPluginPortalRetention();

    function Helper({ open }: { open: boolean }) {
      const props = usePortalScopeProps();

      return open
        ? createPortal(<aside {...props}>Helper portal</aside>, document.body)
        : null;
    }

    const tree = (open: boolean) => (
      <PluginPortalRetentionBoundary retention={outer}>
        <PluginPortalRetentionBoundary retention={inner}>
          <Helper open={open} />
        </PluginPortalRetentionBoundary>
      </PluginPortalRetentionBoundary>
    );

    const view = render(tree(false));
    expect(outer.canRetain()).toBe(true);
    expect(inner.canRetain()).toBe(true);
    view.rerender(tree(true));
    expect(outer.canRetain()).toBe(false);
    expect(inner.canRetain()).toBe(false);
    view.rerender(tree(false));
    expect(outer.canRetain()).toBe(true);
    expect(inner.canRetain()).toBe(true);
  });

  it("retains local state when no external portal is open", () => {
    const view = render(<Harness content={panel} />);
    fireEvent.change(screen.getByLabelText("draft"), {
      target: { value: "keep me" },
    });
    view.rerender(<Harness content={other} />);
    view.rerender(<Harness content={panel} />);
    expect(screen.getByLabelText<HTMLInputElement>("draft").value).toBe(
      "keep me",
    );
  });

  it("unmounts raw escaping portals and does not resurrect them on another render", () => {
    const view = render(<Harness content={panel} />);
    fireEvent.click(screen.getByText("Open portal"));
    expect(screen.getByText("External portal")).toBeTruthy();
    view.rerender(<Harness content={other} />);
    expect(screen.queryByText("External portal")).toBeNull();
    view.rerender(<Harness content={{ ...other }} />);
    expect(screen.queryByText("External portal")).toBeNull();
    view.rerender(<Harness content={panel} />);
    expect(screen.queryByText("External portal")).toBeNull();
  });

  it("preserves active modal focus semantics and releases focus ownership on departure", async () => {
    const view = render(<Harness content={panel} modal />);
    fireEvent.click(screen.getByText("Open modal"));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Modal action"),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    view.rerender(<Harness content={other} modal />);
    expect(screen.queryByRole("dialog")).toBeNull();
    const next = screen.getByText("Other page");
    next.focus();
    await waitFor(() => expect(document.activeElement).toBe(next));
    expect(document.body.style.pointerEvents).not.toBe("none");
    view.rerender(<Harness content={panel} modal />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides and reconnects host chrome portals without removing their state", () => {
    const tree = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <div>
          {createPortal(
            <PluginChromePortalContent>
              <button>Chrome toggle</button>
            </PluginChromePortalContent>,
            document.body,
          )}
        </div>
      </Activity>
    );

    const view = render(tree("visible"));
    const toggle = screen.getByText("Chrome toggle");
    view.rerender(tree("hidden"));
    expect(toggle.parentElement?.style.display).toBe("none");
    view.rerender(tree("visible"));
    expect(screen.getByText("Chrome toggle")).toBe(toggle);
    expect(toggle.parentElement?.style.display).toBe("contents");
  });
});
