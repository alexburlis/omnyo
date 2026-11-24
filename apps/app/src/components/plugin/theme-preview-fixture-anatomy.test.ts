import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");

const THEME_PREVIEW_TAXONOMY = resolve(
  REPO_ROOT,
  "plugins/theme-preview/taxonomy.ts",
);

interface FixtureAnchor {
  file: string;
  mustContain: readonly string[];
  because: string;
}

const SHARED_FIXTURE_ANCHORS: readonly FixtureAnchor[] = [
  {
    file: "apps/app/src/components/ui/sidebar.tsx",
    mustContain: ["fixed inset-y-0", "bg-sidebar text-sidebar-foreground"],
    because:
      "The mock sidebar carries `fixed bg-sidebar` so theme blocks scoped to `.fixed.bg-sidebar` (token overrides, noise overlays) apply to it exactly as they do in the app.",
  },
  {
    file: "packages/shared-ui/src/components/ui/sidebar-row-classes.ts",
    mustContain: [
      "SIDEBAR_ROW_BASE_CLASS =",
      "SIDEBAR_ROW_INTERACTIVE_STATE_CLASS =",
      "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      "SIDEBAR_ROW_SELECTED_STATE_CLASS =",
      "SIDEBAR_ROW_OPEN_IN_SPLIT_STATE_CLASS =",
    ],
    because:
      "Mock thread and settings rows keep Omnyo's shared row geometry and rest, hover, selected, and split states.",
  },
  {
    file: "apps/app/src/components/sidebar/SectionSidebar.tsx",
    mustContain: [
      'from "@omnyo/shared-ui/button"',
      "PROJECT_LIST_ACTION_BUTTON_CLASS",
      "CHROME_SECTION_LABEL_CLASS",
      "SIDEBAR_STANDARD_ROW_PADDING_CLASS",
    ],
    because:
      "Mock sidebars use Omnyo's shared button primitive, section-label token, padding, and project-row anatomy.",
  },
  {
    file: "packages/shared-ui/src/components/ui/context-selection.ts",
    mustContain: ['CONTEXT_SELECTION_SURFACE_CLASS = "bg-state-active"'],
    because: "The open thread's row in the mock paints state-active.",
  },
  {
    file: "apps/app/src/components/ui/theme.css",
    mustContain: [
      "--canvas:",
      "--sidebar:",
      "--card:",
      "--popover:",
      "--secondary:",
      "--muted:",
      "--surface-recessed:",
      "--surface-recessed-solid:",
      "--surface-recessed-soft-solid:",
      "--surface-scrim:",
      "--foreground:",
      "--muted-foreground:",
      "--subtle-foreground:",
      "--readback-foreground:",
      "--sidebar-foreground:",
      "--primary:",
      "--file-accent:",
      "--timeline-accent:",
      "--surface-selected:",
      "--state-hover:",
      "--state-active:",
      "--success:",
      "--warning:",
      "--attention:",
      "--destructive:",
      "--pr-merged:",
      "--diff-added:",
      "--diff-removed:",
      "--border:",
      "--border-hairline:",
      "--border-seam:",
      "--sidebar-border:",
      "--input:",
      "--ring:",
      "--font-sans:",
      "--font-mono:",
      "--text-2xs:",
      "--text-xs:",
      "--text-sm:",
      "--text-base:",
      "--spacing:",
      "--tracking-normal:",
      "--omnyo-sidebar-row-height:",
      "--icon-stroke-width:",
      "--radius:",
      "--shadow-x:",
      "--shadow-y:",
      "--shadow-blur:",
      "--shadow-spread:",
      "--shadow-color:",
      "--shadow-opacity:",
      "--omnyo-sidebar-open-in-split-background",
    ],
    because:
      "Every token the preview reads and lists must still be declared by the app's theme source of truth.",
  },
  {
    file: "apps/app/src/hooks/useTheme.ts",
    mustContain: ['THEME_STORAGE_KEY = "omnyo.theme"'],
    because:
      "The mode switch writes localStorage `omnyo.theme` and dispatches the storage event so Settings → Appearance stays synchronized.",
  },
  {
    file: "apps/app/src/app-entry.tsx",
    mustContain: ["AppToaster"],
    because:
      "The toast specimen fires a real sonner toast rendered by the app-mounted Toaster.",
  },
];

