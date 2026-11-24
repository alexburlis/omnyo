export type PolishKind =
  | "animation"
  | "interaction"
  | "state"
  | "visual"
  | "fix"
  | "story"
  | "ux";

export type PolishVisibility = "obvious" | "noticeable" | "subtle";

export interface PolishArea {
  key: string;
  name: string;
}

export interface PolishChange {
  id: string;
  area: string;
  title: string;
  kind: PolishKind;
  storyId: string | null;
  beforeStoryId: string | null;
  howToSee: string;
  before: string;
  after: string;
  why: string;
  files: readonly string[];
  note: string | null;
  pass: 1 | 2;
  visibility: PolishVisibility | null;
  beforeShot: string | null;
  afterShot: string | null;
}

export const POLISH_KINDS: readonly PolishKind[] = [
  "animation",
  "interaction",
  "state",
  "visual",
  "fix",
  "story",
  "ux",
];

export const POLISH_VISIBILITY_LABEL: Record<PolishVisibility, string> = {
  obvious: "Obvious",
  noticeable: "Noticeable",
  subtle: "Subtle",
};

export const POLISH_KIND_LABEL: Record<PolishKind, string> = {
  animation: "Animation",
  interaction: "Interaction",
  state: "State",
  visual: "Visual",
  fix: "Fix",
  story: "Story",
  ux: "UX",
};

export const POLISH_BEFORE_SNAPSHOT = {
  commit: "f93ae67314",
  branch: "origin/main before the polish passes",
  port: 61422,
  worktree: "~/worktrees/omnyo/thr_jt64u7zs77--ladle-before",
};

export const POLISH_AREAS: readonly PolishArea[] = [
  {
    key: "p2-design-system",
    name: "Design system: readability, buttons, surfaces, shared components, motion",
  },
  {
    key: "p2-automations-workflows",
    name: "Automations and Workflows",
  },
  {
    key: "p2-tasks",
    name: "Tasks",
  },
  {
    key: "p2-sidebar",
    name: "Sidebar and thread list",
  },
  {
    key: "p2-composer",
    name: "Composer, banners and questions",
  },
  {
    key: "p2-timeline",
    name: "Chat timeline, waits list and thread chrome",
  },
  {
    key: "p2-panel",
    name: "Side panel, browser, git and file views",
  },
  {
    key: "p2-settings",
    name: "Settings, dialogs and settings plugins",
  },
  {
    key: "p2-pickers",
    name: "Pickers, command palette and launcher",
  },
  {
    key: "p2-home-tools",
    name: "Home, Tools and plugin pages",
  },
  {
    key: "p2-usage-providers",
    name: "Usage and provider plugins",
  },
  {
    key: "p2-inbox",
    name: "Inbox (omnyo-plugins chat-topics)",
  },
  {
    key: "p2-glance-tidy",
    name: "Glance, Tidy, Pursue and Inline UI (omnyo-plugins)",
  },
  {
    key: "p2-workspace-tools",
    name: "Workspace tools (omnyo-plugins)",
  },
  {
    key: "p2-integration",
    name: "Cross-area fixes from integration",
  },
  {
    key: "p1-primitives",
    name: "Pass 1 · Shared primitives, motion tokens and UI kit",
  },
  {
    key: "p1-dialogs-settings",
    name: "Pass 1 · Dialogs, machines, settings, update prompt and footer usage",
  },
  {
    key: "p1-pickers",
    name: "Pass 1 · Pickers (model, environment, branch, machine, project, permission, option)",
  },
  {
    key: "p1-composer",
    name: "Pass 1 · Composer and prompt box (rail, suggestions, follow-up, new thread box, mentions, compact home)",
  },
  {
    key: "p1-banners-interactions",
    name: "Pass 1 · Composer banners/cards and pending interactions",
  },
  {
    key: "p1-work-rows",
    name: "Pass 1 · Timeline work rows (tools, commands, file changes, reasoning, activity, approvals, delegation, web, workflow, system rows, step rail)",
  },
  {
    key: "p1-messages-chrome",
    name: "Pass 1 · Messages, streaming and thread chrome (assistant/user messages, action bar, sources, streaming, selection menu, context window, catch-up, TOC, terminal, thread actions, split thread)",
  },
  {
    key: "p1-secondary-panel",
    name: "Pass 1 · Secondary panel, browser tab deck, file preview, metadata/info, storage and git diff cards",
  },
  {
    key: "p1-sidebar-onboarding",
    name: "Pass 1 · Sidebar, onboarding and plugins/skills detail tools",
  },
  {
    key: "p1-plugins",
    name: "Pass 1 · Plugin surfaces (browse hero, management banners/signals) and plugin-owned views (automations, workflow runs, provider usage, workflows)",
  },
  {
    key: "p1-integration",
    name: "Pass 1 · Cross-area fixes found while integrating",
  },
];

export const POLISH_CHANGES: readonly PolishChange[] = [
  {
    id: "foundation-primary-button",
    area: "p2-design-system",
    title:
      "Primary buttons read as primary: near-white in dark, deep slate with an edge in light",
    kind: "visual",
    storyId: "ui--button--overview",
    beforeStoryId: "ui--button--overview",
    howToSee:
      "Open ui--button--overview in dark, look at the 'default' row, then open automations--workflow-setup--import or onboarding--first-run--step1-agent-states.",
    before:
      "The default button was bg-foreground: a mid light-grey (ink L 0.897) in dark that matched body text and looked like a chip. In light it was a flat slate.",
    after:
      "The default button uses the new --control-primary token: near-white (L≈0.956) with dark label in dark, and the deeper --primary slate in light. It has an inner highlight or shade plus a 1 px edge shadow, and the hover lightens it slightly. It is clearly the one primary action on every screen (Continue, Sign in, Review Weekly Content Feed, Rename thread).",
    why: "Alex said the import screen's light-grey primary 'does not read as primary'.",
    files: [
      "packages/shared-ui/src/components/ui/button.tsx",
      "apps/app/src/components/ui/theme.css",
      "packages/shared-ui/src/lib/utils.ts",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "foundation-primary-button-before.png",
    afterShot: "foundation-primary-button-after.png",
  },
  {
    id: "foundation-quiet-alternatives",
    area: "p2-design-system",
    title: "Outline and secondary buttons are quieter and better finished",
    kind: "visual",
    storyId: "ui--button--overview",
    beforeStoryId: "ui--button--overview",
    howToSee:
      "Compare the outline and secondary rows in ui--button--overview (light and dark), or 'Show setup guide' in settings--settings--full-page.",
    before:
      "Outline buttons had a strong 30% ink border on a transparent body. Secondary hover faded the fill (bg-secondary/80), so hover looked lighter than rest.",
    after:
      "Outline uses the quieter border token, a faint raised fill and a soft edge shadow, and darkens its border on hover. Secondary hover deepens to the muted fill. Disabled buttons drop their shadow.",
    why: "Button hierarchy: alternatives should step back from the one primary action.",
    files: [
      "packages/shared-ui/src/components/ui/button.tsx",
      "apps/app/src/components/ui/theme.css",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "foundation-quiet-alternatives-before.png",
    afterShot: "foundation-quiet-alternatives-after.png",
  },
  {
    id: "foundation-inline-row-action",
    area: "p2-design-system",
    title:
      "A real small 'row action' button (xs + soft) plus icon-xs and icon-sm sizes",
    kind: "interaction",
    storyId: "ui--button--row-actions",
    beforeStoryId: null,
    howToSee:
      "Open ui--button--row-actions, or ui--status-row--overview and look at Open, Restart and Cancel wait.",
    before:
      "Row actions like 'Cancel wait' and 'Restart' were bare text or ad-hoc 2xs links with no button shape.",
    after:
      'Button size="xs" variant="soft" gives a 24 px high, translucent-filled, rounded action with an optional 14 px icon. It becomes 36 px on touch. Icon-only actions use icon-xs or icon-sm.',
    why: "Alex flagged waits and dev servers whose actions were bare text with no affordance.",
    files: [
      "packages/shared-ui/src/components/ui/button.tsx",
      "apps/app/src/components/ui/button.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "foundation-inline-row-action-after.png",
  },
  {
    id: "foundation-readable-secondary-text",
    area: "p2-design-system",
    title: "Settings descriptions and sidebar section labels meet WCAG AA",
    kind: "fix",
    storyId: "settings--settings--full-page",
    beforeStoryId: "settings--settings--full-page",
    howToSee:
      "In light mode, compare the grey description lines under each setting. Also check the 'Inbox' and 'Threads' section labels in sidebar--thread-list--inbox-read-status.",
    before:
      "57 places used text-subtle-foreground/75 for secondary text, measured at 3.4:1 in light and 4.2:1 in dark, below the 4.5:1 floor. These included settings-section descriptions, machine and project rows, storage, connect and account-pool panels, and CHROME_SECTION_LABEL_CLASS, which styles the sidebar and panel section labels.",
    after:
      "All text uses the full subtle tier: 6.0:1 in light and 6.6:1 in dark. Icon-only uses keep their opacity because icons need 3:1. Settings descriptions are visibly crisper.",
    why: "Alex said secondary text is hard to read. Unrequested scope: this mechanical sweep touched settings and plugin files outside the design system.",
    files: [
      "packages/shared-ui/src/components/ui/chrome-style-tokens.ts",
      "apps/app/src/components/ui/settings-section.tsx",
      "apps/app/src/components/settings/BrowserCookieSyncSettings.tsx",
      "apps/app/src/components/settings/BrowserSettingsSection.tsx",
      "apps/app/src/components/settings/KeyboardSettingsSection.tsx",
      "apps/app/src/components/settings/MachineAccessSettings.tsx",
      "apps/app/src/components/settings/MachinesSettingsSection.tsx",
      "apps/app/src/components/settings/ProjectsSettingsSection.tsx",
      "apps/app/src/components/plugin/PluginSettingsSections.tsx",
      "apps/app/src/views/MachineSettingsView.tsx",
      "apps/app/src/views/ProjectDetailSettingsView.tsx",
      "apps/app/src/components/plugin/theme-preview-fixture-anatomy.test.ts",
      "plugins/account-pool/app.tsx",
      "plugins/connect/app.tsx",
      "plugins/provider-usage/settings.tsx",
      "plugins/storage-retention/app.tsx",
      "plugins/storage-retention/housekeeping-panel.tsx",
      "plugins/storage-retention/managed-panel.tsx",
      "plugins/plugin-api-docs/src/product-map.tsx",
      "plugins/plugin-api-docs/src/wireframes.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "foundation-readable-secondary-text-before.png",
    afterShot: "foundation-readable-secondary-text-after.png",
  },
  {
    id: "foundation-focus-rings",
    area: "p2-design-system",
    title: "Polished keyboard focus rings on every control",
    kind: "visual",
    storyId: "ui--button--overview",
    beforeStoryId: "ui--button--overview",
    howToSee:
      "Tab through ui--button--overview, ui--segmented-control--overview or any dialog input.",
    before:
      "Buttons, inputs, textareas and checkboxes showed a 1 px ring. Select triggers showed it on mouse focus too (focus:ring-1).",
    after:
      "Controls show a 2 px ring offset by 2 px (FOCUS_RING_CLASS), keyboard only. Text fields and select triggers tint their border and add a soft 3 px halo (FIELD_FOCUS_RING_CLASS). Segments use an inset ring.",
    why: "Polished focus rings were a requested part of the foundation.",
    files: [
      "packages/shared-ui/src/components/ui/focus-ring.ts",
      "packages/shared-ui/src/components/ui/button.tsx",
      "packages/shared-ui/src/components/ui/input.tsx",
      "packages/shared-ui/src/components/ui/textarea.tsx",
      "packages/shared-ui/src/components/ui/checkbox.tsx",
      "packages/shared-ui/src/components/ui/select.tsx",
      "plugins/thread-list/app/list/SidebarHeaderControls.test.tsx",
      "plugins/theme-preview/app.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "foundation-status-row",
    area: "p2-design-system",
    title:
      "New StatusRow: thing, coloured state badge, meta, actions and a clear error line",
    kind: "ux",
    storyId: "ui--status-row--overview",
    beforeStoryId: null,
    howToSee:
      "Open ui--status-row--overview and ui--status-row--tones in both themes.",
    before:
      "Dev servers and waits rendered as one run-on text row such as 'localhost:61423 · Recent server · Didn't start · Mac Pro · Restart', with the error as loose text and no state colour.",
    after:
      "Each row has a status dot (halo for running, hollow for pending, red for error), a bold title and a tinted state badge ('Running', 'Didn’t start'). Meta follows in subtle text with dot separators, the error sits on its own line with an alert icon, and xs soft actions align on the right. StatusList adds a card with dividers and list semantics.",
    why: "Alex flagged the dev-servers and waits lists as unpolished text rows with unclear states.",
    files: [
      "packages/shared-ui/src/components/ui/status-row.tsx",
      "apps/app/src/components/ui/status-row.stories.tsx",
      "packages/shared-ui/package.json",
      "packages/plugin-registry/registry.json",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "foundation-status-row-after.png",
  },
  {
    id: "foundation-collapsible-section",
    area: "p2-design-system",
    title:
      "New CollapsibleSection header: chevron, count chip, inline hint, remembered state from the caller",
    kind: "ux",
    storyId: "ui--collapsible-section--overview",
    beforeStoryId: null,
    howToSee:
      "Open ui--collapsible-section--overview and click 'Ready to archive' to expand it.",
    before:
      "Only some Inbox sections could fold. 'Waiting' showed a separate 'Comes back by itself' sub-header row, and there was no shared section header.",
    after:
      "Every section header is a full-width toggle with a rotating chevron, a semibold title, a count chip with a screen-reader label and an optional inline muted description on the same line. Content folds on the smooth spring and is inert when closed. The caller supplies and persists open.",
    why: "Alex asked why 'Ready to archive' cannot collapse and called the Waiting sub-header structure horrible.",
    files: [
      "packages/shared-ui/src/components/ui/section-header.tsx",
      "apps/app/src/components/ui/section-header.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "foundation-collapsible-section-after.png",
  },
  {
    id: "foundation-stagger-arrival",
    area: "p2-design-system",
    title: "Rows and cards the owner reveals arrive in a quick stagger",
    kind: "animation",
    storyId: "ui--collapsible-section--overview",
    beforeStoryId: null,
    howToSee:
      "In ui--collapsible-section--overview, expand 'Ready to archive'. In ui--card--reveal-and-confirm, press 'Show templates'. Watch at 1x.",
    before: "Revealed groups appeared all at once.",
    after:
      "Each item fades in and rises 6 px over 250 ms on ease-out. Items follow 30 ms apart, and the step shrinks so the last starts within 150 ms. Nothing staggers on first paint (useChangedSinceMount). Reduce Motion shows items at once.",
    why: "Richer owner-initiated motion was requested; DESIGN.md now allows it.",
    files: [
      "packages/shared-ui/src/components/ui/motion.ts",
      "apps/app/src/app.css",
      "apps/app/src/components/ui/theme.css",
      "apps/app/src/components/ui/motion-stagger.test.ts",
      "DESIGN.md",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "foundation-stagger-arrival-after.png",
  },
  {
    id: "foundation-meta-chip",
    area: "p2-design-system",
    title: "New MetaChip: every glyph or count chip explains itself",
    kind: "ux",
    storyId: "ui--status-row--tones",
    beforeStoryId: null,
    howToSee:
      "In ui--status-row--tones, hover or tab to the chips in the 'explained chips' row.",
    before:
      "Inbox rows ended in an unlabelled return arrow and a bare '> 1' chip with no tooltip or accessible name.",
    after:
      "MetaChip requires a description that becomes both its tooltip and its aria-label, for example '1 reply is waiting for you'. It comes in neutral, attention, success and error tints, is focusable and has a 20 px pill shape.",
    why: "Alex flagged 'weird things on the right that dont explain themselves'.",
    files: [
      "packages/shared-ui/src/components/ui/meta-chip.tsx",
      "apps/app/src/components/ui/status-row.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "foundation-segmented-control",
    area: "p2-design-system",
    title:
      "New SegmentedControl with one sliding thumb; panel toggles share its helpers",
    kind: "interaction",
    storyId: "ui--segmented-control--overview",
    beforeStoryId: null,
    howToSee:
      "Open ui--segmented-control--overview, click between options and use the arrow keys.",
    before:
      "Segmented toggles were assembled by hand per caller (FilePreview and GitDiffToolbar) from panelSegmentedControl.ts class helpers.",
    after:
      "SegmentedControl draws a tinted track with a raised thumb that slides on the smooth spring. It has radio semantics, roving tabindex, arrow/Home/End keys, disabled segments and icon segments, and works full width or auto width. panelSegmentedControl.ts re-exports the shared helpers so both callers render exactly as before.",
    why: "A shared segmented primitive was requested. Merges duplicated helpers.",
    files: [
      "packages/shared-ui/src/components/ui/segmented-control.tsx",
      "apps/app/src/components/secondary-panel/panelSegmentedControl.ts",
      "apps/app/src/components/ui/segmented-control.stories.tsx",
      "apps/app/src/components/ui/theme.css",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "foundation-segmented-control-after.png",
  },
  {
    id: "foundation-step-indicator",
    area: "p2-design-system",
    title: "New StepIndicator with filled checks and spring-filled connectors",
    kind: "visual",
    storyId: "ui--step-indicator--overview",
    beforeStoryId: null,
    howToSee:
      "Open ui--step-indicator--overview, then ui--step-indicator--interactive and press Continue.",
    before:
      "Multi-step flows used a bare numbered list with short dashes between items.",
    after:
      "Each step has a 24 px numbered circle (current: ink ring with a soft halo; done: filled ink with a check) and a readable label. Connectors fill on the smooth spring when you advance, and the check draws on snappy. Labels for other steps hide below 30rem, with screen-reader state text.",
    why: "Alex called the import stepper a 'bare numbered stepper with dashes'.",
    files: [
      "packages/shared-ui/src/components/ui/step-indicator.tsx",
      "packages/shared-ui/src/components/ui/success-check.tsx",
      "apps/app/src/components/ui/step-indicator.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "foundation-step-indicator-after.png",
  },
  {
    id: "foundation-step-transition",
    area: "p2-design-system",
    title:
      "Step bodies travel along the step axis when advancing or going back",
    kind: "animation",
    storyId: "ui--step-indicator--interactive",
    beforeStoryId: null,
    howToSee:
      "In ui--step-indicator--interactive, press Continue and Back at 1x.",
    before: "Step content swapped instantly.",
    after:
      "The new step fades in over 250 ms while sliding 8 px from the direction of travel on the 350 ms smooth spring. The old step fades out over 150 ms moving 4 px the other way and cannot take input. Reduce Motion crossfades. Nothing moves on first paint.",
    why: "A within-surface step transition owner was requested.",
    files: [
      "packages/shared-ui/src/components/ui/step-transition.tsx",
      "packages/shared-ui/src/components/ui/motion.ts",
      "apps/app/src/app.css",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "foundation-step-transition-after.png",
  },
  {
    id: "foundation-file-drop-zone",
    area: "p2-design-system",
    title: "New FileDropZone replaces raw native file inputs",
    kind: "ux",
    storyId: "ui--file-drop-zone--overview",
    beforeStoryId: null,
    howToSee:
      "Open ui--file-drop-zone--overview. Click the zone, tab into it, or drag a file over it.",
    before:
      "File picking used the browser's 'Choose File / No file chosen' control.",
    after:
      "A dashed zone shows an icon disc, 'Drop a workflow file here', 'or choose a file' and a hint, with a drag-over tint and a keyboard focus ring. Wrong type or size gives a plain sentence. The chosen file becomes a card with icon, name, size or 'Checking…' and a labelled remove button.",
    why: "Alex flagged the raw native file input on the import screen.",
    files: [
      "packages/shared-ui/src/components/ui/file-drop-zone.tsx",
      "apps/app/src/components/ui/file-drop-zone.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "foundation-file-drop-zone-after.png",
  },
  {
    id: "foundation-import-applied",
    area: "p2-design-system",
    title: "Import a workflow uses the new stepper and drop zone",
    kind: "visual",
    storyId: "automations--workflow-setup--import",
    beforeStoryId: "automations--workflow-setup--import",
    howToSee:
      "Open automations--workflow-setup--import (and --brief for step 2) in dark and light.",
    before:
      "The page had a bare 1–2–3–4 list with dashes, a native 'Choose File / No file chosen' input and a light-grey primary button.",
    after:
      "StepIndicator (Import current, connectors ready to fill) and a FileDropZone with chosen-file state and a remove button replace them, and the primary button is near-white in dark. Size and type rejections reuse the existing error note. Card hierarchy, title size and spacing are left to the automations agent.",
    why: "Proves the step indicator and file picker on the screen Alex named. The automations agent finishes the screen.",
    files: [
      "plugins/automations/workflow-setup.tsx",
      "plugins/automations/workflow-panel.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "foundation-import-applied-before.png",
    afterShot: "foundation-import-applied-after.png",
  },
  {
    id: "foundation-card-surfaces",
    area: "p2-design-system",
    title:
      "Card gains surface variants with real elevation and a clickable lift",
    kind: "visual",
    storyId: "ui--card--overview",
    beforeStoryId: null,
    howToSee:
      "Open ui--card--overview and hover the Interactive card. Open ui--card--reveal-and-confirm and press 'Show templates'.",
    before:
      "Card was a flat border box with p-6 and an untyped title. There was no way to tell raised, sunken or clickable groups apart.",
    after:
      "Card variants: default (hairline border plus new shadow-card, rounded-xl), recessed, flat and interactive. Interactive lifts 1 px with a deeper pseudo-element shadow, compositor only, with a focus ring. CardTitle is a 15 px semibold title and padding is p-5.",
    why: "Alex asked for card and section surfaces with clear hierarchy instead of flat identical cards.",
    files: [
      "packages/shared-ui/src/components/ui/card.tsx",
      "apps/app/src/components/ui/card.stories.tsx",
      "apps/app/src/components/ui/theme.css",
      "apps/app/src/app.css",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "foundation-card-surfaces-after.png",
  },
  {
    id: "foundation-success-check",
    area: "p2-design-system",
    title: "Success confirmation draws its check",
    kind: "animation",
    storyId: "ui--card--reveal-and-confirm",
    beforeStoryId: null,
    howToSee:
      "In ui--card--reveal-and-confirm, press Save. Also watch a step complete in ui--step-indicator--interactive.",
    before:
      "There was no shared success confirmation; checks swapped in statically.",
    after:
      "SuccessCheck shows a green-tinted badge that scales from 0.6 on the snappy spring while the check stroke draws over 250 ms after a 50 ms beat. Reduce Motion shows it already drawn.",
    why: "A success confirmation owner was requested.",
    files: [
      "packages/shared-ui/src/components/ui/success-check.tsx",
      "apps/app/src/app.css",
      "packages/shared-ui/src/components/ui/motion.ts",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "foundation-success-check-after.png",
  },
  {
    id: "foundation-empty-and-notices",
    area: "p2-design-system",
    title:
      "New EmptyStateBlock and AA-clean Alert tones for empty, error and notice states",
    kind: "state",
    storyId: "ui--empty-and-notice-states--overview",
    beforeStoryId: null,
    howToSee: "Open ui--empty-and-notice-states--overview in dark.",
    before:
      "Empty and error pages had no shared block. Alert's destructive tone used text-destructive, which is about 3.6:1 in dark, and had no warning or success tones.",
    after:
      "EmptyStateBlock gives a centred icon disc (error tint available), a 15 px title, an explanation and an action row, ready for 'Server not reachable'. Alert gains default, destructive (AA text on a tinted surface), warning and success tones with muted descriptions.",
    why: "Gives the browser 'Server not reachable' and empty-panel agents a designed state. Unrequested primitive, named here.",
    files: [
      "packages/shared-ui/src/components/ui/empty-state.tsx",
      "packages/shared-ui/src/components/ui/alert.tsx",
      "apps/app/src/components/ui/empty-state-block.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "foundation-empty-and-notices-after.png",
  },
  {
    id: "foundation-progress-fill",
    area: "p2-design-system",
    title: "Progress bars and phase meters fill on the smooth spring",
    kind: "animation",
    storyId: "ui--card--reveal-and-confirm",
    beforeStoryId: null,
    howToSee: "Press 'Advance progress' in ui--card--reveal-and-confirm.",
    before:
      "Progress was an 8 px bar with a 20% primary track and a linear 150 ms translate.",
    after:
      "Progress is a 6 px ink-on-state-active bar. The fill scales along X over 350 ms on the smooth spring (PROGRESS_FILL_TRANSITION), shared with the step connectors and workflow phase meters.",
    why: "A progress-fill travel owner was requested.",
    files: [
      "packages/shared-ui/src/components/ui/progress.tsx",
      "packages/shared-ui/src/components/ui/motion.ts",
    ],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "foundation-workflow-header",
    area: "p2-design-system",
    title:
      "Workflow card header: run name, current phase, readable phase meter, agents and elapsed time",
    kind: "visual",
    storyId: "promptbox--banner--workflow-card--overview",
    beforeStoryId: "promptbox--banner--workflow-card--overview",
    howToSee:
      "Compare promptbox--banner--workflow-card--overview (collapsed and expanded rows) and --concurrent-workflows.",
    before:
      "The header showed name, then '6/7 agents 5m 33s' in 10 px grey, then three bare 3 px dashes with a pulsing current dash.",
    after:
      "Name in medium weight is followed by the current phase name ('Synthesize'). On the right are a 6 px segmented phase meter with proportional green or ink fills and an accessible 'Phase 2 of 3' label, '6/7 agents' with a tooltip, and the elapsed time with a clock icon. The same WorkflowRunSummary drives the app card and the workflows plugin composer card.",
    why: "Alex: the workflow progress card 'needs more polish'.",
    files: [
      "packages/shared-ui/src/components/ui/workflow-progress.tsx",
      "apps/app/src/components/promptbox/banner/ThreadWorkflowCard.tsx",
      "plugins/workflows/src/app.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "foundation-workflow-header-before.png",
    afterShot: "foundation-workflow-header-after.png",
  },
  {
    id: "foundation-workflow-phases",
    area: "p2-design-system",
    title:
      "Workflow phases become structured groups with status glyphs, counts and pending states",
    kind: "ux",
    storyId: "thread--timeline--rows--workflow--overview",
    beforeStoryId: "thread--timeline--rows--workflow--overview",
    howToSee:
      "Open thread--timeline--rows--workflow--overview (running, completed, failed, interrupted) and expand a phase in the workflow card.",
    before:
      "Phases were 'Scan 1/2' text lines with a green badge only when done. Not-started phases said 'not started' in the same grey, and agent rows sat flush under them.",
    after:
      "Each phase has a glyph: green check badge when done, ink ring when current, dashed circle when pending, alert when failed, plain circle when stopped. The title is dimmed when pending or done, followed by an 'n/m' count with a tooltip and a right-aligned mini meter. Agents hang off a guide line. Empty phases say 'Not started', 'No agents' or 'Didn’t run'. In collapsible mode the chevron sits at the right, and expand and collapse keep the smooth spring.",
    why: "Alex asked for phases as structured groups with counts and visibly pending not-started phases.",
    files: [
      "packages/shared-ui/src/components/ui/workflow-progress.tsx",
      "apps/app/src/components/thread/timeline/WorkflowWorkRowBody.test.tsx",
      "plugins/workflows/src/app.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "foundation-workflow-phases-before.png",
    afterShot: "foundation-workflow-phases-after.png",
  },
  {
    id: "foundation-workflow-agent-rows",
    area: "p2-design-system",
    title: "Agent rows read as name + tier + plain-language metrics",
    kind: "ux",
    storyId: "promptbox--banner--workflow-card--many-phases",
    beforeStoryId: "promptbox--banner--workflow-card--many-phases",
    howToSee:
      "Look at agent rows in promptbox--banner--workflow-card--many-phases and the failed case in thread--timeline--rows--workflow--overview.",
    before:
      "Rows showed raw metadata in 10 px monospace, such as 'opus · 119.7k tok · 10 tools' and 'haiku · queued'. Errors were truncated inline after an em dash, and done agents could be struck through.",
    after:
      "Labels like 'design-system:opus/xhigh' split into the name plus an 'opus · xhigh' tier chip. Metrics read '119.7k tokens · 10 tool calls' in 12 px secondary text with exact numbers in a tooltip. State words read 'Waiting', 'Stopped', 'Cancelled', 'Skipped' and 'Attempt 3'. The running agent sits on a subtle highlight, and a failed agent's error wraps on its own line. Descriptors and metrics hide in narrow containers instead of clipping.",
    why: "Alex: '119.7k tok · 10 tools' should be legible and secondary, without raw jargon.",
    files: ["packages/shared-ui/src/components/ui/workflow-progress.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "foundation-workflow-agent-rows-before.png",
    afterShot: "foundation-workflow-agent-rows-after.png",
  },
  {
    id: "foundation-workflow-strip-overflow",
    area: "p2-design-system",
    title: "Phase meter no longer overflows on runs with many phases",
    kind: "fix",
    storyId: "promptbox--banner--workflow-card--many-phases",
    beforeStoryId: "promptbox--banner--workflow-card--many-phases",
    howToSee:
      "Header of promptbox--banner--workflow-card--many-phases (40 phases).",
    before: "40 tiny dashes crowded the header strip.",
    after:
      "Above 8 phases the meter condenses to one bar of overall progress, with an accessible 'Phase n of m' label. Segments can never overflow their width.",
    why: "A readable phase indicator at any scale.",
    files: ["packages/shared-ui/src/components/ui/workflow-progress.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "foundation-workflow-strip-overflow-before.png",
    afterShot: "foundation-workflow-strip-overflow-after.png",
  },
  {
    id: "foundation-workflow-panel-labels",
    area: "p2-design-system",
    title:
      "Workflow side panel labels each phase under the meter; status pills share StatusBadge",
    kind: "visual",
    storyId: "plugins--workflows--workflow-panel--panel-states",
    beforeStoryId: "plugins--workflows--workflow-panel--panel-states",
    howToSee:
      "See the 'Loaded' panel in plugins--workflows--workflow-panel--panel-states.",
    before:
      "A full-width bare 3 px line had no phase names. The 'Complete' pill was a 10 px chip.",
    after:
      "A 6 px meter shows phase names underneath, with the current phase emphasised. The 12 px 'Complete' pill is built on the shared StatusBadge. The plugin's local settled-agent counter was replaced by the shared countSettledWorkflowAgents.",
    why: "A readable phase indicator, plus merging duplicated logic.",
    files: [
      "plugins/workflows/src/app.tsx",
      "packages/shared-ui/src/components/ui/workflow-progress.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "foundation-workflow-panel-labels-before.png",
    afterShot: "foundation-workflow-panel-labels-after.png",
  },
  {
    id: "foundation-motion-guard-intro",
    area: "p2-design-system",
    title:
      "motion-literals guard is green again: the first-run logo intro is a named choreography",
    kind: "fix",
    storyId: null,
    beforeStoryId: null,
    howToSee: "Run apps/app vitest src/components/ui/motion-literals.test.ts.",
    before:
      "On origin/main the guard already failed on 14 literal timings and curves in components/onboarding/onboarding-intro.css.",
    after:
      "The guard treats .omnyo-intro like the other named loops, for both timings and its own expo curve, and DESIGN.md records the exception. No animation changed.",
    why: "Keeping motion-literals.test.ts green was required, and the intro is a deliberately timed brand moment.",
    files: ["apps/app/src/components/ui/motion-literals.test.ts", "DESIGN.md"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "foundation-design-md",
    area: "p2-design-system",
    title:
      "DESIGN.md: owner-initiated motion principle, new roles and tokens, and a Components section",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Read DESIGN.md Principles, Durations, Roles, 'Where nothing animates', the owner table and the new '## Components' section. Theme authors also see the new tokens in plugins/omnyo-guide/skills/omnyo-cli/references/theming.md.",
    before:
      "Principles allowed no richer motion. There was no guidance for row actions, status rows, section headers, file pickers or AA on secondary text.",
    after:
      "The owner-initiated motion principle, five new roles, the stagger token and a component decision table are documented. The theming reference lists --control-primary*, --shadow-control*, --shadow-card* and --surface-thumb.",
    why: "Area agents and plugin authors need one documented owner per pattern.",
    files: [
      "DESIGN.md",
      "plugins/omnyo-guide/skills/omnyo-cli/references/theming.md",
    ],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "automations-workflows-import-choice-cards",
    area: "p2-automations-workflows",
    title:
      "Import page: two clear choice cards with a readable header and an obvious primary action",
    kind: "visual",
    storyId: "automations--workflow-setup--import",
    beforeStoryId: "automations--workflow-setup--import",
    howToSee:
      "Open Automations › Import a workflow (story Automations/Workflow setup/Import). Compare light theme in r/import-light-after.png and the 420 px layout in r/import-narrow-after.png.",
    before:
      "A bare numbered stepper with short dashes, a text-xl title, and two flat cards with different layouts. The template card had a tiny icon, a label row and a light-grey button that did not read as primary. The file card had the raw native 'Choose File / No file chosen' input.",
    after:
      "The shared StepIndicator has filled connectors. The title uses text-lead, and a sentence explains that you review first and nothing runs until you confirm. Both cards share one layout: an icon tile, a tag chip ('Built-in template' or 'Shared with you'), a bold title and a description. The template card lists three checked points: seven drafts, every draft reviewed against your facts, and a downloadable calendar. Its near-white primary button ends with an arrow. The file card uses the shared FileDropZone with a size hint and a compact 'Paste JSON instead' disclosure. The cards have the card shadow and equal p-5 padding, and they stack cleanly at narrow widths.",
    why: "Example 1: Alex found the page badly readable and unpolished, with a raw file input, flat cards, an oversized title and a primary button that did not look primary.",
    files: [
      "plugins/automations/workflow-panel.tsx",
      "plugins/automations/workflow-setup.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "automations-workflows-import-choice-cards-before.png",
    afterShot: "automations-workflows-import-choice-cards-after.png",
  },
  {
    id: "automations-workflows-import-review-step",
    area: "p2-automations-workflows",
    title:
      "Reviewing a workflow is its own step, with a clear 'Add to project' footer and a way back",
    kind: "interaction",
    storyId: "automations--workflow-setup--import-review",
    beforeStoryId: "automations--workflow-setup--import",
    howToSee:
      "On the Import page, click 'Review Weekly Content Feed'. The new ImportReview story clicks it for you.",
    before:
      "The review panel appeared under both choice cards, so the page grew long and the cards stayed visible. It ended with a 'Recipient project' native select and a 'Save disabled copy' button.",
    after:
      "The choice cards leave and the review arrives through the shared StepTransition. The heading changes to 'Review before you add it'. A recessed footer, 'Add it to a project', says you get your own copy with its schedule off and write a short brief next. The footer has a styled Project select, a primary 'Add to <project>' button with an icon, and a ghost 'Choose another' button that returns to the choices.",
    why: "'Save disabled copy' was jargon, and the review had no focus and no way back. The new step makes the next action and its consequence obvious.",
    files: ["plugins/automations/workflow-panel.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "automations-workflows-import-review-step-before.png",
    afterShot: "automations-workflows-import-review-step-after.png",
  },
  {
    id: "automations-workflows-package-review-structure",
    area: "p2-automations-workflows",
    title:
      "Workflow review explains what the workflow can do and what it tells the model",
    kind: "ux",
    storyId: "automations--workflow-setup--import-review",
    beforeStoryId: "automations--workflow-setup--import",
    howToSee:
      "Story ImportReview, or open 'Edit workflow instructions' › Compare revision on a copy.",
    before:
      "A plain title, then a grey line ('Revision 2  Source: built-in template'). Below were a terse 'This workflow can' list ('Send selected text to the recipient’s model', 'Save text artifacts in the workflow run'), six separate bordered prompt disclosures and an unlabelled 'SHA-256 …' hash.",
    after:
      "The header has an icon tile, the title and description, and chips for source, revision and an unverified sender (warning tone). 'What it can do' lists each capability in a divided card with an icon tile, a plain title and a true one-line explanation. For example, 'Sends your brief to a model you choose' explains that your brief and the instructions below go to the Codex or Claude Code model you pick, on one of your connected devices. 'What it tells the model' groups every prompt in one divided card. Each row has a file icon, its name, a word count and a chevron. The hash is labelled 'Fingerprint (SHA-256)' beside a shield icon.",
    why: "Alex asked for structure and plain language instead of jargon. Recipients need to understand what a shared workflow does before adding it.",
    files: ["plugins/automations/workflow-setup.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "automations-workflows-package-review-structure-before.png",
    afterShot: "automations-workflows-package-review-structure-after.png",
  },
  {
    id: "automations-workflows-brief-fields",
    area: "p2-automations-workflows",
    title:
      "Brief form: a hint under each field, file loading only on long fields, styled selects",
    kind: "ux",
    storyId: "automations--workflow-setup--brief",
    beforeStoryId: "automations--workflow-setup--brief",
    howToSee:
      "Story Automations/Workflow setup/Brief. At 420 px see r/brief-narrow2-after.png.",
    before:
      "Every field, including 'Startup name' and 'Audience', had a 'From file' upload link, and no field explained what it was for. Device and Model were raw native selects with the OS arrow.",
    after:
      "Each Weekly Content Feed field has a full-width hint, linked with aria-describedby. For example: 'One numbered statement per line. Drafts use only what you write here, and the reviewer rejects claims that go beyond it.' 'Load from file' sits on the label row of long text fields only, and after loading it shows a check and the file name. Device and Model use a styled select with a raised surface, the control shadow, the field focus ring and a chevron. The primary 'Save brief and preview week' button ends with an arrow, and 'Nothing runs until you confirm.' has a shield icon.",
    why: "This fixes unexplained inputs, file upload on one-line fields and native-looking controls.",
    files: ["plugins/automations/workflow-setup.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "automations-workflows-brief-fields-before.png",
    afterShot: "automations-workflows-brief-fields-after.png",
  },
  {
    id: "automations-workflows-brief-disclosures",
    area: "p2-automations-workflows",
    title:
      "Optional settings and Device and model read as distinct, labelled groups",
    kind: "visual",
    storyId: "automations--workflow-setup--brief-options-open",
    beforeStoryId: "automations--workflow-setup--brief-options-open",
    howToSee:
      "Story Brief or BriefOptionsOpen; look at the two sections under the facts field.",
    before:
      "The sections were flat bordered rows with a small left chevron. Nothing showed that 'Sources, style and delivery' was optional.",
    after:
      "Each section has an icon tile (sliders, bot), its title, an 'Optional' tag on the sources section, a one-line summary and a right-hand chevron that turns on the disclosure transition. Both sit on a raised surface with a keyboard focus ring. 'Edit workflow instructions' and the automation footer reuse the same disclosure.",
    why: "The structure was unclear, and nothing marked which settings were optional.",
    files: [
      "plugins/automations/workflow-setup.tsx",
      "plugins/automations/workflow-panel.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "automations-workflows-brief-disclosures-before.png",
    afterShot: "automations-workflows-brief-disclosures-after.png",
  },
  {
    id: "automations-workflows-copy-header",
    area: "p2-automations-workflows",
    title:
      "Workflow copy header: segmented tabs, a tinted status badge and a plain subtitle",
    kind: "visual",
    storyId: "automations--workflow-setup--saved-brief",
    beforeStoryId: "automations--workflow-setup--saved-brief",
    howToSee:
      "Open any workflow copy and switch between Setup, Runs and Share.",
    before:
      "Three buttons in a bordered box acted as tabs. The status was an outlined pill, the confirmed state read 'Confirmed', and the subtitle ended with the jargon 'Restricted text workflow'.",
    after:
      "The tabs use the shared SegmentedControl: a radiogroup with arrow-key support and a sliding thumb. The status is a tinted badge with a dot ('Needs a brief', 'Ready to preview' or 'Ready to run'). The subtitle starts with a clock icon and ends with 'Writes text only'. The title uses text-lead.",
    why: "This removes jargon, replaces a hand-made tab strip with the shared control and makes the status read as a status.",
    files: [
      "plugins/automations/workflow-panel.tsx",
      "plugins/automations/workflow-setup.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "automations-workflows-copy-header-before.png",
    afterShot: "automations-workflows-copy-header-after.png",
  },
  {
    id: "automations-workflows-step-transitions",
    area: "p2-automations-workflows",
    title:
      "Setup and import steps travel forward and back when you advance or go back",
    kind: "animation",
    storyId: "automations--workflow-setup--brief",
    beforeStoryId: "automations--workflow-setup--brief",
    howToSee:
      "In story Import, click 'Review Weekly Content Feed'. In story Brief, click 'Save brief and preview week', then 'Edit brief'.",
    before:
      "The choice cards, review, brief form, saved summary and confirmed panel swapped instantly.",
    after:
      "The import body and the setup step body are wrapped in the shared StepTransition. Advancing travels forward, and going back or editing travels back. The filmstrip (0.25x) shows the old view fading out while the new one arrives. Nothing animates on first paint, and Reduce Motion crossfades.",
    why: "DESIGN.md allows step travel for owner-initiated step changes, and it makes progress feel deliberate.",
    files: ["plugins/automations/workflow-panel.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "automations-workflows-step-transitions-after.png",
  },
  {
    id: "automations-workflows-week-preview",
    area: "p2-automations-workflows",
    title:
      "Week preview: one tile per day, rows that stagger in and a clear note for missing facts",
    kind: "visual",
    storyId: "automations--workflow-setup--week-preview",
    beforeStoryId: "automations--workflow-setup--week-preview",
    howToSee:
      "Story WeekPreview, or click Preview in story SavedBrief to see the stagger (filmstrip r/m-preview-after-frames.png).",
    before:
      "Every row repeated a 'Day N focus' label above the fact. A small tile showed the weekday over a bare number that could pass for a date. A missing fact was an orange sentence.",
    after:
      "The header has a calendar icon tile. Each row has one tile (bold weekday over 'Day N') and the fact on one line, inside a recessed divided list. When you open the preview, the rows stagger in and the last starts within 150 ms. A day without a fact gets a dashed warning tile and an alert icon, and a footer says how many days repeat an earlier focus. The raw data disclosure is now called 'Technical details'.",
    why: "This removes repetition and the date-like number. Opening the preview is owner-initiated, so the stagger role applies.",
    files: [
      "plugins/automations/workflow-setup.tsx",
      "plugins/automations/workflow-panel.tsx",
      "plugins/automations/src/workflow-setup.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "automations-workflows-week-preview-before.png",
    afterShot: "automations-workflows-week-preview-after.png",
  },
  {
    id: "automations-workflows-saved-brief-and-next-step",
    area: "p2-automations-workflows",
    title:
      "Saved brief reads as a summary table, and the preview prompt says what happens next",
    kind: "ux",
    storyId: "automations--workflow-setup--saved-brief",
    beforeStoryId: "automations--workflow-setup--saved-brief",
    howToSee: "Story SavedBrief.",
    before:
      "A grey 'Saved brief' label and a loose label/value list. Below it, a panel read 'Preview your week' and 'A model-free preview from your saved brief. Confirm it to unlock runs.'",
    after:
      "A 'Brief saved' eyebrow with a check sits above the startup name. The values sit in a hairline table with recessed label cells. The next panel has a calendar icon tile and reads 'Next: see your week before anything runs' and 'Shows what each day will cover, built from your brief. No model runs for the preview.' The Preview button has an eye icon and shows a spinner while it works.",
    why: "This replaces the jargon 'model-free' and states the next step in plain words.",
    files: [
      "plugins/automations/workflow-setup.tsx",
      "plugins/automations/workflow-panel.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "automations-workflows-saved-brief-and-next-step-before.png",
    afterShot: "automations-workflows-saved-brief-and-next-step-after.png",
  },
  {
    id: "automations-workflows-confirm-success",
    area: "p2-automations-workflows",
    title: "Confirming the setup draws a success check in a green-edged panel",
    kind: "animation",
    storyId: "automations--workflow-setup--week-preview",
    beforeStoryId: "automations--workflow-setup--confirmed",
    howToSee:
      "In story WeekPreview, click 'Confirm this setup'. Story Confirmed shows the static state.",
    before:
      "A small circle-check icon and 'Setup confirmed' in a plain panel. 'Continue to first run' had no direction cue.",
    after:
      "A large SuccessCheck badge sits in a success-bordered panel, and its check draws only when you have just confirmed. The copy reads 'Run it once now and read the result. Turn on the schedule when you like it.' 'Continue to first run' ends with an arrow. The confirm hint says 'Locks in these inputs, the model and the workflow instructions. You can edit them later.'",
    why: "Confirming is an owner-confirmed moment. The check never draws when the page loads already confirmed.",
    files: ["plugins/automations/workflow-panel.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "automations-workflows-confirm-success-before.png",
    afterShot: "automations-workflows-confirm-success-after.png",
  },
  {
    id: "automations-workflows-runs-tab",
    area: "p2-automations-workflows",
    title:
      "Runs tab: a guided warning before confirming, icons on actions and feedback after turning on the schedule",
    kind: "ux",
    storyId: "automations--workflow-setup--runs-tab-before-confirming",
    beforeStoryId: null,
    howToSee:
      "Stories RunsTab and RunsTabBeforeConfirming (r/runs-tab-after.png).",
    before:
      "Disabled buttons sat above a small grey line, 'Confirm your setup before running. Go to setup', where 'Go to setup' was underlined bare text. The stepper jumped to step 4 (Run) whenever the Runs tab was open, even before confirming. Clicking 'Enable schedule' gave no feedback.",
    after:
      "The header has a play-icon tile. An unconfirmed copy shows a warning Alert, 'Confirm your setup first', with a link-style 'Go to setup' button. 'Run now' has a play icon and 'Enable schedule' has a clock icon, next to the schedule summary. After you turn the schedule on, an inline check reads 'Schedule turned on. Every Monday at 09:00 · …'. The stepper now follows setup progress, not the open tab.",
    why: "This fixes a misleading stepper, a state change with no confirmation and an action styled as bare text.",
    files: ["plugins/automations/workflow-panel.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "automations-workflows-runs-tab-after.png",
  },
  {
    id: "automations-workflows-run-history",
    area: "p2-automations-workflows",
    title:
      "Run history: plain status labels, an 'Open drafts' button, a 'Showing above' badge and a clear trigger label",
    kind: "ux",
    storyId: "automations--workflow-runs--ready-week",
    beforeStoryId: "automations--workflow-runs--ready-week",
    howToSee:
      "Story Automations/Workflow runs/Ready week; scroll to Run history.",
    before:
      "Runs without content showed raw status words ('succeeded', 'skipped'). A complete run offered 'Load run artifacts', and the loaded one had an unexplained 'In reader' chip. Row meta ended with 'Run now', which read like a button label. Each row had a 'Run details' disclosure, the 'Run history' label was small grey text and errors were bare red lines.",
    after:
      "Statuses read Finished, Run failed, Skipped and Recovered. A complete run offers a soft xs 'Open drafts' button, and the run already in the reader shows a 'Showing above' badge with an eye icon. Row meta says 'Started manually' or 'Scheduled'. The disclosure is 'Technical details', and the guidance line points to it. 'Run history' is a real heading, and Refresh is an xs ghost button. Errors use the shared error note, and the download disclosure gained a download icon and the card shadow.",
    why: "This removes unexplained chips and jargon from a list, like example 5.",
    files: [
      "plugins/automations/workflow-run-history.tsx",
      "plugins/automations/workflow-runs.tsx",
      "plugins/automations/src/workflow-runs.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "automations-workflows-run-history-before.png",
    afterShot: "automations-workflows-run-history-after.png",
  },
  {
    id: "automations-workflows-copy-list-and-graphs",
    area: "p2-automations-workflows",
    title: "Workflow list, its empty state and the Advanced workflows page",
    kind: "state",
    storyId: "automations--workflow-setup--empty-copy-list",
    beforeStoryId: "automations--workflow-setup--copy-list",
    howToSee:
      "Stories CopyList and EmptyCopyList. The Advanced workflows page (automations/graphs) has no story.",
    before:
      "The copy list used a native select and plain rows. The empty state was a dashed box reading 'No shared workflows in this project.' The Advanced workflows page used a text-xl heading, ghost buttons inside bordered boxes and a plain 'No advanced workflows.' line.",
    after:
      "The list has a styled select, and each row has a workflow icon tile and a status badge, inside a shadowed card with a row focus ring. The empty state is an EmptyStateBlock with an icon, 'No shared workflows here yet', an explanation and an 'Import a workflow' button. Advanced workflows has a header with a description and a 'New graph' button, rows that match the copy list (a 'Version N' or 'Draft' badge and a chevron), and an empty state with an action. The graphs page was checked only in code, not in a screenshot.",
    why: "The empty states were dead ends, and the graphs page was clearly unpolished.",
    files: ["plugins/automations/workflow-panel.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "automations-workflows-copy-list-and-graphs-before.png",
    afterShot: "automations-workflows-copy-list-and-graphs-after.png",
  },
  {
    id: "automations-workflows-copy-list-import-action",
    area: "p2-automations-workflows",
    title:
      "The workflow list keeps an 'Import a workflow' button when it has entries",
    kind: "ux",
    storyId: "automations--workflow-setup--copy-list",
    beforeStoryId: "automations--workflow-setup--copy-list",
    howToSee: "Story CopyList; look at the top right of the header.",
    before:
      "Once a project had a workflow, the Shared workflows page offered no way to import another one.",
    after:
      "An outline 'Import a workflow' button with a plus icon sits at the right of the header whenever the list has entries. It opens the same Import page as the empty state's button.",
    why: "This adds the missing affordance for the page's main next action.",
    files: ["plugins/automations/workflow-panel.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "automations-workflows-copy-list-import-action-before.png",
    afterShot: "automations-workflows-copy-list-import-action-after.png",
  },
  {
    id: "automations-workflows-automation-footer",
    area: "p2-automations-workflows",
    title: "Automation detail editor for trigger and action",
    kind: "visual",
    storyId: "automations--workflow-setup--automation-edit",
    beforeStoryId: null,
    howToSee:
      "Open an agent or script automation's detail page and scroll to the bottom, or open story AutomationEdit.",
    before: "The edit form used an unstyled disclosure and terse labels.",
    after:
      "The editor groups schedule and action fields and shows saving, success and error states next to the form.",
    why: "The grouped fields make the schedule and action easier to scan.",
    files: [
      "plugins/automations/workflow-panel.tsx",
      "plugins/automations/workflow-setup.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "automations-workflows-run-panel-states",
    area: "p2-automations-workflows",
    title:
      "Workflow run panel: titled empty and error states; the run ID gets a label",
    kind: "state",
    storyId: "plugins--workflows--workflow-panel--panel-states",
    beforeStoryId: "plugins--workflows--workflow-panel--panel-states",
    howToSee:
      "Story plugins/Workflows/Workflow panel/Panel states, or open the workflow side panel in a chat.",
    before:
      "The error, empty and invalid states were one grey sentence at the top of the panel, such as 'No workflow runs were found for this thread.' The loaded panel showed an unexplained mono string ('11111111') at the right of the agents line.",
    after:
      "These states use the shared EmptyStateBlock: an icon circle (a red alert for errors, a workflow glyph otherwise), a title and an explanation. The titles are 'Couldn’t show this workflow run', 'Can’t open this workflow run' and 'No workflow runs yet' ('Workflows started in this chat show their progress here.'). The empty state is announced as a status, not an alert. The short run ID moved into Run details as a labelled 'Run ID' row, with the full ID as a tooltip. The inline chat directive is unchanged.",
    why: "This fixes unexplained glyphs at row ends and unpolished error states.",
    files: [
      "plugins/workflows/src/app.tsx",
      "plugins/workflows/src/app.test.tsx",
      "apps/app/.ladle/workflows.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "automations-workflows-run-panel-states-before.png",
    afterShot: "automations-workflows-run-panel-states-after.png",
  },
  {
    id: "automations-workflows-error-text-contrast",
    area: "p2-automations-workflows",
    title: "Automation error lines use the AA-safe destructive text token",
    kind: "fix",
    storyId: "automations--failure-states",
    beforeStoryId: "automations--failure-states",
    howToSee:
      "Story Automations/Overview rows or Failure states (the red reason text).",
    before: "Failure reasons used text-destructive, the icon colour, on text.",
    after:
      "Failure reasons use text-destructive-text, which DESIGN.md sanctions for readable error text.",
    why: "This makes secondary error text legible. It accompanies the other changes and is not counted on its own.",
    files: [
      "plugins/automations/overview-view.tsx",
      "plugins/automations/detail-view.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: "automations-workflows-error-text-contrast-after.png",
  },
  {
    id: "tasks-list-collapsible-status-groups",
    area: "p2-tasks",
    title:
      "Every status group in the task list can be collapsed, and the choice is remembered",
    kind: "ux",
    storyId: "tasks--list-groups-collapsed",
    beforeStoryId: null,
    howToSee:
      "Open Tasks > All tasks (or any project list). Click the Backlog or Done header, then reload or switch views and come back.",
    before:
      "Status headers (Backlog 2, Todo 4, …) were static text with a plain grey number. Done and Canceled tasks could not be hidden, so finished work always pushed open work down.",
    after:
      "Each header is a full-width button with a rotating chevron, the status icon, the label and a count chip. Clicking it folds the group. The choice is stored per list (All tasks, Active and each project separately), so it survives reloads. A collapsed group takes no rows in the virtualised list.",
    why: "Alex asked that every section be collapsible with the choice remembered. Hiding Done and Canceled is the most common need in a task list.",
    files: [
      "plugins/tasks/views/list/index.tsx",
      "plugins/tasks/views/list/status-group.tsx",
      "plugins/tasks/shared/collapsed-sections.ts",
      "plugins/tasks/views/list/row.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "tasks-list-collapsible-status-groups-before.png",
    afterShot: "tasks-list-collapsible-status-groups-after.png",
  },
  {
    id: "tasks-list-reveal-stagger",
    area: "p2-tasks",
    title: "Rows cascade in when the owner reopens a status group",
    kind: "animation",
    storyId: "tasks--list-groups-collapsed",
    beforeStoryId: null,
    howToSee: "Collapse Todo in All tasks, then click it again at 1x speed.",
    before: "There was no collapse, so nothing was revealed.",
    after:
      "When the owner reopens a group, its first visible rows (up to 12) arrive with the shared staggered-arrival motion. The last row starts within 150 ms. The stagger class is removed after 600 ms, so rows that later scroll into the virtual window do not animate. First paint, data updates and Reduce Motion do not animate.",
    why: "DESIGN.md allows staggered arrival for groups the owner opens. The motion confirms which rows the click revealed.",
    files: [
      "plugins/tasks/views/list/index.tsx",
      "plugins/tasks/views/list/row.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "tasks-list-reveal-stagger-after.png",
  },
  {
    id: "tasks-sidebar-collapsible-sections",
    area: "p2-tasks",
    title:
      "Sidebar sections (Projects, each folder, Agent presets) collapse with count chips and are remembered",
    kind: "ux",
    storyId: "tasks--sidebar",
    beforeStoryId: null,
    howToSee:
      "In the Tasks sidebar, click 'Agent presets' or 'Projects', then reload. Hover a project's number or its green dot.",
    before:
      "Projects and Agent presets were static headings. Only folders could fold, and their state was lost on every reload. Project counts and the green dot had no explanation.",
    after:
      "Every section header is a hover-highlighted button with a chevron, a title and a count chip ('Projects 2', 'Agent presets 3'), and it folds with the shared disclosure reveal. Open and closed state is stored in localStorage. Hovering a project count says '7 tasks, not counting sub-tasks', and screen readers hear the same. The green dot says how many agents are working, both on hover and to screen readers. The worktree glyph's tooltip reads 'Starts each agent in a new worktree'. Rows use the shared focus ring and aria-current.",
    why: "Alex wants every section collapsible and remembered, and every glyph and count explained.",
    files: [
      "plugins/tasks/shell/sidebar.tsx",
      "plugins/tasks/shared/collapsed-sections.ts",
      "plugins/tasks/shell/shell.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "tasks-sidebar-collapsible-sections-before.png",
    afterShot: "tasks-sidebar-collapsible-sections-after.png",
  },
  {
    id: "tasks-row-project-chip",
    area: "p2-tasks",
    title:
      "Task rows name their project instead of showing an unexplained coloured square",
    kind: "ux",
    storyId: "tasks--list-groups",
    beforeStoryId: null,
    howToSee:
      "Open All tasks in a wide window and look at the right end of each row.",
    before:
      "In All tasks, every row ended in a tiny coloured square. Only a hover title said what it meant.",
    after:
      "Rows end in the project's colour swatch followed by its name ('Core app', 'Website'). In narrow containers the name becomes screen-reader text plus a hover title.",
    why: "This is the same complaint Alex made about unexplained glyphs on the right of rows.",
    files: ["plugins/tasks/views/list/row.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "tasks-row-project-chip-before.png",
    afterShot: "tasks-row-project-chip-after.png",
  },
  {
    id: "tasks-due-urgency",
    area: "p2-tasks",
    title:
      "Overdue and due-today tasks stand out in the list, on board cards and in the task properties",
    kind: "state",
    storyId: "tasks--list-groups",
    beforeStoryId: null,
    howToSee:
      "Give an open task a due date in the past and another one today. Then look at the list, the board and the task's Properties.",
    before:
      "Every due date was the same grey clock chip, whether it was due next month or a week late. Board cards did not show due dates at all.",
    after:
      "For open tasks, a past date becomes a red-tinted chip with an alert icon reading 'Overdue · Nov 20'. Today's date becomes a highlighted 'Due today · Nov 22' chip. Wide rows show the words; narrow rows keep the colour and a hover title. Board cards now show the same due chip. In the detail Properties, the due date reads 'Overdue · Nov 20' in red, or 'Today'. Done and Canceled tasks never turn red. This was verified in dark and light themes.",
    why: "Due dates only help if lateness is visible at a glance. Before, the date gave no hint of urgency.",
    files: [
      "plugins/tasks/views/list/lib.ts",
      "plugins/tasks/views/list/row.tsx",
      "plugins/tasks/views/board/index.tsx",
      "plugins/tasks/views/detail/rail.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "tasks-due-urgency-before.png",
    afterShot: "tasks-due-urgency-after.png",
  },
  {
    id: "tasks-detail-labelled-properties",
    area: "p2-tasks",
    title:
      "The task properties rail is a labelled grid with a separate, plainly worded Agents block",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open any task in a window wider than about 45rem and look at the right rail.",
    before:
      "Under 'Properties', the rail showed unlabelled values ('In Progress', 'High', 'Nov 20'), so you had to guess which one was the priority. Further down came tiny headings: the jargon 'Dispatch target' with an arrow icon, a light-grey split button showing only a preset name, and 'Agents: none active'.",
    after:
      "Properties is a two-column grid of labels and values: Status, Priority, Due date, Project and Labels. Each value is a hover-highlighted control with the shared focus ring, and an empty Labels field shows '+ Add'. A divider leads to an 'Agents' block, introduced as 'Start an agent chat that works on this task.' The block has 'Starts in' (a folder icon and the linked Omnyo project, or 'Choose a project…'), the Start button, and the working agents as status dots, for example 'Opus builder working'. With no agent it reads 'No agent is working on this task.' Screen readers now hear 'Change where agents start' instead of 'Edit dispatch target'.",
    why: "Unlabelled values and jargon such as 'Dispatch target' made the rail hard to read. The rail now says what each value is and what happens next.",
    files: [
      "plugins/tasks/views/detail/rail.tsx",
      "plugins/tasks/views/detail/rail.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "tasks-detail-labelled-properties-before.png",
    afterShot: "tasks-detail-labelled-properties-after.png",
  },
  {
    id: "tasks-detail-start-agent-button",
    area: "p2-tasks",
    title:
      "The dispatch button says what it does: 'Start <preset>' with a play icon, as the one primary action",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open a task and look at the button under Agents, or next to the inline properties on narrow widths. Hover it, then open its menu.",
    before:
      "A light-grey split button labelled only 'Codex reviewer'. It did not read as primary or say what a click does. Its busy text was 'Dispatching…', and with no presets it read 'Add a preset…'.",
    after:
      "A primary split button using the design system's control-primary colour, labelled '▷ Start Codex reviewer'. While busy it shows a spinner and 'Starting agent…'. Its tooltip reads 'Start a new agent chat on this task with the Codex reviewer preset'. The menu heading is 'Start an agent with', and the chevron's screen-reader name is 'Choose which preset starts the agent'. With no presets, the button reads 'Add an agent preset', and its tooltip explains what a preset is.",
    why: "This is the same 'primary that doesn't read as primary' problem Alex flagged, and the preset name alone did not say what happens on click.",
    files: [
      "plugins/tasks/views/detail/threads.tsx",
      "plugins/tasks/components/hint.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "tasks-detail-start-agent-button-before.png",
    afterShot: "tasks-detail-start-agent-button-after.png",
  },
  {
    id: "tasks-detail-agent-chats-status-rows",
    area: "p2-tasks",
    title:
      "Agent chats on a task use the shared StatusList, with tone badges and real buttons",
    kind: "visual",
    storyId: "tasks--detail-agent-chats",
    beforeStoryId: null,
    howToSee:
      "Open a task that has attached agent chats and scroll to 'Agent chats'. Hover the × on a row.",
    before:
      "'Agent threads' was a small grey label above separate bordered boxes. Each box had coloured status text on the left, an underlined bare-text 'Open thread ↗' link and a tiny unexplained ×. A failed PR lookup read 'PR unavailable'.",
    after:
      "An 'Agent chats' heading with a count chip sits above one bordered StatusList. The heading says '1 working now', or 'None working right now' when no agent is working. Each row has a tone dot, the title, a status badge (Working, Starting, Completed, Failed) and meta ('Opus builder · added 12h ago'). Its actions are a 'PR #482 Merged' pill, an 'Open chat ↗' button (xs soft) and an icon-only detach button whose tooltip reads 'Remove from this task. The chat itself is kept.' The detach dialog now says 'chat'. A failed PR lookup reads 'PR status unknown'.",
    why: "Alex asked for 'thing + state + meta + actions' lists to use StatusRow, and for actions never to be styled as bare text.",
    files: [
      "plugins/tasks/views/detail/threads.tsx",
      "plugins/tasks/views/detail/sections.tsx",
      "plugins/tasks/views/detail/index.tsx",
      "plugins/tasks/views/detail/threads.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "tasks-detail-agent-chats-status-rows-before.png",
    afterShot: "tasks-detail-agent-chats-status-rows-after.png",
  },
  {
    id: "tasks-detail-subtasks-section",
    area: "p2-tasks",
    title:
      "Sub-tasks get a real section: a heading, progress, a bordered list with status words and an 'Add sub-task' button",
    kind: "ux",
    storyId: "tasks--detail-sub-tasks",
    beforeStoryId: null,
    howToSee:
      "Open a task with sub-tasks, and one without, and look below the description.",
    before:
      "Sub-task rows appeared under the description with no heading, followed by a bare-text '+ Add sub-task' link. A task without sub-tasks showed only that link.",
    after:
      "A 'Sub-tasks' heading with a count chip and '1 of 3 done' (or 'Break this task into smaller steps.' when there are none) has an 'Add sub-task' xs soft button on the right. The rows sit in a bordered card, each with the status icon, key, title and a status word on the right. Closed sub-tasks are dimmed. The inline add row's placeholder explains 'Enter adds it, Esc cancels'.",
    why: "It replaces a list with no structure and a bare-text action, and it shows progress where the work is.",
    files: [
      "plugins/tasks/views/detail/sections.tsx",
      "plugins/tasks/views/detail/index.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "tasks-detail-subtasks-section-before.png",
    afterShot: "tasks-detail-subtasks-section-after.png",
  },
  {
    id: "tasks-detail-dead-reaction-removed",
    area: "p2-tasks",
    title:
      "The disabled 'Reactions coming soon' smiley is gone and the attach button has a label",
    kind: "fix",
    storyId: null,
    beforeStoryId: null,
    howToSee: "Open a task and look directly under the description.",
    before:
      "Two unexplained icons: a faded smiley that did nothing (disabled, 'Reactions coming soon') and a bare paperclip.",
    after:
      "A single ghost xs button reads '📎 Attach files'. The description placeholder explains the editor in plain words: 'Describe the task. Markdown works for headings, lists and checkboxes; type @ to link a task or chat.'",
    why: "A dead control and an unlabelled icon add confusion without adding function.",
    files: ["plugins/tasks/views/detail/index.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "tasks-detail-dead-reaction-removed-before.png",
    afterShot: "tasks-detail-dead-reaction-removed-after.png",
  },
  {
    id: "tasks-empty-and-error-states",
    area: "p2-tasks",
    title:
      "Not-found, load-error and empty pages use the shared EmptyStateBlock with a next step",
    kind: "visual",
    storyId: "tasks--empty-and-error-states",
    beforeStoryId: null,
    howToSee:
      "Open tasks/task/NOPE-99, make the board fail to load, or open an empty project.",
    before:
      "A missing task showed a small icon and 'Task CORE-99 was not found.' in grey, with no way forward. A board error was the grey sentence 'Failed to load the board: …' above a 'Retry' button. A task load error was raw red text. Empty states used a small square icon tile.",
    after:
      "Every empty and error page uses the shared EmptyStateBlock: a round icon badge (red-tinted for errors), a title, a plain explanation and an action. Examples: 'Task CORE-99 was not found' with 'It may have been deleted, or its key changed when it moved to another project.' and a 'Show all tasks' button; 'Couldn't load the board' and 'Couldn't load tasks' with a '↻ Try again' button; and 'Couldn't load CORE-12' for task load errors.",
    why: "This gives Tasks the treatment Alex asked for on the browser's 'Server not reachable' page: say what happened and offer the next action.",
    files: [
      "plugins/tasks/components/empty-state.tsx",
      "plugins/tasks/views/detail/index.tsx",
      "plugins/tasks/views/board/index.tsx",
      "plugins/tasks/views/list/index.tsx",
      "plugins/tasks/shell/app-shell.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "tasks-empty-and-error-states-before.png",
    afterShot: "tasks-empty-and-error-states-after.png",
  },
  {
    id: "tasks-manage-preset-cards",
    area: "p2-tasks",
    title:
      "Agent presets are readable rows with plain-language settings instead of a nine-column table, and deleting one asks first",
    kind: "ux",
    storyId: "tasks--manage-presets",
    beforeStoryId: null,
    howToSee:
      "Open Tasks > Manage > Presets. Hover a preset's trash icon and click it.",
    before:
      "A wide nine-column table (Name, Provider, Model, Reasoning, Tier, Permissions, Environment, Instructions) with truncated instructions and an environment cell reading 'Worktree · main · default'. Edit and delete appeared only on hover, and the trash icon deleted the preset immediately, without confirmation.",
    after:
      "Each preset is a row in a bordered card with a bot avatar, the name and a permission badge (Full Access is highlighted as a warning). Below the name, a meta line reads, for example, 'claude-code · claude-opus-5-5 · high reasoning · ⑂ New worktree from main', or '📁 Project's default workspace'. The instructions follow on up to two lines. An always-visible 'Edit' xs soft button sits beside a trash icon button with a tooltip. Delete opens a 'Delete preset “Opus builder”?' confirmation, which says that running agents keep going. With no presets, an empty state reads 'No agent presets yet'. The intro reads 'A preset decides which model, permissions and workspace an agent uses when you start it on a task.'",
    why: "The table was hard to scan and hid its actions, the environment shorthand was cryptic, and an instant destructive delete is a concrete UX hazard.",
    files: [
      "plugins/tasks/views/manage/preset-list.tsx",
      "plugins/tasks/views/manage/manage-panel.tsx",
      "plugins/tasks/views/manage/preset-dialog.tsx",
      "plugins/tasks/views/manage/manage.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "tasks-manage-preset-cards-before.png",
    afterShot: "tasks-manage-preset-cards-after.png",
  },
  {
    id: "tasks-manage-layout-copy",
    area: "p2-tasks",
    title:
      "Manage drops its duplicate header, centres its content and explains each tab",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee: "Open Tasks > Manage and switch between the tabs.",
    before:
      "The page repeated the topbar ('Manage · labels, presets, folders') with a second 'Manage / Labels, agent presets, and folders.' header. The content stretched edge to edge, and the empty copy used dashes and jargon ('labels are project-scoped').",
    after:
      "The duplicate header is gone, and the tabs and content sit in a centred max-w-3xl column. Labels opens with 'Each project has its own labels. Pick a project to see and edit them.' The empty messages read 'No labels in this project yet. Add one below.', 'Create a project first. Labels belong to a project.' and 'No folders yet. Create one from the New project dialog to group projects in the sidebar.'",
    why: "This removes repetition and jargon and keeps the content at a readable width.",
    files: [
      "plugins/tasks/views/manage/manage-panel.tsx",
      "plugins/tasks/shell/shell.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "tasks-manage-layout-copy-before.png",
    afterShot: "tasks-manage-layout-copy-after.png",
  },
  {
    id: "tasks-topbar-view-segmented",
    area: "p2-tasks",
    title:
      "The List/Board switch uses the shared SegmentedControl, with icons and a sliding thumb",
    kind: "interaction",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open a project and switch between List and Board, with the mouse or with the arrow keys.",
    before:
      "Two small text toggle buttons on a muted pill. The selection jumped between them, and keyboard users got no radio semantics.",
    after:
      "The shared SegmentedControl shows 'List' and 'Board' with icons. Its thumb slides on the smooth spring, and it is a radiogroup that responds to the arrow, Home and End keys.",
    why: "It reuses the design-system owner for a two-way view choice and gives the switch the same motion and accessibility as the rest of the app.",
    files: [
      "plugins/tasks/shell/topbar.tsx",
      "plugins/tasks/shell/shell.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "tasks-topbar-view-segmented-before.png",
    afterShot: "tasks-topbar-view-segmented-after.png",
  },
  {
    id: "tasks-board-cards-meta",
    area: "p2-tasks",
    title:
      "Board cards explain their icons and open from the keyboard; columns show count chips and an empty placeholder",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open a project in Board view. Look at a card with sub-tasks, then Tab to a card and press Enter.",
    before:
      "Sub-task progress was a git-branch glyph with '1/3', and attachments were a bare paperclip; neither was explained. Tasks with no priority showed faint empty bars. Cards could not be focused or opened from the keyboard. Column counts were plain grey numbers, and the '+' buttons had no tooltip.",
    after:
      "Sub-task progress is a pill with a check icon and '1/3'; its hover and screen-reader text is '1 of 3 sub-tasks done'. Attachments are a pill with a count and the text 'N attachments'. Priority appears only when set, with a hover label such as 'High priority'. Cards are focusable buttons with the shared focus ring and open on Enter or Space. Column counts use the shared count chip. The '+' is an icon-xs button with the tooltip 'Add a task to Todo'. Empty columns show a dashed 'No tasks' placeholder, which reads 'Drop to move here' while you drag a card over it.",
    why: "These unexplained glyphs and the missing keyboard path are exactly the kinds of issues Alex called out.",
    files: ["plugins/tasks/views/board/index.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "tasks-board-cards-meta-before.png",
    afterShot: "tasks-board-cards-meta-after.png",
  },
  {
    id: "tasks-comment-composer-labels",
    area: "p2-tasks",
    title:
      "The comment composer's notify bell, attach clip and send arrow become labelled, explained buttons",
    kind: "ux",
    storyId: "tasks--comment-notify-control",
    beforeStoryId: null,
    howToSee:
      "Open a task with an agent reply and look at the comment box footer. Hover the bell button and the paperclip.",
    before:
      "A lone bell icon, with on and off looking almost identical, and a tooltip that only repeated 'Notify <chat>'. A bare paperclip had no tooltip, and sending used a dark arrow square. The placeholder read 'Leave a comment… @-mention tasks and threads to link them'. Under a sent comment, a line in lowercase green read 'notified the last responding agent'.",
    after:
      "The bell is now a labelled switch. On, it reads '🔔 Notify agent' with a soft fill; off, it reads '🔕 Don't notify agent'. When no agent can be notified, the switch is icon-only and disabled. Its tooltip says what will happen: 'Your comment is also sent to <chat>. Click to keep it on the task only.' or 'Your comment stays on the task. Click to also send it to <chat>.' The disabled states explain that no agent has replied yet, or that the last one can't receive messages. The paperclip is an icon-xs button with the tooltip 'Attach files to this comment'. Send is a primary xs '↑ Comment' button. The placeholder reads 'Leave a comment. Type @ to link a task or chat.', and the note under a sent comment reads 'Sent to the agent that last replied'.",
    why: "A toggle that silently decides whether an agent is woken up, with no explanation of either state, is a real source of confusion.",
    files: ["plugins/tasks/views/activity/task-activity.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "tasks-comment-composer-labels-before.png",
    afterShot: "tasks-comment-composer-labels-after.png",
  },
  {
    id: "tasks-embed-card-status",
    area: "p2-tasks",
    title:
      "In-chat task cards show their status, explain the open icon, and broken links read as a notice",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Look at a ::task{key=…} card in a chat message, and at one with a malformed key.",
    before:
      "The card showed only a small status glyph, the key and the title, plus an unlabelled ↗ icon. A malformed key produced a red box reading 'Invalid task link. Expected a task key like TSK-4.'",
    after:
      "At normal widths, the card adds a status pill such as 'In Progress' or 'Todo'. The priority icon has a hover label, and the ↗ button shows the tooltip 'Open CORE-12 in Tasks'. A malformed key shows a tinted notice with an alert icon: 'This task link is broken. Task keys look like TSK-4.'",
    why: "A glyph alone did not say where the task stands, and the open button did not say what it opens.",
    files: [
      "plugins/tasks/views/embed/index.tsx",
      "plugins/tasks/views/embed/embed.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "tasks-embed-card-status-before.png",
    afterShot: "tasks-embed-card-status-after.png",
  },
  {
    id: "tasks-activity-contrast",
    area: "p2-tasks",
    title:
      "Activity timestamps and system-event names no longer use opacity-reduced text",
    kind: "fix",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Look at a system event in a task's Activity feed, for example 'Alex changed status … · 2d ago'.",
    before:
      "Names used text-foreground/80 and timestamps used text-muted-foreground/70, which fall below AA contrast.",
    after:
      "Names use text-foreground and timestamps use text-subtle-foreground, both at full strength.",
    why: "DESIGN.md's readability rule: text never uses opacity-reduced tokens.",
    files: ["plugins/tasks/views/activity/task-activity.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: "tasks-activity-contrast-after.png",
  },
  {
    id: "tasks-stories",
    area: "p2-tasks",
    title: "New Ladle stories for the Tasks plugin",
    kind: "story",
    storyId: "tasks--list-groups",
    beforeStoryId: null,
    howToSee:
      "After the shared Ladle config change in sharedRequests, open the 'Tasks' stories.",
    before: "The Tasks plugin had no stories.",
    after:
      "There are nine presentational stories: List groups, List groups collapsed, List rows narrow, Sidebar, Detail sub-tasks, Detail agent chats, Comment notify control, Manage presets, and Empty and error states.",
    why: "They let the owner and future polish passes see these surfaces without a running server.",
    files: ["plugins/tasks/tasks.stories.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "sidebar-thread-title-room",
    area: "p2-sidebar",
    title: "Thread titles get about 40 px more room in every sidebar row",
    kind: "visual",
    storyId: "sidebar--shell--inbox",
    beforeStoryId: "sidebar--shell--inbox",
    howToSee:
      "Open sidebar/Shell › Inbox at 1440 wide and read the thread titles in the narrow sidebar.",
    before:
      'Titles were cut to about six characters, for example "Profile …", "Chat To…" and "Sp…". A wide empty gap sat between each title and its age, because the right-hand slot always kept 64 px and an empty 16 px glyph box.',
    after:
      'Titles read "Profile comp…", "Chat Topics …", "Plan the week" and "Reading list". The age sits right after the title. On hover, the archive and menu buttons still fit, and the title truncates before them.',
    why: "Alex complained about weird padding and clipped text. The thread list is the most-read surface in the app.",
    files: ["plugins/thread-list/app/rows/ThreadRow.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "sidebar-thread-title-room-before.png",
    afterShot: "sidebar-thread-title-room-after.png",
  },
  {
    id: "sidebar-footer-job-counts-labelled",
    area: "p2-sidebar",
    title:
      'Footer resource counts now say what they are: "2 running · 1 queued"',
    kind: "ux",
    storyId: "sidebar--shell--inbox",
    beforeStoryId: "sidebar--shell--inbox",
    howToSee:
      "Open sidebar/Shell › Inbox at 1440 wide and look at the bottom bar to the right of the machine name.",
    before:
      'The bottom bar showed a bare play glyph with "2" and a clock glyph with "1". Neither said what was being counted.',
    after:
      'The counts read "▸ 2 running" and "◷ 1 queued", with bold numbers and muted words. Below a 52rem footer the words drop away and the glyphs stay.',
    why: "Alex asked for unexplained glyphs and numbers to explain themselves. The footer is visible on every screen.",
    files: ["apps/app/src/components/sidebar/ResourcesRailWidget.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "sidebar-footer-job-counts-labelled-before.png",
    afterShot: "sidebar-footer-job-counts-labelled-after.png",
  },
  {
    id: "sidebar-footer-plain-tooltips",
    area: "p2-sidebar",
    title:
      "Footer CPU, job and GPU readings have plain-language tooltips and keyboard focus",
    kind: "ux",
    storyId: "sidebar--shell--inbox",
    beforeStoryId: "sidebar--shell--inbox",
    howToSee:
      "Hover over or Tab to the CPU meter, the running and queued counts, or GPU in the bottom bar.",
    before:
      'The tooltips used scheduler jargon: "Scheduler CPU units reserved by active jobs", "Active jobs, including starting, stopping and blocked jobs", "Queued jobs" and "GPU admission state reported by Resources". The keyboard could not reach the readings. With no machines, the footer read "Hosts  No hosts".',
    after:
      'The tooltips are sentences that name the machine. Examples: "Running jobs have reserved 6 of the 12 CPU units on Michael\'s MacBook Pro", "2 jobs running on …, counting any that are starting, stopping or blocked", "1 job on … waiting to start" and "The GPU is free, so a GPU job can start now on …". Each reading takes keyboard focus and shows the shared focus ring. The empty states read "Loading…" and "No machines connected". An unavailable GPU still reads "N/A", and its tooltip explains that GPU jobs cannot start.',
    why: "The tooltips repeated internal terms, and keyboard users could not reach them.",
    files: [
      "apps/app/src/components/sidebar/ResourcesRailWidget.tsx",
      "apps/app/src/components/sidebar/ResourcesRailWidget.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "sidebar-footer-plain-tooltips-after.png",
  },
  {
    id: "sidebar-compact-thread-age",
    area: "p2-sidebar",
    title:
      'Thread ages are compact and full strength ("4d", "1w", "1mo" instead of "33d ago")',
    kind: "visual",
    storyId: "sidebar--thread-list--inbox-read-status",
    beforeStoryId: "sidebar--thread-list--inbox-read-status",
    howToSee: "Compare the right-hand age column on both servers.",
    before:
      'Every row ended in "8d ago", "33d ago" or "400d ago" at 80% opacity, and the repeated "ago" crowded the titles.',
    after:
      'Ages read now, 52m, 21h, 5d, 3w, 1mo, 12mo or 1y in full-strength subtle text. Hovering an age still shows the full start date. In this story "Plugin catalog refresh" now fits, where it previously read "Plugin catalog refre…".',
    why: "The short form makes the list easier to read and leaves the titles more room. It also removes reduced-opacity text, which fails AA contrast.",
    files: [
      "plugins/thread-list/app/rows/ThreadRowAge.tsx",
      "plugins/thread-list/app/rows/ThreadRowAge.test.tsx",
      "plugins/thread-list/app/rows/ThreadRow.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "sidebar-compact-thread-age-before.png",
    afterShot: "sidebar-compact-thread-age-after.png",
  },
  {
    id: "sidebar-chat-group-folder",
    area: "p2-sidebar",
    title:
      "Chat groups look like folders, with a folder glyph and a count chip",
    kind: "visual",
    storyId: "sidebar--thread-list-states--project-mode-groups",
    beforeStoryId: "sidebar--thread-list-states--project-mode-groups",
    howToSee:
      'Open sidebar/Thread list states › Project mode groups. "Launch week" is a group of 3 chats. Click it to fold it.',
    before:
      "A chat group row was grey text with a chevron and a tiny bare number at the far right. Nothing marked it as a container rather than a chat.",
    after:
      'The row starts with a folder glyph in the status column: an open folder when expanded and a closed one when folded. The member count is a rounded count chip, and screen readers still hear "3 chats".',
    why: "Group rows were easy to mistake for chats, and the bare number explained nothing.",
    files: ["plugins/thread-list/app/list/ChatGroupRow.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "sidebar-chat-group-folder-after.png",
  },
  {
    id: "sidebar-thread-list-placeholder-cards",
    area: "p2-sidebar",
    title:
      'The "Thread list unavailable" and "stopped working" states are calm cards with one clear action',
    kind: "state",
    storyId: "sidebar--thread-list-states--placeholder-states",
    beforeStoryId: "sidebar--thread-list-states--placeholder-states",
    howToSee: "Open sidebar/Thread list states › Placeholder states.",
    before:
      'Each state was a bare line, "Thread list unavailable." or "<plugin> stopped working.", above an outline button. Nothing said whether any threads were lost.',
    after:
      'Each state is a bordered card with an icon, a medium-weight title and a reassuring line. The missing state reads "Your threads are safe. The thread list plugin isn’t loaded. Retry, or check that it’s turned on in Plugins." The crashed state has a warning glyph and reads "Your threads are safe. Reload the list to show them again." Each card has one xs soft Retry or Reload button.',
    why: "These are the error states of the main navigation. They should reassure the owner and show the next step.",
    files: ["apps/app/src/components/sidebar/ThreadListPlaceholder.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "sidebar-thread-list-placeholder-cards-after.png",
  },
  {
    id: "sidebar-shelf-archive-notices",
    area: "p2-sidebar",
    title:
      "The Shelf and archive load notices are styled, aligned and plainly worded",
    kind: "state",
    storyId: "sidebar--thread-list-states--empty-and-error-states",
    beforeStoryId: "sidebar--thread-list--working-subagents",
    howToSee:
      "Look below the list in any sidebar/Thread list story, where the Shelf cannot load in Ladle. In the real app this appears only when shelved threads fail to load.",
    before:
      'The raw body text "Shelved threads unavailable" sat flush against the panel edge with no icon, out of line with the rows. The archived states were also unstyled text.',
    after:
      'A ThreadListNotice row lines up with the thread rows. It shows an alert glyph, "Couldn’t load shelved threads" in the error colour, and the muted line "Your other threads are unaffected." Archived threads show "Loading archived threads…" with a spinner that stops under Reduce Motion, or "Couldn’t load archived threads".',
    why: "This error state showed raw status text that looked unfinished.",
    files: [
      "plugins/thread-list/app/list/ThreadListNotice.tsx",
      "plugins/thread-list/app/list/ProjectList.tsx",
      "plugins/thread-list/app.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "sidebar-shelf-archive-notices-before.png",
    afterShot: "sidebar-shelf-archive-notices-after.png",
  },
  {
    id: "sidebar-empty-section-legible",
    area: "p2-sidebar",
    title: "The empty and failed section states are legible",
    kind: "visual",
    storyId: "sidebar--thread-list-states--empty-and-error-states",
    beforeStoryId: "sidebar--thread-list--inbox-read-status",
    howToSee: 'Look at "No threads" under the empty Threads section.',
    before:
      '"No threads" was text-subtle-foreground at 60% with its icon at 50%, which is below AA contrast and barely visible. A failed list read "Threads unavailable".',
    after:
      'The same ThreadListNotice shows "No threads" in full-strength subtle text with a full-strength glyph. A failed list shows "Couldn’t load threads" in the error colour.',
    why: "DESIGN.md forbids reduced-opacity text tokens because they fail AA.",
    files: [
      "plugins/thread-list/app/list/ProjectRow.tsx",
      "plugins/thread-list/app/list/ProjectThreadTree.disclosure.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "sidebar-empty-section-legible-before.png",
    afterShot: "sidebar-empty-section-legible-after.png",
  },
  {
    id: "sidebar-collapsed-section-count",
    area: "p2-sidebar",
    title: "A folded sidebar section shows how many threads it hides",
    kind: "ux",
    storyId: "sidebar--thread-list-states--collapsed-sections",
    beforeStoryId: "sidebar--thread-list-states--collapsed-sections",
    howToSee:
      "Open sidebar/Thread list states › Collapsed sections. The Threads section starts folded.",
    before:
      "A folded section showed only its name and a chevron, so the owner could not tell whether it held 1 thread or 40.",
    after:
      'A folded section shows a count chip after its name, for example "Threads 5 ›", using the shared SECTION_COUNT_CLASS. Screen readers hear "5 threads hidden". The chip disappears when the section opens.',
    why: "A count makes a folded section trustworthy instead of looking empty.",
    files: [
      "plugins/thread-list/app/list/TopLevelSidebarSection.tsx",
      "plugins/thread-list/app/list/ProjectListSectionHeader.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "sidebar-collapsed-section-count-after.png",
  },
  {
    id: "sidebar-section-name-toggles",
    area: "p2-sidebar",
    title: "Clicking a built-in section's name folds or unfolds it",
    kind: "interaction",
    storyId: "sidebar--thread-list-states--collapsed-sections",
    beforeStoryId: "sidebar--thread-list--inbox-read-status",
    howToSee:
      'In the Collapsed sections story, click the word "Threads". It opens, and a second click folds it again.',
    before:
      "Only a small chevron toggled a section, and while the section was open that chevron was hidden until hover. Clicking the section name did nothing.",
    after:
      "The names of Pinned, Threads and the Shelf show a pointer cursor and toggle their section. The choice is still saved in the collapsedSections preference. Project and custom section names still rename on double-click, so a click on them does not fold the section. The chevron uses the shared DISCLOSURE_CHEVRON_TRANSITION.",
    why: "The fold control was hard to find. A large, obvious target makes collapsing discoverable.",
    files: [
      "plugins/thread-list/app/list/TopLevelSidebarSection.tsx",
      "plugins/thread-list/PLUGIN_OVERVIEW.md",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "sidebar-section-header-hierarchy",
    area: "p2-sidebar",
    title: "Sidebar section headers read as headings",
    kind: "visual",
    storyId: "sidebar--thread-list--inbox-read-status",
    beforeStoryId: "sidebar--thread-list--inbox-read-status",
    howToSee:
      'Compare the "Inbox" and "Threads" headers in sidebar/Thread list › Inbox read status on both servers.',
    before:
      'Section headers were normal-weight text in the faintest grey, so "Inbox" and "Threads" looked like dim rows.',
    after:
      "Headers are semibold in muted foreground, matching the shared section-title style, so each group stands apart from the rows under it.",
    why: "Alex said the structure was unclear. A header has to look different from the rows it groups.",
    files: ["plugins/thread-list/app/list/TopLevelSidebarSection.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "sidebar-section-header-hierarchy-before.png",
    afterShot: "sidebar-section-header-hierarchy-after.png",
  },
  {
    id: "sidebar-status-glyph-tooltip",
    area: "p2-sidebar",
    title:
      "Hovering a thread's status glyph explains it, including the subagent count",
    kind: "ux",
    storyId: "sidebar--thread-list--working-subagents",
    beforeStoryId: "sidebar--thread-list--working-subagents",
    howToSee:
      'In sidebar/Thread list › Working subagents, hover over the circled "3" or "12" at the start of a row.',
    before:
      'The circled numbers 1, 3 and 12 had no explanation. A slow native title tooltip appeared, and it said only "Working".',
    after:
      'A real tooltip opens above the glyph, for example "Working · 3 subagents running". Clicking the glyph still opens the thread, and Cmd-click or Ctrl-click still opens it in a split. The reason text is exposed as data-status-reason.',
    why: "Alex complained about glyphs that do not explain themselves.",
    files: [
      "plugins/thread-list/app/rows/ThreadRow.tsx",
      "plugins/thread-list/app/rows/ThreadRow.test.tsx",
      "plugins/thread-list/app/workflow-activity.integration.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "sidebar-status-glyph-tooltip-after.png",
  },
  {
    id: "sidebar-states-stories",
    area: "p2-sidebar",
    title: "New Ladle stories for the thread-list states",
    kind: "story",
    storyId: "sidebar--thread-list-states--collapsed-sections",
    beforeStoryId: null,
    howToSee:
      "Open sidebar/Thread list states and look at Collapsed sections, Empty and error states, Placeholder states and Project mode groups.",
    before:
      "No Ladle story showed a folded section, an empty or failed list, the placeholder states or chat groups.",
    after:
      "Four stories render these states through the real thread-list plugin and the public ThreadListPlaceholder props. The Shelf loads empty in every story except Empty and error states, which shows its error deliberately.",
    why: "The owner can review each changed state.",
    files: ["apps/app/src/components/sidebar/ThreadListStates.stories.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "composer-goal-popover-redesign",
    area: "p2-composer",
    title: "Goal popover gets a header, labelled stats and a budget bar",
    kind: "visual",
    storyId: "promptbox--banner--goal-card--overview",
    beforeStoryId: "promptbox--banner--goal-card--overview",
    howToSee:
      "Open the Goal pill at the top right of a chat that has an active goal, or look at the 'expanded' row of the Goal Card story. Light theme: /tmp/claude-501/polish2/composer/review/goal-light-after.png.",
    before:
      "The popover showed the objective text, then a row of bare icons: a lightning bolt with '27,450 / 80,000 tokens' and a clock with '20m 38s'. Clear goal was squeezed onto the end of that row. Nothing said what a goal is.",
    after:
      "The popover opens with a header: a Target badge, 'Goal', a 'Working on it' status badge and the line 'The agent keeps going until this is done or you clear it.' The objective sits in a recessed well. Below it are two labelled stats: 'Tokens used 27,450 of 80,000' with a thin budget bar, and 'Time spent 20m 38s'. Clear goal has its own footer above a hairline divider.",
    why: "The unlabelled icons did not explain themselves, the popover had no hierarchy, and the destructive action sat inside the data row. 'Working on it' is accurate because the card renders only while goal.status is 'active'.",
    files: ["apps/app/src/components/promptbox/banner/ThreadGoalCard.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "composer-goal-popover-redesign-before.png",
    afterShot: "composer-goal-popover-redesign-after.png",
  },
  {
    id: "composer-machine-resume-failure",
    area: "p2-composer",
    title: "A failed machine resume says so and shows the reason",
    kind: "ux",
    storyId: "promptbox--banner--machine-status--states",
    beforeStoryId: "promptbox--banner--machine-status--states",
    howToSee: "Look at the 'resume failed' row of the Machine Status story.",
    before:
      "After a resume failed, the banner still read 'Machine is paused' with a 'Retry' button. The error was hidden behind a chevron that appeared only on hover.",
    after:
      "The header reads 'Couldn’t resume the machine' in red with an alert icon. The reason ('Modal is temporarily unavailable…') is always visible on a second line under a hairline and is announced as an alert. The action reads 'Try again'.",
    why: "The old row looked like a normal paused state and hid why the resume had failed. The failed wording appears only when the resume mutation returned an error and the machine is not currently resuming.",
    files: [
      "apps/app/src/components/promptbox/banner/ThreadMachineStatus.tsx",
      "apps/app/src/components/promptbox/banner/ThreadMachineStatus.stories.tsx",
      "apps/app/src/components/promptbox/banner/ThreadMachineStatus.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "composer-machine-resume-failure-before.png",
    afterShot: "composer-machine-resume-failure-after.png",
  },
  {
    id: "composer-plan-mode-card",
    area: "p2-composer",
    title: "Plan mode card explains itself and has a labelled exit button",
    kind: "ux",
    storyId: "promptbox--banner--prompt-mode-card--overview",
    beforeStoryId: "promptbox--banner--prompt-mode-card--overview",
    howToSee:
      "Turn on Plan mode in a chat, or open the Prompt Mode Card story.",
    before:
      "The card said only 'Plan', with a bare X in a bordered column. Nothing explained what plan mode does or what the X did, and the expanded body was unlabelled text.",
    after:
      "The card reads 'Plan mode · Proposes a plan before changing files'. The description hides on very narrow composers. A soft 'Exit plan mode' button replaces the X and shows a spinner with 'Exiting…' while the exit is pending. A chevron is always visible to show that the card expands, and the body is labelled 'Planning for'.",
    why: "An unexplained mode label and an icon-only X are the kind of self-unexplaining UI Alex flagged.",
    files: [
      "apps/app/src/components/promptbox/banner/ThreadPromptModeCard.tsx",
      "apps/app/src/components/promptbox/banner/CollapsibleActiveStackCard.tsx",
      "apps/app/src/components/promptbox/banner/ThreadPromptModeCard.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "composer-plan-mode-card-before.png",
    afterShot: "composer-plan-mode-card-after.png",
  },
  {
    id: "composer-todo-card",
    area: "p2-composer",
    title: "To-do card shows progress and marks the current item",
    kind: "visual",
    storyId: "promptbox--banner--todo-card--overview",
    beforeStoryId: "promptbox--banner--todo-card--overview",
    howToSee:
      "Open the To-do card above the composer while an agent has to-dos, or open the Todo Card story.",
    before:
      "The header said '2/5 complete'. Rows used square checkbox icons, and the current item differed only by a slightly brighter square.",
    after:
      "The header reads 'To-dos  2 of 5 done' with a small progress meter and an always-visible chevron. Pending items show empty circles. Completed items show check circles with struck-through text. The current item has a filled ring icon, medium-weight text and an 'In progress' badge. When the owner opens the card, the rows already present stagger in; rows the system adds later do not.",
    why: "The old card gave no sense of progress and did not mark which item was being worked on.",
    files: [
      "apps/app/src/components/promptbox/banner/ThreadTodoCard.tsx",
      "apps/app/src/components/promptbox/banner/prompt-stack-header.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "composer-todo-card-before.png",
    afterShot: "composer-todo-card-after.png",
  },
  {
    id: "composer-file-attachment-chip",
    area: "p2-composer",
    title: "Attached files become proper file chips",
    kind: "visual",
    storyId: "promptbox--prompt-box-internal--overview",
    beforeStoryId: "promptbox--prompt-box-internal--overview",
    howToSee:
      "Attach a non-image file to the composer, or look at the 'with attachments' row.",
    before:
      "A file was a small muted rounded-full pill, 'diff.patch ×'. While uploading, the pill showed the name, a retry or X icon and then a spinner, in that order.",
    after:
      "Each file is a raised h-8 card with an icon tile, the file name in medium weight, the type ('PATCH') underneath and a remove button. While uploading, the tile shows a spinner and the subtitle reads 'Uploading…'. A failed upload shows a red alert tile, 'Upload failed', and labelled retry and remove buttons with hover states.",
    why: "The old pill looked unfinished next to the image thumbnails, and the upload states were hard to read.",
    files: ["apps/app/src/components/promptbox/AttachmentPreview.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "composer-file-attachment-chip-before.png",
    afterShot: "composer-file-attachment-chip-after.png",
  },
  {
    id: "composer-background-commands-card",
    area: "p2-composer",
    title: "Background work card drops the jargon prefix and explains '+N'",
    kind: "ux",
    storyId: "promptbox--banner--background-commands-card--overview",
    beforeStoryId: "promptbox--banner--background-commands-card--overview",
    howToSee:
      "Start two or more background commands, or open the Background Commands Card story at full width.",
    before:
      "The header read 'Running background command: Run the dev server' and ended in a bare '+2'. Expanded rows had icons faded to 60% and muted text. The card looked expandable only on hover.",
    after:
      "The header shows a 'Background command' (or 'Background agent') label, then the command in muted text. On the right are a '+2 more' pill and an always-visible chevron. Expanded rows use legible icons and foreground text, are slightly taller, and stagger in when the owner opens the card. The compact layout ('Running 3 background commands') is unchanged.",
    why: "The 'Running background command:' prefix and the bare '+2' were jargon and an unexplained count.",
    files: [
      "apps/app/src/components/promptbox/banner/ThreadBackgroundCommandsCard.tsx",
      "apps/app/src/components/promptbox/banner/ThreadBackgroundCommandsCard.test.tsx",
      "apps/app/src/components/promptbox/banner/prompt-stack-header.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "composer-background-commands-card-before.png",
    afterShot: "composer-background-commands-card-after.png",
  },
  {
    id: "composer-waiting-to-send-card",
    area: "p2-composer",
    title: "Waiting-to-send card has clear states and row actions",
    kind: "visual",
    storyId: "promptbox--banner--waiting-to-send--states",
    beforeStoryId: "promptbox--banner--waiting-to-send--states",
    howToSee:
      "Open the new 'promptbox/banner/Waiting To Send' story. In the app, send a message while the coordinator is unreachable.",
    before:
      "Each row had a tiny inline spinner and the words 'Waiting to send · 2 files'. A failed message showed 'Not sent · <reason>' as one truncated red line, next to an h-8 secondary 'Try again' button and a ghost 'Discard' that crowded the row.",
    after:
      "Each row has a status icon column: a spinner while waiting, or a red alert icon for a failure. Waiting rows read 'Waiting to send  Retrying automatically' with a paperclip and the file count. Failed rows read 'Not sent · <reason>' with 'Not sent' in red and the reason in muted text, wrapping to two lines on narrow composers. The actions are a soft xs 'Try again' with a retry icon and a ghost 'Discard'. Several messages are separated by hairlines.",
    why: "The old row did not say what would happen next, and its oversized buttons did not match the other composer rows. 'Retrying automatically' is true because the outbox drain retries waiting entries with backoff.",
    files: [
      "apps/app/src/components/promptbox/banner/WaitingToSendCard.tsx",
      "apps/app/src/components/promptbox/banner/WaitingToSendCard.test.tsx",
      "apps/app/src/components/promptbox/banner/WaitingToSendCard.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "composer-waiting-to-send-card-after.png",
  },
  {
    id: "composer-banner-row-actions-soft",
    area: "p2-composer",
    title: "Composer banner actions use the shared soft row button",
    kind: "visual",
    storyId: "promptbox--banner--context-banner--overview",
    beforeStoryId: "promptbox--banner--context-banner--overview",
    howToSee:
      "Compare Unarchive and Restore workspace in the Context Banner story, and Resume in the Machine Status story.",
    before:
      "Unarchive, Restore workspace and Resume were tiny outlined boxes with a 1 px border and muted text, so they read as labels.",
    after:
      "They are h-6 filled soft buttons (Button xs/soft) with foreground text, the design system's hover and press feedback, and h-9 touch targets on coarse pointers.",
    why: "Row actions must read as buttons. DESIGN.md asks for xs + soft on row actions.",
    files: [
      "apps/app/src/components/promptbox/banner/prompt-banner-actions.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "composer-banner-row-actions-soft-before.png",
    afterShot: "composer-banner-row-actions-soft-after.png",
  },
  {
    id: "composer-persistent-disclosure-chevrons",
    area: "p2-composer",
    title: "Expandable composer cards always show their chevron",
    kind: "interaction",
    storyId: "promptbox--banner--context-banner--overview",
    beforeStoryId: "promptbox--banner--context-banner--overview",
    howToSee:
      "Without hovering, look at 'Environment unavailable', 'Needs your input' and the active-child rows.",
    before:
      "The expand chevron on these cards appeared only on mouse hover and never on touch, so the cards looked like static labels.",
    after:
      "A subtle chevron is always visible. It rotates on the shared disclosure transition when the card opens and brightens on hover. The to-do, background, child-thread, environment and plan-mode cards share one helper.",
    why: "Alex named the missing collapse affordance as an issue.",
    files: [
      "apps/app/src/components/promptbox/banner/prompt-stack-header.tsx",
      "apps/app/src/components/promptbox/banner/ThreadPromptContextBanner.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "composer-persistent-disclosure-chevrons-before.png",
    afterShot: "composer-persistent-disclosure-chevrons-after.png",
  },
  {
    id: "composer-context-banner-copy",
    area: "p2-composer",
    title: "Context banner says 'Child of …' and '+3 more'",
    kind: "ux",
    storyId: "promptbox--banner--context-banner--overview",
    beforeStoryId: "promptbox--banner--context-banner--overview",
    howToSee:
      "Look at the 'child thread (alone)' and 'parent thread with active children' rows.",
    before:
      "A child chat read 'Parent Parent thread'. The active-children rows ended in a bare '+3', and the continued-in segment ended in a bare '+2'.",
    after:
      "A child chat reads 'Child of Parent thread'. Active-children rows end in a '+3 more' pill. The continued-in count is a MetaChip, '+2 more', whose tooltip and accessible name read 'Also continued in 2 other threads'.",
    why: "Repeated words and bare number chips did not explain themselves.",
    files: [
      "apps/app/src/components/promptbox/banner/ThreadPromptContextBanner.tsx",
      "apps/app/src/components/promptbox/banner/ThreadPromptContextBanner.test.tsx",
      "apps/app/src/components/promptbox/banner/ThreadPromptContextBanner.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "composer-context-banner-copy-before.png",
    afterShot: "composer-context-banner-copy-after.png",
  },
  {
    id: "composer-approval-working-folder",
    area: "p2-composer",
    title: "Command approvals label the folder the command runs in",
    kind: "ux",
    storyId: "thread--pending-interaction--approval--overview",
    beforeStoryId: "thread--pending-interaction--approval--overview",
    howToSee: "Look under the '$ git push …' block in any command approval.",
    before:
      "An unlabelled path ('/workspace/omnyo') sat under the command, and nothing said what it was.",
    after:
      "The line reads 'Runs in /workspace/omnyo' with a folder icon and a monospace path that truncates and shows the full path on hover. The value comes from the same subject.cwd that used to produce the 'Cwd:' detail line.",
    why: "An unexplained path in a permission prompt is confusing at the moment the owner decides.",
    files: [
      "apps/app/src/components/thread/pending-interactions/ThreadPendingInteractionBanner.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "composer-approval-working-folder-before.png",
    afterShot: "composer-approval-working-folder-after.png",
  },
  {
    id: "composer-folded-request-summary",
    area: "p2-composer",
    title: "Folded approval requests say what they ask for",
    kind: "ux",
    storyId: "thread--pending-interaction--approval--queued-requests",
    beforeStoryId: null,
    howToSee:
      "Open the new 'Queued Requests' story, or have an agent raise several approvals at once.",
    before:
      "Every folded request after the first read only 'Approval needed', so the folded rows looked identical.",
    after:
      "A folded row shows its request title in muted text after the label, for example 'Approval needed  Write apps/app/src/components/promptbox/banner/ContextBanner.tsx' and 'Approval needed  Creating issue'. The summary disappears when the row opens.",
    why: "Alex criticised identical repeated rows without structure in the waits list, and the folded approvals had the same problem.",
    files: [
      "apps/app/src/components/thread/pending-interactions/PendingInteractionShell.tsx",
      "apps/app/src/components/thread/pending-interactions/ThreadPendingInteractionBanner.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "composer-folded-request-summary-after.png",
  },
  {
    id: "composer-mention-menu-states",
    area: "p2-composer",
    title: "Mention and command menu states get icons and guidance",
    kind: "visual",
    storyId: "promptbox--mentions--overview",
    beforeStoryId: "promptbox--mentions--overview",
    howToSee:
      "Look at the 'command preparation' and 'command error' rows and at any section header, such as 'Skills' or 'Workspace'.",
    before:
      "'Some commands are not ready yet.' and 'Failed to load commands' were bare text rows, and the error used low-contrast red. Section headers had the same weight as the rows under them.",
    after:
      "The preparing row has a spinner and adds 'They appear here once they load.' The error row has an alert icon and uses the AA destructive text token; a long error truncates and shows its full text on hover. The hint row has a search icon. Section headers use the shared semibold section-title style.",
    why: "These states did not say what was happening, and the list lacked hierarchy.",
    files: ["apps/app/src/components/promptbox/mentions/MentionMenu.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "composer-mention-menu-states-before.png",
    afterShot: "composer-mention-menu-states-after.png",
  },
  {
    id: "composer-prompt-library-actions",
    area: "p2-composer",
    title:
      "Prompt library: real buttons, a primary Insert and a helpful empty state",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open Prompts… from the composer + menu (or press Ctrl+R) and preview a prompt. Search for nonsense to see the empty state.",
    before:
      "Insert and Star draft were flat grey boxes. Star and Back were bare text. Retry was bare text beside a low-contrast red error. 'No prompts found' was a single muted line.",
    after:
      "Insert and Star draft are filled primary xs buttons. Star/Starred and Back are ghost xs buttons. Retry is a soft xs button beside an alert icon and AA red text. The empty state is centred, with an icon, 'No prompts found' and guidance: with no query, 'Prompts you send show up here. Star one to keep it at the top.'; with a query, 'Try a different word, or switch to All to search every project' (or 'Try a shorter or different word.' when already on All).",
    why: "The preview had no obvious primary action, actions were styled as text, and the empty state was a dead end.",
    files: ["plugins/prompt-library/app.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "composer-send-later-preview",
    area: "p2-composer",
    title: "Send later dialog: a clearer schedule preview and error",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee: "Type a message, open the send menu and choose Send later…",
    before:
      "The preview was a flat grey box reading 'Sends today at 4:12 PM' above the time zone. An error was a plain low-contrast red paragraph.",
    after:
      "The preview is a bordered recessed card with a calendar icon tile, the send time in medium weight and the time zone beneath it. Errors show an alert icon and AA destructive text.",
    why: "When a message will go out should be the clearest thing in the dialog.",
    files: ["plugins/scheduled-send/app.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "composer-user-question-submit-error",
    area: "p2-composer",
    title: "A failed answer submission says the answer was not sent",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Answer an agent's question while the coordinator rejects the resolve request. The notice appears under the question form.",
    before:
      "A plain red box showed only the raw error, or 'Failed to submit answer', and was not announced to screen readers.",
    after:
      "The notice has an alert icon and starts with a medium-weight 'Your answer wasn’t sent.' followed by the reason. When there is no specific reason it reads 'Submit it again to retry.' The notice has role=alert.",
    why: "The owner needs to know that the answer did not reach the agent and what to do next.",
    files: [
      "apps/app/src/components/thread/user-questions/UserQuestionInteractionContent.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "composer-queue-toggle-tooltip",
    area: "p2-composer",
    title: "The queue count chip explains itself",
    kind: "ux",
    storyId: "promptbox--banner--queued-messages--overview",
    beforeStoryId: "promptbox--banner--queued-messages--overview",
    howToSee:
      "Hover the '3 ^' chip at the right of an expanded queued-messages card.",
    before:
      "The '3 ^' chip had no tooltip. The hidden-failure warning icon on the collapsed summary used low-contrast red.",
    after:
      "A tooltip reads '3 queued messages. Click to collapse the queue.' The warning icon uses the AA destructive text token. The toggle keeps the same DOM button, so focus stays on it across collapse and expand.",
    why: "Alex flagged unexplained chips at the ends of rows.",
    files: ["apps/app/src/components/promptbox/banner/QueuedMessagesList.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: "composer-queue-toggle-tooltip-after.png",
  },
  {
    id: "timeline-waits-structured-list",
    area: "p2-timeline",
    title:
      "A chat's waits become a structured card list with kind, timing and plain wording",
    kind: "ux",
    storyId: "thread--waits-list--overview",
    beforeStoryId: "thread--waits-list--overview",
    howToSee:
      "Open the Ladle story thread/Waits list in dark or light theme. In the app, open a chat that has open waits; the list sits above the composer.",
    before:
      'The waits list was plain text lines such as "Waiting for <chat> · <title>" and "Loop: Run omnyo chief distill…  Cancel wait", with a separate "Next check <long locale date>" line. The same text was repeated in the headline, the chat line and the action line, and nothing said what kind of wait each line was.',
    after:
      'Below a section header with an icon is a bordered card with one row per wait, each listed once. Each row shows what it waits for and a kind badge: Another chat, Scheduled check, Event ("Watching for …"), On you, Timer, Send later or Several conditions, or "Checking now" while the wait is being checked. A second line names the linked chat. A muted timing line follows, such as "Checks again in 20 min · Checked 3 times" or "Deadline tomorrow", with the full date on hover. A wait only the owner can resolve gets an amber dot and an "On you" badge. The "Waiting: X" headline is hidden when a row already says X, and at narrow widths the timing line wraps instead of being cut off.',
    why: 'Alex called the waits list unreadable, with repeated text and no explanation of what each wait is. Every label comes from the domain model: the kind from InboxWaitView.kind, "Checks again" from nextCheckAt, the deadline from wait.deadline (at the deadline the server closes the wait with a receipt, which puts the chat back in the inbox), the header time from entry.waiting.returnAt (the earliest time the chat is guaranteed to return), and "On you" from report waits, which only the owner\'s "It happened" resolves.',
    files: [
      "apps/app/src/components/thread/ThreadInboxReason.tsx",
      "apps/app/src/components/thread/ThreadInboxReason.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "timeline-waits-structured-list-after.png",
  },
  {
    id: "timeline-waits-row-actions",
    area: "p2-timeline",
    title:
      "Cancel wait and It happened become real small buttons with pending and error states",
    kind: "interaction",
    storyId: "thread--waits-list--overview",
    beforeStoryId: "thread--waits-list--overview",
    howToSee:
      'In the Waits list story, look at the right edge of each row. In the live app, clicking an action shows "Cancelling…" or "Saving…" on that one button.',
    before:
      '"Cancel wait" was a ghost button that read as bare text after the wait text, and "It happened" was a grey secondary button. A failure printed "Could not update this wait." inline in red.',
    after:
      'Each row ends with a right-aligned soft xs "Cancel" button. A report wait gets a soft "It happened" button with a ghost "Cancel" beside it. While a request runs, only the clicked button changes to "Cancelling…" or "Saving…". A failure shows under that wait with an alert glyph. The accessible names stay "Cancel wait: <what>" and "It happened: <what>".',
    why: "The brief says row actions use size xs with the soft variant and never look like bare text.",
    files: ["apps/app/src/components/thread/ThreadInboxReason.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "timeline-waits-row-actions-after.png",
  },
  {
    id: "timeline-waits-story",
    area: "p2-timeline",
    title: "New Ladle story for the waits list",
    kind: "story",
    storyId: "thread--waits-list--overview",
    beforeStoryId: "thread--waits-list--overview",
    howToSee: "Ladle: thread/Waits list → Overview.",
    before:
      "No story rendered ThreadInboxReason, so the waits list could only be reviewed in a live chat.",
    after:
      "The story shows four scenarios through the real component, using a QueryClient seeded with an inbox snapshot and a wait list. They are: waiting on several things (a chat, a recurring check and an On-you report), needs you while a wait is being checked, waiting on another chat with a deadline, and other chats waiting on this one. The story passes only the existing public props (threadId, parentThreadId), so a copy in the BEFORE checkout renders the old component with the same data.",
    why: "Alex can compare before and after, and the surface gets a regression view.",
    files: ["apps/app/src/components/thread/ThreadInboxReason.stories.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "timeline-waits-story-after.png",
  },
  {
    id: "timeline-workflow-header-phase-strip",
    area: "p2-timeline",
    title:
      "Workflow rows show phase progress in the row header, even when collapsed",
    kind: "visual",
    storyId: "thread--timeline--rows--workflow--overview",
    beforeStoryId: "thread--timeline--rows--workflow--overview",
    howToSee:
      'Story thread/timeline/rows/Workflow: look to the right of the title "Running workflow: fixture-mini (1/3 agents)" in the running, completed and failed rows.',
    before:
      'The only sign of progress on a collapsed workflow row was "(1/3 agents)" in the title sentence.',
    after:
      'For workflows with two or more phases, a 64 px shared WorkflowPhaseStrip follows the title. It has one meter per phase that fills as agents settle, turns green when the phase completes and turns red when the phase has a failure. The strip has role=img and a label such as "Phase 1 of 2: Scan. 0 of 2 phases complete". When the row already shows a result tag (for example "interrupted"), the tag is shown instead of the strip. The expanded body uses the redesigned shared WorkflowProgress, which now receives the run\'s terminal state.',
    why: "The brief asks the workflow timeline row to use the redesigned shared progress primitive, and progress now reads at a glance without expanding the row.",
    files: [
      "apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx",
      "apps/app/src/components/thread/timeline/WorkflowWorkRowBody.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "timeline-workflow-header-phase-strip-before.png",
    afterShot: "timeline-workflow-header-phase-strip-after.png",
  },
  {
    id: "timeline-workflow-single-error",
    area: "p2-timeline",
    title: "A failed workflow states its error once",
    kind: "fix",
    storyId: "thread--timeline--rows--workflow--overview",
    beforeStoryId: "thread--timeline--rows--workflow--overview",
    howToSee: 'Workflow story, "failed" row.',
    before:
      '"agent abandoned: user requested retry on all 3 attempts" appeared under the failed agent and again in a red line at the bottom of the card. The title also ended with a red "failed" after "Failed workflow: …".',
    after:
      'The error shows once, under the agent that failed. The bottom line appears only when the workflow error differs from every agent\'s error. The redundant trailing "failed" is dropped because the title\'s leading verb already says "Failed" and the row glyph is red. Stopped and killed runs pass their terminal state to WorkflowProgress, so phase states settle correctly.',
    why: "Repeated text is the kind of noise Alex flagged in the workflow card.",
    files: [
      "apps/app/src/components/thread/timeline/WorkflowWorkRowBody.tsx",
      "apps/app/src/components/thread/timeline/WorkflowWorkRowBody.test.tsx",
      "apps/app/src/components/thread/timeline/timeline-work-result.ts",
      "apps/app/src/components/thread/timeline/timeline-work-result.test.ts",
      "apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "timeline-workflow-single-error-before.png",
    afterShot: "timeline-workflow-single-error-after.png",
  },
  {
    id: "timeline-workflow-degraded-error",
    area: "p2-timeline",
    title: "A workflow that failed without progress data shows an alert line",
    kind: "state",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "This appears only on a workflow row that ended with an error and no summary, where an older CLI sent no progress data.",
    before:
      "The error printed as plain muted text, styled the same as a success summary.",
    after:
      "The error shows in destructive text with an alert icon, and long messages wrap.",
    why: "A failure should not look like a success summary.",
    files: ["apps/app/src/components/thread/timeline/WorkflowWorkRowBody.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "timeline-system-error-glyph",
    area: "p2-timeline",
    title:
      'Provider and system error rows get a red alert icon instead of a trailing "error" word',
    kind: "visual",
    storyId: "thread--timeline--rows--system--errors",
    beforeStoryId: "thread--timeline--rows--system--errors",
    howToSee: "Story thread/timeline/rows/System → Errors.",
    before:
      'Error rows such as "Provider error error", "API Error: Overloaded error", "You\'ve hit your limit … error" and "Command thread.start failed error" had no leading glyph and started flush left. They looked like ordinary system notes except for a small red mono "error" word.',
    after:
      'Every error row (systemKind=error), expandable or static, starts with a red AlertCircle icon aligned like the other timeline glyphs. The trailing "error" word is gone from all of them, so the icon is the one consistent error signal.',
    why: "Failures should stand out and explain themselves at a glance without repeated words.",
    files: [
      "apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx",
      "apps/app/src/components/thread/timeline/TimelineRowHeader.tsx",
      "apps/app/src/components/thread/timeline/ExpandableTimelineRow.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "timeline-system-error-glyph-before.png",
    afterShot: "timeline-system-error-glyph-after.png",
  },
  {
    id: "timeline-error-detail-readable",
    area: "p2-timeline",
    title: "Error and system detail text is readable",
    kind: "fix",
    storyId: "thread--timeline--rows--system--errors",
    beforeStoryId: "thread--timeline--rows--system--errors",
    howToSee:
      "Expand any provider or system error row, for example the stderr stack trace in the thread.start row.",
    before:
      "The detail block used text-subtle-foreground at 70% opacity with tight leading, so error messages and stack traces were faint grey and fell below AA contrast.",
    after:
      "Detail text uses text-muted-foreground at full strength with leading-5, so the stack trace and error text are clearly legible inside the same card.",
    why: "DESIGN.md forbids opacity-reduced text because it fails AA, and an error message is exactly the text the owner must read.",
    files: ["apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "timeline-error-detail-readable-before.png",
    afterShot: "timeline-error-detail-readable-after.png",
  },
  {
    id: "timeline-child-outcome-glyph-tone",
    area: "p2-timeline",
    title:
      "Child chat failures and attention requests are tinted in the timeline",
    kind: "visual",
    storyId: "thread--timeline--generated-conversation-message--overview",
    beforeStoryId: "thread--timeline--generated-conversation-message--overview",
    howToSee:
      "Story thread/timeline/Generated conversation message → Overview: the child-failed and child-needs-attention rows.",
    before:
      '"Codex worker failed" (CircleX) and "… needs attention" (AlertTriangle) used the same grey glyph as "finished" or "assigned".',
    after:
      "The failed glyph is destructive red and the needs-attention glyph is warning amber. Other system messages stay neutral.",
    why: "Outcome rows should show at a glance which child needs action.",
    files: [
      "apps/app/src/components/thread/timeline/GeneratedConversationMessage.tsx",
      "apps/app/src/components/thread/timeline/TimelineRowHeader.tsx",
      "apps/app/src/components/thread/timeline/ExpandableTimelineRow.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "timeline-child-outcome-glyph-tone-before.png",
    afterShot: "timeline-child-outcome-glyph-tone-after.png",
  },
  {
    id: "timeline-terminal-states",
    area: "p2-timeline",
    title:
      "Terminal starting, ended, empty and error states become proper empty states",
    kind: "state",
    storyId: "terminal--content--overview",
    beforeStoryId: "terminal--content--overview",
    howToSee:
      "Story terminal/Content → Overview: the starting, exited and empty panels.",
    before:
      'Each state was a bare centred line, "Terminal starting" or "Terminal exited", on an empty black panel. "No terminals" was plain text, and "Failed to load terminals." was plain red text.',
    after:
      'Each state is an EmptyStateBlock with a terminal icon in a soft circle, a title and an explanation, on the same surface colour as a running terminal. The panels read "Starting terminal…" ("Connecting to the shell on this chat’s machine.") and "This terminal has ended" ("The shell finished and no longer accepts input.", or "The shell exited with code N…" for a non-zero exit code). The empty panel shows "No terminals" with the icon, and the error state reads "Couldn’t load terminals" in error tone with role=alert.',
    why: "These panels said what happened but not why or what it means, and Alex listed unpolished empty and error pages as a recurring problem.",
    files: [
      "apps/app/src/components/thread/terminal/ThreadTerminalContent.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "timeline-terminal-states-before.png",
    afterShot: "timeline-terminal-states-after.png",
  },
  {
    id: "timeline-side-chat-quote",
    area: "p2-timeline",
    title:
      'Side chat "Replying to" quote becomes a card with a real expand button',
    kind: "interaction",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Use Reply in side chat on a long assistant message. The side-chat panel opens with the quote at the top.",
    before:
      'A small "Replying to" label sat over a grey box. The whole box was a click target (role=button) whose only hint was a hover title, "Show full message", so keyboard users could not reach it and nothing on screen said it could expand.',
    after:
      'The quote is a bordered recessed card. It has a "Replying to" caption with an arrow icon, the quoted text as a blockquote with a left rule, and, when the quote is clipped, a ghost xs "Show full message" / "Show less" button with a chevron, aria-expanded and aria-controls.',
    why: "This removes a hidden, mouse-only affordance and gives the quote a clear structure.",
    files: ["plugins/side-chat/app.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "timeline-side-chat-missing-ref",
    area: "p2-timeline",
    title: "Broken side chat tab shows an explained error state",
    kind: "state",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "This appears only when a side chat panel opens with malformed params.",
    before:
      'Small muted text in the top-left corner read "This side chat tab is missing its thread reference."',
    after:
      'A centred EmptyStateBlock in error tone reads "This side chat can’t open". Below it are the original sentence and what to do next: close the tab and start the side chat again from the message. The block keeps role=alert.',
    why: "Error pages should say what happened and what to do next.",
    files: ["plugins/side-chat/app.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "timeline-inline-vis-alerts",
    area: "p2-timeline",
    title: "Inline visualisation errors use the shared Alert with a title",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Reply with an inline-vis directive that names a missing file, has no file attribute or uses an invalid height.",
    before:
      'A load failure showed "Failed to load demo.html: <message>" in a red-tinted box using text-destructive, which has low contrast in dark mode. Authoring mistakes appeared in a flat grey box.',
    after:
      'A load failure uses Alert variant destructive with an icon, the title "Couldn’t show demo.html" and the message below it. A missing file attribute or an invalid height uses Alert variant warning, titled "This preview has no file to show" or "This preview’s height can’t be used", with the example directive in a code chip. role=alert and the original explanatory text are kept.',
    why: "Errors get structure (what failed, then why) and readable contrast.",
    files: ["plugins/inline-vis/app.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "timeline-workspace-changes-contrast",
    area: "p2-timeline",
    title: "Changed-files list text no longer dimmed below AA",
    kind: "fix",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Any surface that uses WorkspaceChangesList, such as a chat's workspace changes list.",
    before:
      "The status column and the file path were both at 70% opacity, so muted text fell below AA.",
    after:
      "The status uses text-subtle-foreground and the path uses FilePathLink's normal colour, both at full strength.",
    why: "DESIGN.md says secondary text must use the muted or subtle tokens at full strength.",
    files: ["apps/app/src/components/thread/WorkspaceChangesList.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "timeline-status-decoration-contrast",
    area: "p2-timeline",
    title: "Status words in row titles drop their extra opacity",
    kind: "fix",
    storyId: "thread--timeline--rows--command--overview",
    beforeStoryId: "thread--timeline--rows--command--overview",
    howToSee:
      "A non-ledger row with a status decoration, for example a denied or interrupted row.",
    before: "The status word rendered in its token colour at 75% opacity.",
    after: "The status word renders at full token strength.",
    why: "The same AA rule applies as in the changed-files list.",
    files: ["apps/app/src/components/thread/timeline/TimelineTitleView.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: "timeline-status-decoration-contrast-after.png",
  },
  {
    id: "panel-browser-error-page",
    area: "p2-panel",
    title: "Browser load errors explain what happened and what to do",
    kind: "ux",
    storyId: "right-panel--browser-tab-states--page-errors",
    beforeStoryId: null,
    howToSee:
      "Open a browser tab on a localhost port where no server is running. The Ladle story 'right-panel/Browser tab states / Page errors' shows six kinds of error.",
    before:
      "Every failure showed the same grey globe in a square, a generic title ('Server not reachable' or 'Page unavailable') and a one-line hint. A small outlined 'Reload' sat next to a muted, text-like 'Open externally', and the raw error code was a dim line of mono text.",
    after:
      "Each failure has its own icon in a red-tinted circle, a plain-language title and a next step. For a localhost address, a refused connection reads 'Nothing is running on localhost:5173'. Other local failures read 'Can’t reach localhost:5173', and both say to start the server or change the port. Other examples: 'Can’t find docs.exmaple.com', 'You’re offline', 'This connection isn’t private', '<host> took too long to answer' and 'This page stopped working'. 'Try again' is the filled primary button and 'Open in your browser' is a ghost button. The technical code sits below them in a labelled 'Error' chip. The page is announced as an alert. Spacing is tighter, so the chip stays visible in short panels.",
    why: "Alex singled out this page. The old copy said neither what failed nor what to do, and the two actions had no visual hierarchy.",
    files: [
      "apps/app/src/components/secondary-panel/BrowserStatePage.tsx",
      "apps/app/src/components/secondary-panel/BrowserTabContent.tsx",
      "apps/app/src/components/secondary-panel/BrowserTabDeck.browser-view-ordering.test.tsx",
      "apps/app/src/components/secondary-panel/BrowserTabStates.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "panel-browser-error-page-before.png",
    afterShot: "panel-browser-error-page-after.png",
  },
  {
    id: "panel-browser-start-page",
    area: "p2-panel",
    title: "A new browser tab is no longer a blank page",
    kind: "ux",
    storyId: "right-panel--browser-tab-states--start-page",
    beforeStoryId: "right-panel--browser-tab--overview",
    howToSee: "Open a new browser tab in a chat that has no browsing history.",
    before:
      "Below the address bar the whole panel was empty, with no hint about what to do.",
    after:
      "A centred start page shows a globe and the title 'Open a web page'. One line explains that you can type an address or a search in the bar above, and that local servers such as localhost:5173 open here too. An outlined 'Enter an address' button focuses the address bar. When the chat has browsing history, the 'Recently visited' list appears instead, as before.",
    why: "An empty panel looked broken and offered no next step.",
    files: [
      "apps/app/src/components/secondary-panel/BrowserNewTabScreen.tsx",
      "apps/app/src/components/secondary-panel/BrowserTabContent.tsx",
      "apps/app/src/components/secondary-panel/BrowserStatePage.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "panel-browser-start-page-before.png",
    afterShot: "panel-browser-start-page-after.png",
  },
  {
    id: "panel-browser-agent-banner",
    area: "p2-panel",
    title:
      "The 'agent is controlling this tab' bar explains itself and has real buttons",
    kind: "ux",
    storyId: "right-panel--browser-tab-states--agent-control",
    beforeStoryId: null,
    howToSee:
      "Let a browser-automation agent take control of a browser tab, then hover the two buttons.",
    before:
      "One line of plain text, '<agent> is controlling this tab', followed by two bare-text actions, 'Stop' and 'Take over', which did not look clickable.",
    after:
      "The bar shows a bot icon in a circle and a bold '<agent> is using this tab', with the explanation 'Clicks and typing here could interrupt it'. It ends with a ghost 'End control' button and a soft 'Take over' button. Each button has a tooltip: 'Take this tab away from <agent>. The agent keeps running.' and 'Take this tab away from <agent> and start using it.' What each button does is unchanged.",
    why: "The actions were styled as text, and the bare word 'Stop' was ambiguous. Both buttons only revoke the agent's lease on the tab (desktop broker takeOver), and the agent keeps running, so the label now says that.",
    files: [
      "apps/app/src/components/secondary-panel/BrowserTabContent.tsx",
      "apps/app/src/components/secondary-panel/BrowserTabContent.chrome.test.tsx",
      "apps/app/src/components/secondary-panel/BrowserTabStates.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "panel-browser-agent-banner-after.png",
  },
  {
    id: "panel-browser-elsewhere-states",
    area: "p2-panel",
    title:
      "The other browser tab states share one page layout with meaningful icons",
    kind: "visual",
    storyId: "right-panel--browser-tab-states--open-elsewhere",
    beforeStoryId: null,
    howToSee:
      "Open a browser tab that belongs to another computer or window. The web app's 'Desktop required' state is in the story 'Browser tab states / Desktop required'.",
    before:
      "Every state showed the same globe in a bordered square, a small title and the URL as muted mono text. 'Try again' was outlined like the secondary actions.",
    after:
      "Each state uses the error page's layout with its own icon: a laptop for 'needs the desktop app', a window for another window, a computer for another computer, a reload arrow for reconnecting and a red cloud-off for unreachable. The URL sits in a recessed mono chip. When 'Try again' is offered, it is the filled primary button.",
    why: "The state pages are now consistent, and the icons hint at the cause.",
    files: [
      "apps/app/src/components/secondary-panel/BrowserTabDeck.tsx",
      "apps/app/src/components/secondary-panel/BrowserTabContent.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "panel-browser-elsewhere-states-after.png",
  },
  {
    id: "panel-file-preview-states",
    area: "p2-panel",
    title: "Empty, missing and failed file previews are proper state pages",
    kind: "ux",
    storyId: "right-panel--file-preview--overview",
    beforeStoryId: "right-panel--file-preview--overview",
    howToSee:
      "Open an empty file, or a file link whose file has since been deleted. The 'empty file', 'file not found' and 'failed to load' rows of the File preview story show each state.",
    before:
      "A dashed grey box with one line of text: 'Empty file.', 'File not found.' or 'Failed to load file'. A failed HTML preview said 'Failed to load HTML preview.'",
    after:
      "Each state is centred, with an icon in a circle, a title and a plain explanation. 'This file is empty' adds 'It exists but has no content yet'. 'File not found' adds 'It may have been moved, renamed or deleted since it was linked'. 'Couldn’t open this file' shows the server's reason in the red tone. A failed HTML preview says 'Couldn’t show the HTML preview' and suggests switching to Raw.",
    why: "The dashed boxes looked like leftover placeholders and explained nothing.",
    files: [
      "apps/app/src/components/secondary-panel/FilePreview.tsx",
      "apps/app/src/components/secondary-panel/FilePreview.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "panel-file-preview-states-before.png",
    afterShot: "panel-file-preview-states-after.png",
  },
  {
    id: "panel-file-preview-segmented",
    area: "p2-panel",
    title:
      "Preview / Raw is the shared sliding segmented control, with a visible selection",
    kind: "interaction",
    storyId: "right-panel--file-preview--overview",
    beforeStoryId: "right-panel--file-preview--overview",
    howToSee:
      "Open a Markdown, CSV or HTML file and switch between Preview and Raw, with the mouse or the arrow keys. Check both themes.",
    before:
      "A small bordered pair of 20 px text buttons with a local indicator.",
    after:
      "The shared SegmentedControl: a 28 px recessed track with an eye icon on 'Preview' and a code icon on 'Raw'. One raised thumb slides on the smooth spring, and the arrow, Home and End keys move between the options. It is announced as a radio group. The track is recessed so that the selected thumb stands out in dark mode as well as light.",
    why: "It matches the design-system owner and improves the target size and keyboard support.",
    files: [
      "apps/app/src/components/secondary-panel/FilePreview.tsx",
      "apps/app/src/components/secondary-panel/FilePreview.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "panel-file-preview-segmented-before.png",
    afterShot: "panel-file-preview-segmented-after.png",
  },
  {
    id: "panel-file-preview-deleted-badge",
    area: "p2-panel",
    title: "A deleted file is marked with a red 'Deleted' badge",
    kind: "visual",
    storyId: "right-panel--file-preview--overview",
    beforeStoryId: "right-panel--file-preview--overview",
    howToSee:
      "Open a deleted file from the diff (the 'deleted file' row of the File preview story).",
    before: "Muted text '(deleted)' after the path.",
    after: "A small red-tinted 'Deleted' status badge after the path.",
    why: "The state is now visible at a glance.",
    files: ["apps/app/src/components/secondary-panel/FilePreview.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "panel-file-preview-deleted-badge-before.png",
    afterShot: "panel-file-preview-deleted-badge-after.png",
  },
  {
    id: "panel-file-preview-unsupported",
    area: "p2-panel",
    title: "Files that can't be previewed get a proper download card",
    kind: "visual",
    storyId: "right-panel--file-preview--overview",
    beforeStoryId: "right-panel--file-preview--overview",
    howToSee:
      "Open a .zip or another binary file (the 'preview not available' row of the File preview story).",
    before:
      "A small grey file icon, the name, 'mime · size', 'This file type can't be previewed.' and an outlined Download button.",
    after:
      "A raised file tile with a neutral extension tag (for example ZIP) on its corner, the name in larger semibold type, 'size · mime', a sentence saying what to do ('Download it to open it with another app') and Download as the one filled primary button.",
    why: "The card has a clearer hierarchy and one obvious primary action.",
    files: [
      "apps/app/src/components/secondary-panel/FilePreview.tsx",
      "apps/app/src/components/secondary-panel/FilePreview.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "panel-file-preview-unsupported-before.png",
    afterShot: "panel-file-preview-unsupported-after.png",
  },
  {
    id: "panel-diff-file-notices",
    area: "p2-panel",
    title: "Notices inside diff cards are structured rows with real buttons",
    kind: "ux",
    storyId: "right-panel--diff-file-card--overview",
    beforeStoryId: "right-panel--diff-file-card--overview",
    howToSee:
      "Open the Diff tab with a large, binary, too-large, truncated or failed file. The Diff file card story shows each case.",
    before:
      "A single line of grey text followed by an underlined text link. Examples: '960 changed lines. Load diff', 'Too large to display (30,000 changed lines). Open file', a red 'Request timed out after 10s' followed by 'Retry', and 'This diff was truncated for display. Show full diff', where the link actually opened the file and not a full diff.",
    after:
      "Each notice is an icon in a circle, a bold title and a muted explanation, with a soft xs button on the right. '960 changed lines' says large diffs load when you ask and offers 'Load diff'. 'Too large to show here' offers 'Open file'. A red 'Couldn’t load this file’s diff' offers 'Retry'. 'The rest of this diff is hidden' offers 'Open file', which replaces the misleading 'Show full diff'. 'No line changes' offers 'Open file'. A loaded binary diff now reads 'Binary file changed' and no longer says that only the name or mode changed.",
    why: "The actions were text links, the error mixed red text with a link, and 'Show full diff' promised something the link does not do.",
    files: [
      "apps/app/src/components/secondary-panel/git-diff/DiffFileCard.tsx",
      "apps/app/src/components/secondary-panel/git-diff/DiffFileCard.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "panel-diff-file-notices-before.png",
    afterShot: "panel-diff-file-notices-after.png",
  },
  {
    id: "panel-diff-tab-states",
    area: "p2-panel",
    title:
      "Empty, failed and unavailable Diff tab states say what is empty and why, and errors can be retried",
    kind: "ux",
    storyId: "right-panel--diff-tab-states--overview",
    beforeStoryId: "right-panel--diff-tab-states--overview",
    howToSee:
      "Open the Diff tab in a clean workspace, a non-Git folder or a removed worktree. Compare the new story 'right-panel/Diff tab states' on both servers; BEFORE shows the old boxes once the parent copies the story file.",
    before:
      "A dashed box saying 'No diff to display.', a small bordered card for 'Workspace unavailable', the raw server text for non-Git folders, and a red box with only the error message and no way to retry.",
    after:
      "Centred state pages with an icon and a title that names the comparison: 'No uncommitted changes', 'No committed changes on this branch', 'No changes compared with main' or 'This commit changes no files'. Each adds a sentence saying what will appear there; while no comparison is chosen yet, the page reads 'No changes to show'. A failure reads 'Couldn’t load the changes' (red tone, announced as an alert), shows the reason and offers a primary 'Try again' that refetches the file list. Non-Git folders read 'No Git changes to show'. An unavailable workspace keeps its message under a folder icon. The note about showing only the first N changed files is now an info Alert. When a filter matches nothing, the page names the filter and says how many files do have changes.",
    why: "'No diff to display.' did not say what was compared, the error left no way forward, and the error and unavailable boxes looked unfinished.",
    files: [
      "apps/app/src/components/secondary-panel/ThreadSecondaryPanelTabContent.tsx",
      "apps/app/src/components/secondary-panel/git-diff/DiffFilesPanel.tsx",
      "apps/app/src/components/secondary-panel/GitDiffTabStates.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "panel-diff-tab-states-after.png",
  },
  {
    id: "panel-shell-fallback-states",
    area: "p2-panel",
    title:
      "The panel's fallback and Git-check failure states use the shared empty-state layout",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open the Diff tab while the workspace's Git check fails, or select a panel view that cannot render.",
    before:
      "Dashed boxes: 'Could not determine whether this workspace uses Git.' with an outlined Retry, 'This panel view is unavailable.' and 'No file preview content provided.'",
    after:
      "Centred pages with an icon. 'Couldn’t check this workspace for Git' uses the red tone, explains the consequence and makes Retry the filled primary button. 'This panel view is unavailable' adds 'Pick another tab above', and the missing-content case reads 'Nothing to preview'.",
    why: "These now match every other state page in the panel, and the copy is plain.",
    files: [
      "apps/app/src/components/secondary-panel/ThreadSecondaryPanel.tsx",
      "apps/app/src/components/secondary-panel/ThreadSecondaryPanel.collapseControl.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "panel-storage-tree",
    area: "p2-panel",
    title:
      "Thread storage folders look like folders, and errors no longer show a '0' count",
    kind: "visual",
    storyId: "right-panel--thread-storage--overview",
    beforeStoryId: "right-panel--thread-storage--overview",
    howToSee:
      "Open the chat's Info tab, look at Thread storage and expand a folder. The 'error' row of the story shows the failure.",
    before:
      "Folder names were dim grey, so they looked disabled, and had no folder icon. When the file list failed, the header still showed a '0' count and the only message was a red line. A search with no results said 'No files match search.'",
    after:
      "Folders show a folder icon that switches to an open folder when expanded, and their names are readable foreground text. On failure the count is hidden and a red-tinted notice says 'Couldn’t list this chat’s files', with the reason below. A search with no results names the query and shows a search icon.",
    why: "Dim folders read as disabled, and a '0' next to an error was misleading.",
    files: [
      "apps/app/src/components/secondary-panel/info/ThreadStorageSection.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "panel-storage-tree-before.png",
    afterShot: "panel-storage-tree-after.png",
  },
  {
    id: "panel-git-popover-explained",
    area: "p2-panel",
    title:
      "The Git popover explains its arrows, status letters and pull request state",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Click the branch pill in a chat's header on a branch that has changes and is ahead of or behind its base.",
    before:
      "The popover header showed bare '↑2 ↓1' arrows. Each file row started with an unexplained coloured letter (M, A, D). The PR status was a line of tiny coloured text, and 'N more files' was bare text. 'Working tree clean' was a single grey line, and 'Review all changes' was muted.",
    after:
      "The ahead and behind counts are MetaChips with arrow icons. Their tooltips and accessible names say, for example, '2 commits on this branch that main doesn’t have yet', and 'behind' uses the attention tone. Status letters sit in small tinted squares, and hovering a row shows 'Modified · path'. The pull request card is raised, with the PR icon in a circle and the status as a dotted pill. 'N more files' is a ghost xs button with an arrow. The clean state is a green check badge with 'Working tree clean' and 'Up to date with main' on two lines. 'Review all changes' has a diff icon and full-strength text.",
    why: "These were unexplained glyphs and bare-text actions, the problems Alex called out elsewhere in the app.",
    files: [
      "plugins/git/GitHeaderControl.tsx",
      "plugins/git/ChangeGroup.tsx",
      "plugins/git/FileRow.tsx",
      "plugins/git/PullRequestCard.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "panel-github-empty-states",
    area: "p2-panel",
    title:
      "GitHub plugin empty and error states have titles, icons and plain copy",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open the GitHub page with no tracked repos, without the gh CLI signed in, or with a filter that matches nothing.",
    before:
      "One centred grey sentence, the same for errors and for empty lists. Example: 'GitHub CLI is not available or not authenticated… ()', with empty brackets when there was no detail.",
    after:
      "State pages with an icon and a title: 'Couldn’t load from GitHub' (red), 'Can’t reach GitHub' (red cloud-off), 'Set up the GitHub CLI', 'No GitHub repos tracked yet', 'No pull requests match this filter' and 'No pull requests to show'. Each has a short explanation, and the gh error detail appears only when there is one.",
    why: "Errors looked exactly like empty lists.",
    files: [
      "plugins/github/components/empty-state.tsx",
      "plugins/github/app.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "panel-pdf-error",
    area: "p2-panel",
    title:
      "A PDF that fails to load shows a proper error page with a primary Try again",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee: "Open a PDF whose file is missing or unreadable.",
    before:
      "Red text 'Failed to load PDF: <message>' above a plain outlined 'Retry' button.",
    after:
      "A red-tinted document icon in a circle, the title 'Couldn’t open this PDF', the reason in muted text and a filled primary 'Try again' button with a reload icon.",
    why: "It matches the other error states and has one clear action.",
    files: ["plugins/pdf-preview/app.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "panel-browser-recent-clear",
    area: "p2-panel",
    title: "'Clear' in Recently visited is a real ghost button",
    kind: "visual",
    storyId: "right-panel--browser-tab--overview",
    beforeStoryId: "right-panel--browser-tab--overview",
    howToSee:
      "Open a new browser tab in a chat that has browsing history, then hover or tab to 'Clear'.",
    before: "'Clear' was bare text at the end of the section header.",
    after:
      "'Clear' is an xs ghost button with a hover fill and a keyboard focus ring.",
    why: "No action should be styled as bare text.",
    files: ["apps/app/src/components/secondary-panel/BrowserNewTabScreen.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: "panel-browser-recent-clear-before.png",
    afterShot: null,
  },
  {
    id: "settings-notification-center-redesign",
    area: "p2-settings",
    title:
      "Notification center: toned icon badges, inline time, real buttons, a count and a friendly empty state",
    kind: "visual",
    storyId: "notifications--notification-center--with-notifications",
    beforeStoryId: null,
    howToSee:
      "Open the notifications list (bell, or the notifications.open command). The With notifications story opens it with five notifications; the Empty story shows the empty state (/tmp/claude-501/polish2/settings/rv/notif-empty-after.png). Light theme: /tmp/claude-501/polish2/settings/rv/notif2-light-after.png.",
    before:
      "Every row used the same plain glyph whatever its tone. The timestamp sat on its own third line. Row actions such as Undo and Open chat were bare text, the header icons were hand-rolled buttons, the header showed no count, and an empty list said only 'No notifications yet.' in small grey text.",
    after:
      "Each row starts with a 28 px round badge tinted by tone: green for success, amber for warning, red for error and neutral for info. The relative time sits right-aligned on the title line, and row actions are soft xs Buttons under the text. Header actions are ghost icon Buttons, and the header shows a count chip. An empty list shows an EmptyStateBlock with a bell, 'You’re all caught up' and a line saying that closing the list clears what you have seen, which matches the store: closing the center empties the list.",
    why: "Rows were hard to scan by severity, and the actions looked like stray text.",
    files: [
      "apps/app/src/components/notifications/NotificationCenter.tsx",
      "apps/app/src/components/notifications/NotificationCenter.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "settings-notification-center-redesign-after.png",
  },
  {
    id: "settings-notification-row-hover-actions",
    area: "p2-settings",
    title:
      "Notification rows: copy and dismiss replace the time on hover instead of reserving an empty column",
    kind: "interaction",
    storyId: "notifications--notification-center--with-notifications",
    beforeStoryId: null,
    howToSee:
      "Open the notifications list and hover a row, or Tab into it. On touch devices both the time and the buttons stay visible.",
    before:
      "Every row kept an invisible 56 px column on the right for the copy and dismiss buttons, so the timestamps stopped well short of the edge and each row had an odd empty gutter.",
    after:
      "The time sits flush with the right edge. When you hover a row or keyboard focus reaches it, the time fades out and the copy and dismiss buttons fade in at that position. On devices without hover, the buttons sit in normal flow next to the time.",
    why: "The empty gutter read as broken padding, which Alex flagged elsewhere in the app.",
    files: ["apps/app/src/components/notifications/NotificationCenter.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "settings-notification-row-hover-actions-before.png",
    afterShot: "settings-notification-row-hover-actions-after.png",
  },
  {
    id: "settings-memory-list-redesign",
    area: "p2-settings",
    title:
      "Memory settings: card rows with labelled chips, a pin icon, inline delete confirmation and a real Select",
    kind: "ux",
    storyId: "plugins--memory--settings",
    beforeStoryId: null,
    howToSee:
      "Settings → Memory with the Memory plugin installed. The plugins/memory/app.stories.tsx story appears in Ladle once the config glob in sharedRequests is added.",
    before:
      "Memories sat in a table with a grey header row. Pinned memories had a 📌 emoji, and kind, importance and date were loose grey words. Edit and Delete were stacked ghost buttons, delete opened a native window.confirm() popup, and the editor used a native <select> for Kind. The provider notice was a plain grey box, and an empty list was a dashed box saying 'No memories stored yet.'",
    after:
      "Each memory is a card with a pin icon and its name, a two-line summary, and chips for kind (Preference, Procedure and so on), scope with a globe or folder icon, 'Importance 60' and #tags, with 'Updated …' on the right. Hovering the importance chip explains that agents see higher-importance memories first and that pinned ones always come first, which matches the server's sort order. Edit is a soft xs button and delete is a ghost trash icon. Delete asks inline ('Delete? Delete memory / Keep') instead of opening a browser dialog. The editor opens inside the card and uses the shared Select. The notice is an info Alert, errors use a destructive Alert, loading shows skeleton cards, and the empty state is an EmptyStateBlock explaining how memories get created.",
    why: "The table read like raw data, the emoji and native dialogs looked unfinished, and kind, scope and importance were unlabelled words.",
    files: [
      "plugins/memory/app.tsx",
      "plugins/memory/app.test.tsx",
      "plugins/memory/app.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "settings-memory-list-redesign-after.png",
  },
  {
    id: "settings-keep-awake-clarity",
    area: "p2-settings",
    title:
      "Keep Awake: accurate copy, choice cards, clickable machine rows with status dots and a saved check",
    kind: "ux",
    storyId: "plugins--keep-awake--settings",
    beforeStoryId: null,
    howToSee: "Settings → Keep Awake. Turn it on and pick Specific machines.",
    before:
      "The heading copy said 'Keep selected Macs awake', while the radio below said macOS and Windows hosts are supported. The section was called 'Hosts', with 'All hosts' and 'Specific hosts'. The radios were plain rows. Machine rows showed 'Connected' or 'Offline' as bare text, only the small checkbox could be clicked, and the last selected machine's checkbox was disabled without explanation. Loading showed 'Loading hosts…', and a permanent 'Saved' word sat bottom right.",
    after:
      "A coffee-cup badge (amber when on) heads the section. The copy says it keeps the chosen Mac and Windows machines awake while Omnyo runs on them, so long chats don’t pause, which matches host.ts (caffeinate on macOS, SetThreadExecutionState on Windows, nothing on Linux). 'Machines' replaces 'Hosts'. All machines and Specific machines are bordered choice cards that highlight when selected, and the All machines card notes that Linux machines are skipped. Each machine row is a full-width clickable label with a status dot and Connected or Offline. The last selected row explains on hover why it can’t be unticked. Loading is a skeleton, load errors are a destructive Alert, and 'Saved' carries a small success check that draws only after the owner changes something.",
    why: "The copy contradicted itself and used jargon, and the rows were hard to hit and unexplained.",
    files: [
      "plugins/keep-awake/app.tsx",
      "plugins/keep-awake/app.test.tsx",
      "plugins/keep-awake/app.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "settings-keep-awake-clarity-after.png",
  },
  {
    id: "settings-push-device-permission-card",
    area: "p2-settings",
    title:
      "Push notifications: a device permission card with a state badge and one clear action",
    kind: "ux",
    storyId: "plugins--push-notifications--device-settings",
    beforeStoryId: null,
    howToSee:
      "Settings → Push notifications, in the 'This browser' or 'This desktop app' part. Check it with permission not yet asked, allowed and blocked, and with the matching channel switch off.",
    before:
      "A bold 'This browser' line and a grey sentence sat above hand-styled bordered <button>s ('Allow notifications', 'Send test notification') that did not match the app's buttons. Hints that a channel was off and test results were grey sentences, and the migration error showed an unstyled 'Reload' button.",
    after:
      "A bordered card shows a browser or laptop icon, the device name and a status badge (Not allowed yet, Allowed, Blocked or Unavailable), with the explanation underneath. On the right sits either the filled 'Allow notifications' primary button or an outline 'Send test notification' button. If the Web or Desktop notifications switch is off, an amber Alert says this device receives nothing until it is turned on. Test results show a success check or an error icon. The migration error is a destructive Alert with a 'Reload Omnyo' button.",
    why: "Users could not tell at a glance whether this device would get notifications or what to press.",
    files: [
      "plugins/push-notifications/app.tsx",
      "plugins/push-notifications/device-settings.tsx",
      "plugins/push-notifications/device-settings.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "settings-push-device-permission-card-after.png",
  },
  {
    id: "settings-row-dividers",
    area: "p2-settings",
    title: "Settings pages: hairline dividers between settings rows",
    kind: "visual",
    storyId: "settings--settings--full-page",
    beforeStoryId: "settings--settings--full-page",
    howToSee: "Settings → General, Appearance, Privacy and Files.",
    before:
      "Each card stacked six or seven settings with only whitespace between them, so a description could look like it belonged to the switch on the next row.",
    after:
      "Rows inside Threads & editing, Links, Git, Appearance, Interface, Privacy & diagnostics, File preferences and File openers are separated by hairline dividers with even 14 px padding, so each label, description and control reads as one row.",
    why: "Long cards were hard to scan, and the rows ran together.",
    files: [
      "apps/app/src/views/SettingsView.tsx",
      "apps/app/src/components/settings/settings-row-stack.ts",
      "apps/app/src/components/settings/FileOpenersSettingsSection.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "settings-row-dividers-before.png",
    afterShot: "settings-row-dividers-after.png",
  },
  {
    id: "settings-machine-permission-chip",
    area: "p2-settings",
    title:
      "Machines list: the permission limit becomes a shield chip with a hover explanation",
    kind: "ux",
    storyId: "settings--machines--rows",
    beforeStoryId: "settings--machines--rows",
    howToSee:
      "Settings → Machines. Hover the 'Full Access' or 'Approve for me' chip on a row.",
    before:
      "Each row's meta line ended in 'Full Access' as orange text (or 'Approve for me' as grey text), with no hint that it is the machine's permission limit. The meta line also used /75-opacity text.",
    after:
      "A rounded chip with the matching shield icon; Full Access is amber-tinted. Hovering shows a native tooltip: 'Highest permission agents can use on this machine', followed by the mode's own description. The meta line now uses full-strength subtle text.",
    why: "An unexplained orange word on every row looked like an error or a link.",
    files: ["apps/app/src/components/settings/MachinesSettingsSection.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "settings-machine-permission-chip-before.png",
    afterShot: "settings-machine-permission-chip-after.png",
  },
  {
    id: "settings-updates-state-pills",
    area: "p2-settings",
    title:
      "Updates: failure, progress and terminal-only captions become pills, and Show all becomes a real toggle",
    kind: "visual",
    storyId: "settings--updates--section-variations",
    beforeStoryId: "settings--updates--section-variations",
    howToSee:
      "Settings → Updates. In the Multiple machines story, look at the homelab, Old Air and ci-runner-3 rows and at 'Show all' under the list.",
    before:
      "'2 failed', 'Update didn't finish', 'Couldn't check for updates' and progress text were tiny 2xs bold words beside the retry icon. 'homelab' said only '1 manual' in grey text. 'Show machines', 'Show all' and 'Hide' were underlined bare-text links.",
    after:
      "Failures are red-tinted text-xs pills with an alert icon, and progress such as 'Updating Omnyo' is a neutral pill. The manual case is a neutral pill with a terminal icon reading '1 CLI to update in terminal'; its tooltip still says 'Update in terminal'. Show machines, Show all and Hide are ghost xs Buttons with a chevron that turns when the list expands.",
    why: "The failure words were the smallest text on the page, '1 manual' was jargon, and the actions looked like stray links.",
    files: [
      "apps/app/src/components/settings/UpdatesSettingsSection.tsx",
      "apps/app/src/components/settings/UpdatesSettingsSection.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "settings-updates-state-pills-before.png",
    afterShot: "settings-updates-state-pills-after.png",
  },
  {
    id: "settings-add-machine-command-card",
    area: "p2-settings",
    title:
      "Add a machine: segmented OS switch, a primary Copy button, an expiry warning and a green connected strip",
    kind: "interaction",
    storyId: "dialogs--add-a-machine--enrollment-command-state",
    beforeStoryId: "dialogs--add-a-machine--enrollment-command-state",
    howToSee:
      "Settings → Machines → Add a machine. Switch between macOS or Linux and Windows, and watch the countdown in its last minute (the 'about to lapse' story row).",
    before:
      "The OS choice was two loose ghost/secondary buttons. The outline 'Copy' had almost the same weight as 'Copy full command'. The countdown stayed grey until it expired, and the connected state looked like the waiting state.",
    after:
      "The OS choice is the shared SegmentedControl, with a sliding thumb and arrow-key support. 'Copy' is the filled primary button with a copy icon that turns into a check, while 'Copy full command' stays a quiet ghost button. The countdown turns amber in its last minute, and the status strip turns green-tinted once the machine connects.",
    why: "The main action and the time pressure were not obvious.",
    files: [
      "apps/app/src/components/dialogs/AddMachineDialog.tsx",
      "apps/app/src/components/dialogs/AddMachineDialog.expiry.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "settings-add-machine-command-card-before.png",
    afterShot: "settings-add-machine-command-card-after.png",
  },
  {
    id: "settings-provider-cli-log-dialog",
    area: "p2-settings",
    title:
      "Provider CLI failure log: an error badge, a labelled output panel and a real Copy log button",
    kind: "visual",
    storyId: "dialogs--provider-cli-install-log--view-log-dialog",
    beforeStoryId: "dialogs--provider-cli-install-log--view-log-dialog",
    howToSee:
      "Make a Codex or Claude Code install or update fail, then press View log on the toast.",
    before:
      "A plain title and grey subtitle sat above a bordered block of log text, with a faint 12 px copy glyph floating in its corner.",
    after:
      "A red alert badge sits beside the title, so the failure reads at a glance. An exit code, when present, is a small mono chip. The log sits in a recessed panel with a 'Command output' toolbar and a soft xs 'Copy log' button that changes to 'Copied'.",
    why: "The dialog did not say that something went wrong, and the copy action was nearly invisible.",
    files: ["apps/app/src/components/dialogs/ProviderCliInstallLogDialog.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "settings-provider-cli-log-dialog-before.png",
    afterShot: "settings-provider-cli-log-dialog-after.png",
  },
  {
    id: "settings-delete-dialog-cancel",
    area: "p2-settings",
    title: "Remove project and Remove source dialogs get a Cancel button",
    kind: "fix",
    storyId: "dialogs--project-delete--overview",
    beforeStoryId: "dialogs--project-delete--overview",
    howToSee:
      "Settings → Projects → a project's menu → Remove, or remove a source on a project page. Also the dialogs--project-source-delete--overview story.",
    before:
      "These dialogs cannot be undone, yet they offered only the red 'Remove project' or 'Remove source' button. Backing out meant finding the small X.",
    after:
      "An outline 'Cancel' button sits beside the destructive button, as in the thread delete dialog, and it is disabled while the removal is pending.",
    why: "A destructive dialog needs an equally visible way out.",
    files: [
      "apps/app/src/components/dialogs/ProjectDeleteDialog.tsx",
      "apps/app/src/components/dialogs/ProjectSourceDeleteDialog.tsx",
      "apps/app/src/components/dialogs/ProjectDeleteDialog.stories.tsx",
      "apps/app/src/components/dialogs/ProjectSourceDeleteDialog.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "settings-delete-dialog-cancel-before.png",
    afterShot: "settings-delete-dialog-cancel-after.png",
  },
  {
    id: "settings-archived-empty-states",
    area: "p2-settings",
    title:
      "Archived threads: skeleton loading, empty states that match the cause and offer a way out, and a count chip",
    kind: "state",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Settings → Archived threads. Search for nonsense, filter to a project that has nothing archived, or open it on a server with nothing archived.",
    before:
      "Loading was the sentence 'Loading archived threads…'. An empty result was a dashed box saying 'No archived threads match these filters.' even when no filter was set and nothing had ever been archived, and it offered no action. Group counts were plain grey text.",
    after:
      "Loading shows three skeleton rows. An empty search shows a search EmptyStateBlock with a 'Clear search' button. Empty filters show 'Show all archived threads', which resets the kind and project filters. With no filters set, it says 'Nothing archived yet' and explains restoring. Project group counts sit in a small chip.",
    why: "The old empty text blamed filters that were not set and gave no next step.",
    files: [
      "apps/app/src/components/settings/ArchivedThreadsSettingsSection.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "settings-desktop-update-copy",
    area: "p2-settings",
    title: "Desktop 'Update ready' prompt says what Later means",
    kind: "ux",
    storyId: "app-update--desktop-update-prompt--states",
    beforeStoryId: "app-update--desktop-update-prompt--states",
    howToSee:
      "In the desktop app with a downloaded update, look at the 'Update ready' toast.",
    before:
      "'Relaunch to use Omnyo 0.46.20.' with Relaunch and Later, and no hint of what Later does.",
    after:
      "'Omnyo 0.46.20 is downloaded. Relaunch to finish installing it, or choose Later and relaunch from Settings → Updates when you’re ready.' The Updates page has a Relaunch button for a downloaded desktop update.",
    why: "Later looked as if it might drop the update.",
    files: ["apps/app/src/components/app-update/DesktopUpdatePromptHost.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: "settings-desktop-update-copy-before.png",
    afterShot: "settings-desktop-update-copy-after.png",
  },
  {
    id: "pickers-branch-remote-section",
    area: "p2-pickers",
    title: "Branch picker puts remote branches in their own labelled section",
    kind: "ux",
    storyId: "pickers--branch-picker--overview",
    beforeStoryId: "pickers--branch-picker--overview",
    howToSee:
      "In the Branch Picker Overview story, open the 'open long branches' picker and scroll the list.",
    before:
      "Local branches and origin/* remote branches sat together in one 'Branches' list, all with the same merge icon, so you could not tell which branches exist locally.",
    after:
      "Local branches stay under the existing header. Remote branches follow under a 'Remote branches' header, each with a cloud icon and a '(remote branch)' tooltip. When you press Enter in search, the picker selects the first visible row, so a local match wins over a remote one. A selected remote branch now appears in the remote section instead of being pinned to the top.",
    why: "The component already split branches into local and remote groups but drew them as one list, so picking a merge base or start branch was guesswork.",
    files: [
      "apps/app/src/components/pickers/BranchPicker.tsx",
      "apps/app/src/components/pickers/BranchPicker.scroll.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "pickers-branch-remote-section-before.png",
    afterShot: "pickers-branch-remote-section-after.png",
  },
  {
    id: "pickers-model-load-error-notice",
    area: "p2-pickers",
    title: "Model picker load failures show as a warning card",
    kind: "visual",
    storyId: "pickers--model-load-error-states--not-signed-in",
    beforeStoryId: "pickers--model-load-error-states--not-signed-in",
    howToSee:
      "Open the model picker in any Model Load Error States story, for example Not Signed In, and look under the failing provider. /tmp/claude-501/polish2/pickers/review/err-light-after.png shows the light theme.",
    before:
      "The failure was three stacked lines of plain grey text at reduced opacity: 'Could not load models for Claude Code.', 'Not signed in', and the guidance with literal backticks. It looked like ordinary rows.",
    after:
      "The failure shows as a tinted warning card with an alert icon and a foreground title. The reason is in warning colour ('CLI not found' still links to the install page), and the guidance uses full-strength muted text. Commands quoted in backticks render as inline code chips. The card reads correctly in both themes.",
    why: "When a provider cannot list its models, a chat cannot start on that provider. The old text looked like a disabled row, and its reduced-opacity text failed AA contrast.",
    files: [
      "apps/app/src/components/pickers/model-load-error-message.tsx",
      "apps/app/src/components/pickers/ModelPickerMatrix.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "pickers-model-load-error-notice-before.png",
    afterShot: "pickers-model-load-error-notice-after.png",
  },
  {
    id: "pickers-model-edit-button",
    area: "p2-pickers",
    title:
      "Model picker Edit is a real button, and Done is the primary action while editing",
    kind: "visual",
    storyId: "pickers--model-reasoning-picker--edit-mode",
    beforeStoryId: "pickers--model-reasoning-picker--edit-mode",
    howToSee:
      "Open the Model Reasoning Picker Edit Mode story, or open All models in any picker that has favourites and click Edit.",
    before:
      "A bare grey 'Edit' or 'Done' word at the right of the search row. Its emphasis did not change between the two modes.",
    after:
      "Outside edit mode, a ghost xs Button with a pencil icon reads 'Edit'. In edit mode, it becomes a filled primary 'Done' button with a check, so it is clear that a mode is active and how to leave it.",
    why: "The design system says actions are never styled as bare text and one primary action ends a mode.",
    files: ["apps/app/src/components/pickers/ModelReasoningPicker.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "pickers-model-edit-button-before.png",
    afterShot: "pickers-model-edit-button-after.png",
  },
  {
    id: "pickers-model-edit-hint",
    area: "p2-pickers",
    title: "Model picker edit mode explains its stars and eye icons",
    kind: "ux",
    storyId: "pickers--model-reasoning-picker--edit-mode",
    beforeStoryId: "pickers--model-reasoning-picker--edit-mode",
    howToSee:
      "Open the Model Reasoning Picker Edit Mode story, or click Edit in the All models view.",
    before:
      "Edit mode added an eye icon before every model and a star after every reasoning level, with nothing to say what either one did.",
    after:
      "A one-line band under the search row reads 'Star the levels you want in Favorites. Use the eye to move models you rarely use under “more”.' The band wraps inside the popover's existing width, so toggling Edit does not make the popover jump wider.",
    why: "Without the band, the edit grid was a field of unexplained glyphs. The wording matches the actual behaviour: stars toggle favourites, and hidden models move into the group's 'N more' disclosure.",
    files: ["apps/app/src/components/pickers/ModelReasoningPicker.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "pickers-model-edit-hint-before.png",
    afterShot: "pickers-model-edit-hint-after.png",
  },
  {
    id: "pickers-permission-menu-icons",
    area: "p2-pickers",
    title: "Permission mode menu shows each mode's shield icon",
    kind: "visual",
    storyId: "pickers--permission-mode-picker--open-menu",
    beforeStoryId: null,
    howToSee: "Open the Permission Mode Picker Open Menu story.",
    before:
      "The rows Accept Edits, Approve for me and Full Access were text only, although the composer's icon-only trigger used a shield icon for each mode.",
    after:
      "Each row starts with its mode icon (ShieldUser, ShieldCheck, ShieldOff). Safe modes use a muted icon and Full Access uses warning colour, so the menu explains the shields the trigger shows.",
    why: "The icon-only trigger showed shields that the menu never explained. OptionPicker gained an optional menuIconName field that other pickers can use for the same purpose.",
    files: [
      "apps/app/src/components/pickers/OptionPicker.tsx",
      "apps/app/src/components/pickers/PermissionModePicker.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "pickers-permission-menu-icons-before.png",
    afterShot: "pickers-permission-menu-icons-after.png",
  },
  {
    id: "pickers-palette-no-matches",
    area: "p2-pickers",
    title:
      "Command palette 'no matches' is a real empty state that names the query",
    kind: "state",
    storyId: "commands--command-palette--no-matches",
    beforeStoryId: null,
    howToSee:
      "Open the new Command Palette > No Matches story, or type nonsense into the command palette.",
    before:
      "A single small grey line, 'No matching commands', squeezed into the results area.",
    after:
      "A centred empty state: a search glyph in a soft circle, 'No commands match “deploy rocket”' in foreground text, and the hint 'Try a shorter or different word.'",
    why: "Showing the query and a next step tells you whether you mistyped or the command does not exist.",
    files: [
      "apps/app/src/components/commands/CommandPaletteBody.tsx",
      "apps/app/src/components/commands/CommandPalette.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "pickers-palette-no-matches-after.png",
  },
  {
    id: "pickers-empty-states-unified",
    area: "p2-pickers",
    title: "Picker searches with no results say what was searched",
    kind: "state",
    storyId: "pickers--machine-picker--overview",
    beforeStoryId: "pickers--machine-picker--overview",
    howToSee:
      "In the Machine, Project, Environment, Reuse Environment or Branch picker stories, type a query that matches nothing, for example 'missing'.",
    before:
      "Each picker had its own bare line: 'No machines found', 'No projects found', 'No environments match.', 'No branches found.' and 'No matching threads.' (the last one at a different size and padding).",
    after:
      "A shared PickerEmptyState shows a centred icon and names the query, for example 'No machines match “missing”'. When the Reuse picker has nothing at all, it says 'Nothing to reuse yet.' and 'Environments your other chats use show up here.' The parent-thread picker shows 'No other threads to choose.' when the list is empty and 'No threads match “…”' when a search finds nothing, which matches its 'Search threads…' field.",
    why: "All pickers now look the same when a search finds nothing, and the message says what was searched instead of using five different bare strings.",
    files: [
      "apps/app/src/components/pickers/PickerEmptyState.tsx",
      "apps/app/src/components/pickers/BranchPicker.tsx",
      "apps/app/src/components/pickers/ProjectSelector.tsx",
      "apps/app/src/components/pickers/MachinePicker.tsx",
      "apps/app/src/components/pickers/EnvironmentPicker.tsx",
      "apps/app/src/components/pickers/ReuseEnvironmentPicker.tsx",
      "apps/app/src/components/pickers/ParentThreadPicker.tsx",
      "apps/app/src/components/pickers/ProjectSelector.test.tsx",
      "apps/app/src/components/pickers/MachinePicker.test.tsx",
      "apps/app/src/components/pickers/EnvironmentPicker.test.tsx",
      "apps/app/src/components/pickers/BranchPicker.scroll.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "pickers-empty-states-unified-before.png",
    afterShot: "pickers-empty-states-unified-after.png",
  },
  {
    id: "pickers-reuse-orphan-heading",
    area: "p2-pickers",
    title:
      "Reuse picker no longer shows an empty section heading under 'no matches'",
    kind: "fix",
    storyId: "pickers--reuse-environment-picker--searchable",
    beforeStoryId: "pickers--reuse-environment-picker--searchable",
    howToSee:
      "Open the Reuse Environment Picker Searchable story, open the picker and type 'zzzz'.",
    before:
      "Under the 'no matches' message, an orphaned 'Reuse an existing environment' heading sat at the bottom with nothing below it.",
    after:
      "Only the empty state shows ('No environments match “zzzz”'). The heading returns as soon as a result matches.",
    why: "A heading with no items looked like a broken or still-loading list.",
    files: ["apps/app/src/components/pickers/ReuseEnvironmentPicker.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "pickers-reuse-orphan-heading-before.png",
    afterShot: "pickers-reuse-orphan-heading-after.png",
  },
  {
    id: "pickers-offline-machine-labels",
    area: "p2-pickers",
    title: "Offline machines say 'Offline', and status dots explain themselves",
    kind: "ux",
    storyId: "pickers--environment-picker--offline-machine",
    beforeStoryId: "pickers--environment-picker--offline-machine",
    howToSee:
      "Open the Environment Picker Offline Machine story. Hover a status dot in the Machine or Environment picker.",
    before:
      "An offline machine showed only a hollow dot, and its section header said just 'last seen 2h ago'. A disconnected machine with no last-seen time showed nothing at all.",
    after:
      "Offline machine rows carry an 'Offline' label. Section headers and the Machine picker read 'Offline · last seen 2h ago', or just 'Offline' when no time is known. Each status dot has an 'Online' or 'Offline' hover title.",
    why: "The greyed-out options under an offline machine now have a visible reason.",
    files: [
      "apps/app/src/components/pickers/MachinePicker.tsx",
      "apps/app/src/components/pickers/EnvironmentPicker.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "pickers-offline-machine-labels-before.png",
    afterShot: "pickers-offline-machine-labels-after.png",
  },
  {
    id: "pickers-palette-match-contrast",
    area: "p2-pickers",
    title: "Command palette search makes the matched letters stand out",
    kind: "visual",
    storyId: "commands--command-palette--filtered-results",
    beforeStoryId: null,
    howToSee:
      "Open Command Palette > Filtered Results (the query is 'thr'), or type into the palette.",
    before:
      "Matched letters were semibold but kept the same foreground colour as the rest of the title.",
    after:
      "While you type, the unmatched part of each title drops to muted-foreground and the matched letters stay bold in foreground colour. Titles shown with an empty query are unchanged, because the muted wrapper only renders when there are match positions.",
    why: "You can see at a glance why each result matched.",
    files: ["apps/app/src/components/commands/CommandPaletteBody.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "pickers-palette-match-contrast-after.png",
  },
  {
    id: "pickers-command-palette-story",
    area: "p2-pickers",
    title: "New Ladle stories for the command palette",
    kind: "story",
    storyId: "commands--command-palette--commands",
    beforeStoryId: null,
    howToSee:
      "Ladle > commands > Command Palette: Commands, Filtered Results, No Matches.",
    before:
      "The command palette had no story, so its states could not be reviewed outside the live app.",
    after:
      "Three stories render the real CommandPaletteBody with fixture actions: the grouped root, a filtered query and the no-match state. The real Settings entries also appear.",
    why: "Alex and later polish passes can see the palette states directly.",
    files: ["apps/app/src/components/commands/CommandPalette.stories.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "pickers-command-palette-story-after.png",
  },
  {
    id: "pickers-shortcut-sheet-count",
    area: "p2-pickers",
    title: "Keyboard shortcut sheet labels its count",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Hold the shortcut-hint modifier to open the keyboard shortcut sheet and look at the right side of its header.",
    before: "A bare number such as '42' next to the collapse chevron.",
    after: "'42 shortcuts' (or '1 shortcut').",
    why: "It removes an unexplained number from the header.",
    files: ["apps/app/src/components/commands/AppCommandShortcutOverlay.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-palette-placeholder-contrast",
    area: "p2-pickers",
    title: "Command palette placeholder is legible",
    kind: "fix",
    storyId: "commands--command-palette--commands",
    beforeStoryId: null,
    howToSee: "Open the command palette with an empty query.",
    before:
      "'Search commands…' was light-weight subtle text at 70% opacity, which is below AA contrast.",
    after:
      "The placeholder uses full-strength subtle-foreground at normal weight.",
    why: "DESIGN.md forbids opacity-reduced text.",
    files: [
      "apps/app/src/components/commands/PaletteInputBand.tsx",
      "apps/app/src/components/commands/CommandPalette.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-ellipsis-copy",
    area: "p2-pickers",
    title: "Loading and creating labels use a real ellipsis",
    kind: "fix",
    storyId: "pickers--branch-picker--loading-branches",
    beforeStoryId: null,
    howToSee:
      "The Branch picker trigger while branches load, or the Project picker while a project is being created.",
    before: "'Loading branches...' and 'Creating...' used three full stops.",
    after: "'Loading branches…' and 'Creating…', matching the rest of the app.",
    why: "The copy now matches the rest of the app.",
    files: [
      "apps/app/src/components/pickers/BranchPicker.tsx",
      "apps/app/src/components/pickers/ProjectSelector.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "home-tools-home-needs-panel",
    area: "p2-home-tools",
    title:
      'Home "Needs you" panel: explained kind chips, a real Open Inbox button and a separate Failed group',
    kind: "ux",
    storyId: "views--home-status-panel--overview",
    beforeStoryId: null,
    howToSee:
      "Open Home on a desktop-width window while chats are in the Inbox, or open the Ladle story views/Home status panel. Hover a kind chip to read what it means.",
    before:
      'The header was plain text, "Needs you · 3". The only way into the Inbox was a muted text link on the right ("2 running · 3 ready to archive >"). Every kind chip had the same yellow tint and used jargon such as Returned, Runs and Chain. Failed chats sat under a bare red "Failed · 2" line, and extra chats showed as loose "2 more in Inbox" text.',
    after:
      'The header has a status dot, the title "Needs you" and a count chip that screen readers hear as "3 chats". The running and ready counts sit beside a real soft xs "Open Inbox" button. Each kind chip has a fixed width, its own tone and a plain label: Question, Result, Back from wait, Problem, Several runs and Wait closed. Hovering a chip explains the kind, and the row button carries the same explanation as its accessible description. Failed chats get their own red heading with a count and the line "Stopped before finishing". Extra rows read "2 more need you … See all in Inbox >". The header and the extra rows now truncate instead of pushing the Open Inbox button off the panel.',
    why: "Alex flagged unexplained chips, actions styled as bare text and jargon. The labels match packages/domain/src/inbox.ts: returned covers deadline, partial, dead-wake, reminder and late-result receipts; chain is written when the chat being waited on was archived without a result; runs groups automation runs; failed is an actionable failure.",
    files: [
      "apps/app/src/views/home-orientation/HomeOrientation.tsx",
      "apps/app/src/views/home-orientation/home-orientation.ts",
      "apps/app/src/views/home-orientation/HomeOrientation.test.tsx",
      "apps/app/src/views/home-orientation/HomeStatusPanel.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "home-tools-home-needs-panel-after.png",
  },
  {
    id: "home-tools-plugin-install-primary",
    area: "p2-home-tools",
    title:
      "Install is the filled primary button on an uninstalled plugin's page",
    kind: "visual",
    storyId: "plugins-and-skills--detail-states--plugin-detail-states",
    beforeStoryId: "plugins-and-skills--detail-states--plugin-detail-states",
    howToSee:
      "Go to Tools > Plugins > Browse, open a plugin you have not installed and look at the Install button in the header.",
    before:
      "Install was a small outline button that looked like every secondary control, although it is the page's only action.",
    after:
      "Install is the filled primary button: near-white in dark mode, with the control shadow. An incompatible plugin keeps an outline Install button with a warning icon. The small icon-only install buttons on browse cards are unchanged.",
    why: "Each surface needs one obvious primary action.",
    files: [
      "apps/app/src/components/plugin/management/PluginCatalogInstallControl.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "home-tools-plugin-install-primary-before.png",
    afterShot: "home-tools-plugin-install-primary-after.png",
  },
  {
    id: "home-tools-banner-reload-labelled",
    area: "p2-home-tools",
    title:
      "Plugin health banners: Reload is a labelled button instead of a bare rotate glyph",
    kind: "ux",
    storyId: "plugins-and-skills--detail-states--plugin-banner-states",
    beforeStoryId: "plugins-and-skills--detail-states--plugin-banner-states",
    howToSee:
      "Open the detail page of a plugin that failed to start or is degraded, and look at the right end of the banner above the plugin name.",
    before:
      'The banner ended in a lone rotate icon. Only its tooltip said that it reloads the plugin. "Open settings" was a hand-sized ghost button with its own height overrides.',
    after:
      'The banner ends in a soft xs button with a rotate icon and the word "Reload". It shows a spinner and "Reloading…" while the reload runs. "Open settings" uses the same soft xs button. The accessible names Reload and Reloading… are unchanged.',
    why: "Alex asked for no unexplained glyphs and for row actions to use the shared soft xs button.",
    files: ["apps/app/src/components/tools/PluginCapabilities.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "home-tools-banner-reload-labelled-before.png",
    afterShot: "home-tools-banner-reload-labelled-after.png",
  },
  {
    id: "home-tools-row-update-labelled",
    area: "p2-home-tools",
    title:
      "Installed plugin cards: the bare green download glyph is now a labelled Update button",
    kind: "ux",
    storyId: "plugin--row-signal--update-states",
    beforeStoryId: "plugin--row-signal--update-states",
    howToSee:
      "Go to Tools > Plugins > Installed with a plugin that has an update, or open the plugin/Row Signal and plugin/Installed plugins stories.",
    before: "A lone green download glyph that only its tooltip explained.",
    after:
      'A soft xs button reads "Update" and keeps the green download icon. The tooltip and the accessible name still give the version, for example "Update to 1.2.0".',
    why: "No unexplained glyphs and no unlabelled actions.",
    files: ["apps/app/src/components/plugin/management/PluginRowSignal.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "home-tools-row-update-labelled-before.png",
    afterShot: "home-tools-row-update-labelled-after.png",
  },
  {
    id: "home-tools-installed-empty",
    area: "p2-home-tools",
    title: "The empty Installed plugins list is a real empty-state block",
    kind: "state",
    storyId: "plugin--installed-plugins--empty",
    beforeStoryId: "plugin--installed-plugins--empty",
    howToSee:
      "Go to Tools > Plugins > Installed with no plugins, or open the plugin/Installed plugins > Empty story.",
    before:
      'One small grey line: "No plugins installed. Browse the catalog, create a plugin, or run omnyo plugin install <source>."',
    after:
      'A dashed well with a puzzle icon, the title "No plugins installed yet" and the text "Browse the catalog or create a plugin. From a terminal, run omnyo plugin install <source>." The command is set as inline code.',
    why: "Gives the empty state structure and readable copy.",
    files: [
      "apps/app/src/components/plugin/management/InstalledPluginsTab.tsx",
      "apps/app/src/components/plugin/management/InstalledPluginsTab.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "home-tools-installed-empty-after.png",
  },
  {
    id: "home-tools-skill-file-heading",
    area: "p2-home-tools",
    title: "Skill pages show file names instead of repeating the full path",
    kind: "ux",
    storyId: "plugins-and-skills--detail-states--skill-detail-states",
    beforeStoryId: "plugins-and-skills--detail-states--skill-detail-states",
    howToSee:
      "Go to Tools > Skills and open any skill. To see the Files list, open a skill with more than one file.",
    before:
      "Below the header path, the section heading repeated the full path (~/.omnyo/skills/writing-voice/SKILL.md). The Files list repeated full paths, and the selected row had a barely visible tint.",
    after:
      'The section heading is a file icon plus "SKILL.md" in mono, and the full path appears on hover. Files rows show names relative to the skill folder, such as SKILL.md and tone.md, each with a file icon. The selected row has the active fill and a "Showing" tag, and the rows share the hover colour change and an inset focus ring.',
    why: "The same path appeared three times, and it was unclear which file was shown.",
    files: [
      "apps/app/src/components/tools/SkillDetailView.tsx",
      "apps/app/src/components/tools/detail-page-recipes.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "home-tools-skill-file-heading-before.png",
    afterShot: "home-tools-skill-file-heading-after.png",
  },
  {
    id: "home-tools-plugin-panel-unavailable",
    area: "p2-home-tools",
    title: "A missing plugin panel explains itself and offers a way out",
    kind: "state",
    storyId: "views--plugin-panel--unavailable",
    beforeStoryId: "views--plugin-panel--unavailable",
    howToSee:
      "Open a plugin panel whose plugin is off, failed to start or was removed, or open the views/Plugin panel > Unavailable story.",
    before:
      'A small dashed box of plain text at the top: "This plugin panel is not available. The plugin may have been disabled or removed." It offered no action.',
    after:
      'A centred empty-state block with a puzzle icon, the title "This plugin panel is not available" and the text "The plugin that adds this panel is turned off, not running or was removed. Check it in your installed plugins to bring the panel back." A primary "Go to installed plugins →" button opens Tools > Plugins > Installed.',
    why: "An error page with no next step was a dead end.",
    files: [
      "apps/app/src/views/PluginPanelView.tsx",
      "apps/app/src/views/PluginPanelView.stories.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "home-tools-plugin-panel-unavailable-after.png",
  },
  {
    id: "home-tools-chat-import-panel",
    area: "p2-home-tools",
    title:
      "Chat import settings: a structured list with Select all, status badges, and real empty and error states",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      'Open Settings > Chat import, the chat-importer plugin\'s "Import chats" section.',
    before:
      'The count was a loose line above a faint bordered list. Rows ended in bare text, "Imported" or "Already imported", followed by a link-styled "Open". Chats that could not be imported looked like the others, only greyed. An empty result was one grey sentence above a native disclosure. A scan error was red text beside an outline button.',
    after:
      'The list is a raised card. Its recessed header row has a "Select all ready chats" checkbox, the count line and "N selected". Rows highlight on hover. A chat that cannot be imported has a muted title and a neutral "Can’t import" badge. Results show as status badges (green Imported, neutral Already imported, red Failed), Open is a soft xs button, and per-chat messages sit under the title with an icon. "New projects: …" has a folder-plus icon. The Import button and the note about CLI history share one row. An empty result shows a "No recent chats" empty state with Skipped files below it, and a scan error shows a destructive alert with a soft "Try again" button.',
    why: "The panel is a list of chats, each with a state and actions, so it now uses the shared status vocabulary. Ladle cannot load the plugin yet (see sharedRequests), so this change was checked by code review, the plugin's tests and tsc, without a screenshot.",
    files: ["plugins/chat-importer/src/ui/ChatImportPanel.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "home-tools-plugin-update-primary",
    area: "p2-home-tools",
    title:
      "Plugin Details: Update is the primary button, and Retry says what it retries",
    kind: "visual",
    storyId: "plugins-and-skills--detail-states--plugin-release-states",
    beforeStoryId: "plugins-and-skills--detail-states--plugin-release-states",
    howToSee:
      "Open an installed plugin that has an update available, or one whose last update failed, and look at the Details header.",
    before:
      "Update and Retry were identical outline buttons, forced to h-6 by custom classes.",
    after:
      'Update is a filled primary xs button. A failed update shows a soft xs "Retry update" button with a rotate icon. Both use the shared sizes.',
    why: "Follows the shared hierarchy: the main release action is filled and the recovery action is soft.",
    files: ["apps/app/src/components/plugin/management/PluginUpdatesCard.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "home-tools-plugin-update-primary-before.png",
    afterShot: "home-tools-plugin-update-primary-after.png",
  },
  {
    id: "home-tools-skill-loading-error",
    area: "p2-home-tools",
    title: "Skill content loading and error states",
    kind: "state",
    storyId: "plugins-and-skills--detail-states--skill-detail-states",
    beforeStoryId: "plugins-and-skills--detail-states--skill-detail-states",
    howToSee:
      "In the Skill detail states story, scroll to Content loading and Content failed.",
    before:
      'Loading showed centred grey text, "Loading ~/.omnyo/skills/…/SKILL.md…". An error showed a red x, one line of text and an outline Retry button.',
    after:
      'Loading shows a document-shaped skeleton (a heading bar and three text lines) with role=status. An error shows an error-tone empty state: a file-question icon, the message as its title, the text "Check that the file still exists, then try again." and a Retry button with an icon.',
    why: "Clearer states that say what to do next.",
    files: ["apps/app/src/components/tools/SkillDetailView.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "home-tools-skill-loading-error-before.png",
    afterShot: "home-tools-skill-loading-error-after.png",
  },
  {
    id: "home-tools-capability-kinds",
    area: "p2-home-tools",
    title: "Plugin Capabilities rows say what each entry is",
    kind: "ux",
    storyId: "plugins-and-skills--detail-states--plugin-banner-states",
    beforeStoryId: "plugins-and-skills--detail-states--plugin-banner-states",
    howToSee:
      "Open an installed, running plugin such as GitHub and look at Capabilities.",
    before:
      'Only a small icon, explained in a hover tooltip, told you what rows such as "omnyo gh", "skills", "gh_search", "Pull requests" and "GitHub Dark" were.',
    after:
      "Each name has a small label underneath: Command, Skill, Agent tool, Thread integration or Theme. The label is aria-hidden because the glyph already carries the same accessible label.",
    why: "Fixes unexplained icons on the plugin page.",
    files: ["apps/app/src/components/tools/PluginCapabilities.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "home-tools-capability-kinds-before.png",
    afterShot: "home-tools-capability-kinds-after.png",
  },
  {
    id: "home-tools-install-dialog-trust",
    area: "p2-home-tools",
    title:
      "Install dialog: a readable full-trust notice, a labelled source field and a boxed install error",
    kind: "visual",
    storyId: "plugins-and-skills--detail-states--plugin-detail-states",
    beforeStoryId: "plugins-and-skills--detail-states--plugin-detail-states",
    howToSee:
      "In the Plugin detail states story, click Install in the first row. Use Add plugin from source to see the labelled field.",
    before:
      'The security warning ("Plugins run as full-trust code…") was tiny, subtle grey text. The Add-from-source field had only a placeholder and a 2xs hint. Install errors appeared as loose amber text.',
    after:
      'The trust warning is an amber-tinted callout with an amber lock icon and foreground text at text-xs. The source field has a visible "Source" label and a readable hint linked through aria-describedby: a GitHub repository URL, `npm:package[@version]` or a local folder. Install errors appear in a destructive-tinted box with an alert icon.',
    why: "A security notice must be readable, and a form field needs a visible label.",
    files: [
      "apps/app/src/components/plugin/management/plugin-ui.tsx",
      "apps/app/src/components/plugin/management/AddPluginDialog.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "home-tools-install-dialog-trust-before.png",
    afterShot: "home-tools-install-dialog-trust-after.png",
  },
  {
    id: "home-tools-api-tester-placeholder",
    area: "p2-home-tools",
    title: "The Plugin API Tester placeholder panel is centred and structured",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open the Plugin API Tester nav panel, which is on by default in development.",
    before: "A plain bordered box at the top left with two lines of text.",
    after:
      "A centred raised card with a beaker icon in a ring, a semibold title and a plain description of what the panel proves.",
    why: "Even the development placeholder should look finished.",
    files: ["plugins/plugin-api-tester/app.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "home-tools-plugin-on-off-label",
    area: "p2-home-tools",
    title: "The installed plugin's header switch shows On or Off",
    kind: "ux",
    storyId: "plugins-and-skills--detail-states--plugin-release-states",
    beforeStoryId: "plugins-and-skills--detail-states--plugin-release-states",
    howToSee:
      "Open any installed plugin's detail page and look at the top right.",
    before: "An unlabelled switch sat next to the … menu.",
    after:
      'A small muted "On" or "Off" sits before the switch, and clicking the word also toggles it. The switch\'s accessible name (Disable/Enable <plugin>) is unchanged.',
    why: "Says what the header switch controls and what state it is in.",
    files: ["apps/app/src/components/tools/PluginDetail.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: "home-tools-plugin-on-off-label-before.png",
    afterShot: "home-tools-plugin-on-off-label-after.png",
  },
  {
    id: "home-tools-installed-card-footer",
    area: "p2-home-tools",
    title:
      'Installed plugin cards: footers line up, and turned-off plugins say "Off"',
    kind: "visual",
    storyId: "plugin--installed-plugins--cards",
    beforeStoryId: "plugin--installed-plugins--cards",
    howToSee:
      "Go to Tools > Plugins > Installed. Compare a card that has an Update button with one that does not, and look at a turned-off plugin.",
    before:
      "A footer holding the Update button was taller than one holding only the switch, so neighbouring dividers sat at different heights. A turned-off plugin differed from a running one only in the switch position.",
    after:
      'Every footer has the same minimum height, so the dividers and bylines line up within a pixel. A turned-off plugin shows a muted "Off" beside its switch.',
    why: "Removes uneven padding and makes the off state readable at a glance.",
    files: [
      "apps/app/src/components/plugin/management/PluginCard.tsx",
      "apps/app/src/components/plugin/management/InstalledPluginsTab.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: "home-tools-installed-card-footer-after.png",
  },
  {
    id: "home-tools-catalog-uninstall-tooltip",
    area: "p2-home-tools",
    title: "The installed catalog card's tooltip names the uninstall action",
    kind: "interaction",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "In Tools > Plugins > Browse, hover the check button on an installed plugin's card.",
    before:
      'The tooltip said "Installed", while hovering swapped the icon to a trash can.',
    after: 'The tooltip says "Installed. Click to uninstall <plugin>."',
    why: "The trash icon appeared on hover without saying what a click would do.",
    files: [
      "apps/app/src/components/plugin/management/PluginCatalogInstallControl.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "home-tools-skills-browse-type-token",
    area: "p2-home-tools",
    title: "Registry skill card stats use the sanctioned text-2xs token",
    kind: "fix",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "In Tools > Skills > Browse, look at the install and star counts on registry cards. Expect little or no visible change.",
    before: "text-[11px]",
    after: "text-2xs",
    why: "The type-token rule bans arbitrary text sizes.",
    files: ["apps/app/src/components/tools/SkillsBrowse.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "usage-providers-settings-group-accounts",
    area: "p2-usage-providers",
    title:
      "Usage limits settings show each provider once, with its accounts listed beneath",
    kind: "ux",
    storyId: "plugins--provider-usage--settings",
    beforeStoryId: "plugins--provider-usage--settings",
    howToSee:
      "Settings → Usage limits with the Account Pooler source. In Ladle, open plugins/Provider usage → Settings and look at the 'healthy' and 'mixed pool' scenarios.",
    before:
      "Every pooled account repeated the provider icon and the bold provider name ('Codex', 'Codex', 'Codex'). A pool read as a list of identical headings with an email under each, and the plan was a tiny square-cornered bordered tag.",
    after:
      "Each provider appears once, with its icon in a tile and an 'N accounts' pill. Its accounts sit indented beneath it, each led by its email with a rounded plan pill, and seam dividers separate them. A provider with a single account keeps the email under the name and the plan pill on the right.",
    why: "This removes the repeated-heading confusion and gives the card a clear provider → account → limit hierarchy.",
    files: [
      "plugins/provider-usage/settings.tsx",
      "plugins/provider-usage/settings.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "usage-providers-settings-group-accounts-before.png",
    afterShot: "usage-providers-settings-group-accounts-after.png",
  },
  {
    id: "usage-providers-settings-state-messages",
    area: "p2-usage-providers",
    title: "Sign-in, expired and error states get coloured messages with icons",
    kind: "state",
    storyId: "plugins--provider-usage-accounts--sign-in-and-errors",
    beforeStoryId: "plugins--provider-usage-accounts--sign-in-and-errors",
    howToSee:
      "In Ladle, open plugins/Provider usage accounts → Sign In And Errors. In the app, open Settings → Usage limits while a pooled account is signed out.",
    before:
      "'Sign in again in the provider’s settings.', provider error text and 'No usage limits reported for this plan.' were all the same plain grey line, so they looked like ordinary account details.",
    after:
      "Signed-out and expired accounts show an amber line with a lock icon. Provider errors show a red line with an alert icon. Neutral facts, such as no limits or not installed, show a muted line with an info icon.",
    why: "An account that needs action now looks different from one that is fine.",
    files: ["plugins/provider-usage/settings.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: "usage-providers-settings-state-messages-after.png",
  },
  {
    id: "usage-providers-settings-loading-skeleton",
    area: "p2-usage-providers",
    title:
      "Account usage loads as a skeleton meter instead of repeated 'Loading usage…'",
    kind: "state",
    storyId: "plugins--provider-usage-accounts--accounts-loading",
    beforeStoryId: "plugins--provider-usage-accounts--accounts-loading",
    howToSee:
      "In Ladle, open plugins/Provider usage accounts → Accounts Loading. In the app, open Settings → Usage limits before the first measurement arrives.",
    before: "Each account printed the text 'Loading usage…' under its email.",
    after:
      "Each account shows a skeleton of the label, value, bar and reset line in the final layout, so nothing jumps when the numbers arrive. The page-level loading notice also has a spinning indicator.",
    why: "Loading looks deliberate and the layout stays stable.",
    files: [
      "plugins/provider-usage/settings.tsx",
      "plugins/provider-usage/usage-feedback.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "usage-providers-settings-loading-skeleton-after.png",
  },
  {
    id: "usage-providers-settings-header-and-values",
    area: "p2-usage-providers",
    title:
      "Usage limits explains its colours, tints high values and puts a clock on resets",
    kind: "ux",
    storyId: "plugins--provider-usage--settings",
    beforeStoryId: "plugins--provider-usage--settings",
    howToSee:
      "Settings → Usage limits. Compare the subtitle, the '86% used' and '97% used' values and the reset lines.",
    before:
      "The subtitle said only 'Your provider subscription usage.' in faint text. Nothing explained the amber and red bars, the 'NN% used' value stayed grey even at 97%, the reset line was a bare sentence, and the refresh button was 28 px.",
    after:
      "The subtitle reads 'How much of each subscription’s limits you’ve used. Bars turn amber at 80% and red at 95%.' in legible muted text, which matches the bar thresholds in usage-format.ts. The value turns amber or red with its bar. Each reset line has a clock glyph, and shows 'Reset time not reported' when the provider gives no time. The card is rounded-xl with the card shadow, though the shadow is faint in dark theme. Refresh uses the standard icon-sm ghost button. The source picker labels disconnected sources 'Offline', and each bar is a labelled role=meter.",
    why: "The card says what its colours mean, and critical usage reads at a glance.",
    files: ["plugins/provider-usage/settings.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "usage-providers-settings-header-and-values-before.png",
    afterShot: "usage-providers-settings-header-and-values-after.png",
  },
  {
    id: "usage-providers-disclosure-column-header",
    area: "p2-usage-providers",
    title: "Sidebar usage card labels its columns: Limit · Used · Resets",
    kind: "ux",
    storyId: "plugins--provider-usage--disclosure",
    beforeStoryId: "plugins--provider-usage--disclosure",
    howToSee:
      "Open the 'Provider usage' disclosure in the sidebar footer. In Ladle, open plugins/Provider usage → Disclosure.",
    before:
      "Rows read '7d ▬▬▬ 28% 3d 11h'. Nothing said whether 28% was used or left, or that '3d 11h' was the time until the limit resets.",
    after:
      "A small header row above the accounts labels the columns 'Limit', 'Used' and 'Resets'. It appears only when at least one usage window is shown. These labels match the data: the value column is usedPercent and the last column is the reset countdown.",
    why: "The numbers explain themselves without hovering.",
    files: ["plugins/provider-usage/app.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "usage-providers-disclosure-column-header-before.png",
    afterShot: "usage-providers-disclosure-column-header-after.png",
  },
  {
    id: "usage-providers-disclosure-source-picker",
    area: "p2-usage-providers",
    title: "The usage source picker now looks like a picker",
    kind: "ux",
    storyId: "plugins--provider-usage--disclosure",
    beforeStoryId: "plugins--provider-usage--disclosure",
    howToSee:
      "Look at the Provider usage disclosure header, next to the refresh button.",
    before:
      "'Account Pooler' was plain grey text in the header, with no hint that it opens a menu.",
    after:
      "The trigger shows an icon (Layers for an account source, Laptop for a machine), the name and a chevron, so it reads as a dropdown.",
    why: "The control gave no sign that it opens a menu.",
    files: ["plugins/provider-usage/app.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "usage-providers-disclosure-source-picker-before.png",
    afterShot: "usage-providers-disclosure-source-picker-after.png",
  },
  {
    id: "usage-providers-disclosure-account-states",
    area: "p2-usage-providers",
    title:
      "Sidebar usage: coloured account messages, rounded plan pills, a loading spinner and a real Retry button",
    kind: "state",
    storyId: "plugins--provider-usage--disclosure",
    beforeStoryId: "plugins--provider-usage--disclosure",
    howToSee:
      "In the Disclosure story, look at ops@example.com in 'mixed pool', the 'load failed' scenario and the 'accounts loading' scenario.",
    before:
      "A signed-out account showed a faint grey 'Sign in again in the provider’s settings.' The failure notice offered a bare text 'Retry' link, plan tags were square grey chips, and pending accounts showed a plain 'Loading usage…'.",
    after:
      "Sign-in prompts show in amber with a lock icon, and errors in red with an alert icon. Pending accounts show a small spinning indicator before 'Loading usage…'. 'Retry' is a compact soft button, the notice text uses legible muted colour, and plan labels are rounded pills.",
    why: "Problems stand out from healthy rows, and the action looks like an action.",
    files: ["plugins/provider-usage/app.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "usage-providers-disclosure-account-states-before.png",
    afterShot: "usage-providers-disclosure-account-states-after.png",
  },
  {
    id: "usage-providers-account-usage-columns-legend",
    area: "p2-usage-providers",
    title:
      "Account usage popover gets column labels and a correct legend for its marks",
    kind: "ux",
    storyId: "plugins--account-usage--pooled-accounts",
    beforeStoryId: "plugins--account-usage--pooled-accounts",
    howToSee:
      "Hover or click the usage rings in the app footer. In Ladle, open plugins/Account usage → Pooled Accounts or Edge States.",
    before:
      "The popover showed bars, percentages, coloured dots, a haloed dot, a thin tick, an amber stretch on the bar and clock glyphs, and labelled none of them. Nothing said whether '41%' was used or left.",
    after:
      "An 'Account · Week left' header sits above the rows. A legend at the bottom explains each mark: 'Serving now' for the haloed dot, 'Time left this week' for the tick, 'Using it faster than time passes' for the amber stretch, and 'Back in' for the clock. Each status dot has a hover title: Ready, Limit reached, Rate limited, Needs attention or Switched off. Rows have slightly more vertical padding.",
    why: "Alex asked for marks that explain themselves. The tick is drawn at timeMarkerPercent, which is the share of the week still remaining, so the legend now describes it as time left.",
    files: [
      "plugins/account-usage/components/usage-footer.tsx",
      "plugins/account-usage/components/usage-rail.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "usage-providers-account-usage-columns-legend-before.png",
    afterShot: "usage-providers-account-usage-columns-legend-after.png",
  },
  {
    id: "usage-providers-account-repair-callout",
    area: "p2-usage-providers",
    title:
      "Broken accounts show a readable red callout, with 'Sign in again' as the primary action",
    kind: "fix",
    storyId: "plugins--account-usage--edge-states",
    beforeStoryId: "plugins--account-usage--edge-states",
    howToSee:
      "Open the Account usage popover and look at the 'Sign-in failed' account in Edge States.",
    before:
      "One truncated grey line read 'Unavailable · Sign in again in the Account Pooler setti…', next to a tiny grey chip button.",
    after:
      "A tinted destructive callout with an alert icon shows the full explanation, wrapped. Retry is a soft row button. When the account can sign in again, 'Sign in again' is the filled primary row action. That case has no Ladle story; the account-repair tests cover it. During the sign-in flow, 'Copy & open' and 'Finish' are primary, and the code field gets the shared focus halo.",
    why: "The text that says what to do was cut off, and the fix action did not stand out.",
    files: [
      "plugins/account-usage/components/account-repair.tsx",
      "plugins/account-usage/components/action-classes.ts",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "usage-providers-account-repair-callout-before.png",
    afterShot: "usage-providers-account-repair-callout-after.png",
  },
  {
    id: "usage-providers-account-usage-headers",
    area: "p2-usage-providers",
    title: "Provider groups get readable names and an 'N of M ready' pill",
    kind: "visual",
    storyId: "plugins--account-usage--pooled-accounts",
    beforeStoryId: "plugins--account-usage--pooled-accounts",
    howToSee: "Look at the group headers in the Account usage popover.",
    before:
      "When a provider had no display name, the header showed the raw id ('claude-code', 'codex'). '1 of 3 ready' was faint loose text, and the header said 'updated just now' in lowercase.",
    after:
      "A provider without a display name shows a title-cased id ('Claude Code', 'Codex') in the popover and in the footer ring's labels. The readiness count is a rounded pill that turns red when no account is ready, and its tooltip explains it ('1 of 3 accounts can take new requests'). The header reads 'Updated just now' in legible muted text, and pool read errors appear as a tinted callout with an icon.",
    why: "The headers no longer show internal ids, and the urgent state is easy to spot.",
    files: [
      "plugins/account-usage/components/usage-footer.tsx",
      "plugins/account-usage/components/usage-rail.tsx",
      "plugins/account-usage/lib/format.ts",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "usage-providers-account-usage-headers-before.png",
    afterShot: "usage-providers-account-usage-headers-after.png",
  },
  {
    id: "usage-providers-account-usage-row-actions",
    area: "p2-usage-providers",
    title: "Reset and speed actions follow one button hierarchy",
    kind: "interaction",
    storyId: "plugins--account-usage--pooled-accounts",
    beforeStoryId: "plugins--account-usage--pooled-accounts",
    howToSee:
      "In the Account usage popover, click 'Use reset' on openai2 to reach the confirm step. Open 'Codex speed' when measurements fail.",
    before:
      "'Use reset' was a faint chip. 'Confirm reset' and 'Cancel' were identical grey chips, and a speed failure offered an underlined text 'Retry'. Two copies of the chip class lived in separate files.",
    after:
      "One shared set of row-action classes covers all of them. Ordinary actions ('Use reset', 'Retry') are soft, the committing step ('Confirm reset') is filled primary, and Cancel is a quiet ghost button. The buttons grow on coarse pointers and use the keyboard-only focus ring. A speed failure reads 'Couldn’t load speed measurements.' with a soft Retry button.",
    why: "The committing action is obvious, and no action is styled as bare text.",
    files: [
      "plugins/account-usage/components/action-classes.ts",
      "plugins/account-usage/components/reset-credits.tsx",
      "plugins/account-usage/components/speed-allowance.tsx",
      "plugins/account-usage/components/speed-allowance.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "usage-providers-account-usage-row-actions-before.png",
    afterShot: "usage-providers-account-usage-row-actions-after.png",
  },
  {
    id: "usage-providers-acp-registry-hierarchy",
    area: "p2-usage-providers",
    title:
      "ACP agent registry: quiet row actions, coloured status badges, icon tiles",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee: "Settings → ACP Providers (New Adapter) → Agent registry.",
    before:
      "Every installable agent had a bright filled 'Add' or 'Update' button, so a long list was a column of competing primary buttons. 'Remove' was an outline button, and every status badge was the same grey block, so 'Update available' looked like 'Added'. Icons were bare 14 px glyphs, a long note broke mid-word ('co mmand'), and the list was a flat box.",
    after:
      "Add and Update are soft extra-small row buttons with a Plus or ArrowUp icon, and show a spinner while working. Remove is a ghost button placed before them. Badges are coloured by status: green 'Added', amber 'Update available', and neutral grey for 'Built in' and 'Manual install'. Agent icons sit in 32 px tiles, versions are monospace, notes wrap at word boundaries, and the list is a rounded card with seam dividers. Refresh shows a rotating icon while it works, and the search field has a magnifier. In the Ladle capture the magnifier sits slightly left, because Ladle does not compile this plugin's left-3 class.",
    why: "The surface has one obvious action style per row, and the list's state reads at a glance.",
    files: ["plugins/provider-acp-next/app.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "usage-providers-acp-registry-hierarchy-before.png",
    afterShot: "usage-providers-acp-registry-hierarchy-after.png",
  },
  {
    id: "usage-providers-acp-registry-notices",
    area: "p2-usage-providers",
    title:
      "Registry errors and saved-copy notices move to the top as tinted notices",
    kind: "state",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open the Agent registry while the registry is unreachable, or after an Add fails.",
    before:
      "'Showing a saved copy. The registry could not be reached…' and add errors appeared as small right-aligned text under the list, easy to miss.",
    after:
      "These messages appear above the search field. The saved copy shows as an amber notice with a cloud-off icon, and failures as a red notice with an alert icon. The wording is unchanged.",
    why: "The owner sees that the list may be out of date before acting on it.",
    files: ["plugins/provider-acp-next/app.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "usage-providers-acp-registry-notices-before.png",
    afterShot: "usage-providers-acp-registry-notices-after.png",
  },
  {
    id: "usage-providers-acp-registry-loading",
    area: "p2-usage-providers",
    title:
      "Registry loads with skeleton rows, and its empty states get an icon",
    kind: "state",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open the Agent registry settings on a slow connection, or search for a name that matches nothing.",
    before:
      "The empty box showed a single line, 'Loading the registry…'. Empty results were one plain sentence.",
    after:
      "While loading, three skeleton rows appear in the final layout (icon tile, name, description, action), announced to screen readers as a status. An empty search shows a centred magnifier with 'No agent matches that search.', and an empty registry shows a toolbox icon with 'No agents to show.'",
    why: "Loading and empty states match the finished list instead of a bare sentence.",
    files: ["plugins/provider-acp-next/app.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "usage-providers-acp-registry-loading-before.png",
    afterShot: "usage-providers-acp-registry-loading-after.png",
  },
  {
    id: "usage-providers-pi-dialog-fields",
    area: "p2-usage-providers",
    title: "Pi extension dialogs use the shared input and textarea",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Wait for a Pi extension to ask for input or editor text in a chat, then focus the field.",
    before:
      "The fields were a hand-styled raw input and textarea with only a faint border tint on focus. The question was not tied to the field, and 'This request could not be displayed.' was plain text.",
    after:
      "The fields are the shared Input and Textarea, with the field focus halo and coarse-pointer sizing. At rest they look almost the same as before. The question labels the field through aria-labelledby, and the unrenderable state is a tinted notice with an icon.",
    why: "Provider dialogs get consistent, accessible fields.",
    files: ["plugins/provider-pi/app.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: "usage-providers-pi-dialog-fields-before.png",
    afterShot: "usage-providers-pi-dialog-fields-after.png",
  },
  {
    id: "usage-providers-codex-elicitation-feedback",
    area: "p2-usage-providers",
    title: "Codex MCP elicitation: failure and sending states",
    kind: "state",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open a Codex MCP elicitation card while its response is sending, or after sending fails.",
    before:
      "'Could not send this response…' was loose red text, and 'Sending response…' was a plain grey line.",
    after:
      "The failure is a tinted destructive notice with an alert icon, and the sending line has a small spinner.",
    why: "Failure and progress read as states rather than stray text.",
    files: ["plugins/provider-codex/app.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "usage-providers-story-usage-accounts",
    area: "p2-usage-providers",
    title:
      "New Ladle stories for account grouping, sign-in and error states, and loading",
    kind: "story",
    storyId: "plugins--provider-usage-accounts--several-accounts-per-provider",
    beforeStoryId:
      "plugins--provider-usage-accounts--several-accounts-per-provider",
    howToSee:
      "Ladle → plugins/Provider usage accounts: Several Accounts Per Provider, Sign In And Errors, and Accounts Loading.",
    before:
      "No story isolated several accounts per provider, every account state side by side, or per-account loading.",
    after:
      "Three stories render UsageSettingsContent through its public props only, so the same file also works in the BEFORE checkout.",
    why: "The grouping and state changes can now be reviewed.",
    files: ["plugins/provider-usage/provider-settings.stories.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "usage-providers-story-usage-accounts-after.png",
  },
  {
    id: "inbox-every-section-collapsible",
    area: "p2-inbox",
    title: "Every Inbox section can be folded, and each choice is remembered",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open the Inbox, click the Ready to archive, Needs you or Finished heading, then reload Omnyo.",
    before:
      "Only Running, Waiting and Shelf had a fold toggle. Needs you, Failed, Finished and Ready to archive had plain text headings that could not fold. Running forgot its state on reload. Folding Waiting hid only the 'Comes back by itself' rows, so a Waiting section that held only 'On you' chats did not visibly fold.",
    after:
      "Every heading (Needs you, Failed, Finished, Ready to archive, Running, Waiting, Shelf) is a toggle with a leading chevron. This device remembers each choice: Running under its own storage key and the others in the existing folds storage. All sections start open except the Shelf. With a tag filter on, folds last only for the session, as before. Folding Waiting hides the whole section while its heading keeps the count. Clicking the 'N new questions' pill opens Needs you if it was folded.",
    why: "Example 6: Alex could fold Running but not Ready to archive.",
    files: [
      "omnyo-plugins/chat-topics/components/feed.tsx",
      "omnyo-plugins/chat-topics/app.tsx",
      "omnyo-plugins/chat-topics/lib/feed-store.ts",
      "omnyo-plugins/chat-topics/app.css",
      "omnyo-plugins/chat-topics/tests/row-interactions.e2e.mjs",
      "omnyo-plugins/chat-topics/README.md",
      "omnyo-plugins/chat-topics/skills/chat-topics/SKILL.md",
      "omnyo-plugins/chat-topics/PLUGIN_OVERVIEW.md",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "inbox-every-section-collapsible-before.png",
    afterShot: "inbox-every-section-collapsible-after.png",
  },
  {
    id: "inbox-section-header-redesign",
    area: "p2-inbox",
    title:
      "Section headings have a leading chevron, a count pill beside the title and a hover target",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee: "Look at any Inbox section heading and hover over it.",
    before:
      "Headings were small grey labels. On some headings the chevron came after the label, and on others it was missing. The count sat alone at the far right edge, away from its label.",
    after:
      "Every heading has the same layout. The chevron comes first, the label lines up with the row titles, and the count sits next to the label in a rounded pill. The Needs you pill uses the attention colour and the Failed pill uses the error colour. The whole toggle shows a hover fill, and the chevron turns on the smooth motion token (no turn under Reduce Motion). On a narrow sidebar the inline note truncates first, then the label, and the heading button never shrinks.",
    why: "Gives every section one consistent structure and puts each count next to its label.",
    files: [
      "omnyo-plugins/chat-topics/components/feed.tsx",
      "omnyo-plugins/chat-topics/app.css",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "inbox-section-header-redesign-before.png",
    afterShot: "inbox-section-header-redesign-after.png",
  },
  {
    id: "inbox-waiting-structure",
    area: "p2-inbox",
    title:
      "Waiting no longer has a bare 'Comes back by itself' sub-heading under its title",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open the Inbox and look at the Waiting section. The single-group case is in /tmp/claude-501/polish2/inbox/final/section-waiting.png.",
    before:
      "The heading read 'Waiting ⌄ … 4'. Directly below it came a second grey heading, 'Comes back by itself' (or 'On you'), and then the rows.",
    after:
      "When every waiting chat is in one group, the heading says so inline: 'Waiting (4) come back on their own', or 'Waiting (1) on you'. No sub-heading row appears. When both kinds exist, quiet indented dividers with a count and a hairline separate them: 'Waiting on you 1' and 'Comes back on its own 3'.",
    why: "Example 8: Alex called this section 'horrible' because its structure was unclear.",
    files: [
      "omnyo-plugins/chat-topics/components/feed.tsx",
      "omnyo-plugins/chat-topics/app.css",
      "omnyo-plugins/chat-topics/README.md",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "inbox-waiting-structure-before.png",
    afterShot: "inbox-waiting-structure-after.png",
  },
  {
    id: "inbox-pending-results-plain-words",
    area: "p2-inbox",
    title: "A reply chip that explains itself replaces 'N pending results'",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "In Waiting, find a chat that finished turns while it waited. Hover over the speech-bubble chip at the right of its row, or Tab to it.",
    before:
      "Waiting rows had a third line, '4 pending results' or '1 pending result', with no explanation.",
    after:
      "The third line is gone. The row ends in a speech-bubble chip with the number. The chip's tooltip and accessible name read '4 new replies since you last wrote or acted on this chat'. This wording matches the source data: pendingResults counts unhandled 'result' receipts, which are the chat's finished turns. An owner message (acknowledgeOwnerMessage) or an Inbox move clears them.",
    why: "Example 5: 'wtf is a pending result'. The change also removes a line from every such row.",
    files: [
      "omnyo-plugins/chat-topics/components/feed.tsx",
      "omnyo-plugins/chat-topics/components/row-rail.tsx",
      "omnyo-plugins/chat-topics/app.css",
      "omnyo-plugins/chat-topics/tests/row-interactions.e2e.mjs",
      "omnyo-plugins/chat-topics/PLUGIN_OVERVIEW.md",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "inbox-pending-results-plain-words-before.png",
    afterShot: "inbox-pending-results-plain-words-after.png",
  },
  {
    id: "inbox-row-chips-explained",
    area: "p2-inbox",
    title:
      "The glyphs at row ends are one chip family with real tooltips, and the subchat chip uses a stack icon",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Hover over the chips at the right of a row that has subchats or continues an earlier chat. The Projects view uses the same chips. See also /tmp/claude-501/polish2/inbox/final/tip-continuation.png.",
    before:
      "Rows ended in a loose curved arrow (the continuation mark) and a '> 1' pill. Both relied on a native title attribute, which needs a long hover and often does not show.",
    after:
      "All row-end markers share one chip: the same 20 px pill, even 4 px gaps and a 12 px icon. The subchat toggle shows a stack icon with the count, plus a small attention dot when a subchat has new replies. Its tooltip reads 'Show 1 subchat', or 'Hide 5 subchats · 2 with new replies'. The continuation chip's tooltip reads 'Continues 1 earlier chat. Show the subchats to see it.' The earlier chat shows an 'Earlier chat' chip whose tooltip reads 'The conversation continues in the chat above.' Tooltips use the app's tooltip colours, open after 350 ms, render in the top layer so the sidebar never clips them, and close on scroll, Escape or press. The subchat and reply chips also open their tooltip on keyboard focus. The continuation chip sits inside the row link, so it is not a tab stop and gives its meaning through its accessible name.",
    why: "Example 5: the 'weird things on the right that dont explain themselves' and the uneven padding.",
    files: [
      "omnyo-plugins/chat-topics/components/hint.tsx",
      "omnyo-plugins/chat-topics/components/row-rail.tsx",
      "omnyo-plugins/chat-topics/components/continuation-mark.tsx",
      "omnyo-plugins/chat-topics/app.css",
      "omnyo-plugins/chat-topics/README.md",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "inbox-row-chips-explained-before.png",
    afterShot: "inbox-row-chips-explained-after.png",
  },
  {
    id: "inbox-archive-all-action",
    area: "p2-inbox",
    title: "Ready to archive gets a visible Archive all button",
    kind: "interaction",
    storyId: null,
    beforeStoryId: null,
    howToSee: "Look at the Ready to archive heading when it holds chats.",
    before:
      "Bulk archive was reachable only through the hidden Shift+E shortcut.",
    after:
      "A soft xs button sits at the right of the Ready to archive heading. It reads 'Archive all' when every chat in the section qualifies and 'Archive N' when some are skipped because they are busy or are run groups. Its tooltip names Shift E, and it carries aria-keyshortcuts. It opens the same confirmation as Shift+E, which lists exactly what will be archived. The archive action itself is unchanged.",
    why: "Gives an existing action a visible control.",
    files: [
      "omnyo-plugins/chat-topics/components/feed.tsx",
      "omnyo-plugins/chat-topics/app.css",
      "omnyo-plugins/chat-topics/README.md",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "inbox-archive-all-action-before.png",
    afterShot: "inbox-archive-all-action-after.png",
  },
  {
    id: "inbox-bulk-archive-panel",
    area: "p2-inbox",
    title:
      "The bulk-archive confirmation reads clearly: a question, an explanation, one line per chat and real buttons",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee: "Click Archive all, or press Shift+E in the Inbox.",
    before:
      "The panel read 'Archive 2 chats'. Each chat was a bold title followed by 'Turn finished · Turn finished · Turn finished …' in faint grey. Cancel was bare text.",
    after:
      "The title asks 'Archive 2 finished chats?', and a note says 'Nothing is running in these chats. Archived chats leave the Inbox.' The note is true because busy families are excluded. Each chat shows its project icon, its title and its recap clamped to two lines. The primary button reads 'Archive 2', and Cancel is a ghost button with an Esc hint. When nothing qualifies, the panel says so in plain words.",
    why: "The confirmation was hard to read, and its actions looked like text.",
    files: [
      "omnyo-plugins/chat-topics/components/feed.tsx",
      "omnyo-plugins/chat-topics/app.css",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "inbox-bulk-archive-panel-before.png",
    afterShot: "inbox-bulk-archive-panel-after.png",
  },
  {
    id: "inbox-secondary-text-contrast",
    area: "p2-inbox",
    title: "Secondary text in the Inbox is legible in both themes",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Compare the second lines of rows, such as 'Omnyo 1.0.148 is offered…', and the amber question lines in light mode.",
    before:
      "Detail lines, counts and group labels used the foreground colour at 36–60% opacity, which is below AA. The darkest detail-text pixel measured 90,93,99 in dark mode. The amber needs-you lines were bright amber (220,158,18) on the light background, at about 2:1 contrast.",
    after:
      "The feed's label tokens map to --muted-foreground and --subtle-foreground at full strength. Detail text now measures 150,152,157 in dark mode. The needs-you line uses the tone-aware text colour, which is a darker amber in light mode (150,116,57) and unchanged in dark mode.",
    why: "Meets the readability bar and DESIGN.md's rule against opacity-reduced text tokens.",
    files: ["omnyo-plugins/chat-topics/app.css"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "inbox-secondary-text-contrast-before.png",
    afterShot: "inbox-secondary-text-contrast-after.png",
  },
  {
    id: "inbox-section-open-stagger",
    area: "p2-inbox",
    title: "Rows stagger in when the owner opens a section",
    kind: "animation",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Fold Ready to archive or Running, then open it again at 1x speed. The after shot freezes the animations at 95 ms.",
    before: "Opening a section made all its rows appear at once.",
    after:
      "When the owner opens a section, its rows and sub-group dividers fade in and move down 4 px on the fast duration and ease-out. Each item starts one stagger token (30 ms) after the previous one, capped at 150 ms. A filmstrip of three rows measured opacity 0.98, 0.86 and 0.67 in the same frame. Nothing animates on first paint, on a system reveal or under a filter change. Under Reduce Motion the rows only crossfade.",
    why: "Follows DESIGN.md's staggered-arrival role for reveals the owner starts.",
    files: [
      "omnyo-plugins/chat-topics/components/feed.tsx",
      "omnyo-plugins/chat-topics/app.css",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: "inbox-section-open-stagger-after.png",
  },
  {
    id: "inbox-loading-error-empty-states",
    area: "p2-inbox",
    title:
      "Loading, error, empty-Inbox and empty-section states say what is happening",
    kind: "state",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open the Inbox during a cold load. Turn on 'Show empty sections' in the Inbox right-click menu. Empty the shown sections, or hide some sections.",
    before:
      "Loading showed the plain line 'Loading the Inbox…'. A load error showed one grey sentence. An empty Inbox showed 'No chats to show'. With 'Show empty sections' on, an empty section was a bare heading.",
    after:
      "Loading shows a static skeleton of two groups, laid out like the feed, with the screen-reader label 'Loading the Inbox'. A load error shows a centred alert icon, 'The Inbox didn’t load', and what to do next. The empty Inbox shows a check, 'Nothing needs you' and a line saying what appears there. When sections are hidden, that line instead says how many are hidden, followed by the right-click hint. Empty open sections say 'Nothing is running', 'Nothing to archive', 'The Shelf is empty' and so on.",
    why: "Every state now says what is happening and what comes next, and the empty Inbox no longer suggests that nothing exists while sections are hidden.",
    files: [
      "omnyo-plugins/chat-topics/components/feed.tsx",
      "omnyo-plugins/chat-topics/app.css",
      "omnyo-plugins/chat-topics/tests/row-interactions.e2e.mjs",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "inbox-toast-and-notices",
    area: "p2-inbox",
    title: "The Undo bar and error notices look like real UI",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Archive or clear a card in the Inbox, or trigger a refused action.",
    before:
      "The Undo bar was a 22 px line of grey text with a text-styled 'Undo'. Errors were grey sentences that looked like ordinary copy.",
    after:
      "The bar is a rounded card with a success check (or a rotate icon after an undo), the message and a soft 'Undo Z' button, and it fades in on the fast token. Errors are destructive-tinted notices with an alert icon. The refresh-failure notice reads 'Couldn’t refresh the Inbox. It shows the last update.'",
    why: "Removes actions styled as bare text, and errors no longer look like content.",
    files: [
      "omnyo-plugins/chat-topics/components/feed.tsx",
      "omnyo-plugins/chat-topics/app.css",
      "omnyo-plugins/chat-topics/tests/row-interactions.e2e.mjs",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "inbox-row-actions-soft",
    area: "p2-inbox",
    title: "Row actions are soft buttons with an explanation and touch sizing",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee: "Look at 'It happened' on a Waiting-on-you row.",
    before:
      "'It happened' was a bordered pill with no explanation, and it kept the same size on touch.",
    after:
      "Row actions use the soft xs look: a translucent fill and no border. They grow to 28 px on coarse pointers and dim when disabled. Hovering 'It happened' shows 'Tell the chat that what it’s waiting for has happened (H)'. The wait menu's text and date inputs show the field focus halo instead of a hard outline.",
    why: "Gives row actions one consistent hierarchy and explains a jargon action.",
    files: [
      "omnyo-plugins/chat-topics/components/feed.tsx",
      "omnyo-plugins/chat-topics/app.css",
    ],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: "inbox-row-actions-soft-before.png",
    afterShot: "inbox-row-actions-soft-after.png",
  },
  {
    id: "glance-tidy-dev-servers-status-rows",
    area: "p2-glance-tidy",
    title: "Dev servers list: structured status rows with one clear action",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open a chat that has a managed preview. The shelf above the composer (or the Dev servers popup on mobile) lists the chat's servers.",
    before:
      "Bare text lines. Each had a grey dot, 'localhost:61424', a right-aligned run-on string 'Running · Mac Pro' and a text-only 'Open'. A failed server read 'Recent server · Didn't start · Mac Pro  Restart', with the exit message as loose grey text under it.",
    after:
      "Each server is a row in a bordered list: a status dot, the address as the title, a tinted status badge (green 'Running', red 'Didn't start', amber 'Port in use' or 'Computer offline', hollow 'Starting…') and the machine as quiet meta. The recent stopped server also shows 'Last seen running 2 h ago', or 'Not seen running yet' if it has never been seen online. On the right is one soft button: 'Open ↗' for a running server, or 'Restart' with a restart icon (a spinner and 'Starting…' while it starts). A failed server shows its exit message as a red alert line, then 'Fix the cause, then Restart to run its saved command again on Mac Pro.' Port-in-use, offline and unknown states each get one plain sentence. The shelf uses compact 36 px rows, and the popup has a heading with a one-line description.",
    why: "This is Alex's example 3: state, machine and action could not be told apart, and 'Recent server' did not say what it meant. The copy follows the data: lastObservedOnlineAt records when Glance last observed the server online, and Restart reruns the saved command on the owning machine.",
    files: [
      "omnyo-plugins/glance/components/dev-servers.tsx",
      "omnyo-plugins/glance/components/ui/status-row.tsx",
      "omnyo-plugins/glance/components/ui/button.tsx",
      "omnyo-plugins/glance/components/ui/cn.ts",
      "omnyo-plugins/glance/components/ui/focus-ring.ts",
      "omnyo-plugins/glance/tests/dev-servers-ui.test.tsx",
      "omnyo-plugins/glance/README.md",
      "omnyo-plugins/glance/skills/glance/SKILL.md",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "glance-tidy-dev-servers-status-rows-before.png",
    afterShot: "glance-tidy-dev-servers-status-rows-after.png",
  },
  {
    id: "glance-tidy-dev-servers-retry-bar",
    area: "p2-glance-tidy",
    title: "Dev servers error bar with an icon and a real Retry button",
    kind: "state",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Let the server status expire (hide the window for about 15 seconds, then return), or lose the coordinator connection.",
    before:
      "A plain grey sentence, 'Server status expired. Retry to check it.', with 'Retry' as bare text at the far right.",
    after:
      "A recessed rounded bar with an alert icon, the same sentence and a soft 'Retry' button.",
    why: "No action should look like bare text. Not captured in a screenshot: the harness serves fresh fixtures, so this state never appears. The claim is verified from code only.",
    files: ["omnyo-plugins/glance/components/dev-servers.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "glance-tidy-ready-row-labelled-actions",
    area: "p2-glance-tidy",
    title:
      "Ready to archive banner: labelled 'Not ready' and 'Archive' buttons instead of bare icons",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open a chat that Tidy marks Ready to archive. The banner above the composer shows it.",
    before:
      "Two unexplained grey glyphs on the right of the banner: an X and an archive-box icon, with no labels.",
    after:
      "A ghost 'Not ready' button and a soft 'Archive' button with its icon. Their tooltips read 'Not ready: hide this suggestion until the chat gets new input' and 'Archive this chat. You can unarchive it later.'",
    why: "Alex called out icons on the right of rows that do not explain themselves. The tooltip copy matches Tidy's dismissal rule, which hides the suggestion until the chat's next input.",
    files: [
      "omnyo-plugins/glance/components/card.tsx",
      "omnyo-plugins/glance/components/companion.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "glance-tidy-ready-row-labelled-actions-before.png",
    afterShot: "glance-tidy-ready-row-labelled-actions-after.png",
  },
  {
    id: "glance-tidy-loop-section-explained",
    area: "p2-glance-tidy",
    title: "Loop panel explains what it does and gets a clear button hierarchy",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "In a chat that has a Pursue loop, open the Glance chat card popover from the toolbar pill.",
    before:
      "One cramped row: 'Loop  Next check in…' cut off by truncation, two identical bordered buttons ('Edit', 'Stop loop'), then the prompt in grey. Nothing said what a loop does or how often it runs.",
    after:
      "A bordered card with a tinted repeat badge, the title 'Loop' and the sentence 'Wakes this chat with the prompt below every 10 min, and less often while nothing changes.' Under it is 'Next check in 4m · 3 checks of 12' in tabular numbers, then the prompt as a quoted block. A ghost 'Stop loop' and a soft 'Edit' with an edit icon sit bottom-right. In edit mode the buttons become a ghost 'Cancel' and a filled 'Save'.",
    why: "The loop's purpose and interval were never shown, the text was truncated and both actions had the same weight. The interval sentence reflects Pursue's backoff: a quiet check doubles the wait, up to a day.",
    files: ["omnyo-plugins/glance/components/loop.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "glance-tidy-loop-section-explained-before.png",
    afterShot: "glance-tidy-loop-section-explained-after.png",
  },
  {
    id: "glance-tidy-loop-badge-tooltip",
    area: "p2-glance-tidy",
    title: "Toolbar loop countdown chip explains itself on hover",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Hover the repeat icon and countdown at the right end of the Glance pill in a chat that has a loop.",
    before: "An unexplained repeat glyph and '4m', with no tooltip.",
    after:
      "The same chip, now with tabular numbers and the tooltip 'Loop: wakes this chat again in 4m' (or 'Loop: checking now').",
    why: "Alex called out unexplained glyph-and-number chips. The screenshots look identical because the change shows only on hover.",
    files: ["omnyo-plugins/glance/components/loop.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: "glance-tidy-loop-badge-tooltip-before.png",
    afterShot: "glance-tidy-loop-badge-tooltip-after.png",
  },
  {
    id: "glance-tidy-glance-page-collapsible-groups",
    area: "p2-glance-tidy",
    title:
      "Glance page: collapsible, remembered status groups with tone dot, count and plain description",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open the Glance page from the sidebar. Click a group header such as 'Blocked', then reload: the group stays collapsed.",
    before:
      "A plain 'Glance' title, a boxy bordered 'Lines | Cards' toggle and bare-text group headings such as 'Needs you 4' that could not fold. The empty state was one grey line, and the error 'Retry' was underlined text.",
    after:
      "Under the title is the line 'Where every open chat stands, grouped by what it needs.', and the toggle is a recessed segmented control with a raised active segment. Each group header has a rotating chevron, the group's tone dot, a count chip and a plain description: 'Waiting for your answer or approval', 'Stuck until something outside the chat changes', 'Paused on a wait, a queue or another machine', 'Reported complete or ready to archive'. Clicking a header folds the group with a smooth height reveal, and each group's choice is saved in localStorage. Rows gain a keyboard focus ring and a hover tint. The empty state is a dashed panel with an icon, a title and an explanation, and the error is a bar with an icon and a Retry button.",
    why: "Alex asked for every section to be collapsible with the choice remembered, and for a structure that explains itself without jargon such as 'comes back by itself'.",
    files: [
      "omnyo-plugins/glance/components/page.tsx",
      "omnyo-plugins/glance/components/ui/section.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "glance-tidy-glance-page-collapsible-groups-before.png",
    afterShot: "glance-tidy-glance-page-collapsible-groups-after.png",
  },
  {
    id: "glance-tidy-glance-page-row-dedupe",
    area: "p2-glance-tidy",
    title:
      "Glance page rows stop repeating their group's status and explain their end-of-row marks",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open the Glance page and look at the rows under 'Needs you', then hover the phase meter or the dot at the end of a row.",
    before:
      "Every row inside 'Needs you' began with its own orange 'Needs you' chip, and every row under 'Blocked' with a red 'Blocked' chip, repeating the group name five or more times. The black dot at the row end and the four-dash phase meter had no hover explanation.",
    after:
      "Rows start directly with the headline. The tone dot appears once, in the group header. The phase meter has the tooltip 'Phase: Ship, step 4 of 5'. The unseen marker is a blue accent dot with the tooltip and accessible name 'Changed since you last looked'.",
    why: "Repetition without structure is what Alex disliked in the waits list, and unexplained marks at row ends were his example 5. Removing the duplicate chip also gives the headline more width before it truncates.",
    files: [
      "omnyo-plugins/glance/components/page.tsx",
      "omnyo-plugins/glance/components/shared.tsx",
      "omnyo-plugins/glance/components/ui/section.tsx",
      "omnyo-plugins/glance/tests/ui.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "glance-tidy-glance-page-row-dedupe-before.png",
    afterShot: "glance-tidy-glance-page-row-dedupe-after.png",
  },
  {
    id: "glance-tidy-evidence-rows",
    area: "p2-glance-tidy",
    title:
      "Evidence rows: chevron disclosure and tone badges that explain the proof kind",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Expand Details on a Glance card whose chat has Evidence entries.",
    before:
      "Native <details> rows with the browser's disclosure triangle, and a grey 'Reproduced', 'Inspected' or 'Hypothesis' word run into the claim. Command output sat in an unstyled block.",
    after:
      "Each row has a rotating chevron and a tinted badge: green 'Reproduced', neutral 'Inspected' or amber 'Hypothesis'. The badge tooltips read 'Seen directly by running it', 'Established by reading the code' and 'Not proven yet'. An open row gets a recessed background, and the command and its output sit in rounded monospace wells.",
    why: "Removes a raw native control and explains the proof labels. Not captured in a screenshot because the harness chat has no evidence entries; verified from code only.",
    files: ["omnyo-plugins/glance/components/card.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "glance-tidy-card-retry-buttons",
    area: "p2-glance-tidy",
    title: "Glance card errors use an alert line and a real Retry button",
    kind: "state",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Force a card read failure, for example by losing the connection while a chat's Glance card loads.",
    before: "Red text followed by an underlined, link-like 'Retry'.",
    after:
      "An alert icon, the message and a soft 'Retry' button. The failed card strip is a bordered row that matches the other strips.",
    why: "No action should look like bare text. Verified from code only; the harness does not fail card reads.",
    files: ["omnyo-plugins/glance/components/card.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "glance-tidy-tidy-page-cards",
    area: "p2-glance-tidy",
    title:
      "Tidy page: plain-language intro, one action hierarchy and a warning callout for open items",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open the Tidy page from the sidebar when at least one chat is Ready to archive.",
    before:
      "The intro and every card said 'Next-message prediction', which is jargon and also wrong: readiness comes from Omnyo's shared work summary. Each card had an outline 'Not done' next to a filled black 'Archive', so the page stacked one filled primary button per card. The reason was plain text, and open items were a grey box with '· ' bullets headed 'Still open on this chat'.",
    after:
      "The intro reads 'Chats Omnyo judges finished, with the reason it gives. Nothing here is archived until you archive it, and archived chats can be unarchived.' Each card has a bold title that opens the chat (hover underline, focus ring) and the meta 'omnyo · Updated 26m ago'. Each card ends with a ghost 'Not done' and an outline 'Archive', matching the outline 'Archive all' in the title bar. The reason has a green check, and open items appear in an amber 'Still open in this chat' callout with a warning icon. Loading and empty states are centred icon panels ('Checking your chats…' with a spinner, or 'Nothing to tidy' with one explanatory sentence), and errors are tinted alert bars with an icon.",
    why: "Removes misleading jargon, sets a calm and consistent button hierarchy, and makes clear what is still open in a chat.",
    files: ["omnyo-plugins/tidy/app.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "glance-tidy-tidy-page-cards-before.png",
    afterShot: "glance-tidy-tidy-page-cards-after.png",
  },
  {
    id: "glance-tidy-goal-dialog",
    area: "p2-glance-tidy",
    title:
      "Pursue goal dialog explains the judge, shows checks used and frames the last verdict",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "In a chat with an active Pursue goal, click the Goal pill in the chat header.",
    before:
      "The title was just 'Goal', followed by 'Checked 3 of 10 times…', an unlabelled input and a loose grey 'Last check: …' line. A large filled red 'Cancel goal' sat beside 'Save', so the destructive action looked primary.",
    after:
      "The title 'Goal for this chat' has a target icon. The description reads: 'After each turn, an independent judge checks whether this objective is met. If not, the chat keeps working on what is missing; once it is met, the goal clears itself. Editing or cancelling never interrupts the current turn.' The input is labelled 'Objective' and has a helpful placeholder. A 'Checks used  3 of 10' row sits above a progress bar (role=progressbar). The last verdict sits in a framed panel headed 'Judge's last verdict'. 'Cancel goal' is a quiet red text button on the left, and 'Save' is the primary on the right.",
    why: "The goal mechanism was unexplained, and the destructive action had primary weight. The copy matches Pursue's README: an unmet verdict sends a continuation, and a met verdict ends the goal.",
    files: ["omnyo-plugins/pursue/app.tsx", "omnyo-plugins/pursue/README.md"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "glance-tidy-goal-dialog-before.png",
    afterShot: "glance-tidy-goal-dialog-after.png",
  },
  {
    id: "glance-tidy-goal-pill",
    area: "p2-glance-tidy",
    title: "Goal header pill: target icon and a checks-used chip",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Look at the chat header of a chat with an active goal, and at the chat's actions menu.",
    before:
      "A book icon (the 'Explore' glyph), then 'Goal 3/10' and the objective, with the count run into the label.",
    after:
      "A target icon, 'Goal', a small '3/10' count chip and the truncated objective. The accessible name reads 'Goal, checked 3 of 10 times: …'. The thread-actions menu item uses the same target icon.",
    why: "A book is the wrong metaphor for a goal, and the bare '3/10' did not say what it counts.",
    files: [
      "omnyo-plugins/pursue/app.tsx",
      "omnyo-plugins/pursue/goal-menu.ts",
      "omnyo-plugins/pursue/goal-menu.test.ts",
      "omnyo-plugins/pursue/README.md",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "glance-tidy-goal-pill-before.png",
    afterShot: "glance-tidy-goal-pill-after.png",
  },
  {
    id: "glance-tidy-inline-steps-stepper",
    area: "p2-glance-tidy",
    title:
      "Ordered-steps blocks become a connected stepper with tone-coloured markers",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Any assistant reply with an ::ordered-steps block, or the inline-ui fixture case 'steps-all-states' (dark theme: the -dark.png pair, or inline-steps-detail-dark.png).",
    before:
      "A plain decimal list ('1.', '2.') separated by hairlines, with lowercase state pills ('done', 'running').",
    after:
      "Each step has a 22 px numbered circle joined to the next by a vertical connector. A done step is a solid green circle with a green connector. A running step has a blue ring with a soft halo, waiting and blocked steps are amber, failed is red and the rest are neutral. State pills are capitalised ('Done', 'Running'). The list keeps its visible numbers and now declares role=list, so VoiceOver still announces it as a list under list-style:none.",
    why: "Steps blocks in chat read like raw Markdown. The stepper shows progress at a glance and keeps the list order and the visible numbers that the inline-ui contract requires.",
    files: [
      "omnyo-plugins/inline-ui/steps.tsx",
      "omnyo-plugins/inline-ui/steps.css",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "glance-tidy-inline-steps-stepper-before.png",
    afterShot: "glance-tidy-inline-steps-stepper-after.png",
  },
  {
    id: "glance-tidy-inline-callout-tones",
    area: "p2-glance-tidy",
    title:
      "Warning, negative and positive callouts get a tone tint and hairline",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      'An assistant reply with ::callout{tone="negative"} or tone="warning".',
    before:
      "Every callout used the same grey recessed well, and only the small glyph's colour told a failure from a note.",
    after:
      "Positive, warning and negative callouts mix 9% of their tone into the well and add a 22% tone hairline, so a failure reads as a failure. Info, neutral and muted callouts are unchanged.",
    why: "Callout severity was not visible at a glance. The fixture page lacks the host's --surface-recessed token, so the screenshot shows only the hairline; the live host also shows the tint.",
    files: ["omnyo-plugins/inline-ui/app.css"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "glance-tidy-inline-callout-tones-before.png",
    afterShot: "glance-tidy-inline-callout-tones-after.png",
  },
  {
    id: "workspace-tools-left-running-status-rows",
    area: "p2-workspace-tools",
    title:
      "Left running: each process is a status row with a coloured state and real buttons",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open the Left running nav panel (/plugins/leftover-processes/left-running) while a chat has leftover processes.",
    before:
      "Each process was three loose text lines: the name, the command, and '3.1 GB · 1 h · Busy'. Keep and Stop sat on the right as bare text that looked like labels.",
    after:
      "Each process is a row with a coloured status dot and the name, then the memory and 'up 2 h' as muted meta. The command is one truncated monospace line, and hovering shows the full command. Stop is a soft xs button with Keep or Unkeep as a ghost xs button beside it. A row shows its own state badge ('Stops in 23 h', 'Kept running', 'Stopping now') only when its state differs from the rest of its chat (see the next entry).",
    why: "Alex said rows like these were unpolished text with unclear states and actions that did not look like actions.",
    files: [
      "omnyo-plugins/leftover-processes/components/panel.tsx",
      "omnyo-plugins/leftover-processes/components/ui/status-row.tsx",
      "omnyo-plugins/leftover-processes/components/ui/button.tsx",
      "omnyo-plugins/leftover-processes/components/ui/icon.tsx",
      "omnyo-plugins/leftover-processes/tests/panel.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "workspace-tools-left-running-status-rows-before.png",
    afterShot: "workspace-tools-left-running-status-rows-after.png",
  },
  {
    id: "workspace-tools-left-running-chat-state-once",
    area: "p2-workspace-tools",
    title:
      "Left running: a chat-wide state is said once in the chat header, with what it means",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open Left running while a chat with several leftover processes is still using CPU.",
    before:
      "After the first pass, every one of a chat's 98 rows carried the same green 'Still working' badge (before that, every row ended in 'Busy'). Nothing said what it meant.",
    after:
      "When all of a chat's processes share one state, the chat card header shows it once, as a badge beside the chat title, with one plain sentence under it. For example: 'Still working: A process from this chat used CPU since the last check, so nothing stops yet.' Other examples are 'Chat is running: Nothing here stops while the chat is running.' and 'Waiting on open work: The chat still has open work, so nothing stops until it finishes.' The rows drop their repeated badges. Mixed chats keep a badge on each row.",
    why: "The busy and in-use states come from the whole chat (policy.ts decides them from threadBusy and the thread's status), not from each process. Repeating the badge per row was noise, and it wrongly suggested that every process was itself busy.",
    files: [
      "omnyo-plugins/leftover-processes/components/panel.tsx",
      "omnyo-plugins/leftover-processes/tests/panel.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "workspace-tools-left-running-chat-state-once-before.png",
    afterShot: "workspace-tools-left-running-chat-state-once-after.png",
  },
  {
    id: "workspace-tools-left-running-chat-cards",
    area: "p2-workspace-tools",
    title: "Left running: one card per chat and clear machine headers",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open Left running and look at the machine headings and the chat groups below them.",
    before:
      "The machine name, 'Not available on this machine' and 'Last successful inspection 3 min ago.' were three separate grey paragraphs. A chat was a bold title with its memory pushed to the far right, above an indented list with no container.",
    after:
      "Each machine has one header line: a laptop icon, the name in semibold, then a 'Not tracked' or 'Scan failed' badge or 'Last checked 3 min ago'. An unsupported machine shows the real reason it reports, for example 'Process tracking is only available on macOS.' Each chat is a bordered card. Its header holds the chat title as a link with a chevron and '37 processes · 8.5 GB', and the process rows sit inside it with dividers. Light theme was checked (review/leftover-panel-light-after.png).",
    why: "The page had no visible structure, so it was hard to tell which process belonged to which chat or machine.",
    files: [
      "omnyo-plugins/leftover-processes/components/panel.tsx",
      "omnyo-plugins/leftover-processes/components/ui/focus-ring.ts",
      "omnyo-plugins/leftover-processes/tests/panel.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "workspace-tools-left-running-chat-cards-before.png",
    afterShot: "workspace-tools-left-running-chat-cards-after.png",
  },
  {
    id: "workspace-tools-left-running-explainer",
    area: "p2-workspace-tools",
    title: "Left running explains what the page is and when things stop",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee: "Open the Left running panel and read the header.",
    before:
      "The header showed only the title and 'Inspection incomplete. Observed 14.1 GB in 156 processes.' When auto-stop was off, a bare 'Auto-stop is off.' line appeared. 'Show all chats' and 'Retry' were underlined text.",
    after:
      "Under the title, one sentence says these are servers and scripts that chats left behind. Once the list loads, it adds that each one stops by itself shortly after its chat is archived, or once the chat has been idle for the configured number of hours, unless you keep it. The hours come from the live idleHours setting. The summary follows in medium weight. When auto-stop is off, an info notice reads 'Auto-stop is off. Nothing here stops by itself; stop what you no longer need.' 'Show all chats' is an outline button with a back arrow. Errors appear in a red-tinted notice with a soft Retry button.",
    why: "Nothing on the page said what it was or what would happen to these processes.",
    files: ["omnyo-plugins/leftover-processes/components/panel.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "workspace-tools-left-running-explainer-before.png",
    afterShot: "workspace-tools-left-running-explainer-after.png",
  },
  {
    id: "workspace-tools-left-running-empty-and-recent",
    area: "p2-workspace-tools",
    title:
      "Left running: a proper empty state, and a Recent stops section that folds and remembers",
    kind: "interaction",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open Left running for a chat with nothing running, then fold Recent stops and reload the page.",
    before:
      "An empty list showed only the grey sentence 'Nothing left running.' Recent stops was a fixed list of tiny two-line text entries, and failures were red text.",
    after:
      "An empty list shows a dashed card with a check icon, the title 'Nothing left running.' and a line saying whether this covers all chats or one chat. Recent stops is a collapsible section with a chevron and a count chip, and its open or closed state is remembered in localStorage. Its rows are status rows. A failed stop gets a 'Could not stop' badge and its reason on an error line with an alert icon. Loading reads 'Checking what is still running…' with an icon.",
    why: "Alex asked for every section to fold with the choice remembered, and for empty, loading and error states that explain themselves.",
    files: [
      "omnyo-plugins/leftover-processes/components/panel.tsx",
      "omnyo-plugins/leftover-processes/components/ui/section-header.tsx",
      "omnyo-plugins/leftover-processes/components/ui/empty-state.tsx",
      "omnyo-plugins/leftover-processes/components/ui/motion.ts",
      "omnyo-plugins/leftover-processes/tests/panel.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "workspace-tools-left-running-cua-and-companion",
    area: "p2-workspace-tools",
    title:
      "Left running: Cua runtimes and the chat companion card use the same row and button system",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open a chat that left processes running and look at its Left running companion card. If a Cua runtime is tracked, open the panel.",
    before:
      "Cua runtimes were plain text rows with an underlined 'Open owning chat' link and full-sentence meta lines ending in periods. The companion card was a bordered box with two lines of text and nothing showing that it could be clicked.",
    after:
      "Each Cua runtime is a status row whose badge tone follows its state, for example 'Waiting to stop' or 'Cleanup held'. Its meta reads 'Last measured 2.0 GB, 3 min ago' or 'Memory not measured'. 'Open owning chat' is a ghost xs button, and 'Keep running' or 'Allow cleanup' is a soft xs button. The companion card has a terminal icon tile, the process count, the memory and the next step ('Busy' shows as 'Still working'), a trailing chevron and a keyboard focus ring.",
    why: "Text-only actions and a card with no affordance were among the problems Alex named.",
    files: [
      "omnyo-plugins/leftover-processes/components/cua-resources.tsx",
      "omnyo-plugins/leftover-processes/components/companion.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "workspace-tools-handsfree-thread-updates",
    area: "p2-workspace-tools",
    title:
      "Handsfree sessions: thread updates passed to Aide are labelled cards instead of centred italic markdown",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open Handsfree (/plugins/handsfree/sessions) and open a session that announced thread updates.",
    before:
      "Each update Aide was given to announce was a centred block of grey italic text that started with a bell emoji. The paragraphs could run 5–6 lines and showed raw markdown such as **bold** markers and `backticks`, and nothing said what the block was.",
    after:
      "Each update is a left-aligned card with a bell icon, the label 'Update passed to Aide' and its time, followed by the update as plain text clamped to three lines. Hovering the text shows all of it. Markdown markers are stripped, and Aide's own spoken replies stand out clearly against the cards.",
    why: "Long centred italic blocks with raw asterisks were the least polished part of the transcript, and the reader could not tell what they were. The events are thread notices that voice-agent.ts logs when it hands a digest to the voice model.",
    files: ["omnyo-plugins/handsfree/sessions-panel.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "workspace-tools-handsfree-thread-updates-before.png",
    afterShot: "workspace-tools-handsfree-thread-updates-after.png",
  },
  {
    id: "workspace-tools-handsfree-readable-meta",
    area: "p2-workspace-tools",
    title:
      "Handsfree sessions: timestamps, event groups and stat labels are readable",
    kind: "fix",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open a Handsfree session and look at the times next to 'You' and 'Aide', the 'Session activity · N' groups and the EVENTS and COST labels.",
    before:
      "Times, event-group labels and the EVENTS and COST captions used arbitrary 10–11 px sizes at 40–60% text opacity. That falls below AA contrast.",
    after:
      "These labels use the text-2xs and text-xs tokens, and their text is set in text-subtle-foreground or text-muted-foreground at full strength.",
    why: "DESIGN.md forbids text-[Npx] sizes and opacity-reduced text colours because they fail AA.",
    files: ["omnyo-plugins/handsfree/sessions-panel.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: "workspace-tools-handsfree-readable-meta-before.png",
    afterShot: "workspace-tools-handsfree-readable-meta-after.png",
  },
  {
    id: "workspace-tools-stats-hero-unclipped",
    area: "p2-workspace-tools",
    title: "Stats: the bottom line of the hero cards is no longer cut off",
    kind: "fix",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open Stats (/plugins/stats/stats) and look at the four cards at the top.",
    before:
      "A fixed 194 px card height sliced the bottom line of every hero card in half: '3 main 0 subagent 0 unknown', 'Wall-clock throughput', 'Retained after chat deletion' and 'Local, durable SQLite'. Captions were 11 px and footers 10 px, and on narrow widths they shrank to 8–10 px.",
    after:
      "The cards grow to fit their content, at least 194 px tall (170 px when narrow), so every footer line shows in full. Labels and captions are 12 px and footers 11 px. On narrow layouts nothing is smaller than 10 px.",
    why: "Clipped text is the clearest sign of an unpolished surface.",
    files: [
      "omnyo-plugins/stats/app.css",
      "omnyo-plugins/stats/tests/ui.e2e.mjs",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "workspace-tools-stats-hero-unclipped-before.png",
    afterShot: "workspace-tools-stats-hero-unclipped-after.png",
  },
  {
    id: "workspace-tools-stats-units-attached",
    area: "p2-workspace-tools",
    title: "Stats: units sit next to their numbers",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "On Stats, look at 'tok/s' in the throughput card and at 'agents · peak' above the charts.",
    before:
      "Units floated far from their numbers: '0.7' sat at the left edge of the throughput card and 'tok/s' about 500 px away, and '13' sat apart from 'agents · peak' in the chart cards.",
    after:
      "Each unit follows its number on the same baseline with an 8 px gap ('0.7 tok/s', '13 agents · peak'), set at 12–13 px instead of 10–12 px.",
    why: "A detached unit reads as a separate stray label.",
    files: ["omnyo-plugins/stats/app.css"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "workspace-tools-stats-units-attached-before.png",
    afterShot: "workspace-tools-stats-units-attached-after.png",
  },
  {
    id: "workspace-tools-state-machines-needs-you-dedupe",
    area: "p2-workspace-tools",
    title:
      "State machines: the Needs you card stops repeating itself and its action says what it does",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open State machines (/plugins/state-machines/machines) while a machine needs you.",
    before:
      "Inside the 'Needs you' section, each card started with another 'Needs you' pill, then an underlined link 'Omnyo Sentry root-cause maintenance · A step stopped', then the heading 'A step stopped' again. The section had an underlined 'View all (1)' link, and the card's only action was 'Open'.",
    after:
      "In the compact list the extra pill is gone. The machine name is a quiet muted link that underlines on hover, and it drops the state title when that repeats the heading. 'View all (1)' is now a ghost button reading 'See all', or 'See all N' when more than three items are waiting. The card action reads 'Review and decide'.",
    why: "The same words appeared three times in one card, and 'Open' did not say where it led.",
    files: [
      "omnyo-plugins/state-machines/src/ui/attention/AttentionCard.tsx",
      "omnyo-plugins/state-machines/src/ui/screens/MachineList.tsx",
      "omnyo-plugins/state-machines/app.css",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "workspace-tools-state-machines-needs-you-dedupe-before.png",
    afterShot: "workspace-tools-state-machines-needs-you-dedupe-after.png",
  },
  {
    id: "workspace-tools-state-machines-instance-count",
    area: "p2-workspace-tools",
    title: "State machines: '+4 more' now says what it counts",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee: "Look at the Status column of the machine table.",
    before: "The Status column showed '+4 more' and '+1 more' with no noun.",
    after:
      "It reads '+4 more instances' and '+1 more instance', which matches the 'No instances' wording in the same column.",
    why: "A count without a noun is one of the unexplained chips Alex complained about.",
    files: ["omnyo-plugins/state-machines/src/ui/screens/MachineList.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: "workspace-tools-state-machines-instance-count-before.png",
    afterShot: "workspace-tools-state-machines-instance-count-after.png",
  },
  {
    id: "workspace-tools-sentry-sync-status",
    area: "p2-workspace-tools",
    title:
      "Sentry: the sync line says truthfully what state the sync is in, and Refreshing sits on that line",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open Sentry (/plugins/sentry/sentry) and look at the top-left line.",
    before:
      "A pink dot and pink text read 'Last synced Nov 22, 04:25 PM'. The same error colour appeared whether the sync was only partial or actually behind. 'Refreshing…' sat alone on a separate row under the buttons.",
    after:
      "A partial sync (one route still has pages to fetch or has never completed) reads 'Partly synced · last synced …' in muted grey. A sync with an error or more than 15 minutes old reads 'Sync is behind · last synced …' in the warning colour. A healthy sync stays green: 'Synced …'. 'Refreshing…' appears inline on the same line.",
    why: "Pink error text for a sync that was only partial was a false alarm. The first pass labelled that state 'Still syncing', which is untrue when a paged sync was interrupted, so the label now matches what store.ts computes.",
    files: [
      "omnyo-plugins/sentry/src/ui/view.tsx",
      "omnyo-plugins/sentry/src/ui/style.css",
      "omnyo-plugins/sentry/tests/ui.test.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "workspace-tools-sentry-sync-status-before.png",
    afterShot: "workspace-tools-sentry-sync-status-after.png",
  },
  {
    id: "workspace-tools-sentry-issue-details-affordance",
    area: "p2-workspace-tools",
    title:
      "Sentry: issue rows show a labelled Details control and no repeated environment",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Look at the issue rows in the Sentry Inbox, then hover over one and expand it.",
    before:
      "Each row ended in a tiny unlabelled '⌄' glyph next to Start solver. The meta line repeated the environment ('Paraspeech Mac · Direct · direct') or showed a bare '*'.",
    after:
      "Each row shows a 'Details' label with a chevron. On hover it gets a soft pill background, and the chevron rotates on the smooth ease when the row opens (no rotation under Reduce Motion). The environment is hidden when the route name already contains it, and '*' reads 'All environments'.",
    why: "Alex named unexplained glyphs on the right of rows and repeated text as problems.",
    files: [
      "omnyo-plugins/sentry/src/ui/view.tsx",
      "omnyo-plugins/sentry/src/ui/style.css",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "workspace-tools-sentry-issue-details-affordance-before.png",
    afterShot: "workspace-tools-sentry-issue-details-affordance-after.png",
  },
  {
    id: "workspace-tools-github-empty-state",
    area: "p2-workspace-tools",
    title:
      "GitHub: an empty list shows an icon and a title instead of a bare table",
    kind: "state",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open the GitHub panel and select Open when there are no open issues. Also try a filter that matches nothing.",
    before:
      "An empty list still showed the ID / TITLE / ASSIGNEE / STATUS / UPDATED column headers above one grey line, 'No open issues in the tracked repos.'",
    after:
      "The column headers are hidden while the list is empty. A centred empty state shows an icon in a ringed circle, a title and the message: a check with 'All clear' when nothing is open, a search icon with 'Nothing matches' for a filter with no results, and a GitHub or pull-request icon for an empty All list. Error messages keep the same component without an icon.",
    why: "Column headers over nothing made the list look broken.",
    files: [
      "omnyo-plugins/workspace-github/components/empty-state.tsx",
      "omnyo-plugins/workspace-github/app.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "workspace-tools-github-empty-state-before.png",
    afterShot: "workspace-tools-github-empty-state-after.png",
  },
  {
    id: "workspace-tools-github-recent-cache-label",
    area: "p2-workspace-tools",
    title:
      "GitHub: 'Recent cache' becomes 'Recent items only' with an explanation",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Look to the right of the All / Open / Closed filter buttons and hover the label.",
    before: "Grey text 'Recent cache' followed the counts with no explanation.",
    after:
      "An info icon and 'Recent items only'. Hovering the label shows, and screen readers hear: 'Counts cover your most recent issues and pull requests, synced every 15 minutes, not every item on GitHub.' This matches the bounded cache the README describes.",
    why: "'Recent cache' was jargon, and the counts could be mistaken for all-time GitHub totals.",
    files: ["omnyo-plugins/workspace-github/app.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "workspace-tools-github-recent-cache-label-before.png",
    afterShot: "workspace-tools-github-recent-cache-label-after.png",
  },
  {
    id: "workspace-tools-worktrees-sort-select",
    area: "p2-workspace-tools",
    title:
      "Worktrees: the Sort control matches the search field instead of looking like a native select",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open Worktrees & Branches from Storage & retention and look under the stat cards.",
    before:
      "Sort was a raw browser select with the system chevron and a hard border. Beside the filled, borderless search field it looked like a different control.",
    after:
      "Sort uses the same 36 px height, filled surface and 8 px radius as the search field, with Omnyo's ChevronDown icon. A border appears on hover, and the app's existing keyboard focus ring is kept.",
    why: "Alex asked for no raw, native-looking controls. The first pass still drew a bordered select next to a borderless field.",
    files: [
      "plugins/storage-retention/src/worktrees/app.tsx",
      "plugins/storage-retention/src/worktrees/style.css",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "workspace-tools-worktrees-sort-select-before.png",
    afterShot: "workspace-tools-worktrees-sort-select-after.png",
  },
  {
    id: "workspace-tools-worktrees-disclosures",
    area: "p2-workspace-tools",
    title:
      "Worktrees: the two disclosures use chevrons, and the attention line explains itself",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Look at 'What gets removed and why it’s safe' and 'N paths need attention' under the toolbar, and open each one.",
    before:
      "Both used the browser's black ▶ triangle, and '47 paths need attention' gave no hint of what it meant.",
    after:
      "Both use a muted chevron that rotates when opened (no rotation under Reduce Motion). The attention line adds a warning icon and the hint 'Not checked in the last scan, so totals may be low'. That matches the 'Partial inventory: N paths unchecked' summary above it.",
    why: "An unexplained warning count and mismatched native markers were both on Alex's list of problems.",
    files: [
      "plugins/storage-retention/src/worktrees/app.tsx",
      "plugins/storage-retention/src/worktrees/style.css",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "workspace-tools-worktrees-disclosures-before.png",
    afterShot: "workspace-tools-worktrees-disclosures-after.png",
  },
  {
    id: "workspace-tools-customizer-defaults-form",
    area: "p2-workspace-tools",
    title:
      "Customizer settings: the form explains itself and has a styled select and a right-sized Save button",
    kind: "ux",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open Settings → Plugins → Omnyo Customizer (/settings/plugins/self-improvement).",
    before:
      "A native select labelled 'Chat folder', the model picker, then a full-width grey 'Save defaults' bar, with no explanation of what these defaults control. Saving showed plain 'Defaults saved.' text.",
    after:
      "An intro says that when you pick part of Omnyo with the Customizer, the New chat dialog it opens starts in this folder with this model, and that until you save, the dialog uses the composer's usual project and model. The folder select is styled with a chevron and a focus halo. A hint under it says that in a folder that is not Omnyo's source, the chat is asked to make the change with settings, a theme or a plugin. Labels are medium weight. 'Save defaults' is a normal-width button above a divider, and the result shows a green check or a red alert icon. Changing a field clears the old message.",
    why: "Settings with no context and a full-width bar for the primary action looked raw. The wording follows the plugin README.",
    files: ["omnyo-plugins/self-improvement/app.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: "workspace-tools-customizer-defaults-form-before.png",
    afterShot: "workspace-tools-customizer-defaults-form-after.png",
  },
  {
    id: "workspace-tools-speech-model-status",
    area: "p2-workspace-tools",
    title:
      "Dictation settings: the speech model status is a labelled status card",
    kind: "state",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Open Settings → Plugins → Dictation (/settings/plugins/local-voice).",
    before:
      "One grey sentence: 'Speech model downloaded. Dictation runs on this Mac.' A download problem used the same grey text, and the Download / Try again button was a raw bordered box.",
    after:
      "A bordered card shows a state dot and a bold label (Ready, Downloading, Download needed, Download failed or Unavailable) above the server's message. The Download model or Try again button is filled and sits inside the card. Problems appear in a red-tinted alert. The first load shows 'Checking the speech model…', which is hidden when an error alert is already showing.",
    why: "The state was not visible at a glance, and errors looked the same as normal status text.",
    files: ["omnyo-plugins/local-voice/app.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: "workspace-tools-speech-model-status-before.png",
    afterShot: "workspace-tools-speech-model-status-after.png",
  },
  {
    id: "integration-toast-action-buttons",
    area: "p2-integration",
    title: "Toast actions are real buttons instead of underlined text",
    kind: "visual",
    storyId: "toasts--catalog",
    beforeStoryId: "toasts--catalog",
    howToSee:
      "Look at the provider-update-failed toast's View log action and any toast with Undo.",
    before:
      "Toast actions such as View log, Relaunch and Undo were grey underlined link text.",
    after:
      "The primary action is a small soft button and cancel is a small ghost button; Undo is soft when it is alone.",
    why: "Actions should read as buttons, never as bare text.",
    files: ["apps/app/src/components/ui/app-toast.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-fast-mode-tooltip",
    area: "p2-integration",
    title: "The lightning toggle beside the model says what it does",
    kind: "ux",
    storyId: "pickers--model-reasoning-picker--pill-composer-favorites",
    beforeStoryId: "pickers--model-reasoning-picker--pill-composer-favorites",
    howToSee: "Hover the lightning icon next to the model name.",
    before: "An icon-only lightning toggle with the bare label Fast mode.",
    after:
      "A tooltip names the next click (Turn on Fast mode, Switch to Ultrafast mode) and explains it asks the provider for its faster, usually costlier service tier.",
    why: "Unexplained icon controls.",
    files: ["apps/app/src/components/pickers/ModelSpeedControl.tsx"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-question-form-descriptions",
    area: "p2-integration",
    title: "Question options keep their descriptions right under the label",
    kind: "visual",
    storyId: "plugins--question-form--compact-question",
    beforeStoryId: "plugins--question-form--compact-question",
    howToSee: "Widen the frame to Fill and read an option with a description.",
    before:
      "In wide composers each option's description sat in a second column about 300 px to the right, reading as unrelated text.",
    after: "The description sits directly under its option label.",
    why: "Readability of question forms.",
    files: ["apps/app/src/components/ui/compact-question-form.css"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-split-load-failure",
    area: "p2-integration",
    title: "A part of Omnyo that fails to load shows a proper error page",
    kind: "visual",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "Shown when a lazily loaded pane fails to download; covered by lazySecondaryPanelComponents.test.tsx.",
    before:
      "Bare red text 'Could not load. Try again' with an underlined link.",
    after:
      "An error empty state titled 'This part of Omnyo didn't load' with a Try again button, plus Reload Omnyo and a one-line reason when the module itself failed.",
    why: "Errors should say what happened and what to do.",
    files: ["apps/app/src/lib/define-split.tsx"],
    note: null,
    pass: 2,
    visibility: "obvious",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-status-row-meta-wrap",
    area: "p2-integration",
    title: "Status rows wrap their details instead of truncating each one",
    kind: "fix",
    storyId: "ui--status-row--overview",
    beforeStoryId: null,
    howToSee: "Set the frame width to Phone.",
    before:
      "At narrow widths every meta item truncated to an ellipsis, e.g. 'Checks agai… · Checked …'.",
    after:
      "Meta items wrap as whole items and only truncate when one alone is wider than the row.",
    why: "Readability at narrow widths.",
    files: ["packages/shared-ui/src/components/ui/status-row.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-segmented-thumb-dark",
    area: "p2-integration",
    title: "The selected segment stands out in dark mode",
    kind: "visual",
    storyId: "ui--segmented-control--overview",
    beforeStoryId: null,
    howToSee: "Look at any segmented control in dark mode.",
    before:
      "The track used the hover tint, close to the thumb, so the selection read mostly through text colour.",
    after:
      "The track uses the recessed surface, so the sliding thumb is clearly visible.",
    why: "Selected state must be visible.",
    files: [
      "packages/shared-ui/src/components/ui/segmented-control.tsx",
      "apps/app/src/components/secondary-panel/FilePreview.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-machine-status-dot-labels",
    area: "p2-integration",
    title: "Machine status dots explain themselves",
    kind: "ux",
    storyId: "settings--machines--rows",
    beforeStoryId: "settings--machines--rows",
    howToSee: "Hover a machine's status dot.",
    before: "Coloured dots with no explanation in settings and dialogs.",
    after:
      "A tooltip names the exact status (Online, Paused, Needs update…), and dialogs announce it to screen readers.",
    why: "Unexplained glyphs.",
    files: [
      "apps/app/src/components/machines/MachineStatusDot.tsx",
      "apps/app/src/components/machines/machine-status.ts",
    ],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-thread-list-empty-contrast",
    area: "p2-integration",
    title: "Empty thread-list messages are legible",
    kind: "visual",
    storyId: "sidebar--thread-list-states--empty-and-error-states",
    beforeStoryId: "sidebar--thread-list-states--empty-and-error-states",
    howToSee: "Look at the empty-state message.",
    before: "The message was at 60% of the subtle text colour.",
    after:
      "Full subtle-foreground strength, meeting AA; the icon stays dimmed.",
    why: "Readability.",
    files: ["packages/shared-ui/src/components/ui/thread-list-empty-state.tsx"],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-queued-wait-wording",
    area: "p2-integration",
    title: "Queued-message wait lines stop repeating themselves",
    kind: "ux",
    storyId:
      "promptbox--banner--queued-messages--scheduled-and-waiting-dispatch",
    beforeStoryId:
      "promptbox--banner--queued-messages--scheduled-and-waiting-dispatch",
    howToSee: "Read the rate-limited and plugin-held rows.",
    before:
      "'Rate limited · held by provider-retry · Rate limited · retrying at 3:18 PM · attempt 2'.",
    after:
      "'Rate limited · held by Provider Retry · retrying at 6:03 PM · attempt 2', with the plugin's display name.",
    why: "Jargon and duplicated text.",
    files: ["apps/app/src/lib/queued-message-wait.ts"],
    note: null,
    pass: 2,
    visibility: "noticeable",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-ladle-plugin-stories",
    area: "p2-integration",
    title: "Plugin settings stories load in Ladle",
    kind: "story",
    storyId: "plugins--provider-settings--acp-registry",
    beforeStoryId: null,
    howToSee:
      "Open the provider settings, keep awake, memory and tasks stories.",
    before:
      "Tasks, keep-awake, memory, push-notification and provider settings had no reviewable stories, and extended icons rendered blank in plugin stories.",
    after: "Their stories load with the plugins' styles and extended icons.",
    why: "Screens could not be reviewed.",
    files: [
      "apps/app/.ladle/config.mjs",
      "apps/app/.ladle/ladle.css",
      "apps/app/.ladle/components.tsx",
    ],
    note: null,
    pass: 2,
    visibility: "subtle",
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "primitives-press-hover-timing",
    area: "p1-primitives",
    title:
      "Buttons and press-feedback controls: hover colour now runs fast/standard, only the scale springs",
    kind: "animation",
    storyId: "ui--button--overview",
    beforeStoryId: "ui--button--overview",
    howToSee:
      "Hover each button, then press and hold one and release it. Compare the hover fade on both servers. The Press row in Theme Tokens / Motion shows the same timing on a default button, an outline button and a tile.",
    before:
      "CONTROL_PRESS_TRANSITION ran every transitioned property (colour, background, border, outline, text-decoration, fill, stroke and scale) over 250 ms on the snappy spring. Button hover fills therefore faded more slowly than inputs and chips, and on a spring curve.",
    after:
      "The seven colour properties fade over 150 ms on the standard curve, and scale releases over 250 ms on snappy. Press-in is still 150 ms to 0.97. Computed values on AFTER: durations 0.15s x7 then 0.25s; timing the standard curve x7, then the snappy spring.",
    why: "DESIGN.md Control hover says colour moves over fast on standard (CONTROL_HOVER_TRANSITION). DESIGN.md Press says scale moves over fast and releases over base, on snappy. The shared owner had applied the press timing to colours too. The change reaches every one of the roughly 60 call sites that use CONTROL_PRESS_TRANSITION, including the shared Button. No consumer overrides its duration or easing classes.",
    files: [
      "packages/shared-ui/src/components/ui/motion.ts",
      "packages/plugin-registry/r/motion.json",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "primitives-split-button-seam",
    area: "p1-primitives",
    title: "Split button halves press toward their shared seam",
    kind: "interaction",
    storyId: "ui--split-button--overview",
    beforeStoryId: "ui--split-button--overview",
    howToSee:
      "Press and hold the 'Commit' half, then the chevron half, of the text primary row.",
    before:
      "Each half scaled to 0.97 around its own centre. The transform origin of the 58 px primary half sat at 29 px, so pressing a half pulled its seam edge in by about 0.9 px and opened a hairline gap.",
    after:
      "The primary half scales from its right edge (origin 58 px) and the chevron half from its left edge (origin 0 px). The seam stays joined while either half is pressed.",
    why: "DESIGN.md Press role on a compound control. A split button is one control and should not come apart under the finger.",
    files: ["apps/app/src/components/ui/split-button.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "primitives-scroll-to-bottom-arrival",
    area: "p1-primitives",
    title: "Jump-to-latest pill appears with a 6 px ease-out rise",
    kind: "animation",
    storyId: "ui--scrolltobottombutton--show-and-hide",
    beforeStoryId: null,
    howToSee:
      "Open ui / ScrollToBottomButton / Show And Hide. Click Show, then Hide. The same component appears in the Overview and In Thread stories.",
    before:
      "When shown, the pill rose 8 px and faded in over 250 ms on the standard curve. Hiding faded it and dropped it 8 px over 150 ms.",
    after:
      "When shown, the pill rises 6 px, with translate and opacity on ease-out over 250 ms. Hiding fades it and drops it 6 px over 150 ms. Hover colour (150 ms), press feedback and Reduce Motion (no travel) are unchanged.",
    why: "DESIGN.md has no dedicated role for this floating pill. The nearest role is Arrival of new content: opacity with at most 6 px rise, over base, on ease-out. Quick in, quicker out.",
    files: ["apps/app/src/components/ui/scroll-to-bottom-button.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "primitives-scroll-to-bottom-story",
    area: "p1-primitives",
    title: "New interactive Show And Hide story for the jump-to-latest pill",
    kind: "story",
    storyId: "ui--scrolltobottombutton--show-and-hide",
    beforeStoryId: null,
    howToSee:
      "Open ui / ScrollToBottomButton / Show And Hide and use the Show/Hide button. Clicking the pill also hides it.",
    before:
      "The existing stories showed only static visible and hidden states, so the enter and exit transitions could not be reviewed.",
    after:
      "A toggle drives the pill's visible prop on a staged pill, so the arrival and the exit can be watched and compared.",
    why: "This state was missing, and it is needed to review the arrival motion. Existing story ids are unchanged.",
    files: ["apps/app/src/components/ui/scroll-to-bottom-button.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "primitives-copy-to-check",
    area: "p1-primitives",
    title:
      "Copy-to-check glyph: snappy settle in, quick fade out, symmetric symbol swap",
    kind: "animation",
    storyId: "ui--markdown-preview--overview",
    beforeStoryId: "ui--markdown-preview--overview",
    howToSee:
      "In the 'code' row, click the copy button at the top right of the ts code block. Watch the glyph swap to a check, then the swap back after the copied state ends. Mermaid source copy and CopyableInlineLabel use the same glyph.",
    before:
      "Both glyphs crossfaded over 150 ms. The check scaled in from 0.9 on snappy. On the way back, the copy glyph only faded in, with no scale.",
    after:
      "Whichever glyph comes in settles from 0.9 to 1 over 250 ms on snappy. The glyph going out fades and shrinks to 0.9 over 150 ms. This applies both ways: copy to check, and check back to copy. Under Reduce Motion the swap is opacity only.",
    why: "DESIGN.md Small control state: the copy-to-check mark travels over base on snappy. Quick in, quicker out.",
    files: ["apps/app/src/components/ui/copy-button.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "primitives-toast-action-hover",
    area: "p1-primitives",
    title: "Toast action links and 'Show more' brighten on hover",
    kind: "interaction",
    storyId: "toasts--catalog",
    beforeStoryId: "toasts--catalog",
    howToSee:
      "Hover 'View log' on the 'Provider CLI / provider update failed' preview, or 'Undo' on an archive toast.",
    before:
      "Hovering a toast action link changed nothing. The link stayed muted (oklch 0.78) and was already underlined, so it gave no hover cue.",
    after:
      "Hovering brightens the link to the foreground colour (oklch 0.897) over 150 ms on standard.",
    why: "DESIGN.md Control hover: interactive controls change colour on hover, over fast on standard.",
    files: ["apps/app/src/components/ui/app-toast.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "primitives-inline-math-loading",
    area: "p1-primitives",
    title:
      "Inline math stays inline while KaTeX loads (no block jump, no invalid DOM)",
    kind: "fix",
    storyId: "ui--markdown-preview--overview",
    beforeStoryId: "ui--markdown-preview--overview",
    howToSee:
      "Reload the story and watch the 'math (LaTeX)' row in the first seconds, before KaTeX arrives. With devtools open, check the console for <p>/<pre> nesting errors.",
    before:
      "Until KaTeX loaded, inline math rendered as a full 'math' code block inside the paragraph, then jumped to inline once KaTeX arrived. React logged 4 nesting errors of the form 'cannot be a descendant of <p>'.",
    after:
      "Until KaTeX loads, inline math renders as inline code inside the sentence. There is no block-to-inline jump and no nesting errors. Display math still falls back to a block. Once KaTeX has loaded, both servers render the same.",
    why: "Loading states should not reflow content, and the DOM must be valid. Root cause: isMarkdownCodeBlock treated remark-math's 'language-math math-inline' code as a fenced block. A regression test covers it.",
    files: [
      "apps/app/src/components/ui/markdown-code-block.ts",
      "apps/app/src/components/ui/markdown-code-block.test.ts",
      "apps/app/src/components/ui/markdown-preview.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "primitives-overflow-fade-story-sizes",
    area: "p1-primitives",
    title:
      "Overflow fade Sizes story actually shows the fades, with correct size hints",
    kind: "story",
    storyId: "ui--overflow-fade--sizes",
    beforeStoryId: "ui--overflow-fade--sizes",
    howToSee: "Open ui / Overflow fade / Sizes, in dark and light themes.",
    before:
      "The above and below fades were positioned outside the clipped stage, so 4 of the 5 rows showed plain rows and no fade. The hints claimed h-8 and h-16 for sm and default, but the code uses h-2 and h-6.",
    after:
      "Each stage has a pinned bar. The above fades sit on a pinned footer, and the below fade hangs under a pinned header, matching how page-shell and StickyUserMessage use them. Rows now dissolve into the bar. The hints read h-2 (8 px), h-6 (24 px) and h-24 (96 px). The left/right row is unchanged.",
    why: "The story was broken and misleading, so the primitive could not be reviewed. Story ids are unchanged.",
    files: ["apps/app/src/components/ui/overflow-fade.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "primitives-overflow-fade-story-tones",
    area: "p1-primitives",
    title: "Overflow fade Tones story shows each tone's fade",
    kind: "story",
    storyId: "ui--overflow-fade--tones",
    beforeStoryId: "ui--overflow-fade--tones",
    howToSee: "Open ui / Overflow fade / Tones, in dark and light themes.",
    before:
      "All three tone stages showed plain rows. Each fade was clipped outside its stage, so the background, sidebar and surface-raised gradients were never visible.",
    after:
      "Each tone stage has a pinned footer, and its above fade blends the rows into that surface, so the three tones can be compared in both themes.",
    why: "The story was broken: the fade tones could not be reviewed.",
    files: ["apps/app/src/components/ui/overflow-fade.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "primitives-theme-typography-tokens",
    area: "p1-primitives",
    title:
      "Theme Tokens story uses typography tokens instead of arbitrary pixel sizes",
    kind: "visual",
    storyId: "theme-tokens--overview",
    beforeStoryId: "theme-tokens--overview",
    howToSee:
      "Open Theme Tokens / Overview and compare the small captions: swatch names, ramp labels, the 'on background' / 'on sidebar' headers and the sidebar widget items.",
    before: "Captions used text-[9px], text-[10px] and text-[11px].",
    after:
      "Captions use the sanctioned text-2xs (10 px) and text-xs tokens. Ramp labels grow from 9 px to 10 px, and group headers move from 11 px to the xs step. Nothing wraps or truncates.",
    why: "AGENTS.md UI rule: use sanctioned typography tokens, never arbitrary text-[Npx].",
    files: ["apps/app/src/components/ui/theme.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "primitives-theme-motion-story",
    area: "p1-primitives",
    title:
      "New Theme Tokens / Motion story: every curve and duration played side by side",
    kind: "story",
    storyId: "theme-tokens--motion",
    beforeStoryId: null,
    howToSee:
      "Open Theme Tokens / Motion and click Play, then Reverse. Press and hold the buttons in the Press row. Under Reduce Motion the dots snap.",
    before: "No story showed the motion tokens that DESIGN.md owns.",
    after:
      "The story has three parts. Curves: standard, out, in, inOut, smooth, snappy and sheet each move a dot over 350 ms, with the curve's use on one line beside it. Durations: sidebar 60, panel 90, fast 150, base 250, drawer 267, slow 350 and sheet 400 ms, all on smooth. Press: a default button, an outline button and a tile, all using CONTROL_PRESS_TRANSITION. Rows keep an even rhythm because no description wraps.",
    why: "The story lets the owner review the motion system itself. It reads only tokens and MOTION_DURATION_MS, with no literal timings.",
    files: ["apps/app/src/components/ui/theme.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "primitives-design-working-orb-loops",
    area: "p1-primitives",
    title:
      "Design system: the working orb's loops are registered as named loop constants",
    kind: "fix",
    storyId: "theme-tokens--motion",
    beforeStoryId: null,
    howToSee: "No visual change. The motion-literals guard now passes.",
    before:
      "motion-literals.test.ts already failed at HEAD on 8 literal timings in app.css. They come from the omnyo-working breathe, ping, spin, halo and sheen loops and the thinking-state ring/halo duration overrides added in commit 444ed3226d. The DESIGN.md list of named loops did not mention them.",
    after:
      "DESIGN.md lists the working orb's breathe (2 s and 2.4 s), ping (2 s), ring spin (0.9 s, or 1.8 s while thinking), halo (2.4 s, or 3.2 s while thinking) and tab sheen (3.2 s) with the other named loops. The guard exempts exactly those keyframes and the .omnyo-working-orb-ring/-halo duration overrides. omnyo-working-tab-in and tab-out stay on tokens and stay guarded. Reduce Motion already stops these loops.",
    why: "DESIGN.md Durations: named loop constants are the only other allowed literal timings, and each lives with its keyframes. This fixes a guard that was already failing.",
    files: ["DESIGN.md", "apps/app/src/components/ui/motion-literals.test.ts"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "primitives-toast-material-test",
    area: "p1-primitives",
    title: "Toast material test updated to the opaque popover surface",
    kind: "fix",
    storyId: "toasts--catalog",
    beforeStoryId: "toasts--catalog",
    howToSee: "No visual change. Run scroll-to-bottom-button.test.tsx.",
    before:
      "The test 'renders toasts on the smoke material' already failed at HEAD. It expected bg-(--material-smoke), but commit a03627c8ee had deliberately moved toasts to an opaque bg-popover surface.",
    after:
      "The test is now named 'renders toasts on the opaque popover material' and asserts bg-popover plus the float shadow. The no-blur assertions are unchanged.",
    why: "A stale test pinned an outdated implementation detail. Its behavioural intent, an opaque surface with no backdrop blur, is kept.",
    files: ["apps/app/src/components/ui/scroll-to-bottom-button.test.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-access-gate-manage-row",
    area: "p1-dialogs-settings",
    title:
      "Manage link sits on the status line in the Add a machine access gate",
    kind: "fix",
    storyId: "dialogs--add-a-machine--access-gate",
    beforeStoryId: "dialogs--add-a-machine--access-gate",
    howToSee: "Look at the 'Omnyo connect unavailable' row.",
    before:
      "A lone 'Manage' link sat on its own line, about 12 px in from the left content edge, above the 'Unavailable  Credential revoked' status line, so it looked detached.",
    after:
      "'Manage' sits at the right end of the status line ('Unavailable  Credential revoked … Manage'), with its text flush with the dialog's right content edge (the edge of the method picker and Save button). The card is about 25 px shorter.",
    why: "Alignment and state polish. The dialog renders MachineAccessStatus without a method picker, so its justify-between row held only one child.",
    files: ["apps/app/src/components/settings/MachineAccessSettings.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-access-section-manage-flush",
    area: "p1-dialogs-settings",
    title: "Manage link aligns to the card's content edge in Machine access",
    kind: "visual",
    storyId: "settings--machine-access--section",
    beforeStoryId: "settings--machine-access--section",
    howToSee:
      "Compare the 'connected', 'connected, no URL yet' and 'unavailable' rows.",
    before:
      "The 'Manage' text sat about 12 px inside the card's right content edge, out of line with the inputs and buttons in the other rows.",
    after:
      "The 'Manage' text lines up with the card's 16 px content inset, the same edge as the Save button in the Manual rows. Its px-3 hit area stays, offset by a matching negative margin.",
    why: "Alignment polish.",
    files: ["apps/app/src/components/settings/MachineAccessSettings.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-access-section-width",
    area: "p1-dialogs-settings",
    title: "Machine access cards fill their column at one consistent width",
    kind: "story",
    storyId: "settings--machine-access--section",
    beforeStoryId: "settings--machine-access--section",
    howToSee: "Scroll through every row of the story.",
    before:
      "Each card shrank to fit its content, so rows ranged from about 290 px to 440 px wide. In the Manual rows the address description wrapped into a narrow column and Save sat on its own line.",
    after:
      "Every card fills the same column, because the StoryCard is capped at max-w-4xl and the section takes w-full. The address description wraps once and Save sits beside the input, as on the real Settings page.",
    why: "The story misrepresented the component. The section's w-full has no effect in the real block layout.",
    files: [
      "apps/app/src/components/settings/MachineAccessSettings.tsx",
      "apps/app/src/components/settings/MachineAccessSettings.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-access-gate-checking-delay",
    area: "p1-dialogs-settings",
    title: "'Checking machine access…' follows the loading-reveal rule",
    kind: "state",
    storyId: "dialogs--add-a-machine--access-gate",
    beforeStoryId: "dialogs--add-a-machine--access-gate",
    howToSee:
      "Reload the story and watch the 'checking' row during the first fraction of a second.",
    before:
      "'Checking machine access…' appeared in the same frame the dialog mounted, so a fast access check flashed it.",
    after:
      "The line appears only after 200 ms and fades in over 150 ms. A min-h-5 slot keeps the dialog's height steady while the line is hidden.",
    why: "DESIGN.md Loading reveal (DelayedLoading).",
    files: ["apps/app/src/components/dialogs/AddMachineDialog.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-access-loading-delay",
    area: "p1-dialogs-settings",
    title: "'Loading connection settings…' follows the loading-reveal rule",
    kind: "state",
    storyId: "settings--machine-access--section",
    beforeStoryId: "settings--machine-access--section",
    howToSee:
      "No story fixture shows this state. In the app it appears on the Machines settings page before the system config loads.",
    before:
      "The spinner and 'Loading connection settings…' showed immediately.",
    after:
      "The row appears after 200 ms and fades in over 150 ms, inside a fixed h-8 slot, so the card does not change height.",
    why: "DESIGN.md Loading reveal (DelayedLoading).",
    files: ["apps/app/src/components/settings/MachineAccessSettings.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-project-path-story-fixtures",
    area: "p1-dialogs-settings",
    title: "Project Path story rows now show the states their hints describe",
    kind: "story",
    storyId: "dialogs--project-path--overview",
    beforeStoryId: "dialogs--project-path--overview",
    howToSee:
      "Look at the 'create', 'wsl', 'unknown platform' and 'machine picker' rows.",
    before:
      "The 'create', 'wsl' and 'unknown platform' rows all showed 'No machine is online … Every machine is offline' instead of the copy their hints described. The 'machine picker' row showed a red 'Internal Server Error' with an empty breadcrumb.",
    after:
      "'create' browses a seeded /Users/michael/Projects listing (omnyo, omnyo-plugins, notes.md) and shows 'Project name: Projects'. 'wsl' and 'unknown platform' use kind add-source, so their WSL /mnt/c/... and generic absolute-path descriptions are visible. 'machine picker' lists the selected machine's folders. The hints were updated to match.",
    why: "The story fixtures were broken and misleading: create mode always browses a machine, so rows without hosts could only render the offline state.",
    files: ["apps/app/src/components/dialogs/ProjectPathDialog.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-path-browser-crumb-hover",
    area: "p1-dialogs-settings",
    title:
      "Folder browser breadcrumbs fade their hover colour and show focus rings",
    kind: "interaction",
    storyId: "dialogs--project-path--overview",
    beforeStoryId: "dialogs--project-path--overview",
    howToSee:
      "In the 'create' row, hover the 'Users' and 'michael' breadcrumbs, then Tab through the breadcrumbs and folder rows.",
    before:
      "The breadcrumb hover background and text colour snapped on. Tabbing to a breadcrumb or folder row showed no visible focus indicator.",
    after:
      "Breadcrumb hover colour fades over 150 ms on the standard curve. Breadcrumbs show a 1 px ring on focus-visible and folder rows an inset 1 px ring. Folder-row hover stays instant.",
    why: "DESIGN.md Control hover (CONTROL_HOVER_TRANSITION) and List row hover (instant), plus focus-visible state polish.",
    files: ["apps/app/src/components/dialogs/RemotePathBrowser.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-path-browser-loading-delay",
    area: "p1-dialogs-settings",
    title: "Folder browser 'Loading…' follows the loading-reveal rule",
    kind: "state",
    storyId: "dialogs--project-path--overview",
    beforeStoryId: "dialogs--project-path--overview",
    howToSee:
      "Visible only when a folder listing takes longer than 200 ms. The story's listings are seeded and load instantly.",
    before:
      "The spinner and 'Loading…' row showed on the first frame of every folder load, so fast listings flashed it.",
    after:
      "The loading row appears only after 200 ms and fades in over 150 ms. A listing that loads sooner replaces the empty pane directly.",
    why: "DESIGN.md Loading reveal (DelayedLoading).",
    files: ["apps/app/src/components/dialogs/RemotePathBrowser.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-server-move-stopped-step",
    area: "p1-dialogs-settings",
    title: "A stopped server move no longer shows a spinning step",
    kind: "fix",
    storyId: "machines--server-move--finished",
    beforeStoryId: "machines--server-move--finished",
    howToSee:
      "Look at the 'server restarted' row. The same rule applies to any ended move (failed, cancelled or abandoned switch) that still has a step marked running.",
    before:
      "'Exporting server data' kept a spinning progress glyph under the 'Server move stopped' title, which contradicts the hint that the app 'says so instead of spinning forever'.",
    after:
      "That step shows a muted empty circle and muted text with a 'Stopped' caption, styled like 'Skipped'. The screen-reader label reads 'Stopped', data-status still reports the raw 'running' value, and live progress states keep their spinner.",
    why: "State polish: a spinner on a terminal state reads as a hang (DESIGN.md Spinners and progress run only while the state is live).",
    files: ["apps/app/src/components/machines/ServerMoveOverlayView.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-attention-error-details",
    area: "p1-dialogs-settings",
    title:
      "'Error details' is a real disclosure with a rotating chevron and expand/collapse",
    kind: "animation",
    storyId: "settings--machine-attention--mixed-issues",
    beforeStoryId: "settings--machine-attention--mixed-issues",
    howToSee:
      "Click 'Error details' under 'Build server cleanup failed', then click it again. It also appears in settings--machine-attention--cleanup-failed.",
    before:
      "A native <details> element with the browser's ▶ marker. The error text snapped in and out, the banner and cards below jumped, and the label had no hover feedback.",
    after:
      "A single chevron rotates 90° over 250 ms on the smooth spring. The message expands over 350 ms and collapses over 250 ms through the shared Collapsible keyframes, and the cards below move with it. The label fades to foreground over 150 ms on hover and shows a focus ring. Under Reduce Motion the chevron turns instantly and the height snaps.",
    why: "DESIGN.md Disclosure chevron (DISCLOSURE_CHEVRON_TRANSITION) and Expand and collapse (COLLAPSIBLE_CONTENT_MOTION).",
    files: [
      "apps/app/src/components/settings/MachinesSettingsSection.tsx",
      "apps/app/src/components/settings/MachinesSettingsSection.test.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-machines-loading-delay",
    area: "p1-dialogs-settings",
    title: "Machines list 'Loading…' follows the loading-reveal rule",
    kind: "state",
    storyId: "settings--machines--rows",
    beforeStoryId: "settings--machines--rows",
    howToSee:
      "No fixture shows this state. In the app it appears while the hosts query loads.",
    before: "'Loading…' showed immediately in the machines card.",
    after:
      "It appears after 200 ms with a 150 ms fade, inside a min-h-5 slot so the card keeps its height.",
    why: "DESIGN.md Loading reveal.",
    files: ["apps/app/src/components/settings/MachinesSettingsSection.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-show-more-focus",
    area: "p1-dialogs-settings",
    title: "'Show all machines' toggle shows a focus ring",
    kind: "state",
    storyId: "settings--machines--rows",
    beforeStoryId: "settings--machines--rows",
    howToSee: "Tab to the 'Show all machines' toggle under the machine list.",
    before: "Keyboard focus on the toggle was invisible.",
    after:
      "A 1 px ring appears on focus-visible. The hover fade and chevron rotation are unchanged.",
    why: "Focus-visible state polish.",
    files: ["apps/app/src/components/settings/ShowMoreToggle.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-env-loading-delay",
    area: "p1-dialogs-settings",
    title: "Environment variables 'Loading…' follows the loading-reveal rule",
    kind: "state",
    storyId: "settings--machine-environment--section",
    beforeStoryId: "settings--machine-environment--section",
    howToSee: "Reload the story and watch the 'loading' row.",
    before: "'Loading…' was present from the first frame.",
    after:
      "'Loading…' appears 200 ms after mount and fades in over 150 ms, inside a min-h-4 slot so the card keeps its height.",
    why: "DESIGN.md Loading reveal.",
    files: ["apps/app/src/components/settings/MachineEnvironmentSettings.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-env-automatic-dim",
    area: "p1-dialogs-settings",
    title: "The automatic GH_TOKEN row dims together with its switch",
    kind: "animation",
    storyId: "settings--machine-environment--section",
    beforeStoryId: "settings--machine-environment--section",
    howToSee: "In the 'first run' row, toggle the GH_TOKEN switch off and on.",
    before:
      "The name, value and caption snapped to 50% opacity in one frame while the switch thumb travelled over 250 ms.",
    after:
      "The name, value and caption fade over 250 ms (base), matching the switch's fill and thumb timing.",
    why: "DESIGN.md Small control state (fill over base). Only opacity animates.",
    files: ["apps/app/src/components/settings/MachineEnvironmentSettings.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-env-global-link-hover",
    area: "p1-dialogs-settings",
    title: "'global settings' link fades its hover colour",
    kind: "interaction",
    storyId: "settings--machine-environment--scopes",
    beforeStoryId: "settings--machine-environment--scopes",
    howToSee: "Hover 'global settings' in a project-scope row caption.",
    before: "The text colour snapped to foreground on hover.",
    after: "The colour fades over 150 ms on the standard curve.",
    why: "DESIGN.md Control hover (CONTROL_HOVER_TRANSITION).",
    files: ["apps/app/src/components/settings/MachineEnvironmentSettings.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-updates-reveal-rows",
    area: "p1-dialogs-settings",
    title: "Machines revealed by 'Show all' fade in",
    kind: "animation",
    storyId: "settings--updates--section-variations",
    beforeStoryId: "settings--updates--section-variations",
    howToSee:
      "In the 'Multiple machines' row, click 'Show all' in the quiet-machines line under the Provider CLIs card.",
    before:
      "The quiet machines popped into the Provider CLIs card in one frame.",
    after:
      "Only the machines revealed by that click fade in over 250 ms; the card's height changes at once. Rows that were already listed stay still. Nothing animates on first paint, on 'Hide', or when a machine later becomes quiet while the list is expanded.",
    why: "Matches the Machines settings reveal (REVEALED_ROW_CLASS) under DESIGN.md Arrival of new content. Status changes do not animate.",
    files: ["apps/app/src/components/settings/UpdatesSettingsSection.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-updates-showall-hover",
    area: "p1-dialogs-settings",
    title: "'Show all' / 'Hide' link fades its hover colour",
    kind: "interaction",
    storyId: "settings--updates--section-variations",
    beforeStoryId: "settings--updates--section-variations",
    howToSee: "Hover 'Show all' in the 'Multiple machines' row.",
    before: "The text colour snapped on hover.",
    after: "The colour fades over 150 ms.",
    why: "DESIGN.md Control hover.",
    files: ["apps/app/src/components/settings/UpdatesSettingsSection.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-upstream-credit-link",
    area: "p1-dialogs-settings",
    title: "'bb' credit link fades its underline and shows a focus ring",
    kind: "interaction",
    storyId: "settings--settings--full-page",
    beforeStoryId: "settings--settings--full-page",
    howToSee:
      "Open the Updates section of the full Settings page, then hover or Tab to 'bb' in 'Omnyo is built on bb'.",
    before:
      "The underline colour snapped on hover, and keyboard focus was invisible.",
    after:
      "The underline colour fades over 150 ms, and focus-visible shows a 1 px ring.",
    why: "DESIGN.md Control hover, plus focus-visible state polish.",
    files: ["apps/app/src/components/settings/UpstreamCredit.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-machine-back-link",
    area: "p1-dialogs-settings",
    title:
      "'‹ Machines' back link fades its hover colour and shows a focus ring",
    kind: "interaction",
    storyId: "settings--machine-page--header",
    beforeStoryId: "settings--machine-page--header",
    howToSee: "Hover the '‹ Machines' link above any header, or Tab to it.",
    before:
      "The colour snapped to foreground on hover, and keyboard focus was invisible.",
    after:
      "The colour fades over 150 ms. On focus-visible a 1 px ring appears with 4 px padding, offset so the text stays in place. The 'Machine is no longer paired' page now uses the same link, as one shared component.",
    why: "DESIGN.md Control hover and focus-visible polish. The duplicated link was merged into one component.",
    files: ["apps/app/src/views/MachineSettingsView.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-permission-radio-dot",
    area: "p1-dialogs-settings",
    title: "The Permission limit radio dot settles in instead of popping",
    kind: "animation",
    storyId: "settings--machine-page--header",
    beforeStoryId: "settings--machine-page--header",
    howToSee:
      "The header story does not show this. In the app, open a machine's settings page and choose a different Permission limit option.",
    before:
      "The 8 px dot appeared and vanished in one frame, and the ring colour switched instantly.",
    after:
      "The dot scales up from 0.5 and fades in over 250 ms on the snappy spring, and the deselected dot reverses the same way. The ring colour fades over 250 ms. Under Reduce Motion the dot only crossfades.",
    why: "DESIGN.md Small control state (radio dot over base on snappy), mirroring the shared RadioGroup indicator.",
    files: ["apps/app/src/views/MachineSettingsView.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-machine-page-links-loading",
    area: "p1-dialogs-settings",
    title:
      "Machine page project links fade on hover, and the page's 'Loading…' follows the loading-reveal rule",
    kind: "state",
    storyId: "settings--machine-page--header",
    beforeStoryId: "settings--machine-page--header",
    howToSee:
      "In the app, open a machine's settings page. Hover the project names under Machine information, and watch the first load.",
    before:
      "The project link colour snapped on hover with no focus indicator, and 'Loading…' showed immediately on every page load.",
    after:
      "The project link colour fades over 150 ms and shows a 1 px ring on focus-visible. 'Loading…' appears only after 200 ms, with a 150 ms fade.",
    why: "DESIGN.md Control hover and Loading reveal.",
    files: ["apps/app/src/views/MachineSettingsView.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-setup-guide-link",
    area: "p1-dialogs-settings",
    title: "'Setup guide' link in Settings fades its hover colour",
    kind: "interaction",
    storyId: "settings--settings--full-page",
    beforeStoryId: "settings--settings--full-page",
    howToSee:
      "Open the section with the open-in-editor setting and hover 'Setup guide' in its description.",
    before: "The colour snapped on hover.",
    after: "The colour fades over 150 ms.",
    why: "DESIGN.md Control hover.",
    files: ["apps/app/src/views/SettingsView.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-usage-codex-speed-disclosure",
    area: "p1-dialogs-settings",
    title:
      "Codex speed and Allowance details expand with a single rotating chevron",
    kind: "animation",
    storyId: "plugins--account-usage--pooled-accounts",
    beforeStoryId: "plugins--account-usage--pooled-accounts",
    howToSee:
      "Wait for the usage popover to open and click 'Codex speed', then 'Allowance details'. Click each again to close it.",
    before:
      "Text glyphs swapped between ▸ and ▾. The panels snapped open and closed, the popover jumped in height, and the row hover colour snapped.",
    after:
      "One chevron glyph rotates 90° over 250 ms on the smooth spring. Each panel expands over 350 ms and collapses over 250 ms through the shared Collapsible and keeps its content while collapsing. The popover grows and shrinks upward smoothly, and the row hover colour fades over 150 ms. Details are still fetched only when a panel opens.",
    why: "DESIGN.md Disclosure chevron ('never swap icons') and Expand and collapse (COLLAPSIBLE_CONTENT_MOTION).",
    files: [
      "plugins/account-usage/components/speed-allowance.tsx",
      "plugins/account-usage/components/glyphs.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-usage-press-feedback",
    area: "p1-dialogs-settings",
    title:
      "The usage footer pill, refresh, Use reset and account repair buttons get press feedback",
    kind: "interaction",
    storyId: "plugins--account-usage--edge-states",
    beforeStoryId: "plugins--account-usage--edge-states",
    howToSee:
      "Press and hold one of these: the footer usage pill while its popover is closed, the popover's refresh icon, 'Use reset' (in pooled-accounts), or the account repair buttons (in edge-states).",
    before:
      "Pressing gave no response. Hover colour on the refresh button and on the repair and reset pills snapped; only the footer pill faded its colour.",
    after:
      "Pressing scales these controls to 0.97 over 150 ms, and they release over 250 ms on the snappy spring. Hover colour fades over 150 ms. The footer pill stays still while its popover is open, and Reduce Motion drops the scale.",
    why: "DESIGN.md Press (CONTROL_PRESS_TRANSITION + CONTROL_PRESS_FEEDBACK) and Control hover.",
    files: [
      "plugins/account-usage/components/usage-footer.tsx",
      "plugins/account-usage/components/account-repair.tsx",
      "plugins/account-usage/components/reset-credits.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "dialogs-settings-usage-story-telemetry",
    area: "p1-dialogs-settings",
    title: "Account usage stories show real Codex speed data",
    kind: "story",
    storyId: "plugins--account-usage--pooled-accounts",
    beforeStoryId: "plugins--account-usage--pooled-accounts",
    howToSee:
      "Open 'Codex speed' in the usage popover. Both account-usage stories show it.",
    before:
      "The panel showed a red measurements-unavailable error, because the story did not stub the plugin's telemetry RPC.",
    after:
      "The panel shows 'gpt-6.1-sol vs Standard 1.5× Fast 2.2× Ultrafast' and a median tokens/s table (27 / 41.7 / 58.2, with turn counts), so the disclosure motion and layout can be reviewed.",
    why: "Broken story fixture: the telemetry RPC stub was missing.",
    files: ["apps/app/src/components/layout/AppFooterUsage.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-more-row-rotating-chevron",
    area: "p1-pickers",
    title: '"N more" / "Show fewer" uses one rotating chevron',
    kind: "animation",
    storyId: "pickers--model-reasoning-picker--open-popover",
    beforeStoryId: "pickers--model-reasoning-picker--open-popover",
    howToSee:
      'Wait for the popover to open, click "All models", then click "2 more" under Codex. Click "Show fewer" to collapse again.',
    before:
      "The glyph swapped from a ChevronDown icon to a separate ChevronUp icon in the same frame as the label change.",
    after:
      "A single ChevronDown rotates 180 degrees over 250 ms on the smooth curve, in both directions. With Reduce Motion it flips instantly.",
    why: "DESIGN.md Disclosure chevron role: one rotating chevron (DISCLOSURE_CHEVRON_TRANSITION); never swap icons.",
    files: ["apps/app/src/components/pickers/ModelPickerMatrix.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-more-rows-reveal-fade",
    area: "p1-pickers",
    title:
      'Rows revealed by "N more" fade in, only when the owner expands them',
    kind: "animation",
    storyId: "pickers--model-reasoning-picker--open-popover",
    beforeStoryId: "pickers--model-reasoning-picker--open-popover",
    howToSee:
      'Click "All models", then click "2 more" under Codex and watch the 5.6-Sol and 5.6-Luna rows appear.',
    before:
      "The hidden-model rows appeared at full opacity in the same frame as the click.",
    after:
      "Only the newly revealed rows fade in, over 250 ms, which is the treatment ShowMoreToggle gives revealed settings rows. The fade runs only when the group goes from collapsed to expanded. First paint, rows already showing, clearing a search and leaving Edit mode with the group expanded all render without it. The animation class is removed when the fade ends.",
    why: "DESIGN.md Arrival of new content, never on first paint or bulk insert. The existing show-more reveal is the precedent. Height is not animated because the rows are CSS subgrid rows that the keyboard cursor indexes.",
    files: ["apps/app/src/components/pickers/ModelPickerMatrix.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-matrix-star-eye-press",
    area: "p1-pickers",
    title: "Press feedback on the favorite star and the hide/show toggles",
    kind: "interaction",
    storyId: "pickers--model-reasoning-picker--edit-mode",
    beforeStoryId: "pickers--model-reasoning-picker--edit-mode",
    howToSee:
      "In Edit mode, press and hold an eye (hide/show) button beside a model name. For the star, open pickers--model-reasoning-picker--pill-composer-non-favorite-model, open the picker and press the outline star at the right of the current 6-Sol row.",
    before:
      "The buttons changed colour on hover over 150 ms and did not move when pressed.",
    after:
      "Pressing scales them to 0.97 over 150 ms, and they release over 250 ms on the snappy curve, like other buttons. The hover colour is unchanged. Reduce Motion removes the scale.",
    why: "DESIGN.md Press role (CONTROL_PRESS_TRANSITION + CONTROL_PRESS_FEEDBACK) for buttons and small controls.",
    files: ["apps/app/src/components/pickers/ModelPickerMatrix.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-popover-toolbar-controls",
    area: "p1-pickers",
    title:
      "Popover toolbar buttons (Back, Edit/Done, Exit handoff) behave as controls",
    kind: "interaction",
    storyId: "pickers--model-reasoning-picker--edit-mode",
    beforeStoryId: "pickers--model-reasoning-picker--edit-mode",
    howToSee:
      'Hover and press the "<" back button and the Edit/Done button in the all-models header. For Exit handoff, open pickers--model-reasoning-picker--existing-chat-active-handoff, then press the X, or Tab to it.',
    before:
      "The buttons used the list-row owner, so the hover fill appeared instantly and pressing did nothing. When focused from the keyboard, the Exit handoff X showed the browser's default focus outline.",
    after:
      "The hover fill eases in over 150 ms, and pressing scales the buttons to 0.97 and back on the snappy curve. The Exit handoff X now shows the app's 1 px ring on keyboard focus, matching the other toolbar buttons.",
    why: "The DESIGN.md Control hover and Press roles name toolbar icons and buttons, while LIST_HOVER_TRANSITION is reserved for rows. The focus ring was inconsistent with the other toolbar buttons.",
    files: ["apps/app/src/components/pickers/ModelReasoningPicker.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-speed-button-press",
    area: "p1-pickers",
    title: "Press feedback on the Fast-mode (Zap) toggle",
    kind: "interaction",
    storyId: "pickers--model-reasoning-picker--account-notice",
    beforeStoryId: "pickers--model-reasoning-picker--account-notice",
    howToSee:
      "Press and hold the Zap button to the right of the model trigger, then release it to toggle Fast mode.",
    before: "It changed colour on hover and did not move when pressed.",
    after:
      "It scales to 0.97 when pressed and settles back on release on the snappy curve. Reduce Motion removes the scale. The same class is used next to the favorites bar.",
    why: "DESIGN.md Press role for buttons and pills.",
    files: ["apps/app/src/components/pickers/ModelSpeedControl.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-load-error-help-link",
    area: "p1-pickers",
    title:
      "The install-help link in model-load errors eases its hover and shows a focus ring",
    kind: "visual",
    storyId: "pickers--model-load-error-states--missing-cli",
    beforeStoryId: "pickers--model-load-error-states--missing-cli",
    howToSee:
      'Open the picker, choose All models if needed, and hover the underlined "CLI not found" link under Codex. Tab to the link to see its focus state.',
    before:
      "The link colour snapped to foreground on hover, and keyboard focus showed the browser's default outline.",
    after:
      "The colour change eases over 150 ms on the standard curve, and keyboard focus shows the app's 1 px ring with a small radius.",
    why: "DESIGN.md Control hover role (CONTROL_HOVER_TRANSITION), and focus rings consistent with the app.",
    files: ["apps/app/src/components/pickers/model-load-error-message.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-loading-rows-delayed-reveal",
    area: "p1-pickers",
    title: "Model-list skeleton rows follow the loading-reveal delay",
    kind: "state",
    storyId: "pickers--model-load-error-states--catalog-loading",
    beforeStoryId: null,
    howToSee:
      "Click the trigger, which shows the spinner and skeleton bars, to open the picker. Watch the Codex group while its models load.",
    before:
      "The four skeleton bars appeared at full opacity the moment the menu opened, so even a fast load flashed placeholders.",
    after:
      "The four rows keep their height and the status region is announced at once. The bars appear only after the 200 ms reveal delay and then fade in over 150 ms. Real content still replaces them without a transition. The same component also draws the microphone picker's loading rows.",
    why: "DESIGN.md Loading reveal role: skeletons and lazy row placeholders appear only after the reveal delay (DelayedLoading), then fade over fast.",
    files: ["apps/app/src/components/pickers/PickerLoadingRows.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-story-catalog-loading",
    area: "p1-pickers",
    title: "New story: model catalog loading",
    kind: "story",
    storyId: "pickers--model-load-error-states--catalog-loading",
    beforeStoryId: null,
    howToSee: "Open the new story, then click the trigger.",
    before:
      "No picker story showed the model list loading, so neither the trigger skeleton nor the loading rows could be reviewed.",
    after:
      'CatalogLoading renders the picker with modelIsLoading set and no error. The trigger shows the brand icon with skeleton bars, and the menu shows delayed skeleton rows under Codex. Claude Code and Pi read "Could not load models." because the fixture gives them no catalog, as in the sibling stories.',
    why: "Missing reviewable loading state.",
    files: ["apps/app/src/components/pickers/ModelLoadErrorStates.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-story-option-open-menus",
    area: "p1-pickers",
    title: "Option Picker open states now render open",
    kind: "story",
    storyId: "pickers--option-picker--open-menu",
    beforeStoryId: null,
    howToSee:
      "Compare pickers--option-picker--overview on both servers, then open the new pickers--option-picker--open-menu and pickers--option-picker--wrapping-menu.",
    before:
      'In the Overview, the "open menu" and "wrapping menu" rows both used defaultOpen. The two menus dismissed each other, so no menu was visible and the wrapping layout could not be reviewed.',
    after:
      "OpenMenu and WrappingMenu each show one menu open; WrappingMenu shows long labels and descriptions wrapping, with the orange warning row. The Overview rows start closed, and their hints say so and name the dedicated stories.",
    why: "Broken, misleading story: Radix non-modal menus close when focus moves outside them, so only one defaultOpen menu can stay open per story.",
    files: ["apps/app/src/components/pickers/OptionPicker.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-story-permission-open-menus",
    area: "p1-pickers",
    title: "Permission Mode Picker open states now render open",
    kind: "story",
    storyId: "pickers--permission-mode-picker--open-menu",
    beforeStoryId: null,
    howToSee:
      "Compare pickers--permission-mode-picker--overview on both servers, then open the new pickers--permission-mode-picker--open-menu and pickers--permission-mode-picker--wrapping-menu.",
    before:
      "The two defaultOpen rows in the Overview cancelled each other, so neither the menu nor the wrapping of long descriptions was visible.",
    after:
      "The new OpenMenu and WrappingMenu stories each show the menu open, including long wrapped descriptions. The Overview rows start closed, with accurate hints.",
    why: "Broken, misleading story (more than one defaultOpen menu).",
    files: ["apps/app/src/components/pickers/PermissionModePicker.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-story-project-open-menus",
    area: "p1-pickers",
    title: "Project Selector open states now render open",
    kind: "story",
    storyId: "pickers--project-selector--open-menu-with-actions",
    beforeStoryId: null,
    howToSee:
      "Compare pickers--project-selector--overview on both servers, then open pickers--project-selector--open-menu, --open-menu-with-actions and --no-projects.",
    before:
      'Three Overview rows claimed defaultOpen, but every popover was closed, so the separator, "New project" and "Don\'t work in a project" were never visible.',
    after:
      'Each state has its own story with its popover open: the project list with the no-project item; the list with "New project" and "Don\'t work in a project" under one separator; and the empty list. The Overview rows start closed, with accurate hints.',
    why: "Broken, misleading story (more than one defaultOpen popover).",
    files: ["apps/app/src/components/pickers/ProjectSelector.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-story-environment-open-menus",
    area: "p1-pickers",
    title: "Environment Picker long-host and open-menu states render open",
    kind: "story",
    storyId: "pickers--environment-picker--long-host-menu",
    beforeStoryId: null,
    howToSee:
      "Scroll pickers--environment-picker--overview to its last two rows on both servers, then open the new pickers--environment-picker--long-host-menu and pickers--environment-picker--open-menu.",
    before:
      "The Overview's last two rows (long host, open menu) both used defaultOpen, so neither popover was open and the wrapping of the long host name could not be seen.",
    after:
      "LongHostMenu shows the long tailnet host name wrapping inside the menu, and OpenMenu shows the options for an online local host. The Overview rows start closed, with accurate hints.",
    why: "Broken, misleading story (more than one defaultOpen popover).",
    files: ["apps/app/src/components/pickers/EnvironmentPicker.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-story-branch-empty-states",
    area: "p1-pickers",
    title: "Branch Picker loading and no-branches menus render open",
    kind: "story",
    storyId: "pickers--branch-picker--loading-branches",
    beforeStoryId: null,
    howToSee:
      "Compare pickers--branch-picker--empty-states on both servers, then open the new pickers--branch-picker--loading-branches and pickers--branch-picker--no-branches.",
    before:
      "Empty States opened two popovers with defaultOpen. Both closed, so the story showed only two closed triggers.",
    after:
      'LoadingBranches shows the open popover with the search field and three skeleton rows under Branches. NoBranches shows "No branches found." The Empty States rows start closed.',
    why: "Broken story: the empty and loading states it exists to show were invisible.",
    files: ["apps/app/src/components/pickers/BranchPicker.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-story-many-machines-frame",
    area: "p1-pickers",
    title: "Many Machines story gets the standard story frame",
    kind: "story",
    storyId: "pickers--environment-picker--many-machines",
    beforeStoryId: "pickers--environment-picker--many-machines",
    howToSee: "Open the story.",
    before:
      "The trigger and its open menu sat flush against the top-left corner of the canvas with no label or padding, unlike every sibling story.",
    after:
      'It sits in the shared StoryCard with the label "many machines" and the hint "twelve connected hosts; the machine list scrolls inside the menu". The picker itself is unchanged.',
    why: "Consistency between stories, so the state is legible on the review page.",
    files: ["apps/app/src/components/pickers/EnvironmentPicker.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "pickers-parent-thread-trigger-press",
    area: "p1-pickers",
    title: "The parent-thread picker trigger uses the shared press owner",
    kind: "interaction",
    storyId: "right-panel--info--row--parent-selector",
    beforeStoryId: "right-panel--info--row--parent-selector",
    howToSee:
      'In the "unassigned" row, hover, then press and hold the Parent trigger; release it to open the popover.',
    before:
      'A bare transition-colors with no press response, unlike the matching minimal "Branch from" trigger.',
    after:
      "It uses CONTROL_PRESS_TRANSITION and CONTROL_PRESS_FEEDBACK: colour on the motion tokens, and a 0.97 press scale while closed. There is no scale while its popover is open or under Reduce Motion.",
    why: "DESIGN.md: one owner per pattern, no bare transition, Press role; a trigger stays still while its menu is open.",
    files: ["apps/app/src/components/pickers/ParentThreadPicker.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "composer-suggestion-actions-clipped",
    area: "p1-composer",
    title:
      "Desktop suggested-reply actions are no longer clipped off the right edge",
    kind: "fix",
    storyId: "composer--suggested-reply--ready",
    beforeStoryId: "composer--suggested-reply--ready",
    howToSee:
      "Open Ready, Loading, Failed or No suggestion at desktop width and look at the action row under the ghost text, at the right of the composer.",
    before:
      "The action row had a -44 px right margin inside the editor's scroll box, so it ran past the card edge. Ready showed the Tab pill and the Suggest another reply icon pressed against the edge, with Dismiss cut off. Failed showed Retry but no Dismiss. Loading showed only a sliver of Stop at the card edge. The editor also overflowed sideways.",
    after:
      "The action row ends on the editor's 16 px content inset. Tab, Suggest another reply and Dismiss (or Stop, Retry, Suggest anyway) are all visible, and Dismiss lines up under the collapse chevron and the send button. Compact layouts are unchanged, because they already reset the margin to 0.",
    why: "A broken state left controls unreachable. The -mr-11 came from an older editor layout that reserved right padding for the send column.",
    files: ["apps/app/src/components/promptbox/ComposerSuggestion.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "composer-suggestion-action-press",
    area: "p1-composer",
    title: "Press feedback on desktop suggested-reply actions",
    kind: "interaction",
    storyId: "composer--suggested-reply--ready",
    beforeStoryId: "composer--suggested-reply--ready",
    howToSee:
      "Press and hold Tab, Suggest another reply or Dismiss (or Stop, Retry or Suggest anyway in the other states).",
    before:
      "The buttons changed colour on hover (transition-colors) and did not respond to a press.",
    after:
      "While pressed, the buttons scale to 0.97 over 150 ms on the snappy spring, then release over 250 ms. The hover colour uses the same shared transition. Under Reduce Motion only the colour changes.",
    why: "DESIGN.md Press role (CONTROL_PRESS_TRANSITION + CONTROL_PRESS_FEEDBACK) for buttons and pills.",
    files: ["apps/app/src/components/promptbox/ComposerSuggestion.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "composer-suggestion-ghost-text-token",
    area: "p1-composer",
    title: "Ghost suggestion text colour change uses the shared hover owner",
    kind: "visual",
    storyId: "composer--suggested-reply--ready",
    beforeStoryId: "composer--suggested-reply--ready",
    howToSee:
      "Not visible: the timing is identical. In the app, the ghost text dims from ready ink to shadow ink when the suggestion is engaged.",
    before:
      "The colour change used a bare transition-colors, which is 150 ms on the standard curve.",
    after:
      "The colour change is the same 150 ms on the standard curve, now set through CONTROL_HOVER_TRANSITION. Nothing looks different.",
    why: "DESIGN.md implementation rule: one owner per pattern.",
    files: ["apps/app/src/components/promptbox/ComposerSuggestion.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "composer-suggestion-card-failed-instant",
    area: "p1-composer",
    title: "Failed suggestion card appears at once instead of rising in",
    kind: "animation",
    storyId: "composer--suggested-reply--compact-state-changes",
    beforeStoryId: null,
    howToSee:
      "In Compact state changes, click Loading, then Ready (the card body rises in), then Failed.",
    before:
      "Every status change remounts the card body. A change from Loading or Ready to Failed faded in the error (role=alert) and lifted it 4 px over 250 ms, like ordinary content. This was verified by inspection, because no BEFORE story could reach that state change.",
    after:
      "Loading and Ready still arrive with a 4 px rise over 250 ms on ease-out. Failed replaces the body in the same frame with no animation (0 running animations, measured).",
    why: "DESIGN.md Where nothing animates: errors, validation messages and inline alerts appear at once.",
    files: ["apps/app/src/components/promptbox/ComposerSuggestionCard.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "composer-suggestion-card-expand-glide",
    area: "p1-composer",
    title: "Long suggested reply expands and collapses with a height glide",
    kind: "animation",
    storyId: "composer--suggested-reply--compact-ready-long",
    beforeStoryId: "composer--suggested-reply--compact-ready-long",
    howToSee:
      "On Compact ready long, click the clamped suggestion text to expand it, then click it again to collapse it.",
    before:
      "The 3-line clamp snapped open to the full text and snapped shut in one frame, and the Edit and Send pills jumped by about 43 px.",
    after:
      "The text height glides from 63 px to 106 px over 350 ms on the smooth spring, and the pills ride down with it. Collapse glides back over 250 ms. Both directions were measured in the browser: 63, 87, 97, 104, 106 px going down and 106, 71, 66, 63 px going up. Under Reduce Motion the height snaps.",
    why: "DESIGN.md Expand and collapse: height over slow on smooth, collapse over base, and size snaps under Reduce Motion. The glide uses getDisclosureDurationMs and the area's existing glidePromptBoxHeight helper. HeightTransition does not fit, because it handles show and hide, not a clamp toggle.",
    files: ["apps/app/src/components/promptbox/ComposerSuggestionCard.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "composer-suggestion-card-icon-press",
    area: "p1-composer",
    title:
      "Press feedback on the card's Suggest another reply and Dismiss icons",
    kind: "interaction",
    storyId: "composer--suggested-reply--compact-ready",
    beforeStoryId: "composer--suggested-reply--compact-ready",
    howToSee:
      "Press and hold the refresh icon or the X icon in the card header (Compact ready, Compact failed, Compact send blocked).",
    before:
      "The round icon buttons changed colour on hover only. The Edit and Send pills beside them already scaled on press.",
    after:
      "The icon buttons scale to 0.97 on press and release on the same snappy spring as the pills. Under Reduce Motion only the colour changes.",
    why: "DESIGN.md Press role. This brings the icons in line with the pills next to them.",
    files: ["apps/app/src/components/promptbox/ComposerSuggestionCard.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "composer-status-tray-chevron",
    area: "p1-composer",
    title: "Chat status chevron rotates on the disclosure spring",
    kind: "animation",
    storyId: "promptbox--follow-up-prompt-box--compact-status-tray",
    beforeStoryId: null,
    howToSee:
      "In Compact status tray, click Chat status to open the tray, then click it again to close it, and watch the chevron.",
    before:
      "The chevron rotated 180 degrees over 150 ms on the standard curve, using a local timing class. This was verified by inspection, because the phone-only tray had no BEFORE story.",
    after:
      "The chevron rotates over 250 ms on the smooth spring (DISCLOSURE_CHEVRON_TRANSITION) and turns instantly under Reduce Motion.",
    why: "DESIGN.md Disclosure chevron role and its single owner.",
    files: ["apps/app/src/components/promptbox/ComposerStatusTray.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "composer-status-tray-toggle-press",
    area: "p1-composer",
    title: "Press feedback on the Chat status pill",
    kind: "interaction",
    storyId: "promptbox--follow-up-prompt-box--compact-status-tray",
    beforeStoryId: null,
    howToSee: "Press and hold the Chat status pill above the compact composer.",
    before:
      "The pill changed colour on hover and when expanded, and did not respond to a press.",
    after:
      "The pill scales to 0.97 while pressed and releases on the snappy spring. It keeps its hover and expanded fills. Under Reduce Motion only the colour changes.",
    why: "DESIGN.md Press role for pills.",
    files: ["apps/app/src/components/promptbox/ComposerStatusTray.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "composer-story-compact-status-tray",
    area: "p1-composer",
    title: "New story: compact status tray",
    kind: "story",
    storyId: "promptbox--follow-up-prompt-box--compact-status-tray",
    beforeStoryId: null,
    howToSee:
      "Open Promptbox / Follow Up Prompt Box / Compact status tray and toggle Chat status.",
    before:
      "No story rendered the phone status tray (the Chat status pill with its queue and context tray). The tray appears only in compact viewports, so it could not be reviewed in Ladle.",
    after:
      "The story shows a 390 px compact composer with a context banner and two queued messages behind the Chat status pill. Opening the tray shows its fade and 8 px slide-in and the chevron rotation.",
    why: "A missing state worth reviewing. The story makes the tray's motion inspectable.",
    files: ["apps/app/src/components/promptbox/FollowUpPromptBox.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "composer-story-compact-state-changes",
    area: "p1-composer",
    title: "New story: suggested reply state changes",
    kind: "story",
    storyId: "composer--suggested-reply--compact-state-changes",
    beforeStoryId: null,
    howToSee:
      "Open composer / Suggested reply / Compact state changes and click Hidden, Loading, Ready and Failed in turn.",
    before:
      "Every suggested-reply story mounted already visible, so the card's arrival animation and its state changes could never be seen.",
    after:
      "Hidden, Loading, Ready and Failed buttons drive one compact composer. The card's rise-in on reveal, the Loading-to-Ready arrival and the instant Failed state can all be reviewed.",
    why: "A missing interactive state. Arrival never runs on first paint, so the story needs a real transition to show it.",
    files: ["apps/app/src/components/promptbox/ComposerSuggestion.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "banners-interactions-workflow-stack-fan-out",
    area: "p1-banners-interactions",
    title:
      "Workflow stack fans out with the disclosure reveal instead of snapping",
    kind: "animation",
    storyId: "promptbox--banner--workflow-card--concurrent-workflows",
    beforeStoryId: "promptbox--banner--workflow-card--concurrent-workflows",
    howToSee:
      'In the "four running" row (wide column), click the front card with the +3 count to fan the stack out. Click the up chevron below the cards to restack.',
    before:
      "Clicking the stacked card replaced the peeking stack with the full list of cards in a single frame, so the composer below jumped down by the height of all the hidden cards at once.",
    after:
      "The front card stays put and the three hidden cards grow out from under it: their wrapper opens from 0 to 126 px while fading in, over 350 ms on the smooth spring (sampled per frame: 0 -> 56 -> 112 -> 126 px, opacity 0 -> 0.44 -> 0.89 -> 1). The resting layout is pixel-identical to before. Restacking still snaps back to the peek. First paint and an already-expanded stack do not animate. Under Reduce Motion the height snaps and only opacity fades over 150 ms.",
    why: "DESIGN.md lists the composer banner stack and workflow cards under Expand and collapse: grid rows plus opacity over slow on smooth through getDisclosureRevealClass. Collapse still snaps so the existing focus handoff back to the stack trigger keeps working.",
    files: ["apps/app/src/components/promptbox/banner/ThreadWorkflowStack.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "banners-interactions-queued-row-hover-instant",
    area: "p1-banners-interactions",
    title: "Queued-row hover affordances appear instantly",
    kind: "interaction",
    storyId: "promptbox--banner--queued-messages--overview",
    beforeStoryId: "promptbox--banner--queued-messages--overview",
    howToSee:
      'Hover a row in "with attachments" or "multiple messages": the row number turns into the drag grip, and the attachment count gives way to the Send, Edit and Delete actions. At a compact width the More button behaves the same.',
    before:
      "Hovering a queued row crossfaded the row number into the grip, the attachment count out and the action bar in over 150 ms. The mobile More button also faded in over 150 ms, and its press released over 150 ms.",
    after:
      "The row number, grip, attachment count, action bar and More button swap in the same frame as the hover or focus, with no fade. The action buttons keep their own colour and press transitions; the More button now uses the shared button press (release over 250 ms on the snappy curve). The send-together divider grip is unchanged and still fades with its pill. The story hint now says hovering swaps the count for the actions instead of saying it crossfades.",
    why: "DESIGN.md Rows versus blocks: affordances revealed by hovering a row in a list appear instantly; the List row hover role covers time/actions swaps.",
    files: [
      "apps/app/src/components/promptbox/banner/QueuedMessagesList.tsx",
      "apps/app/src/components/promptbox/banner/QueuedMessagesList.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "banners-interactions-queued-toggle-press",
    area: "p1-banners-interactions",
    title: "Queue count toggle pill gets press feedback",
    kind: "interaction",
    storyId: "promptbox--banner--queued-messages--overview",
    beforeStoryId: "promptbox--banner--queued-messages--overview",
    howToSee:
      'In "multiple messages", press and hold the count pill with the chevron (top right of the tray), then release.',
    before:
      "The pill only faded its text colour on hover. Pressing it gave no physical feedback.",
    after:
      "Pressing the pill scales it to 0.97 over 150 ms, and it springs back over 250 ms on the snappy curve when released. The hover colour fade is unchanged. Under Reduce Motion there is no scale.",
    why: "DESIGN.md Press role: pills scale on :active through CONTROL_PRESS_TRANSITION + CONTROL_PRESS_FEEDBACK.",
    files: ["apps/app/src/components/promptbox/banner/QueuedMessagesList.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "banners-interactions-queued-summary-hover",
    area: "p1-banners-interactions",
    title: "Collapsed queue summary bar fades its hover fill",
    kind: "interaction",
    storyId: "promptbox--banner--queued-messages--overview",
    beforeStoryId: "promptbox--banner--queued-messages--overview",
    howToSee:
      'In "multiple messages", click the count pill to collapse the queue to its "3 queued messages" bar, then move the pointer on and off that bar.',
    before: "The summary bar's hover background snapped on and off.",
    after:
      "The hover background fades over 150 ms on the standard curve, like the other prompt-stack card headers.",
    why: "DESIGN.md Control hover role: colour changes over fast on standard (CONTROL_HOVER_TRANSITION).",
    files: ["apps/app/src/components/promptbox/banner/QueuedMessagesList.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "banners-interactions-banner-action-press",
    area: "p1-banners-interactions",
    title:
      "Banner action buttons (Unarchive, Restore workspace, Resume, Retry) get press feedback",
    kind: "interaction",
    storyId: "promptbox--banner--context-banner--overview",
    beforeStoryId: "promptbox--banner--context-banner--overview",
    howToSee:
      'Press and hold Unarchive in "archived thread" or Restore workspace in "environment archived (restorable)", then release. The same applies to Resume and Retry in promptbox--banner--machine-status--states.',
    before:
      "These small outlined buttons only faded their colours on hover. Pressing them did nothing visible.",
    after:
      "Pressing scales the button to 0.97 over 150 ms, and it springs back over 250 ms on the snappy curve. Colours still fade on hover over 150 ms. Under Reduce Motion there is no scale. Disabled buttons do not scale.",
    why: "DESIGN.md Press role: buttons use CONTROL_PRESS_TRANSITION + CONTROL_PRESS_FEEDBACK.",
    files: [
      "apps/app/src/components/promptbox/banner/prompt-banner-actions.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "banners-interactions-goal-pill-press",
    area: "p1-banners-interactions",
    title: "Goal pill gets press feedback and stays still while open",
    kind: "interaction",
    storyId: "promptbox--banner--goal-card--overview",
    beforeStoryId: "promptbox--banner--goal-card--overview",
    howToSee:
      'Press and hold the floating "Goal · 20m" pill in "floating pill", then release to open the popover. Press it again while the popover is open.',
    before:
      "The pill only faded its hover fill over 150 ms. Pressing it gave no feedback.",
    after:
      "Pressing the closed pill scales it to 0.97 and springs it back over 250 ms on the snappy curve. While the popover is open the pill does not scale. Under Reduce Motion there is no scale.",
    why: "DESIGN.md Press role: pills use CONTROL_PRESS_TRANSITION + CONTROL_PRESS_FEEDBACK, and a trigger stays still while its menu is open.",
    files: ["apps/app/src/components/promptbox/banner/ThreadGoalCard.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "banners-interactions-goal-story-expanded-fix",
    area: "p1-banners-interactions",
    title: 'Goal Card "expanded" row actually shows the open popover',
    kind: "fix",
    storyId: "promptbox--banner--goal-card--overview",
    beforeStoryId: "promptbox--banner--goal-card--overview",
    howToSee: 'Open the story and look at the "expanded" row.',
    before:
      'The "expanded" and "no token budget" rows each mounted two popovers that started open. They closed each other on load, so the story showed only closed pills and no popover.',
    after:
      'The "expanded" row renders one right-aligned pill with its popover open below it: the full objective, "27,450 / 80,000 tokens", the elapsed time and Clear goal, in a 192 px stage so the popover does not cover the next row. The "no token budget" row now shows closed pills that open on click, and its hint points to the new Expanded Without Budget story.',
    why: "Broken story: the row claimed a state it never rendered.",
    files: [
      "apps/app/src/components/promptbox/banner/ThreadGoalCard.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "banners-interactions-goal-story-unbounded",
    area: "p1-banners-interactions",
    title: "New story: Goal Card expanded without a token budget",
    kind: "story",
    storyId: "promptbox--banner--goal-card--expanded-without-budget",
    beforeStoryId: null,
    howToSee: "Open promptbox/banner/Goal Card -> Expanded Without Budget.",
    before:
      "No story showed the popover for a goal without a token budget; the old row tried to and rendered closed.",
    after:
      'A single open popover shows the unbounded summary: "9,820 tokens" with no cap, 6m 52s elapsed and Clear goal.',
    why: "Missing state: two open popovers cannot share one story because they close each other, so the unbounded summary gets its own export.",
    files: [
      "apps/app/src/components/promptbox/banner/ThreadGoalCard.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "banners-interactions-pending-toggle-press",
    area: "p1-banners-interactions",
    title:
      "Pending-interaction chevron toggle and mobile Minimize get press feedback",
    kind: "interaction",
    storyId: "thread--pending-interaction--approval--overview",
    beforeStoryId: "thread--pending-interaction--approval--overview",
    howToSee:
      'Press and hold the chevron button at the top right of any "Approval needed" card, then release. At a compact width, open a card and press Minimize. The same shell renders the user-question and additional-states stories.',
    before:
      "The 28 px chevron button and the mobile Minimize button only faded their hover fill. Pressing them gave no feedback; the chevron already rotated on the smooth spring.",
    after:
      "Both buttons scale to 0.97 on press over 150 ms and spring back over 250 ms on the snappy curve. The hover fill and the chevron rotation are unchanged. Under Reduce Motion there is no scale.",
    why: "DESIGN.md Press role: buttons use CONTROL_PRESS_TRANSITION + CONTROL_PRESS_FEEDBACK.",
    files: [
      "apps/app/src/components/thread/pending-interactions/PendingInteractionShell.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "banners-interactions-show-more-lines-hover",
    area: "p1-banners-interactions",
    title: '"Show N more lines" in command approvals fades its hover fill',
    kind: "interaction",
    storyId: "thread--pending-interaction--approval--overview",
    beforeStoryId: "thread--pending-interaction--approval--overview",
    howToSee:
      'In "command approval (multi-line script from a child)", hover "Show 3 more lines" under the command.',
    before: "The hover background and text colour snapped on and off.",
    after:
      "The hover background and text colour fade over 150 ms on the standard curve.",
    why: "DESIGN.md Control hover role (CONTROL_HOVER_TRANSITION). This is a single control in a block, not a list row.",
    files: [
      "apps/app/src/components/thread/pending-interactions/ThreadPendingInteractionBanner.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "banners-interactions-prompt-mode-exiting-row",
    area: "p1-banners-interactions",
    title: "Prompt Mode Card story shows the exiting (pending dismiss) state",
    kind: "story",
    storyId: "promptbox--banner--prompt-mode-card--overview",
    beforeStoryId: "promptbox--banner--prompt-mode-card--overview",
    howToSee:
      'Open Prompt Mode Card -> Overview and look at the new "exiting" row above "inactive".',
    before: "No row showed what happens after Exit plan mode is pressed.",
    after:
      'An "exiting" row shows the Plan card with its dismiss cell replaced by a spinning loader and disabled (wait cursor), in both the wide and the narrow stage.',
    why: "Missing state: the in-flight dismiss is a real product state worth reviewing.",
    files: [
      "apps/app/src/components/promptbox/banner/ThreadPromptModeCard.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "banners-interactions-machine-long-name-hint",
    area: "p1-banners-interactions",
    title: 'Machine Status "long machine name" row explains what it shows',
    kind: "story",
    storyId: "promptbox--banner--machine-status--states",
    beforeStoryId: "promptbox--banner--machine-status--states",
    howToSee:
      'Open Machine Status -> States and read the "long machine name" row label.',
    before:
      'The row had no hint and rendered the same "Machine is paused" banner as "paused", so it looked like the long name was missing.',
    after:
      "The row hint says the banner names the state, not the machine, so a long host name leaves it unchanged. The rendered banner is the same.",
    why: "Misleading story: the banner never renders the host name (only the status and the machine icon), so the row needed to say what it proves.",
    files: [
      "apps/app/src/components/promptbox/banner/ThreadMachineStatus.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-git-pill-press",
    area: "p1-work-rows",
    title:
      "Git activity pill gets press feedback and stays lit while its popover is open",
    kind: "interaction",
    storyId: "thread--timeline--rows--assistant-message--turn-git-activity",
    beforeStoryId:
      "thread--timeline--rows--assistant-message--turn-git-activity",
    howToSee:
      'Press and hold the "2 commits · main" pill under the first message. Release to open the Git activity popover, then move the pointer away from the pill.',
    before:
      "Pressing the pill gave no visible response: computed scale stayed 'none' while held. Hover faded the text to foreground, but once the pointer left, the text dropped back to muted even with the popover open (measured oklch 0.78 with data-state=open).",
    after:
      'While held, the pill scales to 0.97 over 150 ms and releases over 250 ms on the snappy curve (measured 0.97 while held). Hover still fades the colour over 150 ms. With the popover open the pill stays still and its text stays at foreground strength (measured oklch 0.897 with the pointer away). The commit row\'s "Open commit on GitHub" icon button, when present, gets the same press feedback.',
    why: "DESIGN.md Press role: pills and buttons use CONTROL_PRESS_TRANSITION + CONTROL_PRESS_FEEDBACK, and a trigger stays still while its menu is open.",
    files: ["apps/app/src/components/thread/timeline/TurnGitPill.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-image-thumbnail-press",
    area: "p1-work-rows",
    title: "Image-view thumbnail gets press feedback",
    kind: "interaction",
    storyId: "thread--timeline--rows--image-view--overview",
    beforeStoryId: "thread--timeline--rows--image-view--overview",
    howToSee:
      'Press and hold the expanded "Sightglass Dashboard" image thumbnail, then release to open the lightbox.',
    before:
      "The zoom-in thumbnail button had no press response: scale stayed 'none' while held, and the lightbox appeared on release.",
    after:
      "While held, the thumbnail scales to 0.97 over 150 ms on the snappy curve and springs back over 250 ms. Under Reduce Motion it does not scale.",
    why: "DESIGN.md Press role: tile-like buttons use CONTROL_PRESS_TRANSITION + CONTROL_PRESS_FEEDBACK.",
    files: ["apps/app/src/components/thread/timeline/TimelineRowDetails.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-turn-hover-text-fade",
    area: "p1-work-rows",
    title: "Turn receipt text fades with its header on hover",
    kind: "animation",
    storyId: "thread--timeline--rows--turn--overview",
    beforeStoryId: "thread--timeline--rows--turn--overview",
    howToSee:
      'Hover the collapsed "Worked for 11s +39 -4" turn header and watch the words "Worked for" and "11s".',
    before:
      'The header background faded in over 150 ms, but "Worked for" and the duration brightened instantly in the first frame (no transition; colour jumped from oklch 0.68 to 0.78).',
    after:
      '"Worked for" and the duration fade over 150 ms together with the background, so the whole header brightens as one piece.',
    why: "DESIGN.md Control hover role: colour changes use CONTROL_HOVER_TRANSITION, and the parent header already did.",
    files: [
      "apps/app/src/components/thread/timeline/TimelineTurnActivityLine.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-show-full-command-hover",
    area: "p1-work-rows",
    title: '"Show full command" toggle fades on hover and shows a pointer',
    kind: "interaction",
    storyId: "thread--timeline--rows--command--highlighted",
    beforeStoryId: "thread--timeline--rows--command--highlighted",
    howToSee:
      'Hover "Show full command" under the Python heredoc command in the first card.',
    before:
      "The toggle's text jumped from muted to foreground with no transition, and the cursor stayed the default arrow.",
    after:
      "The text fades to foreground over 150 ms, and the cursor becomes a pointer.",
    why: "DESIGN.md Control hover role (CONTROL_HOVER_TRANSITION) for text buttons.",
    files: ["apps/app/src/components/thread/timeline/TerminalOutputBlock.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-tool-show-more-opaque",
    area: "p1-work-rows",
    title: 'Tool input "Show more" overlay no longer shows text through it',
    kind: "fix",
    storyId: "thread--timeline--rows--tool--overview",
    beforeStoryId: "thread--timeline--rows--tool--overview",
    howToSee:
      'Look at the end of the last input line in the "notify_user — short" row ("…tasks to child … Show more"), and at the "Show more" band in the "notify_user — long" row.',
    before:
      'The overlay used the translucent surface-recessed tint, so the clipped argument text showed through the fade and the label: in the short row the word "threads" and "Show more" overlapped into an unreadable jumble. In the long row the overlay band was visibly lighter than the input panel, because the tint was applied twice.',
    after:
      'The overlay and its fade use the opaque surface-recessed-solid twin, which matches the input panel exactly (the card behind it is the canvas colour). The text fades out cleanly behind a readable "Show more", and the band no longer shows as a lighter patch, in light and dark themes.',
    why: "State polish: theme.css defines --surface-recessed-solid for overlays that must hide what is behind them without doubling the translucent tint.",
    files: ["apps/app/src/components/thread/timeline/ToolCallDetailBlock.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-tool-show-less-control",
    area: "p1-work-rows",
    title: 'Tool input "Show less" gets a hover fade, pointer and focus ring',
    kind: "interaction",
    storyId: "thread--timeline--rows--tool--overview",
    beforeStoryId: "thread--timeline--rows--tool--overview",
    howToSee:
      'In the "notify_user — short" row, click "Show more", then hover "Show less" below the input, or reach it with Tab.',
    before:
      '"Show less" jumped colour on hover, kept the arrow cursor, and showed no focus indicator when reached by keyboard.',
    after:
      '"Show less" fades to foreground over 150 ms, shows a pointer, and draws the standard 2 px focus ring with small rounded corners when focused from the keyboard.',
    why: "DESIGN.md Control hover role, plus the focus-visible state every control needs.",
    files: ["apps/app/src/components/thread/timeline/ToolCallDetailBlock.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-diff-card-frame",
    area: "p1-work-rows",
    title:
      "Expanded diff card keeps its bottom border and corners under the scroll fade",
    kind: "visual",
    storyId: "thread--timeline--rows--file-change--overview",
    beforeStoryId: "thread--timeline--rows--file-change--overview",
    howToSee:
      'Scroll to the "expanded — large diff" row (ThreadFollowUpComposer.tsx) and look at the bottom edge of the diff card.',
    before:
      "The overflow fade sat outside the bordered scroller and painted over the card's bottom edge: the side borders dissolved into the fade, and the card had no bottom border or rounded bottom corners.",
    after:
      "The border, radius and background sit on the outer frame, which clips its content, so the fade sits inside the card. The bottom border and rounded corners stay crisp while the last lines fade out.",
    why: "State polish: the detail-card frame should stay intact; the fade treats the content, not the card's edge.",
    files: [
      "apps/app/src/components/thread/timeline/TimelineFileDiffBlock.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-placeholder-reveal-fast",
    area: "p1-work-rows",
    title: "Lazy row-body skeleton fades in over the fast token",
    kind: "animation",
    storyId: "thread--timeline--activity--running-to-finished",
    beforeStoryId: "thread--timeline--activity--running-to-finished",
    howToSee:
      "Load the story (or click Restart) and watch the three-line skeleton under the running command before its terminal block loads. It also appears briefly when a large diff in File Change is expanded.",
    before:
      "After its 150 ms reveal delay, the skeleton faded in over 250 ms (base).",
    after:
      "After the same 150 ms delay, the skeleton fades in over 150 ms (fast). Content still replaces it with no transition.",
    why: "DESIGN.md Loading reveal role: appear only after the reveal delay, then fade over fast, matching DelayedLoading.",
    files: [
      "apps/app/src/components/thread/timeline/TimelineRowBodyPlaceholder.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-summary-hover-owner",
    area: "p1-work-rows",
    title: "Summary-tone row header hover uses the shared hover owner",
    kind: "fix",
    storyId: "thread--timeline--rows--bundle-summary--conversation",
    beforeStoryId: "thread--timeline--rows--bundle-summary--conversation",
    howToSee:
      'Hover a summary-tone row header such as "Explored 2 files, 1 search, 1 list".',
    before:
      "The colour change used a bare Tailwind transition-colors (150 ms, standard curve).",
    after:
      "It looks the same (150 ms, standard curve), but the timing now comes from CONTROL_HOVER_TRANSITION, so one constant owns it.",
    why: "DESIGN.md implementation rules: one owner per pattern; no bare transition utilities.",
    files: [
      "apps/app/src/components/thread/timeline/ExpandableTimelineRow.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-preview-open-press",
    area: "p1-work-rows",
    title:
      'Preview activity "Open" link gets a hover transition and press feedback',
    kind: "interaction",
    storyId: "thread--timeline--rows--system--operations",
    beforeStoryId: "thread--timeline--rows--system--operations",
    howToSee:
      'No Ladle story renders this row, because preview activity rows need live managed-preview data. In the app, hover and press the "Open" link on a running preview\'s timeline row.',
    before:
      'The "Open" link changed its background and text colour instantly on hover and did not respond to press.',
    after:
      "Hover colour and fill fade over 150 ms. Pressing scales the link to 0.97 on the snappy curve, with no scale under Reduce Motion.",
    why: "DESIGN.md Control hover and Press roles (CONTROL_PRESS_TRANSITION + CONTROL_PRESS_FEEDBACK).",
    files: ["apps/app/src/components/thread/timeline/PreviewActivityRow.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-background-running-fixture",
    area: "p1-work-rows",
    title: "Running background command shows a realistic live duration",
    kind: "story",
    storyId: "thread--timeline--rows--backgroundprocess--overview",
    beforeStoryId: "thread--timeline--rows--backgroundprocess--overview",
    howToSee: 'Look at the figure on the right of the "running" row.',
    before:
      'The running row\'s fixture started in June 2026, so its live figure read "4116h 51m".',
    after:
      "The row starts 9 seconds before the story loads, so it reads about 9s at load and counts up like a real running command.",
    why: "Broken or misleading story fixture.",
    files: [
      "apps/app/src/components/thread/timeline/rows/BackgroundProcess.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-workflow-running-fixture",
    area: "p1-work-rows",
    title: "Running workflows show a realistic live duration",
    kind: "story",
    storyId: "thread--timeline--rows--workflow--overview",
    beforeStoryId: "thread--timeline--rows--workflow--overview",
    howToSee:
      'Look at the figure on the right of the "running" and "no phases" rows.',
    before:
      'Both running workflow rows read "4117h 4m", because their fixture timestamp was months old.',
    after:
      "Both rows start 4 seconds before the story loads and count up from about 4s.",
    why: "Broken or misleading story fixture.",
    files: [
      "apps/app/src/components/thread/timeline/rows/Workflow.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-completion-report-timestamp",
    area: "p1-work-rows",
    title: "Completion report story shows a real timestamp",
    kind: "story",
    storyId: "thread--timeline--activity--completion-report",
    beforeStoryId: "thread--timeline--activity--completion-report",
    howToSee: "Look at the timestamp under the assistant message.",
    before:
      'The message had no creation time, so its timestamp read "Dec 31, 1969 · 7:00 PM".',
    after:
      'The message is stamped two minutes before the story loads and reads "2m ago".',
    why: "Broken or misleading story fixture.",
    files: [
      "apps/app/src/components/thread/timeline/rows/Activity.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-step-summary-closing-message",
    area: "p1-work-rows",
    title: "Step Summary closing messages read as real replies",
    kind: "story",
    storyId: "thread--timeline--rows--step-summary--overview",
    beforeStoryId: "thread--timeline--rows--step-summary--overview",
    howToSee: "Look at the assistant message under each expanded step.",
    before:
      'Every step closed with an assistant message that contained only "—", which looked like a rendering bug.',
    after:
      'Each step closes with "Moved the active-thinking state into the projection pass and verified the build."',
    why: "Misleading story fixture.",
    files: [
      "apps/app/src/components/thread/timeline/rows/StepSummary.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "work-rows-long-command-story",
    area: "p1-work-rows",
    title: 'New Long Command story for the "Show full command" state',
    kind: "story",
    storyId: "thread--timeline--rows--command--long-command",
    beforeStoryId: null,
    howToSee:
      'Open Command / Long Command, click "Show full command", then click "Show less".',
    before:
      "No story had a command long enough to exercise the toggle properly; Highlighted's 8-line heredoc reveals only one extra line.",
    after:
      'A 17-line Node heredoc shows 7 lines and "Show full command". Expanding shows 16 lines, the cap, and the closing "JS" line is reached by scrolling inside the command block. The height change still snaps; see the HeightTransition shared request.',
    why: "Missing state worth reviewing (long text and disclosure).",
    files: ["apps/app/src/components/thread/timeline/rows/Command.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "messages-chrome-toc-panel-exit",
    area: "p1-messages-chrome",
    title: "TOC outline panel fades and shrinks out instead of vanishing",
    kind: "animation",
    storyId: "thread--table-of-contents--default",
    beforeStoryId: "thread--table-of-contents--default",
    howToSee:
      "Hover the right-hand marker rail and click the ••• button under the markers to open the outline. Click it again, press Esc or move the pointer away to close it.",
    before:
      "Closing the outline removed it in the same frame, so the panel and its list disappeared at once. The entrance was a hand-written `motion-safe:` fade/zoom/slide, so under Reduce Motion the panel had no crossfade at all.",
    after:
      "Closing keeps the panel and its content mounted while it fades and scales to 0.95 over 150 ms (omnyo-motion-exit), then removes it. Opening uses the shared popover entrance: it fades in and scales from 0.95, starting 8 px toward the trigger side, over 250 ms from the top-right origin. Both were measured in the browser. Under Reduce Motion both directions are an opacity-only crossfade.",
    why: "The DESIGN.md role 'Popovers and anchored panels' (TOC outline) calls for FLOATING_POPOVER_MOTION, with the exit as a fade to 0.95 over fast. The rule 'Keep content during exits' applies. Under Reduce Motion a popover should be opacity only, not frozen.",
    files: ["apps/app/src/components/thread/toc/ThreadTableOfContents.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "messages-chrome-toc-tab-indicator",
    area: "p1-messages-chrome",
    title:
      "The TOC 'Agent messages / Your messages' selection slides between tabs",
    kind: "animation",
    storyId: "thread--table-of-contents--default",
    beforeStoryId: "thread--table-of-contents--default",
    howToSee:
      "Open the outline with the ••• button under the marker rail, then click 'Agent messages' and 'Your messages' in turn.",
    before:
      "The selected fill jumped from one tab to the other. Each tab drew its own background, which colour-faded over 150 ms (and snapped under Reduce Motion).",
    after:
      "One shared selection pill travels between the two tabs over 250 ms on the smooth spring, with no overshoot. At rest it lines up exactly with each tab (137×28 px). Under Reduce Motion it snaps. When only the 'Your messages' tab is shown, that tab keeps its own fill as before.",
    why: "DESIGN.md says travel between two resting places (segmented controls and tabs) settles on the smooth spring, and that Reduce Motion makes travel snap.",
    files: ["apps/app/src/components/thread/toc/ThreadTableOfContents.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "messages-chrome-toc-trigger-hover",
    area: "p1-messages-chrome",
    title: "The TOC ••• trigger tints smoothly on hover",
    kind: "interaction",
    storyId: "thread--table-of-contents--default",
    beforeStoryId: "thread--table-of-contents--default",
    howToSee:
      "Hover the marker rail, then move the pointer onto the ••• button.",
    before:
      "The button transitioned only its opacity, so the icon colour jumped from muted to foreground at once. Under Reduce Motion the opacity reveal and the tab colour fades also snapped.",
    after:
      "The reveal opacity and the icon colour both change over 150 ms on the standard curve. Because these are colour and opacity changes, the trigger and the tab colour fades also keep them under Reduce Motion.",
    why: "In the DESIGN.md 'Control hover' role, colour changes over fast on standard, and Reduce Motion leaves colour unchanged. Reduce Motion turns movement into crossfades, and opacity fades are allowed.",
    files: ["apps/app/src/components/thread/toc/ThreadTableOfContents.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "messages-chrome-action-hover-color",
    area: "p1-messages-chrome",
    title: "Message action icons tint on hover again",
    kind: "fix",
    storyId: "thread--timeline--message-action-bar--overview",
    beforeStoryId: "thread--timeline--message-action-bar--overview",
    howToSee:
      "In the new 'hover reveal' row (or any Assistant Message or User Message row story), hover the message, then hover the Copy, Fork or Add-to-chat icons.",
    before:
      "Through tailwind-merge, the reveal class's `transition-opacity` replaced the buttons' `transition-colors`. The icons faded in, but their muted-to-foreground hover colour snapped with no transition. The Copy button and the ••• overflow trigger were affected too.",
    after:
      "The icons fade in over 150 ms when the message is hovered, and each icon's colour also eases over 150 ms on the standard curve when the icon itself is hovered.",
    why: "This follows the DESIGN.md 'Control hover' role (CONTROL_HOVER_TRANSITION) and the 'Rows versus blocks' rule, which says a message's action bar fades over fast.",
    files: ["apps/app/src/components/thread/timeline/MessageActionBar.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "messages-chrome-action-bar-story-width",
    area: "p1-messages-chrome",
    title:
      "The Message Action Bar story shows the real inline actions, plus a live hover row",
    kind: "story",
    storyId: "thread--timeline--message-action-bar--overview",
    beforeStoryId: "thread--timeline--message-action-bar--overview",
    howToSee:
      "Open the story and compare the first three rows, then hover the bordered message in the new last row.",
    before:
      "The stage had no width, so the action slot measured about 0 px. Every row showed only a ••• overflow button and the timestamp, despite the 'Copy + menu' hint, and the 'disabled' row could not show the greyed Fork.",
    after:
      "Each stage is up to 448 px wide. The rows show Copy plus Fork (or Add to chat) inline, the disabled row shows Fork greyed, and the hints read 'Copy + Fork' and 'Copy + Add to chat'. A new 'hover reveal' row is not forced visible, so the fade and the icon tint can be reviewed in both themes.",
    why: "The story was broken or misleading: its fixture did not exercise the state its hint described.",
    files: [
      "apps/app/src/components/thread/timeline/MessageActionBar.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "messages-chrome-selection-story-collapsed",
    area: "p1-messages-chrome",
    title: "The selection menu stories render the message under the menu",
    kind: "fix",
    storyId: "thread--timeline--selectionmenu--overview",
    beforeStoryId: "thread--timeline--selectionmenu--overview",
    howToSee:
      "Open the SelectionMenu stories Overview, Compact viewport and Interactive.",
    before:
      "Each agent card collapsed to about 25 px with only a clipped 'AGENT' label, and the 'Add to chat' menu floated over an empty strip. The cause was that the card carried `data-thread-window`, which app.css makes a size container.",
    after:
      "The card shows the full paragraph with the highlighted phrase, and the 'Add to chat' menu floats just above the highlighted text. The label uses the `text-2xs` token instead of `text-[11px]`, so it is 10 px on desktop. The compact-viewport and interactive stories get the same fix.",
    why: "The story used a wrong fixture. Typography must use tokens, not arbitrary text-[Npx] classes.",
    files: [
      "apps/app/src/components/thread/timeline/TimelineSelectionMenu.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "messages-chrome-context-curves",
    area: "p1-messages-chrome",
    title:
      "The context window card's expand and the ring's change use the smooth spring",
    kind: "animation",
    storyId: "thread--timeline--context-window-indicator--overview",
    beforeStoryId: "thread--timeline--context-window-indicator--overview",
    howToSee:
      "In 'Optional context breakdown', click 'Show details', then 'Hide details'. The ring change appears when usage changes between turns.",
    before:
      "The card widened from 224 px to 360 px, and the bar grew from 6 px to 16 px tall, on the symmetric ease-in-out curve: 350 ms to open and 250 ms to close. The usage ring's stroke moved linearly over 350 ms.",
    after:
      "The width and height changes are the same, with the same durations, but now settle on the smooth spring: a fast start that reaches 90% by half time, with no overshoot. The ring's per-turn change also uses the smooth spring over 350 ms. Under Reduce Motion everything still snaps.",
    why: "DESIGN.md reserves ease-in-out for loops, never for reveals or travel, and runs expand and collapse on smooth. In the 'Charts and meters' role, a per-turn ring change moves over slow on smooth.",
    files: [
      "apps/app/src/components/thread/timeline/ThreadContextWindowIndicator.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "messages-chrome-attachment-press",
    area: "p1-messages-chrome",
    title: "Attachment thumbnails and file pills give press feedback",
    kind: "interaction",
    storyId: "thread--timeline--rows--user-message--overview",
    beforeStoryId: "thread--timeline--rows--user-message--overview",
    howToSee:
      "In the 'with image' or 'with images and mixed attachments' rows, press and hold an image thumbnail. In a product context with openable files, hover and press a file pill.",
    before:
      "Image thumbnails did not respond to a press; only their anchor ring (box-shadow) transitioned. Interactive file pills changed their hover fill at once and had no press feedback.",
    after:
      "Thumbnails and interactive file pills scale to 0.97 on press over 150 ms and release over 250 ms on the snappy spring. The pills' hover fill now eases over 150 ms through the shared press transition. The thumbnail's anchor ring keeps its 150 ms standard-curve transition. Under Reduce Motion nothing scales.",
    why: "This follows the DESIGN.md 'Press' role for tiles and pills (CONTROL_PRESS_TRANSITION + CONTROL_PRESS_FEEDBACK). Control hover should not snap.",
    files: [
      "apps/app/src/components/thread/timeline/ConversationAttachments.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "messages-chrome-overflow-toggle-hover",
    area: "p1-messages-chrome",
    title: "'Show more / Show less' on long messages tints smoothly",
    kind: "interaction",
    storyId: "thread--timeline--rows--user-message--overview",
    beforeStoryId: "thread--timeline--rows--user-message--overview",
    howToSee: "In the 'long' row, hover 'Show more'.",
    before:
      "Hovering switched the text from muted to foreground at once. The inline variant snapped the same way.",
    after:
      "The colour eases over 150 ms on the standard curve, for both the block toggle and the inline toggle.",
    why: "This follows the DESIGN.md 'Control hover' role (CONTROL_HOVER_TRANSITION).",
    files: [
      "apps/app/src/components/thread/timeline/conversation-message-overflow.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "messages-chrome-generated-ellipsis",
    area: "p1-messages-chrome",
    title: "Collapsed agent and system message previews end in a real ellipsis",
    kind: "visual",
    storyId: "thread--timeline--generated-conversation-message--overview",
    beforeStoryId: "thread--timeline--generated-conversation-message--overview",
    howToSee:
      "Look at the end of the 'child-completed' and 'child-outcome-batch' previews, or of 'agent-initiated' in the User Message Overview story.",
    before:
      "The continuation was three separate periods ('...'), so after a sentence ending in a full stop it read as four dots ('landed....').",
    after:
      "The continuation is a single ellipsis glyph ('…'), which is tighter and set as typographic punctuation. The meaning is unchanged.",
    why: "This is typographic polish so the text reads like a first-party app. The tests that pin the continuation text now use the new glyph.",
    files: [
      "apps/app/src/components/thread/timeline/GeneratedConversationMessage.tsx",
      "apps/app/src/components/thread/timeline/GeneratedConversationMessage.test.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "messages-chrome-actions-menu-trigger",
    area: "p1-messages-chrome",
    title: "The Thread actions menu story uses the production trigger",
    kind: "story",
    storyId: "thread--thread-actions-menu--overview",
    beforeStoryId: "thread--thread-actions-menu--overview",
    howToSee:
      "Hover and press each ••• trigger, then click one to open the menu.",
    before:
      "The trigger was a raw, unstyled `<button>` with the literal text '...'. It had no hover fill, no press scale and no fill while the menu was open.",
    after:
      "The trigger is the ghost icon Button with the MoreHorizontal glyph, matching the one ThreadDetailView uses. It has a hover fill, a 0.97 press, and the `bg-state-active` fill while the menu is open.",
    why: "The story was misleading: the trigger should exercise the real control states (Press, Control hover, and a trigger that stays still while its menu is open).",
    files: ["apps/app/src/components/thread/ThreadActionsMenu.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "messages-chrome-story-dates",
    area: "p1-messages-chrome",
    title: "Message stories show a real date instead of 'Dec 31, 1969'",
    kind: "story",
    storyId: "thread--timeline--rows--assistant-message--turn-git-activity",
    beforeStoryId:
      "thread--timeline--rows--assistant-message--turn-git-activity",
    howToSee:
      "Look at the timestamps under the messages in the Assistant Message, User Message, Generated conversation message, User message markdown and Streaming rows stories.",
    before:
      "The fixtures used timestamp 0, so every message read 'Dec 31, 1969 - 7:00 PM' (epoch 0 in local time).",
    after:
      "The fixtures use a fixed date, so the timestamps read 'Sep 30 - 12:05 PM' in the reviewer's local time zone, the same date the Message Action Bar story already used. Streaming rows step by 1 s, and the mobile review rows step by 1 minute.",
    why: "Wrong fixtures made the timestamps look broken during review.",
    files: [
      "apps/app/src/components/thread/timeline/rows/AssistantMessage.stories.tsx",
      "apps/app/src/components/thread/timeline/rows/UserMessage.stories.tsx",
      "apps/app/src/components/thread/timeline/GeneratedConversationMessage.stories.tsx",
      "apps/app/src/components/thread/timeline/UserMessageMarkdown.stories.tsx",
      "apps/app/src/components/thread/timeline/StreamingRows.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "messages-chrome-streaming-elapsed",
    area: "p1-messages-chrome",
    title:
      "The streaming command row counts up from 0 s instead of showing '498711h 24m'",
    kind: "story",
    storyId: "thread--timeline--streaming--row-details",
    beforeStoryId: "thread--timeline--streaming--row-details",
    howToSee:
      "Look at the elapsed time on the right of the 'command output' row, then click Restart.",
    before:
      "The running command showed an elapsed time of '498711h 24m', because it started at epoch 0.",
    after:
      "The row starts from the time the story mounted, so it reads '0s', '1s', '2s' and so on while output streams. The final duration is about 5 s (34 chunks at 150 ms each). Restart remounts the row and resets the clock.",
    why: "The fixture was wrong. The live elapsed counter itself still does not animate.",
    files: ["apps/app/src/components/thread/timeline/Streaming.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-preview-raw-sliding-indicator",
    area: "p1-secondary-panel",
    title: "Preview/Raw toggle uses a sliding selection fill",
    kind: "animation",
    storyId: "right-panel--file-preview--overview",
    beforeStoryId: "right-panel--file-preview--overview",
    howToSee:
      "Find the 'CSV file' (or markdown) row and click Raw in the header toggle, then Preview.",
    before:
      "Each segment had its own active fill. On click, the fill on Preview faded out and a separate fill on Raw faded in over 150 ms, and nothing travelled between them. The segments were sized to their text, so Preview was wider than Raw.",
    after:
      "A single fill slides between the two segments over 250 ms on the smooth spring and settles without overshoot. The two segments are now equal width (about 62 px each). With Reduce Motion the fill jumps straight to the new segment.",
    why: "Springs for travel: something that moves between two resting places settles on the smooth spring instead of crossfading between two surfaces.",
    files: [
      "apps/app/src/components/secondary-panel/FilePreview.tsx",
      "apps/app/src/components/secondary-panel/panelSegmentedControl.ts",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-diff-view-mode-sliding-indicator",
    area: "p1-secondary-panel",
    title: "Stacked/Split diff view toggle uses a sliding selection fill",
    kind: "animation",
    storyId: "right-panel--diff-file-card--toolbar",
    beforeStoryId: null,
    howToSee:
      "Open the new Toolbar story and click the Split and Stacked icons at the right end of the toolbar.",
    before:
      "No story showed this toolbar. In the app, the selected icon button's fill faded off one button and onto the other over 150 ms.",
    after:
      "A single fill slides between the two 28 px icon segments, across the 4 px gap, over 250 ms on the smooth spring. With Reduce Motion it jumps. The colours are unchanged in both light and dark themes.",
    why: "The same travel role as the Preview/Raw toggle, served by one shared local owner (panelSegmentedControl.ts).",
    files: [
      "apps/app/src/components/secondary-panel/GitDiffToolbar.tsx",
      "apps/app/src/components/secondary-panel/panelSegmentedControl.ts",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-diff-toolbar-story",
    area: "p1-secondary-panel",
    title: "New story: diff toolbar, default and while stats load",
    kind: "story",
    storyId: "right-panel--diff-file-card--toolbar",
    beforeStoryId: null,
    howToSee: "Open right-panel / Diff File Card / Toolbar.",
    before:
      "No story rendered GitDiffToolbar, so its selector, filter, collapse-all, wrap and view-mode controls could not be reviewed in Ladle.",
    after:
      "The first row shows a working toolbar for 12 files (+248 −61): filter, collapse-all, wrap, the selector and view mode all change state. The second row shows the toolbar while the change summary is still loading, with the selector disabled and a skeleton where the stats go.",
    why: "A surface in this area had no story coverage.",
    files: [
      "apps/app/src/components/secondary-panel/git-diff/DiffFileCard.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-info-list-more-expands",
    area: "p1-secondary-panel",
    title: "'N more' rows expand and collapse instead of snapping",
    kind: "animation",
    storyId: "right-panel--info--list-primitives--rows",
    beforeStoryId: "right-panel--info--list-primitives--rows",
    howToSee:
      "In 'overflow and timeline rail', click '4 more', then 'Show less'. Commits ('2 more') in right-panel--info--overview, the changed-files list and Thread storage behave the same way.",
    before:
      "Clicking '4 more' added the four hidden rows in a single frame and pushed everything below down at once. 'Show less' removed them in a single frame.",
    after:
      "The extra rows open by growing in height while fading in, over 350 ms on the smooth spring, and close over 250 ms. The rows keep their place while the list folds. With Reduce Motion the height snaps and only the opacity crossfades. Nothing animates on first paint, or when a reveal opens the list as it loads. Screen readers still hear one flat list.",
    why: "Expand and collapse role, using the shared Radix Collapsible owner (COLLAPSIBLE_CONTENT_MOTION), the same pattern InfoSection already uses.",
    files: ["apps/app/src/components/secondary-panel/info/info-list.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-info-heading-chevron",
    area: "p1-secondary-panel",
    title:
      "Collapsible info section headings get a rotating disclosure chevron",
    kind: "visual",
    storyId: "right-panel--info--list-primitives--rows",
    beforeStoryId: "right-panel--info--list-primitives--rows",
    howToSee:
      "In 'collapsible heading', look at the collapsed heading, click it, then hover it while it is expanded. The Commits, Uncommitted files and Thread storage headings in right-panel--info--overview work the same way.",
    before:
      "A collapsed section heading showed only its label and count pill. Nothing showed that it could be clicked or that its body was hidden, so the 'collapsible heading' row looked empty.",
    after:
      "A small chevron after the count points right while the section is collapsed. When the section expands, the chevron rotates 90° to point down over 250 ms on the smooth spring. While the section is open, the chevron shows only on hover or keyboard focus (always on touch screens), and it appears with no fade.",
    why: "Disclosure chevron role: info sections use one rotating chevron (DISCLOSURE_CHEVRON_TRANSITION). It also gives a collapsed section a visible affordance.",
    files: ["apps/app/src/components/secondary-panel/info/info-list.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-info-row-actions-instant",
    area: "p1-secondary-panel",
    title: "Info row hover actions appear instantly",
    kind: "interaction",
    storyId: "right-panel--info--list-primitives--rows",
    beforeStoryId: "right-panel--info--list-primitives--rows",
    howToSee:
      "Move the pointer over a row in 'row anatomy', and over commit and changed-file rows in the overview, and watch the copy or open-in-tab button.",
    before:
      "The row's action button faded in and out over 150 ms whenever the pointer crossed a row.",
    after:
      "The action button appears and disappears in the same frame as the row hover. Only the button's own hover fill and colour still transition, over 150 ms.",
    why: "Rows versus blocks rule: an affordance revealed by hovering a list row appears instantly.",
    files: ["apps/app/src/components/secondary-panel/info/info-list.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-new-tab-drag-handle-instant",
    area: "p1-secondary-panel",
    title: "New-tab action reorder handle appears instantly on row hover",
    kind: "interaction",
    storyId: "right-panel--new-tab--new-tab",
    beforeStoryId: "right-panel--new-tab--new-tab",
    howToSee:
      "Hover the 'Open browser' or 'Start terminal' row under Actions and watch the drag handle on the right.",
    before:
      "The reorder handle faded in over 150 ms while a launcher row was hovered.",
    after:
      "The handle appears and disappears in the same frame as the row hover. It is still always visible on touch screens and when it has keyboard focus.",
    why: "Rows versus blocks rule: list row hover is instant.",
    files: ["apps/app/src/components/secondary-panel/NewTabActions.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-git-diff-chevron-easing",
    area: "p1-secondary-panel",
    title:
      "Diff card collapse chevron rotates on the smooth spring, with a rounded focus ring",
    kind: "animation",
    storyId: "right-panel--diff-file-card--overview",
    beforeStoryId: "right-panel--diff-file-card--overview",
    howToSee:
      "Click the chevron on any file header (for example 'loaded · modified'), or Tab to it.",
    before:
      "The chevron rotated over 250 ms on a symmetric ease-in-out curve and still rotated with Reduce Motion. On keyboard focus the button showed the app-wide fallback: a square-cornered 2 px outline.",
    after:
      "The chevron rotates over 250 ms on the smooth spring (fast start, soft settle), and with Reduce Motion it turns instantly. On keyboard focus the button shows a rounded 1 px ring, matching the shared Button.",
    why: "Disclosure chevron role (DISCLOSURE_CHEVRON_TRANSITION); ease-in-out is reserved for symmetric loops.",
    files: ["apps/app/src/components/git-diff/GitDiffCardHeader.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-diff-loading-delayed",
    area: "p1-secondary-panel",
    title: "Diff card loading skeleton waits for the reveal delay",
    kind: "state",
    storyId: "right-panel--diff-file-card--overview",
    beforeStoryId: "right-panel--diff-file-card--overview",
    howToSee:
      "Reload the story and watch the 'loading' row and the 'image change' row while they fetch.",
    before:
      "The six-bar skeleton painted on the first frame, so even fast loads flashed it.",
    after:
      "The body stays blank for 200 ms, then the skeleton fades in over 150 ms, so fast loads show no skeleton at all. For text diffs the estimated body height is still reserved. For image diffs nothing is reserved during the delay; their estimated body height was already zero.",
    why: "Loading reveal role (DelayedLoading).",
    files: [
      "apps/app/src/components/secondary-panel/git-diff/DiffFileCard.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-diff-image-fixture",
    area: "p1-secondary-panel",
    title: "'image change' story shows a real image",
    kind: "fix",
    storyId: "right-panel--diff-file-card--overview",
    beforeStoryId: "right-panel--diff-file-card--overview",
    howToSee: "Look at the 'image change' row.",
    before:
      "The fixture image was a 1×1 px PNG, so the card body looked empty apart from a speck in the corner.",
    after:
      "A 240×120 sample logo (a gradient tile with a circle and two bars) renders inside the card, so the image preview layout can be reviewed.",
    why: "The story fixture was misleading.",
    files: [
      "apps/app/src/components/secondary-panel/git-diff/DiffFileCard.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-file-preview-loading-delayed",
    area: "p1-secondary-panel",
    title: "File preview loading skeleton waits for the reveal delay",
    kind: "state",
    storyId: "right-panel--file-preview--overview",
    beforeStoryId: "right-panel--file-preview--overview",
    howToSee:
      "Reload the story and watch the 'loading' row at the bottom. In the app, open a file tab while its code chunk is still loading.",
    before:
      "The source skeleton appeared on the first frame of every load, both while content loaded and in the lazy file-preview fallback.",
    after:
      "The header renders at once. The skeleton appears only after 200 ms and fades in over 150 ms, so quick loads go straight to the content.",
    why: "Loading reveal role (DelayedLoading).",
    files: [
      "apps/app/src/components/secondary-panel/FilePreview.tsx",
      "apps/app/src/components/secondary-panel/FilePreviewChrome.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-tab-strip-scroll-chevron-press",
    area: "p1-secondary-panel",
    title:
      "Tab strip scroll chevrons regain their hover transition and press release",
    kind: "interaction",
    storyId: "right-panel--tabbed-shell--overview",
    beforeStoryId: "right-panel--tabbed-shell--overview",
    howToSee:
      "In the 'overflow — many tabs' row, hover and press the left or right scroll chevron.",
    before:
      "A plain transition-opacity class replaced the Button's transition list, so the chevron's hover fill and colour changed instantly, and pressing jumped to 0.97 scale and back with no transition.",
    after:
      "The hover fill and colour fade over 150 ms. Pressing scales the chevron to 0.97 over 150 ms, and it releases over 250 ms on the snappy spring. The 150 ms fade when scrolling becomes possible is unchanged.",
    why: "Press role (CONTROL_PRESS_TRANSITION) and Control hover. The fix removes a class conflict that cancelled both.",
    files: [
      "apps/app/src/components/secondary-panel/SecondaryPanelTabStrip.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-browser-toolbar-press",
    area: "p1-secondary-panel",
    title: "Browser toolbar and find-bar buttons get press feedback",
    kind: "interaction",
    storyId: "right-panel--browser-tab--overview",
    beforeStoryId: "right-panel--browser-tab--overview",
    howToSee:
      "In any browser row, press Back, Forward, Reload/Stop or Open in external browser, or the find-bar arrows and close button.",
    before:
      "These buttons changed colour on hover and did not react when pressed.",
    after:
      "Pressing scales the button to 0.97 over 150 ms, and it releases over 250 ms on the snappy spring. With Reduce Motion there is no scale. The hover colour is unchanged.",
    why: "Press role (CONTROL_PRESS_TRANSITION + CONTROL_PRESS_FEEDBACK).",
    files: ["apps/app/src/components/secondary-panel/BrowserFindBar.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-browser-error-actions",
    area: "p1-secondary-panel",
    title:
      "Page-load error buttons get press feedback, a 1 px focus ring and a type token",
    kind: "interaction",
    storyId: "right-panel--browser-tab--page-load-error",
    beforeStoryId: null,
    howToSee:
      "Open the new Page load error story. Press Reload and Open externally, Tab between them, and read the error code under them.",
    before:
      "Reload and Open externally did not react when pressed. On keyboard focus they showed the app-wide fallback 2 px outline. The error code used an arbitrary text-[11px].",
    after:
      "Both buttons press to 0.97 and release on the snappy spring. On keyboard focus they show a 1 px ring, matching the shared Button. The error code uses the text-2xs token, which is 1 px smaller.",
    why: "Press role, a consistent focus-visible ring, and the rule against arbitrary text sizes.",
    files: ["apps/app/src/components/secondary-panel/BrowserTabContent.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-browser-error-story",
    area: "p1-secondary-panel",
    title: "New story: browser page-load error",
    kind: "story",
    storyId: "right-panel--browser-tab--page-load-error",
    beforeStoryId: null,
    howToSee: "Open right-panel / Browser tab / Page load error.",
    before:
      "No story showed the 'Server not reachable' page that the browser tab shows when a page fails to load.",
    after:
      "A browser tab on http://localhost:5173/ fails with net::ERR_CONNECTION_REFUSED. The story shows the warning glyph in the address bar, the globe tile, the title, the guidance text, Reload, Open externally and the error code.",
    why: "The error state had no story to review.",
    files: [
      "apps/app/src/components/secondary-panel/BrowserTabDeck.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-env-new-thread-press",
    area: "p1-secondary-panel",
    title:
      "Environment row 'New thread' button gets press feedback and a 1 px focus ring",
    kind: "interaction",
    storyId: "right-panel--info--row--environment",
    beforeStoryId: "right-panel--info--row--environment",
    howToSee:
      "Press, or Tab to, the small message-plus icon after 'git-worktree (not installed)'.",
    before:
      "The icon button changed colour on hover and did not react when pressed. On keyboard focus it showed the app-wide fallback 2 px outline.",
    after:
      "It presses to 0.97 and releases on the snappy spring. On keyboard focus it shows a 1 px ring, matching the shared Button.",
    why: "Press role and a consistent focus-visible ring.",
    files: [
      "apps/app/src/components/secondary-panel/ThreadMetadataContent.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-storage-search-press",
    area: "p1-secondary-panel",
    title: "Thread storage search and close buttons get press feedback",
    kind: "interaction",
    storyId: "right-panel--thread-storage--overview",
    beforeStoryId: "right-panel--thread-storage--overview",
    howToSee:
      "In the default row, press the search icon on the Thread storage heading, then press the X.",
    before:
      "The buttons changed colour on hover and did not react when pressed.",
    after:
      "They press to 0.97 and release on the snappy spring. The hover colour and focus ring are unchanged.",
    why: "Press role.",
    files: [
      "apps/app/src/components/secondary-panel/info/ThreadStorageSection.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-new-tab-show-more-press",
    area: "p1-secondary-panel",
    title: "New-tab 'Show N more' toggle gets press feedback",
    kind: "interaction",
    storyId: "right-panel--new-tab--new-tab",
    beforeStoryId: "right-panel--new-tab--new-tab",
    howToSee: "In 'long recents', press 'Show 8 more'.",
    before:
      "The toggle changed colour on hover and did not react when pressed; its chevron already rotated.",
    after: "It also presses to 0.97 and releases on the snappy spring.",
    why: "Press role.",
    files: ["apps/app/src/components/secondary-panel/NewTabFileSearch.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-storage-empty-hint",
    area: "p1-secondary-panel",
    title: "Empty thread-storage story explains its blank panel",
    kind: "story",
    storyId: "right-panel--thread-storage--overview",
    beforeStoryId: "right-panel--thread-storage--overview",
    howToSee: "Read the hint on the 'empty' row.",
    before:
      "The hint said only 'Thread has no storage files yet', above an empty bordered box that looked like a broken render.",
    after:
      "The hint adds that the section hides itself when there are no files, so the panel stays blank. ThreadStorageSection returns null in that case.",
    why: "The story was misleading.",
    files: [
      "apps/app/src/components/secondary-panel/ThreadStorageSection.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "secondary-panel-themed-diff-label-token",
    area: "p1-secondary-panel",
    title: "Themed diff panel captions use the text-2xs token",
    kind: "visual",
    storyId: "git-diff--themed-panel--themed-diff-panel",
    beforeStoryId: "git-diff--themed-panel--themed-diff-panel",
    howToSee: "Look at the 'light' and 'dark' captions on the two panes.",
    before: "The captions used an arbitrary text-[11px].",
    after: "The captions use the text-2xs token, which is 1 px smaller.",
    why: "Typography token rule: no arbitrary text-[Npx].",
    files: ["apps/app/src/components/git-diff/GitDiffCard.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "sidebar-onboarding-update-chip-press",
    area: "p1-sidebar-onboarding",
    title:
      "Sidebar update chips get press feedback and a consistent focus ring",
    kind: "interaction",
    storyId: "sidebar--updates-badge--omnyo-update-now",
    beforeStoryId: "sidebar--updates-badge--omnyo-update-now",
    howToSee:
      "Press and hold the 'Update Omnyo' chip or the provider chip, or Tab to them. The same applies to Retry update and Update failed in the Omnyo update failed story, and to the provider chip in Provider update available and downloading.",
    before:
      "The chips faded their background over 150 ms on hover but did not respond to press. On keyboard focus the full chips and the compact label chip showed the browser-default 2 px outline offset by 1 px. The compact warning icons already had a 1 px sidebar ring but did not respond to press.",
    after:
      "Every chip, full and compact, including the machine warning and the failure warning, scales to 0.97 while pressed (150 ms in, 250 ms snappy release), keeps the 150 ms colour hover, and shows the same 1 px sidebar-ring focus ring.",
    why: "DESIGN.md Press role (CONTROL_PRESS_TRANSITION + CONTROL_PRESS_FEEDBACK) for pills, plus one consistent focus-visible ring.",
    files: [
      "apps/app/src/components/sidebar/SidebarUpdatesBadge.tsx",
      "apps/app/src/components/sidebar/SidebarUpdatesBadge.test.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "sidebar-onboarding-resources-host-picker",
    area: "p1-sidebar-onboarding",
    title:
      "Resources machine picker: hover fade, press, and a working open-state fill",
    kind: "interaction",
    storyId: "sidebar--shell--project",
    beforeStoryId: "sidebar--shell--project",
    howToSee:
      "The trigger appears only when the footer Resources widget lists more than one machine. Hover the machine name with its chevron, press it, then keep its menu open. The sidebar--shell stories currently fail to render on both servers (see sharedRequests), so check this in the app or after the Ladle shim is fixed.",
    before:
      "The hover fill snapped on, and the trigger did not respond to press. Its data-[state=open] active fill never appeared, because the outer TooltipTrigger overwrote the menu's data-state with the tooltip's state.",
    after:
      "The hover fill fades over 150 ms, and the trigger scales to 0.97 while pressed. DropdownMenuTrigger now wraps TooltipTrigger, so the button carries the menu's data-state. While the menu is open the trigger shows the bg-state-active fill and stays still. The tooltip and its label are unchanged.",
    why: "DESIGN.md Control hover and Press roles, and 'a trigger stays still while its menu is open'. This also fixes an adjacent defect: the open-state fill never applied.",
    files: ["apps/app/src/components/sidebar/ResourcesRailWidget.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "sidebar-onboarding-thread-list-story-controls",
    area: "p1-sidebar-onboarding",
    title: "Thread list story controls use the shared button",
    kind: "story",
    storyId: "sidebar--thread-list--inbox-read-status",
    beforeStoryId: "sidebar--thread-list--inbox-read-status",
    howToSee:
      "Hover, press or Tab to 'Mark open thread read' and Reset beside the list. The story currently fails to render on both servers (see sharedRequests), so check this after the Ladle shim is fixed.",
    before:
      "These were hand-styled bordered buttons with no hover fill and no press response. They showed only the browser-default focus outline, and the disabled state was a plain 50% opacity.",
    after:
      "They are the shared outline Button at small size, with its hover fill, press scale, focus ring and standard disabled style.",
    why: "DESIGN.md Press and Control hover roles; story controls should use the shared Button.",
    files: ["apps/app/src/components/sidebar/PluginThreadList.stories.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "sidebar-onboarding-skill-loading-reveal",
    area: "p1-sidebar-onboarding",
    title: "Skill file loading text waits for the reveal delay",
    kind: "state",
    storyId: "plugins-and-skills--detail-states--skill-detail-states",
    beforeStoryId: "plugins-and-skills--detail-states--skill-detail-states",
    howToSee: "Scroll to the 'Content loading' row, then reload the story.",
    before:
      "'Loading ~/.omnyo/skills/writing-voice/SKILL.md…' appeared immediately, so fast loads flashed the text.",
    after:
      "The panel keeps its 100 px height from the first frame. The text fades in over 150 ms after 200 ms. Errors ('Content failed') still appear at once.",
    why: "DESIGN.md Loading reveal role (DelayedLoading); errors appear at once.",
    files: ["apps/app/src/components/tools/SkillDetailView.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "plugins-run-row-chevron-instant",
    area: "p1-plugins",
    title: "Run row chevron appears instantly on hover",
    kind: "interaction",
    storyId: "automations--run-states",
    beforeStoryId: "automations--run-states",
    howToSee:
      "Hover an agent run row that opens a thread, for example 'agent · succeeded', and watch the chevron at the right edge. The same row also appears in automations--failure-states.",
    before:
      "The trailing chevron faded in over the default 150 ms opacity transition each time the pointer entered the row, so it lagged behind the row's hover fill, which appears instantly.",
    after:
      "The chevron appears and disappears in the same frame as the row's hover fill. This matches ResourceRowDetailChevron in the shared resource list. Keyboard focus and devices without hover still show it.",
    why: "DESIGN.md 'List row hover and selection' and 'Rows versus blocks': an affordance revealed by hovering a row in a list appears instantly, and list hover never animates.",
    files: ["plugins/automations/detail-view.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "plugins-workflow-loading-delayed-reveal",
    area: "p1-plugins",
    title: "Workflow run loading skeleton waits for the loading-reveal delay",
    kind: "state",
    storyId: "plugins--workflows--workflow-panel--panel-states",
    beforeStoryId: "plugins--workflows--workflow-panel--panel-states",
    howToSee:
      "Reload the story and watch the 'Loading' cell during the first moment. The same skeleton is used by the thread workflow panel and by the workflow preview inside a message while a run loads.",
    before:
      "The three skeleton bars painted on the first frame, so a run that loaded quickly flashed a skeleton before its content appeared.",
    after:
      "The skeleton is wrapped in the shared DelayedLoading. For the first 200 ms the panel shows only its padding; after that the bars fade in over 150 ms (fast). Once visible, the layout, the 16 px panel inset and aria-busy are the same as before.",
    why: "DESIGN.md 'Loading reveal': DelayedLoading and skeletons appear only after the reveal delay, then fade over fast. The automations plugin already uses this pattern.",
    files: ["plugins/workflows/src/app.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "plugins-usage-reset-disclosure",
    area: "p1-plugins",
    title: "Usage window reset line expands and collapses instead of snapping",
    kind: "animation",
    storyId: "plugins--provider-usage--disclosure",
    beforeStoryId: "plugins--provider-usage--disclosure",
    howToSee:
      "In the 'healthy' card, click a usage bar row such as '7d  28%  3d 11h'. The 'Resets Wed …' line opens below it; click the row again to close it. The same rows appear in plugins--provider-usage--live-server. The BEFORE server cannot render provider-usage stories (Vite cannot resolve zod/mini in its worktree), so compare against the description.",
    before:
      "The reset line was mounted and unmounted conditionally. It appeared and disappeared in one frame, and the rows below jumped by its 18 px height.",
    after:
      "The line reveals through getDisclosureRevealClass. Its grid row and opacity grow over 350 ms (slow) on the smooth spring and collapse over 250 ms (base); the rows below move with it. With Reduce Motion the size snaps and only the opacity crossfades over 150 ms. The collapsed line is aria-hidden and ignores the pointer. An in-page probe on the AFTER server confirmed the measured height going 0 → 15 → 18 px on open and 18 → 1.4 → 0 px on close.",
    why: "DESIGN.md 'Expand and collapse': in-flow disclosures animate grid rows plus opacity through the disclosure owner, slow in and base out on smooth.",
    files: ["plugins/provider-usage/app.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "plugins-usage-loading-delayed-reveal",
    area: "p1-plugins",
    title: "Provider usage loading skeleton waits for the loading-reveal delay",
    kind: "state",
    storyId: "plugins--provider-usage--disclosure",
    beforeStoryId: "plugins--provider-usage--disclosure",
    howToSee:
      "Reload the story and scroll to the 'loading' row to see the skeleton rows inside that card. The BEFORE server cannot render this story, so compare against the description.",
    before:
      "The three skeleton rows (a circle, a bar and two short bars) painted on the first frame of the initial usage request.",
    after:
      "The skeleton appears after the shared 200 ms reveal delay and fades in over 150 ms (fast). A response that arrives quickly now replaces the empty card without a skeleton flash.",
    why: "DESIGN.md 'Loading reveal': skeletons appear only after the reveal delay, then fade over fast (DelayedLoading).",
    files: ["plugins/provider-usage/app.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "plugins-usage-header-press-feedback",
    area: "p1-plugins",
    title: "Usage header tabs and buttons get press feedback and eased colour",
    kind: "interaction",
    storyId: "plugins--provider-usage--disclosure",
    beforeStoryId: "plugins--provider-usage--disclosure",
    howToSee:
      "In any card header, press and hold the 'All' tab, a provider icon tab, the reload arrow or the collapse chevron, then release. Hover an inactive provider tab, and switch tabs to see the selection fill. The BEFORE server cannot render this story, so compare against the description.",
    before:
      "The provider tabs had no transition: their hover colour and the selection fill switched instantly, and nothing responded to a press. The reload and collapse buttons faded their hover colour over 150 ms but did not respond to a press.",
    after:
      "All four controls use CONTROL_PRESS_TRANSITION with CONTROL_PRESS_FEEDBACK. A press scales them to 0.97 over 150 ms on the snappy spring, and release takes 250 ms. Hover colour and the tab selection fill now ease over 150 ms, the same as the shared TabsTrigger. Reduce Motion removes the scale and keeps the colour change.",
    why: "DESIGN.md 'Press' (buttons and pills scale to 0.97 on snappy) and 'Control hover' (colour eases over fast). These hand-rolled buttons now match the shared Button and Tabs primitives.",
    files: ["plugins/provider-usage/app.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "plugins-archetype-section-heading",
    area: "p1-plugins",
    title: "Both example-section headings share one size and heading level",
    kind: "visual",
    storyId: "plugin--browse-archetype-cards--grid",
    beforeStoryId: "plugin--browse-archetype-cards--grid",
    howToSee:
      "Compare the 'Start from an example' and 'Explore plugin capabilities' headings. The change is also visible in plugin--browse-archetype-cards--narrow.",
    before:
      "'Start from an example' was an h3 at text-xs, but the sibling 'Explore plugin capabilities' was a smaller text-2xs h4, so two section labels of equal rank looked mismatched.",
    after:
      "Both headings are h3 elements at text-xs, font-medium, in subtle-foreground. The 20 px gap above the second group is unchanged.",
    why: "Typography polish: section labels of equal rank use one typography token and the same heading level.",
    files: [
      "apps/app/src/components/plugin/browse-hero/BrowseArchetypeCards.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "plugins-archetype-sentence-case",
    area: "p1-plugins",
    title: "Capability card descriptions start with a capital letter",
    kind: "visual",
    storyId: "plugin--browse-archetype-cards--grid",
    beforeStoryId: "plugin--browse-archetype-cards--grid",
    howToSee:
      "Read the six cards under 'Explore plugin capabilities': Panel, Homepage section, File opener, CLI command, Background service and Prompt mentions.",
    before:
      "These descriptions started in lowercase ('adds a nav panel…', 'connects Linear issues…'), while the six example cards above them used sentence case.",
    after:
      "The displayed descriptions start with a capital letter ('Adds a nav panel…'). The prompt sent on click and the tooltip still use the original lowercase brief inside 'Build a plugin that …'.",
    why: "Copy consistency across adjacent cards. The change affects only the displayed text and does not change meaning or behaviour.",
    files: [
      "apps/app/src/components/plugin/browse-hero/BrowseArchetypeCards.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "plugins-update-dialog-check-icon",
    area: "p1-plugins",
    title: "Update dialog uses a real check icon for compatibility",
    kind: "visual",
    storyId: "plugin--row-signal--update-dialog-short-hash",
    beforeStoryId: "plugin--row-signal--update-dialog-short-hash",
    howToSee:
      "Open the story (the dialog opens automatically) and look at the 'Compatible with your Omnyo and plugin SDK' line.",
    before:
      "The line started with a text glyph '✓' in a medium-weight span. The glyph was smaller than the 16 px icons used in the dialog's failed and blocked states (CircleX, AlertTriangle) and did not line up with them.",
    after:
      "The line starts with a 16 px CircleCheck icon in the same success colour mix. It is centred on the text line and matches the icons in the dialog's other states.",
    why: "State polish: icon alignment and consistent icons across the dialog's success, failure and blocked states.",
    files: ["apps/app/src/components/plugin/management/UpdatePluginDialog.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "plugins-row-signal-logo-badge-story",
    area: "p1-plugins",
    title: "Row signal story shows the status badge on a real plugin logo",
    kind: "story",
    storyId: "plugin--row-signal--update-states",
    beforeStoryId: "plugin--row-signal--update-states",
    howToSee:
      "Scroll to the last row, 'Status badge on the plugin logo', and hover the red badge to see its tooltip.",
    before:
      "The story covered only the standalone update and status buttons. The badge that the Installed tab overlays on a plugin logo (PluginSignalLogo) had no story state.",
    after:
      "A fifth row renders PluginSignalLogo with an error status badge over the same 24 px ResourceIconFrame and PluginLogo that InstalledPluginsTab uses, so the badge's ring, offset and tooltip can be reviewed against the real logo. The existing rows and story ids are unchanged.",
    why: "A missing state worth reviewing: the badge variant is the one users see in the plugin list.",
    files: [
      "apps/app/src/components/plugin/management/PluginRowSignal.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-height-transition-snap",
    area: "p1-integration",
    title:
      "HeightTransition keeps its spring after a snap instead of losing its transition",
    kind: "fix",
    storyId: "thread--timeline--streaming--rows",
    beforeStoryId: "thread--timeline--streaming--rows",
    howToSee:
      "Let the stream cycle and watch the working indicator under the rows. The defect needs a snap first (resize the window, switch tabs and back, or let the indicator shrink), after which growth used to jump.",
    before:
      "Snapping wrote the transition-duration longhand onto a transition shorthand that contains var(). Chrome then dropped the whole shorthand (computed duration 0s), so after any snap the wrapper's later growth jumped in one frame until visibility toggled again.",
    after:
      "A snap now sets a data-snap attribute with transition-none! for one frame and leaves the inline shorthand alone, so the height and opacity keep animating on the smooth spring after every snap.",
    why: "Expand and collapse role (HeightTransition is a named disclosure owner). Reproduced in Chrome (computed duration 0s after snap and restore); regression test added.",
    files: [
      "apps/app/src/components/ui/height-transition.tsx",
      "apps/app/src/components/ui/height-transition.test.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-skill-path-copy-glyph",
    area: "p1-integration",
    title: "Skill path copy icon morphs from copy to check",
    kind: "animation",
    storyId: "plugins-and-skills--detail-states--skill-detail-states",
    beforeStoryId: "plugins-and-skills--detail-states--skill-detail-states",
    howToSee: "Hover a skill path without a link and click it.",
    before: "The icon swapped from Copy to Check in one frame.",
    after:
      "It uses the shared CopyGlyph: the check settles in from 0.9 over 250 ms on snappy while the copy glyph fades and shrinks over 150 ms, and the reverse when the copied state ends.",
    why: "Small control state role (copy-to-check) and one owner per pattern: CopyGlyph is now exported instead of copied locally.",
    files: [
      "apps/app/src/components/ui/copy-button.tsx",
      "apps/app/src/components/tools/SkillDetailView.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-workflow-settled-scroll",
    area: "p1-integration",
    title:
      "A finished workflow panel opens at its title instead of scrolled to the last phase",
    kind: "fix",
    storyId: "plugins--workflows--workflow-panel--panel-states",
    beforeStoryId: "plugins--workflows--workflow-panel--panel-states",
    howToSee: "Look at the Loaded cell.",
    before:
      "The active-phase autoscroll also ran for succeeded or cancelled runs, so the panel opened scrolled to the last phase with the run title, description and status cut off.",
    after:
      "The panel only follows the active phase while the run is live; a settled run opens at the top.",
    why: "State polish: settled content should open in its resting position. Found by the plugins agent.",
    files: ["packages/shared-ui/src/components/ui/workflow-progress.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-title-qualifier-truncation",
    area: "p1-integration",
    title:
      "Row titles truncate the parenthetical before the tool or agent name",
    kind: "visual",
    storyId: "thread--timeline--rows--approval--overview",
    beforeStoryId: "thread--timeline--rows--approval--overview",
    howToSee:
      "Set the frame width to Phone and read the interrupted permission-grant and delegation titles.",
    before:
      "The tool name and its '(reason)' shrank equally, giving titles like 'Permission grant interrupted: TodoW… (Host daemon session expired…'.",
    after:
      "A parenthetical qualifier shrinks first, so the tool or agent name stays whole and only the qualifier ellipsizes.",
    why: "Long-text state polish; the same split-priority rule already used for file path directories.",
    files: ["apps/app/src/components/thread/timeline/TimelineTitleView.tsx"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-themed-diff-light-pane",
    area: "p1-integration",
    title: "Themed diff story's light pane renders light code",
    kind: "story",
    storyId: "git-diff--themed-panel--themed-diff-panel",
    beforeStoryId: "git-diff--themed-panel--themed-diff-panel",
    howToSee: "Compare the light and dark panes in dark mode.",
    before:
      "The diff renderer read only the document theme, so on a dark page the 'light' pane also showed near-black code.",
    after:
      "The story scopes each pane with PreferredThemeOverride, so the light pane renders the light code theme.",
    why: "Misleading story fixed through a subtree theme override in usePreferredTheme (absent by default, so production is unchanged).",
    files: [
      "apps/app/src/hooks/useTheme.ts",
      "apps/app/src/components/git-diff/GitDiffCard.stories.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-sidebar-stories-render",
    area: "p1-integration",
    title: "Sidebar shell and thread-list stories render again",
    kind: "fix",
    storyId: "sidebar--shell--project",
    beforeStoryId: "sidebar--shell--project",
    howToSee: "Open any sidebar shell or thread-list story.",
    before:
      "Every sidebar shell and thread-list story was blank: the Ladle plugin SDK shim lacked four exports the thread-list plugin imports (project sidebar items, chat group actions, chat selection).",
    after:
      "The shim forwards those exports, so the stories render. The before snapshot was patched the same way so the sidebar polish can be compared.",
    why: "Broken stories made the sidebar unreviewable on both servers.",
    files: ["apps/app/.ladle/plugin-sdk-app.ts"],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
  {
    id: "integration-start-on-menu-trigger",
    area: "p1-integration",
    title: "Start-on machine menu trigger sees its own open state",
    kind: "fix",
    storyId: null,
    beforeStoryId: null,
    howToSee:
      "No story renders this menu; covered by QueuedMessageStartOnMenu.test.tsx. In the app, open Start on… from a queued message.",
    before:
      "The tooltip trigger wrapped the menu trigger, so the tooltip's data-state overwrote the menu's: the button never styled as open and still press-scaled while its menu was open.",
    after:
      "The menu trigger wraps the tooltip trigger, so data-state=open reaches the button and the press scale stays still while the menu is open.",
    why: "Press role: a trigger stays still while its menu is open.",
    files: [
      "apps/app/src/components/promptbox/banner/QueuedMessageStartOnMenu.tsx",
    ],
    note: null,
    pass: 1,
    visibility: null,
    beforeShot: null,
    afterShot: null,
  },
];
