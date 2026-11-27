import { describe, expect, it, vi } from "vitest";
import { COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { Icon } from "@omnyo/shared-ui/icon";
import { PluginItemIcon } from "@/components/plugin/PluginIcon";
import type {
  BrowserFixedPanelTab,
  PluginPanelFixedPanelTab,
  SecondaryFileFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import { buildSecondaryPanelRenderableTabs } from "./buildSecondaryPanelRenderableTabs";
import { RightPanelFileTabIcon } from "./RightPanelFileTabIcon";

type BuilderArgs = Parameters<typeof buildSecondaryPanelRenderableTabs>[0];

function createBuilderArgs(tabs: readonly SecondaryFileFixedPanelTab[]) {
  const terminalsById: BuilderArgs["terminalsById"] = new Map();

  return {
    tabs,
    pluginActions: [],
    terminalsById,
    terminals: { select: vi.fn(), close: vi.fn() },
    onActivateTab: vi.fn(),
    onCloseTab: vi.fn(),
    renderTabContent: vi.fn(() => <div>Panel content</div>),
  } satisfies BuilderArgs;
}

describe("buildSecondaryPanelRenderableTabs", () => {
  it.each([
    {
      title: "Browser title",
      url: "https://example.com/page",
      label: "Browser title",
    },
    {
      title: null,
      url: "https://example.com:8443/page",
      label: "example.com:8443",
    },
    { title: "", url: "https://example.com/page", label: "Browser" },
    { title: null, url: "", label: "Browser" },
  ])(
    "uses browser label $label for title $title and URL $url",
    ({ title, url, label }) => {
      const tab: BrowserFixedPanelTab = {
        id: "browser-tab",
        kind: "browser",
        environmentId: null,
        title,
        url,
      };

      const descriptors = buildSecondaryPanelRenderableTabs(
        createBuilderArgs([tab]),
      );

      expect(descriptors).toMatchObject([
        { label, statusLabel: null, contentFillsRegion: false },
      ]);
      const [descriptor] = descriptors;
      expect(descriptor?.leadingVisual).toStrictEqual(
        <Icon
          name="Globe"
          className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
          aria-hidden
        />,
      );
    },
  );

  it("uses session titles and statuses and routes terminal actions by session ID", () => {
    const args = createBuilderArgs([
      { id: "missing-tab", kind: "terminal", terminalId: "missing-session" },
      { id: "running-tab", kind: "terminal", terminalId: "running-session" },
      { id: "exited-tab", kind: "terminal", terminalId: "exited-session" },
    ]);

    const terminalsById: BuilderArgs["terminalsById"] = new Map([
      ["running-session", { title: "Shell", status: "running" }],
      ["exited-session", { title: "Build", status: "exited" }],
    ]);

    const descriptors = buildSecondaryPanelRenderableTabs({
      ...args,
      terminalsById,
    });

    expect(descriptors).toMatchObject([
      { label: "Terminal", statusLabel: null, contentFillsRegion: false },
      { label: "Shell", statusLabel: null, contentFillsRegion: false },
      { label: "Build", statusLabel: "exited", contentFillsRegion: false },
    ]);

    for (const descriptor of descriptors) {
      expect(descriptor.leadingVisual).toStrictEqual(
        <Icon
          name="Terminal"
          className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
          aria-hidden
        />,
      );
      descriptor.onSelect();
      descriptor.onClose();
    }

    expect(args.terminals.select.mock.calls).toEqual([
      ["missing-session"],
      ["running-session"],
      ["exited-session"],
    ]);
    expect(args.terminals.close.mock.calls).toEqual([
      ["missing-session"],
      ["running-session"],
      ["exited-session"],
    ]);
    expect(args.onActivateTab).not.toHaveBeenCalled();
    expect(args.onCloseTab).not.toHaveBeenCalled();
  });

  it("preserves mixed file and New Tab order, visuals, callbacks, and renderer arguments", () => {
    const args = createBuilderArgs([
      {
        id: "host-tab",
        kind: "host-file-preview",
        environmentId: null,
        hostId: "host",
        lineRange: null,
        path: "/home/user/report.txt",
        threadId: null,
      },
      { id: "new-tab", kind: "new-tab" },
      {
        id: "attachment-tab",
        kind: "attachment-file-preview",
        name: "Screenshot.png",
        path: "uploads/opaque-id",
        projectId: "project",
      },
      {
        id: "workspace-tab",
        kind: "workspace-file-preview",
        environmentId: "env",
        lineRange: null,
        path: "src/removed.ts",
        projectId: "project",
        source: { kind: "head" },
        statusLabel: "deleted",
      },
      {
        id: "pinned-storage-tab",
        kind: "thread-storage-file-preview",
        environmentId: "env",
        isPinned: true,
        lineRange: null,
        path: "artifacts/notes.md",
        threadId: "thread",
      },
      {
        id: "storage-tab",
        kind: "thread-storage-file-preview",
        environmentId: "env",
        isPinned: false,
        lineRange: null,
        path: "artifacts/log.txt",
        threadId: "thread",
      },
    ]);

    const pane = { isFocused: false, onFocusPane: vi.fn() };
    const content = <div>Panel content</div>;

    const renderTabContent = vi.fn<BuilderArgs["renderTabContent"]>(
      () => content,
    );

    const descriptors = buildSecondaryPanelRenderableTabs({
      ...args,
      renderTabContent,
    });

    expect(
      descriptors.map(
        ({ label, statusLabel, isPinned, contentFillsRegion }) => [
          label,
          statusLabel,
          isPinned,
          contentFillsRegion,
        ],
      ),
    ).toEqual([
      ["report.txt", null, undefined, false],
      ["New tab", null, undefined, false],
      ["Screenshot.png", null, undefined, false],
      ["removed.ts", "deleted", undefined, false],
      ["notes.md", null, true, false],
      ["log.txt", null, false, false],
    ]);
    expect(descriptors.map(({ leadingVisual }) => leadingVisual)).toStrictEqual(
      [
        <RightPanelFileTabIcon path="/home/user/report.txt" />,
        <Icon
          name="NewTab"
          className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
          aria-hidden
        />,
        <RightPanelFileTabIcon path="Screenshot.png" />,
        <RightPanelFileTabIcon path="src/removed.ts" />,
        <RightPanelFileTabIcon path="artifacts/notes.md" />,
        <RightPanelFileTabIcon path="artifacts/log.txt" />,
      ],
    );
    expect(renderTabContent).not.toHaveBeenCalled();

    for (const [index, descriptor] of descriptors.entries()) {
      expect(descriptor.tab).toBe(args.tabs[index]);
      expect(descriptor.renderContent(pane)).toBe(content);
      expect(renderTabContent.mock.calls[index]?.[0]).toBe(args.tabs[index]);
      expect(renderTabContent.mock.calls[index]?.[1]).toBe(pane);
      descriptor.onSelect();
      descriptor.onClose();
    }

    expect(renderTabContent).toHaveBeenCalledTimes(args.tabs.length);
    expect(args.onActivateTab.mock.calls).toEqual(
      args.tabs.map(({ id }) => [id]),
    );
    expect(args.onCloseTab.mock.calls).toEqual(args.tabs.map(({ id }) => [id]));
    expect(args.terminals.select).not.toHaveBeenCalled();
    expect(args.terminals.close).not.toHaveBeenCalled();
  });

  it("matches plugin actions by both IDs and fills for flush actions and file openers", () => {
    const panel: PluginPanelFixedPanelTab = {
      id: "standard-tab",
      kind: "plugin-panel",
      pluginId: "notes",
      actionId: "standard",
      paramsJson: null,
      title: "Notes",
    };

    const args = createBuilderArgs([
      {
        ...panel,
        id: "unmatched-tab",
        actionId: "unmatched",
        title: "Unmatched",
      },
      panel,
      { ...panel, id: "flush-tab", actionId: "flush", title: "Editor" },
      {
        ...panel,
        id: "opener-tab",
        actionId: "file-opener:editor",
        title: "notes.md",
        fileOpenerOwner: {
          kind: "thread-storage-file-preview",
          environmentId: "env",
          threadId: "thread",
          tab: { path: "artifacts/notes.md", lineRange: null },
        },
      },
    ]);

    const descriptors = buildSecondaryPanelRenderableTabs({
      ...args,
      pluginActions: [
        {
          pluginId: "other-plugin",
          id: "unmatched",
          icon: "Zap",
          layout: "flush",
        },
        {
          pluginId: "notes",
          id: "different-action",
          icon: "Zap",
          layout: "flush",
        },
        { pluginId: "notes", id: "standard", icon: "Globe", layout: "padded" },
        { pluginId: "notes", id: "standard", icon: "Zap", layout: "flush" },
        { pluginId: "notes", id: "flush", icon: "Terminal", layout: "flush" },
      ],
    });

    expect(
      descriptors.map(({ label, statusLabel, contentFillsRegion }) => [
        label,
        statusLabel,
        contentFillsRegion,
      ]),
    ).toEqual([
      ["Unmatched", null, false],
      ["Notes", null, false],
      ["Editor", null, true],
      ["notes.md", null, true],
    ]);
    expect(descriptors.map(({ leadingVisual }) => leadingVisual)).toStrictEqual(
      [
        <PluginItemIcon
          pluginId="notes"
          icon={null}
          className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
        />,
        <PluginItemIcon
          pluginId="notes"
          icon="Globe"
          className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
        />,
        <PluginItemIcon
          pluginId="notes"
          icon="Terminal"
          className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
        />,
        <PluginItemIcon
          pluginId="notes"
          icon={null}
          className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
        />,
      ],
    );
  });
});