const VIEW_FIXTURE_ANCHORS: Record<string, readonly FixtureAnchor[]> = {
  thread: [
    {
      file: "apps/app/src/views/thread-detail/ThreadTimelinePane.tsx",
      mustContain: [
        'variant="hosted-footer"',
        "scrollOverlay=",
        "<ThreadTableOfContents",
        "footer={footer}",
      ],
      because:
        "The thread projection keeps the real hosted-footer timeline, bottom composer, and held-open table of contents composition.",
    },
    {
      file: "apps/app/src/components/thread/toc/ThreadTableOfContents.tsx",
      mustContain: [
        'aria-label="Thread table of contents"',
        'label="Agent messages"',
        'label="Your messages"',
        "bg-popover",
      ],
      because:
        "The held-open fixture keeps the real message-role tabs and popover surface.",
    },
    {
      file: "apps/app/src/views/thread-detail/ThreadDetailView.tsx",
      mustContain: [
        'label: "Info"',
        'label: "Diff"',
        '<Icon name="Info" />',
        '<Icon name="FileDiff" />',
      ],
      because:
        "The thread projection exposes the same fixed secondary-panel tabs as Omnyo.",
    },
    {
      file: "apps/app/src/components/secondary-panel/ThreadMetadataContent.tsx",
      mustContain: [
        'appearance="flat"',
        "<EnvironmentRow",
        "<BranchRow",
        "<PullRequestRow",
      ],
      because:
        "The open Info panel projects Omnyo's flat metadata card and representative environment, branch, and pull-request rows.",
    },
    {
      file: "apps/app/src/components/promptbox/follow-up-placeholder.ts",
      mustContain: [
        "Ask for a follow-up. @ to mention files, folders, sections, or threads",
      ],
      because:
        "The thread composer uses the current follow-up prompt language.",
    },
  ],
  new: [
    {
      file: "apps/app/src/views/RootComposeView.tsx",
      mustContain: [
        'ROOT_COMPOSE_STAGE_CONTENT_CLASS = "min-h-full"',
        'selectionLayout: isCompactViewport ? "footer" : "stage"',
        '<HomeGreeting layout="stage" />',
        "HOME_COMPOSER_PANEL_CLASS",
        "data-home-project-shelf",
        "<HomeStatusCards />",
        "{promptBox}",
      ],
      because:
        "The New thread projection opens on Home's stage: a display greeting, one raised composer card, the project shelf below it and the status cards, placed at 40% of the page height.",
    },
    {
      file: "apps/app/src/views/home-orientation/home-stage.ts",
      mustContain: [
        'HOME_STAGE_WIDTH_CLASS = "max-w-stage"',
        '"@container/home-composer rounded-[14px] border-0 bg-(--material-raised) p-2 shadow-(--material-shadow-raised)"',
        'HOME_STAGE_TOP_SPACER_CLASS = "min-h-8 shrink-0 grow-2 basis-0"',
        'HOME_STAGE_BOTTOM_AREA_CLASS = "flex grow-3 basis-0 flex-col"',
      ],
      because:
        "Home draws its own raised 680px stage composer, separate from the ⌘N launcher.",
    },
    {
      file: "apps/app/src/views/home-orientation/HomeOrientation.tsx",
      mustContain: [
        "text-display font-semibold tracking-tight text-foreground",
        "text-numeral font-normal tracking-tight text-foreground tabular-nums lining-nums",
        'HOME_CARD_RESERVED_HEIGHT_CLASS = "min-h-[108px]"',
      ],
      because:
        "Home sets the greeting at display size and each status card as a large numeral under a small label.",
    },
    {
      file: "apps/app/src/components/new-chat-launcher/new-chat-launcher.ts",
      mustContain: [
        'NEW_CHAT_LAUNCHER_WIDTH_CLASS = "max-w-[620px]"',
        '"border-0 bg-(--material-raised) shadow-(--material-shadow-raised) sm:rounded-[14px]"',
      ],
      because:
        "The ⌘N launcher keeps its single raised 620px composer surface; Home no longer borrows it.",
    },
    {
      file: "apps/app/src/components/new-chat-launcher/LauncherComposer.tsx",
      mustContain: ['selectionLayout: "dock"'],
      because:
        "The ⌘N launcher keeps the docked project cells, favorites and where line under its input.",
    },
    {
      file: "apps/app/src/components/promptbox/dock/NewChatDock.tsx",
      mustContain: [
        "<ProjectDock",
        "{favorites}",
        "<WhereLine",
        "aria-pressed:bg-state-active",
        "<ProjectShelf",
        "<StageWhereControls",
        'variant="tile"',
        "group-aria-pressed/shelf-cell:opacity-100",
      ],
      because:
        "The launcher panel keeps project cells, grouped model favorites and the where line under the input, while Home's stage puts plus, model, machine and workspace in one control row and portals the rail-plated project shelf below the card.",
    },
    {
      file: "apps/app/src/views/RootComposeSecondaryContent.tsx",
      mustContain: ['ROOT_COMPOSE_MAX_WIDTH_CLASS = "max-w-[760px]"'],
      because: "The New thread projection keeps Omnyo's home column width.",
    },
    {
      file: "apps/app/src/components/promptbox/NewThreadPromptBox.tsx",
      mustContain: [
        '"Ask anything."',
        "STAGE_PROMPT_BOX_MIN_HEIGHT = 56",
        '"[&_[data-promptbox-editor-scroll]]:text-lead"',
      ],
      because:
        "The empty composer uses the current new-thread prompt language, and Home's stage input is set at lead size above a 56px minimum.",
    },
  ],
  split: [
    {
      file: "apps/app/src/views/thread-detail/SplitThreadArea.tsx",
      mustContain: [
        "data-split-pane-id",
        "data-focused",
        "data-pane-focus-scrim",
        '"bg-background/30"',
        "<SplitDivider",
      ],
      because:
        "The Split projection keeps Omnyo's pane identity, focus state, divider, and inactive-pane wash.",
    },
  ],
  settings: [
    {
      file: "apps/app/src/components/settings/SettingsSidebar.tsx",
      mustContain: ["activeSection === section.id"],
      because:
        "The Appearance projection uses Omnyo's settings navigation hierarchy and selected-row state.",
    },
    {
      file: "apps/app/src/components/settings/settings-sections.ts",
      mustContain: [
        '{ icon: "Palette", id: "appearance", label: "Appearance" }',
      ],
      because:
        "The settings navigation keeps Appearance as a first-class Omnyo settings destination.",
    },
    {
      file: "apps/app/src/components/settings/AppearanceSettingsPage.tsx",
      mustContain: [
        '<SettingsSection title="Appearance">',
        '<SettingsWithControl label="Theme">',
        'label="Palette"',
        "Palettes change Omnyo's colors, including syntax colors in diffs and file previews.",
        'label="Favicon color"',
        "<SplitDimmingSetting />",
      ],
      because:
        "The Appearance projection keeps Omnyo's current theme, palette, favicon, and inactive-split controls.",
    },
    {
      file: "apps/app/src/components/ui/settings-section.tsx",
      mustContain: [
        "rounded-lg border border-border bg-card px-4 py-3.5",
        "flex flex-col gap-2.5",
        "text-xs leading-snug text-subtle-foreground",
      ],
      because:
        "The Appearance projection keeps Omnyo's section card, responsive rows, and supporting-copy hierarchy.",
    },
  ],
};

