// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Provider } from "jotai";
import { MemoryRouter } from "react-router-dom";
import {
  createBrowserFixedPanelTab,
  createWorkspaceFilePreviewFixedPanelTab,
} from "./fixed-panel-tabs-state";
import {
  projectVisiblePanel,
  usePublishVisiblePanel,
  useVisibleAppContext,
} from "./visible-app-context";
import { useRootComposeProjectId } from "./root-compose-selection";
import { useLayoutEffect } from "react";

afterEach(cleanup);

function Context({ projectId }: { projectId?: string }) {
  const [, setProject] = useRootComposeProjectId();
  useLayoutEffect(() => {
    if (projectId) setProject(projectId);
  }, [projectId, setProject]);
  const context = useVisibleAppContext();

  return <output>{JSON.stringify(context)}</output>;
}

function Owner(props: Parameters<typeof usePublishVisiblePanel>[0]) {
  usePublishVisiblePanel(props);

  return null;
}

function snapshot() {
  return JSON.parse(screen.getByRole("status").textContent ?? "null");
}

const browser = createBrowserFixedPanelTab({
  environmentId: null,
  url: "https://user:secret@example.com/private?token=secret#secret",
});

const file = createWorkspaceFilePreviewFixedPanelTab({
  environmentId: "env_1",
  projectId: null,
  tab: {
    path: "/private/project/notes.md",
    source: { kind: "working-tree" },
    statusLabel: null,
    lineRange: null,
  },
});

describe("visible app context", () => {
  it("includes only the focused open panel and clears it on close and unmount", () => {
    function View({ open, owner = true }: { open: boolean; owner?: boolean }) {
      return (
        <Provider>
          <MemoryRouter initialEntries={["/threads/chat_1"]}>
            <Context />
            <Owner tab={browser} isOpen isFocused={false} />
            {owner && <Owner tab={file} isOpen={open} isFocused />}
          </MemoryRouter>
        </Provider>
      );
    }

    const view = render(<View open />);
    expect(snapshot()).toMatchObject({
      view: "thread",
      threadId: "chat_1",
      panel: { kind: "file", label: "notes.md", resourceId: null },
    });
    view.rerender(<View open={false} />);
    expect(snapshot().panel).toBeNull();
    view.rerender(<View open />);
    expect(snapshot().panel.label).toBe("notes.md");
    view.rerender(<View open owner={false} />);
    expect(snapshot().panel).toBeNull();
  });

  it("uses the root compose selection without inventing a current chat", () => {
    render(
      <Provider>
        <MemoryRouter>
          <Context projectId="proj_selected" />
        </MemoryRouter>
      </Provider>,
    );
    expect(snapshot()).toEqual({
      view: "compose",
      projectId: "proj_selected",
      threadId: null,
      panel: null,
    });
  });

  it("does not expose retained panel state on settings", () => {
    render(
      <Provider>
        <MemoryRouter initialEntries={["/settings/plugins"]}>
          <Context />
          <Owner tab={file} isOpen isFocused />
        </MemoryRouter>
      </Provider>,
    );
    expect(snapshot()).toEqual({
      view: "settings",
      projectId: null,
      threadId: null,
      panel: null,
    });
  });

  it("distinguishes fixed panels from the same plugin without exposing targets", () => {
    const tab = {
      kind: "plugin-page-fixed",
      id: "internal",
      pluginId: "docs",
      pageId: "library",
      fixedTabId: "outline",
    } as const;

    expect(projectVisiblePanel(tab)?.resourceId).toBe("docs:library:outline");
    expect(
      projectVisiblePanel({ ...tab, fixedTabId: "sources" })?.resourceId,
    ).toBe("docs:library:sources");
  });

  it("exposes a browser origin without credentials, path, query, hash or title", () => {
    expect(projectVisiblePanel(browser)).toEqual({
      kind: "browser",
      label: "https://example.com",
      resourceId: null,
    });
    expect(
      projectVisiblePanel({ ...browser, url: "data:text/plain,secret" }),
    ).toEqual({ kind: "browser", label: "Browser", resourceId: null });
  });
});