const FIXTURE_ANCHORS: readonly FixtureAnchor[] = [
  ...SHARED_FIXTURE_ANCHORS,
  ...Object.values(VIEW_FIXTURE_ANCHORS).flat(),
];

async function themePreviewViewIds(): Promise<string[]> {
  const taxonomy: { MOCK_VIEWS?: unknown } = await import(
    /* @vite-ignore */ THEME_PREVIEW_TAXONOMY
  );

  const views = taxonomy.MOCK_VIEWS;

  if (!Array.isArray(views)) {
    throw new Error("plugins/theme-preview/taxonomy.ts exports no MOCK_VIEWS");
  }

  return views.map((view: unknown) => {
    if (
      typeof view !== "object" ||
      view === null ||
      !("id" in view) ||
      typeof view.id !== "string"
    ) {
      throw new Error("a Theme Preview mock view has no string id");
    }

    return view.id;
  });
}

describe("Theme Preview fixture anatomy", () => {
  it("gives every Theme Preview mock view a live-app source contract", async () => {
    for (const id of await themePreviewViewIds()) {
      expect(VIEW_FIXTURE_ANCHORS[id]?.length ?? 0, id).toBeGreaterThan(0);
    }
  });

  for (const anchor of FIXTURE_ANCHORS) {
    it(`still matches ${anchor.file}`, () => {
      const source = readFileSync(resolve(REPO_ROOT, anchor.file), "utf8");

      for (const needle of anchor.mustContain) {
        expect(
          source,
          `${anchor.because}\nTheme Preview's mock (plugins/theme-preview/app.tsx) mirrors this, so update it together with this anchor.\nExpected ${anchor.file} to contain: ${needle}`,
        ).toContain(needle);
      }
    });
  }
});
