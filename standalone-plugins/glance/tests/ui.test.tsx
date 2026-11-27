import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
  type PluginRpcTestHandlers,
  type PluginSdkTestFakes,
} from "@omnyo/plugin-sdk/testing/app";
import {
  definePluginApp,
  useComposer,
  useSdk,
  experimental_useAppNavigate,
  type ExperimentalThreadCompanionPlacement,
  type PluginSidebarThread,
  type PluginSdkApp,
} from "@omnyo/plugin-sdk/app";
import { setupGlance } from "../app";
import { cardPresentation } from "../components/presentation";
import { GlanceCard } from "../components/card";
import {
  cardSchema,
  realtimeChannel,
  type CardDiff,
  type CardIndexEntry,
  type CardView,
  type GlanceRpcContract,
} from "../contract";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  READINESS_ENDED_EVENT,
  READINESS_EVENT,
  READINESS_REQUEST_EVENT,
} from "../components/readiness";

function tidyApp(initial: { threadIds: string[]; revision: number; stale?: boolean }) {
  let current = initial;
  const send = () => window.dispatchEvent(new CustomEvent(READINESS_EVENT, { detail: current }));
  window.addEventListener(READINESS_REQUEST_EVENT, send);

  return {
    mark(next: { threadIds: string[]; revision: number; stale?: boolean }) {
      current = next;
      send();
    },
    unload() {
      window.removeEventListener(READINESS_REQUEST_EVENT, send);
      window.dispatchEvent(new Event(READINESS_ENDED_EVENT));
    },
  };
}

let app: CapturedPluginApp;

let phoneViewport = false;

beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
});

beforeEach(() => {
  phoneViewport = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phoneViewport && query === "(max-width: 767px)",
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface FixtureData {
  view: CardView | null;
  conversationSeq: number;
  diff: CardDiff;
  cards: CardIndexEntry[];
  indexFails: boolean;
}

function fixtures() {
  const card = cardSchema.parse({
    goal: "Ship the redesigned preview",
    headline: "Ready to review the preview",
    status: "needs-you",
    phase: "test",
    facts: [{ label: "Checks", value: "12 passed", tone: "positive" }],
    deliverables: [
      {
        title: "Preview [desktop]",
        href: "/Users/me/Preview One.html",
        meta: "Desktop and narrow layouts",
      },
    ],
    proof: [
      { kind: "reproduced", claim: "The preview renders", command: "pnpm test", eventSeq: 42 },
      { kind: "inspected", claim: "The layout is compact", ref: "components/card.tsx" },
    ],
    next: "Sam selects the release scope",
  });

  const view: CardView = {
    threadId: "thr_one",
    revision: 2,
    updatedAt: Date.now(),
    source: "cli",
    staleSince: null,
    card,
    proofs: [
      {
        index: 0,
        linked: true,
        eventSeq: 42,
        command: "pnpm test",
        status: "completed",
        exitCode: 0,
        cwd: "/workspace",
        excerpt: "12 tests passed",
        excerptUnavailable: false,
      },
    ],
  };

  const diff: CardDiff = {
    seenRevision: 1,
    revision: 2,
    conversationSeq: 55,
    changes: [
      {
        field: "headline",
        label: "Headline",
        before: "Checking the preview",
        after: card.headline,
      },
    ],
    newReplies: 3,
    moreActivity: false,
  };

  const entry: CardIndexEntry = {
    threadId: view.threadId,
    revision: view.revision,
    updatedAt: view.updatedAt,
    status: card.status,
    phase: card.phase,
    goal: card.goal ?? null,
    headline: card.headline,
    sidebarSummary: null,
    blocker: null,
    next: card.next ?? null,
    facts: card.facts,
    visuals: [],
    stale: false,
    unseen: true,
  };

  const data: FixtureData = {
    view,
    conversationSeq: 55,
    diff,
    cards: [entry],
    indexFails: false,
  };

  const rpc: PluginRpcTestHandlers<GlanceRpcContract> = {
    "servers.remember": () => ({ active: [], recent: null }),
    "servers.read": () => ({ active: [], recent: null }),
    "servers.restart": () => ({ active: [], recent: null }),
    "card.read": () => ({ view: data.view }),
    "card.get": () => ({ view: data.view, conversationSeq: data.conversationSeq }),
    "card.diff": () => ({ ...data.diff, conversationSeq: data.conversationSeq }),
    "card.markSeen": () => ({ ok: true }),
    "cards.index": () => {
      if (data.indexFails) throw new Error("Disconnected");

      return { cards: data.cards };
    },
  };

  return { data, rpc, view, entry };
}

function companion() {
  const registration = app.threadCompanions[0];

  if (registration === undefined) throw new Error("Glance thread companion is not registered");

  return registration;
}

function composerReadiness() {
  const registration = app.composerCustomizations
    .find((entry) => entry.id === "glance-ready")
    ?.banners?.find((entry) => entry.id === "ready");

  if (registration === undefined) throw new Error("Composer readiness badge is not registered");

  return registration;
}

function companionProps(placement: ExperimentalThreadCompanionPlacement) {
  return { threadId: "thr_one", projectId: "proj_one", placement };
}

function InlineCompanion() {
  const composer = useComposer();
  const Companion = companion().component;

  if (composer.scope.kind !== "thread") return null;

  return <Companion threadId={composer.scope.threadId} projectId="proj_one" placement="inline" />;
}

function inlineCard() {
  return { component: InlineCompanion };
}

function cardToggle() {
  return screen.getByRole("button", { name: "Chat card" });
}

function minimize() {
  expect(cardToggle().getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(cardToggle());
}

function openDetails() {
  fireEvent.click(screen.getByRole("button", { name: /^Details/u }));
}

const foreignRowStatus = { icon: "Server", label: "Resources job", tone: "running" } as const;

interface TidyState {
  ids: string[];
  fails: boolean;
}

function tidy(state: TidyState): PluginSdkTestFakes {
  return {
    plugins: {
      async callRpc(args) {
        if (state.fails) throw new Error("Tidy is unavailable");
        expect({ pluginId: args.pluginId, method: args.method }).toEqual({
          pluginId: "tidy",
          method: "ready_ids",
        });

        return args.outputSchema.parse({ threadIds: state.ids, revision: 1 });
      },
    },
  };
}

function page() {
  const registration = app.navPanels[0];

  if (registration === undefined) throw new Error("Glance page is not registered");

  return registration;
}

type ServerWork = NonNullable<PluginSidebarThread["experimental_work"]>;

function serverWork(
  label: ServerWork["primary"]["label"],
  reason: string,
  next: string[] = [],
): ServerWork {
  return {
    revision: "work-1",
    basis: "basis-1",
    primary: { label, reason: { code: "test", text: reason } },
    activity: [],
    requiredInput: [],
    optionalInput: [],
    failures: [],
    waits: [],
    nextActors: next.map((actor) => ({ kind: "unknown", id: null, label: actor })),
    assessment: {
      availability: "missing",
      reason: "No completion assessment has been prepared.",
      sourceSeq: null,
      suggestion: "unavailable",
      noSuggestionReason: null,
      waitingOn: null,
      ask: null,
      recap: null,
    },
    postponement: null,
    archive: { eligible: false, recommended: false, reason: "The chat is not finished." },
  };
}

function thread(id: string): PluginSidebarThread {
  return {
    id,
    projectId: "proj_one",
    title: id,
    titleFallback: null,
    experimental_subtitle: null,
    experimental_shelvedAt: null,
    experimental_shelfSortKey: null,
    displayTitle: `Chat ${id}`,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: `/projects/proj_one/threads/${id}`,
    isHidden: false,
    environment: null,
    host: null,
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: null,
    lastMessageAt: null,
    latestAttentionAt: 1,
  };
}

describe("Glance user journeys", () => {
  function completedFixture() {
    const fixture = fixtures();
    fixture.data.view = {
      ...fixture.view,
      card: cardSchema.parse({
        status: "done",
        phase: "done",
        headline: "The completed result is delivered",
        sidebarSummary: "Completed result delivered",
      }),
    };
    fixture.data.diff = { ...fixture.data.diff, changes: [], newReplies: 0 };

    return fixture;
  }

  function completionSdk(): PluginSdkTestFakes {
    return {
      plugins: {
        async callRpc(args) {
          expect(args.pluginId).toBe("tidy");
          expect(args.method).toBe("ready_ids");

          return args.outputSchema.parse({ threadIds: ["thr_one"], revision: 1 });
        },
      },
    };
  }

  function coreArchive(run: () => Promise<void>) {
    return () => [
      {
        key: "omnyo--core/archive",
        pluginId: "omnyo--core",
        group: "lifecycle",
        action: { label: "Archive", icon: "Archive" as const, run },
      },
    ];
  }

  it("completion card hands off to Omnyo's optimistic archive once", async () => {
    const { rpc } = completedFixture();
    const archive = vi.fn(async () => {});

    const slot = renderSlot(
      { component: GlanceCard },
      { threadId: "thr_one" },
      {
        pluginId: "glance",
        rpc,
        sdk: completionSdk(),
        composer: { scope: { kind: "thread", threadId: "thr_one" } },
        sidebarThreads: { threads: [thread("thr_one"), thread("thr_next")] },
        threadActions: coreArchive(archive),
      },
    );

    const button = await screen.findByRole("button", { name: "Archive" });

    expect(cardToggle().contains(button)).toBe(false);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(archive).toHaveBeenCalledTimes(1);
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(document.querySelector("[data-glance-archived]")).toBeNull();
  });

  it("puts archive actions on the one-line phone card instead of a second readiness row", async () => {
    phoneViewport = true;
    const { rpc } = completedFixture();
    const archive = vi.fn(async () => {});

    function PhoneStack() {
      const Readiness = composerReadiness().component;

      return (
        <>
          <InlineCompanion />
          <Readiness />
        </>
      );
    }

    renderSlot(
      { component: PhoneStack },
      {},
      {
        pluginId: "glance",
        rpc,
        sdk: completionSdk(),
        composer: { scope: { kind: "thread", threadId: "thr_one" } },
        sidebarThreads: { threads: [thread("thr_one")] },
        experimental_threadWork: {
          thr_one: serverWork("ready-to-archive", "The completed result is verified."),
        },
        threadActions: coreArchive(archive),
      },
    );

    const button = await screen.findByRole("button", { name: "Archive" });

    expect(screen.getAllByRole("button", { name: "Archive" })).toHaveLength(1);
    expect(screen.queryByRole("group", { name: "Ready to archive" })).toBeNull();
    expect(screen.queryByText("The completed result is verified.")).toBeNull();
    expect(screen.queryByText("The completed result is delivered")).toBeNull();
    expect(cardToggle().contains(button)).toBe(false);
    fireEvent.click(button);
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("completion card disappears as soon as new work invalidates readiness", async () => {
    const { rpc } = completedFixture();
    const owner = tidyApp({ threadIds: ["thr_one"], revision: 2 });
    const live = thread("thr_one");

    const slot = renderSlot(
      inlineCard(),
      {},
      {
        pluginId: "glance",
        rpc,
        sdk: tidy({ ids: [], fails: true }),
        composer: { scope: { kind: "thread", threadId: "thr_one" } },
        sidebarThreads: { threads: [live] },
      },
    );

    try {
      await screen.findByText("Completed result delivered");
      expect(await screen.findByRole("button", { name: "Archive" })).toBeTruthy();
      live.status = "active";
      live.runtimeStatus = "active";
      slot.rerender(<GlanceCard threadId="thr_one" />);
      expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
      expect(document.querySelector("[data-glance-complete]")).toBeNull();
      expect(cardToggle().textContent).toContain("Working");
    } finally {
      cleanup();
      owner.unload();
    }
  });

  it("completion card rejects stale completion and leaves normal expansion intact", async () => {
    const { data, rpc, view } = completedFixture();

    if (data.view === null) throw new Error("Completed fixture is missing");
    data.view = { ...data.view, staleSince: view.updatedAt };
    renderSlot(
      inlineCard(),
      {},
      {
        pluginId: "glance",
        rpc,
        sdk: completionSdk(),
        composer: { scope: { kind: "thread", threadId: "thr_one" } },
        sidebarThreads: { threads: [thread("thr_one")] },
      },
    );
    await screen.findByText("Completed result delivered");
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    fireEvent.click(cardToggle());
    expect(screen.getByText("The completed result is delivered")).toBeTruthy();
  });

  it.each([
    ["needs-you", null],
    ["blocked", null],
    ["needs-you", "needs-input"],
    ["needs-you", "error"],
    ["needs-you", "unavailable"],
  ] as const)(
    "shows a %s card waiting on %s as muted Waiting across the card, overview and subtitle without a card revision",
    async (savedStatus, sourceState) => {
      const { data, rpc, view, entry } = fixtures();
      const live = thread("thr_one");
      live.queuedWork = sourceState === null ? "waiting" : "none";
      live.experimental_attention = {
        kind: sourceState === null ? "none" : "dependency-failed",
        requiredCount: 0,
        optionalCount: 0,
        callback:
          sourceState === null
            ? null
            : {
                id: "wait_one",
                threadId: live.id,
                sourceThreadId: "thr_source",
                sourceTitle: "Resources review",
                reason: "Wait for the reviewed result",
                createdAt: 1,
                afterSeq: 0,
                matchText: "review-result",
                sourceState,
              },
      };
      const saved = { ...view.card, status: savedStatus };

      if (savedStatus === "blocked") saved.blocker = "Sam approves the old report";
      data.view = { ...view, card: cardSchema.parse(saved) };
      data.cards = [
        {
          ...entry,
          status: savedStatus,
          blocker: savedStatus === "blocked" ? "Sam approves the old report" : null,
        },
      ];

      const composer = renderSlot(
        inlineCard(),
        {},
        {
          rpc,
          composer: { scope: { kind: "thread", threadId: "thr_one" } },
          sidebarThreads: { threads: [live] },
        },
      );

      await waitFor(() =>
        expect(
          within(composer.container).getByRole("button", { name: "Chat card" }).textContent,
        ).toContain("Waiting"),
      );
      expect(within(composer.container).getByText("Waiting").className).toContain(
        "text-muted-foreground",
      );
      fireEvent.click(within(composer.container).getByRole("button", { name: "Chat card" }));
      expect(within(composer.container).queryByText("Sam selects the release scope")).toBeNull();
      expect(within(composer.container).queryByText("Sam approves the old report")).toBeNull();

      const overview = renderSlot(
        page(),
        { subPath: "" },
        { rpc, sidebarThreads: { threads: [live] } },
      );

      await within(overview.container).findByRole("region", { name: "Waiting" });
      expect(within(overview.container).queryByRole("region", { name: "Blocked" })).toBeNull();
      expect(within(overview.container).queryByRole("region", { name: "Needs you" })).toBeNull();

      const script = app.contentScripts[0];
      const overlay = app.appOverlays[0];

      if (script === undefined || overlay === undefined)
        throw new Error("Subtitle lifecycle missing");
      const subtitles: Array<string | null> = [];

      const dispose = await script.mount({
        pluginId: "glance",
        generation: 1,
        signal: new AbortController().signal,
        experimental_setThreadRowSubtitle: (_threadId: string, subtitle: { text: string } | null) =>
          subtitles.push(subtitle?.text ?? null),
      });

      try {
        renderSlot(overlay, {}, { rpc, sidebarThreads: { threads: [live] } });
        await waitFor(() =>
          expect(subtitles.at(-1)).toBe("Waiting: The agent is waiting to continue"),
        );
      } finally {
        if (dispose !== undefined) await dispose();
      }
    },
  );

  it.each(["required", "optional"] as const)(
    "keeps independent work active and recognizes its own %s question while a dependency needs input",
    async (mode) => {
      const { rpc } = fixtures();
      const live = thread("thr_one");
      live.runtimeStatus = "active";
      live.status = "active";
      live.experimental_attention = {
        kind: "dependency-failed",
        requiredCount: 0,
        optionalCount: 0,
        callback: {
          id: "wait_one",
          threadId: live.id,
          sourceThreadId: "thr_source",
          sourceTitle: "Resources review",
          reason: "Wait for the reviewed result",
          createdAt: 1,
          afterSeq: 0,
          matchText: "review-result",
          sourceState: "needs-input",
        },
      };

      const slot = renderSlot(
        { component: GlanceCard },
        { threadId: "thr_one" },
        { rpc, sidebarThreads: { threads: [live] } },
      );

      await waitFor(() => expect(cardToggle().textContent).toContain("Working"));
      live.runtimeStatus = "idle";
      live.status = "idle";
      slot.rerender(<GlanceCard threadId="thr_one" />);
      expect(cardToggle().textContent).toContain("Waiting");
      live.experimental_attention = {
        ...live.experimental_attention,
        requiredCount: mode === "required" ? 1 : 0,
        optionalCount: mode === "optional" ? 1 : 0,
      };
      slot.rerender(<GlanceCard threadId="thr_one" />);
      expect(cardToggle().textContent).toContain("Needs you");
      expect(screen.getByText("A question is open in this chat")).toBeTruthy();
    },
  );

  it("keeps a stale blocker retired after queued work runs and returns idle without a card revision", async () => {
    const { data, rpc, view } = fixtures();
    data.view = {
      ...view,
      staleSince: view.updatedAt + 1,
      card: cardSchema.parse({
        ...view.card,
        status: "blocked",
        blocker: "Sam approves the old report",
      }),
    };
    const live = thread("thr_one");
    live.queuedWork = "waiting";

    const slot = renderSlot(
      { component: GlanceCard },
      { threadId: "thr_one" },
      { rpc, sidebarThreads: { threads: [live] } },
    );

    await waitFor(() => expect(cardToggle().textContent).toContain("Waiting"));
    const reads = slot.inspection.rpcCalls.length;
    live.runtimeStatus = "active";
    live.status = "active";
    slot.rerender(<GlanceCard threadId="thr_one" />);
    expect(cardToggle().textContent).toContain("Working");
    live.runtimeStatus = "idle";
    live.status = "idle";
    live.queuedWork = "none";
    slot.rerender(<GlanceCard threadId="thr_one" />);
    expect(cardToggle().textContent).toContain("Idle");
    expect(screen.queryByText("Sam approves the old report")).toBeNull();
    expect(screen.queryByText("Sam selects the release scope")).toBeNull();
    expect(slot.inspection.rpcCalls).toHaveLength(reads);
  });

  it("follows native answer, queue, activity and failure changes without waiting for another card revision", async () => {
    const { rpc } = fixtures();
    const live = thread("thr_one");
    live.queuedWork = "waiting";
    live.experimental_attention = {
      kind: "required-answer",
      requiredCount: 1,
      optionalCount: 0,
      callback: null,
    };

    const slot = renderSlot(
      { component: GlanceCard },
      { threadId: "thr_one" },
      { rpc, sidebarThreads: { threads: [live] } },
    );

    await waitFor(() => expect(cardToggle().textContent).toContain("Needs you"));
    const reads = slot.inspection.rpcCalls.length;
    live.experimental_attention = {
      ...live.experimental_attention,
      kind: "none",
      requiredCount: 0,
    };
    slot.rerender(<GlanceCard threadId="thr_one" />);
    expect(cardToggle().textContent).toContain("Waiting");
    expect(screen.queryByText("Sam selects the release scope")).toBeNull();
    live.runtimeStatus = "active";
    live.status = "active";
    slot.rerender(<GlanceCard threadId="thr_one" />);
    expect(cardToggle().textContent).toContain("Working");
    live.runtimeStatus = "waiting-for-host";
    live.activity.goals = 1;
    slot.rerender(<GlanceCard threadId="thr_one" />);
    expect(cardToggle().textContent).toContain("Waiting");
    live.activity.goals = 0;
    live.runtimeStatus = "idle";
    live.status = "idle";
    live.queuedWork = "failed";
    slot.rerender(<GlanceCard threadId="thr_one" />);
    expect(cardToggle().textContent).toContain("Failed");
    live.experimental_attention = {
      ...live.experimental_attention,
      kind: "required-answer",
      requiredCount: 1,
    };
    slot.rerender(<GlanceCard threadId="thr_one" />);
    expect(cardToggle().textContent).toContain("Failed");
    live.queuedWork = "none";
    slot.rerender(<GlanceCard threadId="thr_one" />);
    expect(cardToggle().textContent).toContain("Needs you");
    expect(screen.queryByText("Sam selects the release scope")).toBeNull();
    live.experimental_attention = {
      ...live.experimental_attention,
      kind: "none",
      requiredCount: 0,
    };
    slot.rerender(<GlanceCard threadId="thr_one" />);
    expect(cardToggle().textContent).toContain("Idle");
    expect(slot.inspection.rpcCalls).toHaveLength(reads);
  });

  it("keeps attention status without a second decision form or composer writes", async () => {
    const { rpc } = fixtures();

    const slot = renderSlot(
      inlineCard(),
      {},
      { rpc, composer: { scope: { kind: "thread", threadId: "thr_one" }, text: "Existing draft" } },
    );

    await screen.findAllByText("Ready to review the preview");
    expect(screen.queryByRole("region", { name: "Your decision" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Web only|All clients/u })).toBeNull();
    minimize();
    fireEvent.click(cardToggle());
    expect(screen.queryByRole("region", { name: "Your decision" })).toBeNull();
    expect(slot.inspection.composer.submits).toEqual([]);
    expect(slot.inspection.composer.text).toBe("Existing draft");
    expect(slot.inspection.composer.inputLocked).toBe(false);
  });

  it("hides a stale needs-you banner and restores a freshly updated status", async () => {
    const { data, rpc, view } = fixtures();

    const slot = renderSlot(
      inlineCard(),
      {},
      { rpc, composer: { scope: { kind: "thread", threadId: "thr_one" } } },
    );

    await screen.findAllByText("Ready to review the preview");
    data.view = { ...view, staleSince: Date.now() };
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 2 });
    await waitFor(() =>
      expect(screen.queryAllByText("Ready to review the preview")).toHaveLength(0),
    );
    data.view = { ...view, revision: 3 };
    data.diff = { ...data.diff, revision: 3 };
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 3 });
    await screen.findAllByText("Ready to review the preview");
  });

  it("keeps a stale card in the overview without claiming a native answer is required", async () => {
    const { data, rpc, entry } = fixtures();
    data.cards = [{ ...entry, stale: true }];
    renderSlot(page(), { subPath: "" }, { rpc, sidebarThreads: { threads: [thread("thr_one")] } });
    await screen.findByRole("region", { name: "Idle" });
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });

  it("loads the route card before the composer mounts and shares the completed read", async () => {
    const { rpc } = fixtures();
    const overlay = app.appOverlays[0];

    if (!overlay) throw new Error("Missing app overlay");

    const early = renderSlot(
      overlay,
      {},
      { rpc, context: { projectId: null, threadId: "early-chat" } },
    );

    await waitFor(() =>
      expect(early.inspection.rpcCalls.some((call) => call.method === "card.read")).toBe(true),
    );
    await act(async () => {});

    const composer = renderSlot(
      inlineCard(),
      {},
      { rpc, composer: { scope: { kind: "thread", threadId: "early-chat" } } },
    );

    expect(screen.getAllByText("Ready to review the preview").length).toBeGreaterThan(0);
    expect(screen.queryByText("Loading Glance…")).toBeNull();
    expect(composer.inspection.rpcCalls.some((call) => call.method === "card.read")).toBe(false);
  });

  it("opens a ready chat's card in its final shape without refetching Tidy readiness", async () => {
    const { data, rpc } = fixtures();
    data.view = {
      ...data.view!,
      threadId: "thr_two",
      card: cardSchema.parse({ status: "done", phase: "done", headline: "Delivered" }),
    };

    let readyCalls = 0;

    const sdk: PluginSdkTestFakes = {
      plugins: {
        async callRpc(args) {
          readyCalls += 1;

          return args.outputSchema.parse({ threadIds: ["thr_one", "thr_two"], revision: 1 });
        },
      },
    };

    const threads = { threads: [thread("thr_one"), thread("thr_two")] };
    const overlay = app.appOverlays[0];

    if (!overlay) throw new Error("Missing app overlay");

    renderSlot(
      overlay,
      {},
      { rpc, sdk, sidebarThreads: threads, context: { projectId: null, threadId: null } },
    );
    await waitFor(() => expect(readyCalls).toBe(1));
    await act(async () => {});

    renderSlot(
      inlineCard(),
      {},
      {
        rpc,
        sdk,
        sidebarThreads: threads,
        composer: { scope: { kind: "thread", threadId: "thr_two" } },
      },
    );

    const layouts: (string | null)[] = [];
    await waitFor(() => {
      const card = document.querySelector("[data-glance-card]");
      layouts.push(card === null ? null : card.getAttribute("data-glance-complete"));
      expect(card).not.toBeNull();
    });
    expect(layouts.filter((layout) => layout !== null)).toEqual(["true"]);
    expect(readyCalls).toBe(1);
  });

  it("shows a listed ready chat's completion card while its fresh read is still pending", async () => {
    const { data, rpc, entry } = fixtures();
    data.cards = [
      {
        ...entry,
        threadId: "thr_three",
        status: "done",
        phase: "done",
        headline: "Delivered",
        next: null,
      },
    ];

    const pendingRpc: PluginRpcTestHandlers<GlanceRpcContract> = {
      ...rpc,
      "card.read": () => new Promise<never>(() => {}),
    };

    const threads = { threads: [thread("thr_three")] };

    const sdk: PluginSdkTestFakes = {
      plugins: {
        async callRpc(args) {
          return args.outputSchema.parse({ threadIds: ["thr_three"], revision: 1 });
        },
      },
    };

    renderSlot(page(), { subPath: "" }, { rpc: pendingRpc, sdk, sidebarThreads: threads });
    await screen.findAllByText("Delivered");
    cleanup();

    const overlay = app.appOverlays[0];

    if (!overlay) throw new Error("Missing app overlay");

    renderSlot(
      overlay,
      {},
      {
        rpc: pendingRpc,
        sdk,
        sidebarThreads: threads,
        context: { projectId: null, threadId: null },
      },
    );
    await act(async () => {});
    renderSlot(
      inlineCard(),
      {},
      {
        rpc: pendingRpc,
        sdk,
        sidebarThreads: threads,
        composer: { scope: { kind: "thread", threadId: "thr_three" } },
      },
    );

    expect(document.querySelector("[data-glance-card]")?.getAttribute("data-glance-complete")).toBe(
      "true",
    );
    expect(screen.getByRole("status").textContent).toBe("Last loaded card · checking for updates…");
  });

  it("keeps a foreign-project image in the real card through readiness updates and releases it on unmount", async () => {
    const { data, rpc, view } = fixtures();

    const preview = {
      kind: "project-image",
      projectId: "project-other",
      path: "uploads/result.png",
      mimeType: "image/png",
      alt: "Updated narrow layout",
    };

    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    const read = vi.fn(
      async (_input: { projectId: string; path: string; signal?: AbortSignal }) => ({
        bytes,
        sizeBytes: bytes.length,
        mimeType: preview.mimeType,
      }),
    );

    const create = vi.fn(() => "blob:http://localhost/card-result");
    const revoke = vi.fn();

    class ImageURL extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    }

    vi.stubGlobal("URL", ImageURL);
    vi.stubGlobal("IntersectionObserver", undefined);
    data.view = {
      ...view,
      card: cardSchema.parse({
        ...view.card,
        status: "done",
        phase: "done",
        deliverables: [{ title: "Result image", href: "https://example.com/report", preview }],
      }),
    };
    data.diff = { ...data.diff, changes: [], newReplies: 0 };
    const owner = tidyApp({ threadIds: [view.threadId], revision: 1 });

    try {
      const slot = renderSlot(
        inlineCard(),
        {},
        {
          pluginId: "glance",
          rpc,
          sdk: { projects: { attachments: { read } } },
          composer: { scope: { kind: "thread", threadId: view.threadId }, text: "Existing draft" },
          sidebarThreads: { threads: [thread(view.threadId)] },
        },
      );

      const draft = structuredClone(slot.composer.draft);

      await waitFor(() => expect(cardToggle().textContent).toContain("Ready to archive"));
      expect(read).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "View image" })).toBeNull();
      fireEvent.click(cardToggle());
      expect(read).not.toHaveBeenCalled();
      openDetails();
      expect(read).not.toHaveBeenCalled();
      const imageButton = screen.getByRole("button", { name: "View image" });

      expect(imageButton.closest("a")).toBeNull();
      fireEvent.click(imageButton);
      const image = await screen.findByRole("img", { name: preview.alt });

      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "project-other", path: "uploads/result.png" }),
      );
      expect(image.getAttribute("src")).toBe("blob:http://localhost/card-result");
      act(() => owner.mark({ threadIds: [], revision: 2 }));
      await waitFor(() => expect(screen.queryAllByText("Ready to archive")).toHaveLength(0));
      expect(screen.getByRole("img", { name: preview.alt })).toBe(image);
      act(() => owner.mark({ threadIds: [view.threadId], revision: 3 }));
      await screen.findAllByText("Ready to archive");
      expect(read).toHaveBeenCalledTimes(1);
      expect(slot.composer.draft).toEqual(draft);
      expect(slot.inspection.composer.submits).toEqual([]);
      const signal = read.mock.calls[0]?.[0]?.signal;

      slot.unmount();
      expect(signal?.aborted).toBe(true);
      expect(create).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith("blob:http://localhost/card-result");
    } finally {
      cleanup();
      owner.unload();
      vi.unstubAllGlobals();
    }
  });

  it("shows attention status and proof without submitting a choice", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { data, rpc } = fixtures();
    data.diff.changes.push(
      { field: "facts", label: "Checks", before: "8 passed", after: "12 passed" },
      { field: "facts", label: "Delivery", before: "Prepared", after: "Pending" },
    );

    const slot = renderSlot(
      inlineCard(),
      {},
      {
        pluginId: "glance",
        rpc,
        composer: { scope: { kind: "thread", threadId: "thr_one" }, text: "Existing draft" },
      },
    );

    await screen.findAllByText("Ready to review the preview");
    expect(screen.getAllByText("Ready to review the preview").length).toBeGreaterThan(0);
    expect(screen.getByText("Ship the redesigned preview")).toBeTruthy();
    expect(screen.getByText("Sam selects the release scope")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Phase: Test, step 3 of 4" })).toBeTruthy();
    expect(screen.getByText("Updated since you last looked.", { exact: false })).toBeTruthy();
    expect(screen.queryByText("12 passed")).toBeNull();
    expect(screen.queryByRole("region", { name: "Since you last looked" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Details/u }).textContent).toMatch(
      /Facts 1.*Files 1.*Evidence 2.*Changed/u,
    );
    openDetails();
    expect(within(screen.getByLabelText("Facts")).getByText("12 passed")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Since you last looked" }).textContent).toContain(
      "Checking the preview",
    );
    expect(screen.getByText("3 new replies")).toBeTruthy();
    expect(slot.inspection.composer.submits).toEqual([]);
    expect(slot.inspection.composer.text).toBe("Existing draft");
    expect
      .soft(
        screen.getByText("12 tests passed").closest("details")?.querySelector("summary")
          ?.textContent,
      )
      .toBe("Reproduced The preview renders");
    fireEvent.click(screen.getByText("The preview renders", { exact: false }));
    expect(screen.getByText("Event 42 · completed · Exit 0")).toBeTruthy();
    expect(screen.getByText("Not linked")).toBeTruthy();
    expect(
      screen.getByText("[Preview \\[desktop\\]](</Users/me/Preview One.html>)"),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Since you last looked" }).textContent).toContain(
      "Delivery",
    );
    minimize();
    expect(screen.queryByRole("region", { name: "Your decision" })).toBeNull();
    fireEvent.click(cardToggle());
    expect(slot.inspection.composer.submits).toEqual([]);
    expect
      .soft(
        errors.mock.calls.some((args) =>
          args.some((message) => String(message).includes("same key")),
        ),
      )
      .toBe(false);
  });

  it("keeps completed recaps compact and opens a new attention status even after a manual collapse", async () => {
    const { data, rpc, view } = fixtures();
    data.view = {
      ...view,
      card: cardSchema.parse({
        status: "done",
        phase: "done",
        headline: "Checks complete",
        facts: [{ label: "Result", value: "Passed" }],
      }),
    };

    const slot = renderSlot(
      inlineCard(),
      {},
      { rpc, composer: { scope: { kind: "thread", threadId: "thr_one" } } },
    );

    await screen.findByText("Checks complete");
    expect(screen.queryByText("Passed")).toBeNull();
    fireEvent.click(cardToggle());
    expect(await screen.findByText("Archive status unavailable")).toBeTruthy();
    expect(screen.queryByText("Passed")).toBeNull();
    openDetails();
    expect(screen.getByText("Passed")).toBeTruthy();
    minimize();
    expect(screen.queryByText("Passed")).toBeNull();
    data.view = { ...view, revision: 3 };
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 3 });
    expect(await screen.findAllByText("Ready to review the preview")).toBeTruthy();
  });

  async function openDoneCardWhenTidyFails(status: number) {
    const { data, rpc, view } = fixtures();

    const callRpc = vi.fn(async () => {
      throw Object.assign(new Error(`HTTP ${status}`), { status });
    });

    data.view = {
      ...view,
      card: cardSchema.parse({ status: "done", phase: "done", headline: "Checks complete" }),
    };
    renderSlot(
      inlineCard(),
      {},
      {
        rpc,
        sdk: { plugins: { callRpc } },
        composer: { scope: { kind: "thread", threadId: "thr_one" } },
      },
    );
    await screen.findByText("Checks complete");
    fireEvent.click(cardToggle());
    await waitFor(() => expect(callRpc).toHaveBeenCalled());
    await act(async () => {});
  }

  it("leaves the archive line out of a done card when Tidy is not installed", async () => {
    await openDoneCardWhenTidyFails(404);
    expect(screen.queryByText("Archive status unavailable")).toBeNull();
    expect(screen.queryByText("Not marked ready to archive yet")).toBeNull();
  });

  it("says archive status is unavailable when an installed Tidy cannot answer", async () => {
    await openDoneCardWhenTidyFails(503);
    expect(await screen.findByText("Archive status unavailable")).toBeTruthy();
  });

  it("working card with idle thread uses unknown when current activity is unavailable", () => {
    const presentation = cardPresentation(
      {
        status: "working",
        stale: false,
        headline: "Checking the preview",
        next: "Check the result",
      },
      undefined,
    );

    expect(presentation).toMatchObject({
      status: "unknown",
      headline: "Current activity is unavailable",
      lastReported: { headline: "Checking the preview", next: "Check the result" },
    });
  });

  it.each([false, true])(
    "working card with idle thread is idle and retains last report (stale=%s)",
    async (stale) => {
      const { data, rpc, view } = fixtures();
      data.view = {
        ...view,
        staleSince: stale ? view.updatedAt + 1 : null,
        card: cardSchema.parse({
          status: "working",
          phase: "test",
          headline: "Checking the preview",
          next: "The agent checks the result",
        }),
      };
      const live = thread("thr_one");
      live.activity.goals = 1;
      live.activity.planMode = 1;
      renderSlot(
        { component: GlanceCard },
        { threadId: live.id },
        { rpc, sidebarThreads: { threads: [live] } },
      );
      await waitFor(() => expect(cardToggle().textContent).toContain("Idle"));
      fireEvent.click(cardToggle());
      openDetails();
      const report = screen.getByRole("region", { name: "Last reported" });
      expect(within(report).getByText("Checking the preview")).toBeTruthy();
      expect(within(report).getByText("The agent checks the result")).toBeTruthy();
    },
  );

  it("working card with idle thread shares its projection with the overview and sidebar", async () => {
    const { data, rpc, entry } = fixtures();
    data.cards = [
      { ...entry, status: "working", headline: "Checking the preview", next: "Verify the result" },
    ];
    const live = thread("thr_one");

    const overview = renderSlot(
      page(),
      { subPath: "" },
      { rpc, sidebarThreads: { threads: [live] } },
    );

    await within(overview.container).findByRole("region", { name: "Idle" });
    fireEvent.click(within(overview.container).getByRole("button", { name: "Cards" }));
    const report = within(overview.container).getByRole("region", { name: "Last reported" });
    expect(within(report).getByText("Checking the preview")).toBeTruthy();
    expect(within(report).getByText("Verify the result")).toBeTruthy();
    const script = app.contentScripts[0];
    const overlay = app.appOverlays[0];

    if (script === undefined || overlay === undefined)
      throw new Error("Subtitle lifecycle missing");
    const subtitles: Array<string | null> = [];

    const dispose = await script.mount({
      pluginId: "glance",
      generation: 1,
      signal: new AbortController().signal,
      experimental_setThreadRowSubtitle: (_threadId: string, subtitle: { text: string } | null) =>
        subtitles.push(subtitle?.text ?? null),
    });

    try {
      renderSlot(overlay, {}, { rpc, sidebarThreads: { threads: [live] } });
      await waitFor(() => expect(subtitles.at(-1)).toBe("The agent is idle"));
    } finally {
      if (dispose !== undefined) await dispose();
    }
  });

  it("keeps routine updates compact, remembers an explicit expansion, and shows blockers immediately", async () => {
    const { data, rpc, view } = fixtures();
    data.view = {
      ...view,
      card: cardSchema.parse({
        status: "working",
        phase: "test",
        headline: "Checking the preview",
        next: "The agent checks the result",
        facts: [{ label: "Checks", value: "Passing" }],
      }),
    };

    const slot = renderSlot(
      inlineCard(),
      {},
      { rpc, composer: { scope: { kind: "thread", threadId: "thr_one" } } },
    );

    await screen.findByText("Current activity is unavailable");
    expect(cardToggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("The agent checks the result")).toBeNull();
    fireEvent.click(cardToggle());
    openDetails();
    expect(screen.getAllByText("The agent checks the result")).toHaveLength(1);
    data.view = { ...data.view!, revision: 3 };
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 3 });
    expect(cardToggle().getAttribute("aria-expanded")).toBe("true");
    minimize();
    data.view = {
      ...view,
      revision: 4,
      card: cardSchema.parse({
        status: "blocked",
        phase: "ship",
        headline: "An owner action is required",
        blocker: "Sam must accept the provider agreement",
      }),
    };
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 4 });
    expect(screen.getAllByText("Sam must accept the provider agreement")).toHaveLength(1);
    minimize();
    expect(screen.queryByText("Sam must accept the provider agreement")).toBeNull();
    expect(screen.getByText("An owner action is required")).toBeTruthy();
  });

  it("reads the current session expansion without importing obsolete preferences", async () => {
    const { data, rpc, view } = fixtures();
    data.view = {
      ...view,
      card: cardSchema.parse({
        status: "working",
        phase: "test",
        headline: "Checking the preview",
      }),
    };
    const raw = '{"revision":2,"open":true,"future":{"order":[2,1]}}';
    sessionStorage.setItem("omnyo:glance:expansion:thr_one", raw);
    sessionStorage.setItem("bb:glance:expansion:thr_one", "{bad");
    renderSlot(
      inlineCard(),
      {},
      {
        pluginId: "glance",
        rpc,
        composer: { scope: { kind: "thread", threadId: "thr_one" } },
      },
    );
    await screen.findByText("Current activity is unavailable");
    expect(cardToggle().getAttribute("aria-expanded")).toBe("true");
    expect(sessionStorage.getItem("omnyo:glance:expansion:thr_one")).toBe(raw);
    expect(sessionStorage.getItem("bb:glance:expansion:thr_one")).toBe("{bad");
    fireEvent.click(cardToggle());
    expect(JSON.parse(sessionStorage.getItem("omnyo:glance:expansion:thr_one") ?? "null")).toEqual({
      revision: 2,
      open: false,
      future: { order: [2, 1] },
    });
    expect(sessionStorage.getItem("bb:glance:expansion:thr_one")).toBe("{bad");
  });

  it("minimizes an open blocker to one line until a new revision arrives", async () => {
    const { data, rpc, view } = fixtures();

    const blocked = (revision: number): CardView => ({
      ...view,
      revision,
      card: cardSchema.parse({
        status: "blocked",
        phase: "ship",
        headline: "Delivery waits for the provider agreement",
        blocker: "The provider refuses new deployments until the agreement is accepted",
        next: "Sam accepts the agreement in the provider console",
        facts: [{ label: "Production", value: "Unchanged" }],
      }),
    });

    data.view = blocked(2);
    const options = { rpc, composer: { scope: { kind: "thread" as const, threadId: "thr_one" } } };
    const first = renderSlot(inlineCard(), {}, options);

    await screen.findByText("Delivery waits for the provider agreement");
    expect(cardToggle().getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByText("The provider refuses new deployments until the agreement is accepted"),
    ).toBeTruthy();
    expect(screen.getByText("Sam accepts the agreement in the provider console")).toBeTruthy();
    expect(screen.queryByText("Unchanged")).toBeNull();
    openDetails();
    expect(screen.getByText("Unchanged")).toBeTruthy();
    minimize();
    expect(cardToggle().getAttribute("aria-expanded")).toBe("false");

    for (const hidden of [
      "The provider refuses new deployments until the agreement is accepted",
      "Sam accepts the agreement in the provider console",
      "Unchanged",
    ])
      expect(screen.queryByText(hidden)).toBeNull();

    const line = screen.getByText("Delivery waits for the provider agreement");
    expect(line.className).toContain("truncate");
    expect(cardToggle().contains(line)).toBe(true);
    first.unmount();
    const second = renderSlot(inlineCard(), {}, options);

    await screen.findByText("Delivery waits for the provider agreement");
    expect(cardToggle().getAttribute("aria-expanded")).toBe("false");
    data.view = blocked(3);
    await second.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 3 });
    await waitFor(() => expect(cardToggle().getAttribute("aria-expanded")).toBe("true"));
    expect(
      screen.getByText("The provider refuses new deployments until the agreement is accepted"),
    ).toBeTruthy();
  });

  it("puts a completed card's sidebar summary on the minimized line", async () => {
    const { data, rpc, view } = fixtures();
    data.view = {
      ...view,
      card: cardSchema.parse({
        status: "done",
        phase: "done",
        headline: "Private .52 is installed on every requested target",
        sidebarSummary: "Private .52 installed · all targets",
      }),
    };

    renderSlot(
      inlineCard(),
      {},
      { rpc, composer: { scope: { kind: "thread", threadId: "thr_one" } } },
    );

    await screen.findByText("Private .52 installed · all targets");
    expect(screen.queryByText("Private .52 is installed on every requested target")).toBeNull();
    fireEvent.click(cardToggle());
    expect(screen.getByText("Private .52 is installed on every requested target")).toBeTruthy();
    expect(screen.queryByText("Private .52 installed · all targets")).toBeNull();
  });

  it("answers goal, status and what is next from Tidy's own readiness, even when another plugin owns the row", async () => {
    const { data, rpc, view } = fixtures();
    data.view = {
      ...view,
      threadId: "thr_ready",
      card: cardSchema.parse({
        status: "done",
        phase: "done",
        headline: "The new card is live in every chat",
        sidebarSummary: "New Glance card live",
        next: "The agent marks the chat ready",
      }),
    };
    data.diff = { ...data.diff, changes: [], newReplies: 0 };
    const state: TidyState = { ids: ["thr_ready"], fails: false };

    const slot = renderSlot(
      inlineCard(),
      {},
      {
        rpc,
        sdk: tidy(state),
        composer: { scope: { kind: "thread", threadId: "thr_ready" } },
        sidebarThreads: { threads: [thread("thr_ready")] },
        sidebarRowStatuses: { thr_ready: foreignRowStatus },
      },
    );

    await screen.findByText("New Glance card live");
    await waitFor(() => expect(cardToggle().textContent).toContain("Ready to archive"));
    expect(slot.inspection.sdkCalls.map((call) => call.method)).toContain("plugins.callRpc");

    const description = (cardToggle().getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");

    expect(description).toContain("New Glance card live");
    expect(description).toContain("Ready to archive");
    expect(within(cardToggle()).getByText("The new card is live in every chat")).toBeTruthy();
    fireEvent.click(cardToggle());
    expect(within(cardToggle()).queryByText("The new card is live in every chat")).toBeNull();
    const rows = screen.getByText("The new card is live in every chat").closest("dl");

    if (rows === null) throw new Error("Summary rows are missing");
    expect(Array.from(rows.querySelectorAll("dt")).map((term) => term.textContent)).toEqual([
      "Goal",
      "Now",
    ]);
    expect(within(rows).getByText("Chat thr_ready")).toBeTruthy();
    expect(within(rows).queryByText("Ready to archive")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Archive" })).toHaveLength(1);
    expect(screen.queryByText("The agent marks the chat ready")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Details/u })).toBeNull();
    state.ids = [];
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByText("The agent marks the chat ready");
    expect(within(rows).queryByText("Ready to archive")).toBeNull();
  });

  function renderMarked(entry: PluginSidebarThread) {
    const { data, rpc, view } = fixtures();
    data.view = {
      ...view,
      threadId: entry.id,
      card: cardSchema.parse({ status: "done", phase: "done", headline: "Report delivered" }),
    };
    data.diff = { ...data.diff, changes: [], newReplies: 0 };
    sessionStorage.setItem(
      `omnyo:glance:expansion:${entry.id}`,
      JSON.stringify({ revision: 2, open: true }),
    );

    renderSlot(
      inlineCard(),
      {},
      {
        pluginId: "glance",
        rpc,
        sdk: tidy({ ids: [entry.id], fails: false }),
        composer: { scope: { kind: "thread", threadId: entry.id } },
        sidebarThreads: { threads: [entry] },
      },
    );
  }

  it("hides Tidy's mark during an active turn", async () => {
    renderMarked({ ...thread("thr_busy"), status: "active", runtimeStatus: "active" });
    await waitFor(() => expect(cardToggle().textContent).toContain("Working"));
    await act(async () => {});
    expect(screen.queryByText("Ready to archive")).toBeNull();
  });

  const openWork: Array<[string, (base: PluginSidebarThread) => PluginSidebarThread, string]> = [
    [
      "a background command",
      (base) => ({ ...base, activity: { ...base.activity, backgroundCommands: 1 } }),
      "Working",
    ],
    ["an open question", (base) => ({ ...base, hasPendingInteraction: true }), "Needs you"],
    ["a waiting send", (base) => ({ ...base, queuedWork: "waiting" }), "Waiting"],
    [
      "a chat that has not started",
      (base) => ({ ...base, status: "pending", runtimeStatus: "pending" }),
      "Waiting",
    ],
  ];

  for (const [name, open, status] of openWork) {
    it(`hides Tidy's mark while the chat has ${name}`, async () => {
      renderMarked(open(thread("thr_open")));
      await waitFor(() => expect(cardToggle().textContent).toContain(status));
      await act(async () => {});
      expect(screen.queryByText("Ready to archive")).toBeNull();
    });
  }

  it("applies the same rule on the Glance page", async () => {
    const { data, rpc, entry } = fixtures();
    data.cards.push({ ...entry, threadId: "thr_turn", status: "done", phase: "done", next: null });
    data.cards.push({ ...entry, threadId: "thr_asks", status: "done", phase: "done", next: null });

    renderSlot(
      page(),
      { subPath: "" },
      {
        rpc,
        sdk: tidy({ ids: ["thr_turn", "thr_asks"], fails: false }),
        sidebarThreads: {
          threads: [
            { ...thread("thr_turn"), status: "active", runtimeStatus: "active" },
            { ...thread("thr_asks"), hasPendingInteraction: true },
          ],
        },
      },
    );

    const group = (threadId: string) =>
      document
        .querySelector(`[data-glance-thread="${threadId}"]`)
        ?.closest("section")
        ?.getAttribute("aria-label");

    await waitFor(() => expect(group("thr_turn")).toBe("Working"));
    expect(group("thr_asks")).toBe("Needs you");
    await act(async () => {});
    expect(screen.queryByText("Ready to archive")).toBeNull();
  });

  it("updates Ready to archive live from Tidy's window events and clears when Tidy unloads", async () => {
    const tidySource = readFileSync(resolve(process.cwd(), "../tidy/readiness-store.ts"), "utf8");

    for (const name of [READINESS_EVENT, READINESS_REQUEST_EVENT, READINESS_ENDED_EVENT])
      expect(tidySource).toContain(`"${name}"`);

    const { data, rpc, view } = fixtures();
    data.view = {
      ...view,
      threadId: "thr_live",
      card: cardSchema.parse({ status: "done", phase: "done", headline: "Report delivered" }),
    };
    data.diff = { ...data.diff, changes: [], newReplies: 0 };
    sessionStorage.setItem(
      "omnyo:glance:expansion:thr_live",
      JSON.stringify({ revision: 2, open: true }),
    );
    const tidyClient = tidyApp({ threadIds: [], revision: 7 });

    try {
      const slot = renderSlot(
        inlineCard(),
        {},
        {
          pluginId: "glance",
          rpc,
          sdk: tidy({ ids: [], fails: true }),
          composer: { scope: { kind: "thread", threadId: "thr_live" } },
          sidebarThreads: { threads: [thread("thr_live")] },
        },
      );

      await screen.findByText("Not marked ready to archive yet");
      const reads = slot.inspection.sdkCalls.length;
      act(() => tidyClient.mark({ threadIds: ["thr_live"], revision: 8 }));
      expect(await screen.findByText("Ready to archive")).toBeTruthy();
      expect(slot.inspection.sdkCalls.length).toBe(reads);
      act(() => tidyClient.mark({ threadIds: ["thr_live"], revision: 9, stale: true }));
      expect(await screen.findByText("Archive status unavailable")).toBeTruthy();
      expect(screen.queryByText("Ready to archive")).toBeNull();
      act(() => tidyClient.mark({ threadIds: ["thr_live"], revision: 8 }));
      expect(screen.queryByText("Ready to archive")).toBeNull();
      act(() => tidyClient.mark({ threadIds: ["thr_live"], revision: 10, stale: false }));
      expect(await screen.findByText("Ready to archive")).toBeTruthy();
      act(() => tidyClient.unload());
      expect(await screen.findByText("Archive status unavailable")).toBeTruthy();
    } finally {
      act(() => tidyClient.unload());
    }
  });

  it("does not offer archive from Tidy's stale RPC result", async () => {
    const { rpc } = completedFixture();

    const sdk: PluginSdkTestFakes = {
      plugins: {
        async callRpc(args) {
          if (args.pluginId !== "tidy") throw new Error("not under test");

          return args.outputSchema.parse({ threadIds: ["thr_one"], revision: 2, stale: true });
        },
      },
    };

    renderSlot(
      inlineCard(),
      {},
      {
        pluginId: "glance",
        rpc,
        sdk,
        sidebarThreads: { threads: [thread("thr_one")] },
        composer: { scope: { kind: "thread", threadId: "thr_one" } },
      },
    );

    await screen.findAllByText("Completed result delivered");
    fireEvent.click(cardToggle());
    await screen.findByText("Archive status unavailable");
    expect(screen.queryByRole("group", { name: "Ready to archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("summarizes changes in plain words, flags a stale card and shows supporting detail when opened", async () => {
    const { data, rpc, view } = fixtures();
    data.view = {
      ...view,
      updatedAt: Date.now() - 40 * 60_000,
      staleSince: Date.now(),
      card: cardSchema.parse({
        status: "done",
        phase: "done",
        headline: "Checkout works on iPhone again",
        facts: [{ label: "Orders", value: "None lost" }],
        proof: [{ kind: "inspected", claim: "The payment path is fixed", ref: "checkout.ts" }],
      }),
    };
    data.diff = {
      ...data.diff,
      newReplies: 0,
      changes: [
        {
          field: "headline",
          label: "Headline",
          before: "Fixing checkout",
          after: "Checkout works on iPhone again",
        },
        { field: "status", label: "Status", before: "working", after: "done" },
        { field: "phase", label: "Phase", before: "ship", after: "done" },
        { field: "next", label: "Next", before: "The agent tests checkout", after: null },
        { field: "facts", label: "Required gate", before: "70 typecheck tasks", after: null },
      ],
    };

    renderSlot(
      inlineCard(),
      {},
      { rpc, composer: { scope: { kind: "thread", threadId: "thr_one" } } },
    );

    await screen.findByText("Checkout works on iPhone again");
    expect(screen.getByText("Chat moved on")).toBeTruthy();
    expect(
      screen.getByText("The chat continued after this card was updated 40m ago.", {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText("None lost")).toBeNull();
    fireEvent.click(cardToggle());
    expect(screen.queryByText("None lost")).toBeNull();
    openDetails();
    expect(screen.getByText("None lost")).toBeTruthy();
    expect(screen.getByText("The payment path is fixed")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Since you last looked" }).textContent).toContain(
      "Removed: 70 typecheck tasks",
    );
  });

  it("renders nothing for a chat without a card", async () => {
    const { data, rpc } = fixtures();
    data.view = null;
    data.diff = { ...data.diff, revision: null, changes: [], newReplies: 0 };

    const slot = renderSlot(
      inlineCard(),
      {},
      { rpc, composer: { scope: { kind: "thread", threadId: "thr_one" } } },
    );

    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBe(2));
    expect(slot.container.textContent).toBe("");
  });

  it("shows the server's chat status as one strip when the chat has no card", async () => {
    const { data, rpc } = fixtures();
    data.view = null;
    data.diff = { ...data.diff, revision: null, changes: [], newReplies: 0 };

    const slot = renderSlot(
      inlineCard(),
      {},
      {
        rpc,
        composer: { scope: { kind: "thread", threadId: "thr_one" } },
        experimental_threadWork: {
          thr_one: serverWork("waiting", "The release job is still running.", ["Release job"]),
        },
      },
    );

    const strip = await slot.findByRole("region", { name: "Chat status" });
    expect(strip.textContent).toContain("Waiting");
    expect(strip.textContent).toContain("The release job is still running.");
    expect(strip.textContent).toContain("Next: Release job");
    expect(slot.queryByRole("button", { name: "Chat card" })).toBeNull();
  });

  it("labels the card with the server's status and reason instead of its own guess", async () => {
    const { data, rpc, view } = fixtures();
    data.view = {
      ...view,
      card: cardSchema.parse({
        status: "working",
        phase: "build",
        headline: "Launcher logic is built and tested",
        next: "The agent builds the dock",
      }),
    };
    const live = thread("thr_one");
    live.runtimeStatus = "error";
    const reason = "The last agent run failed and needs recovery.";

    renderSlot(
      { component: GlanceCard },
      { threadId: live.id },
      {
        rpc,
        sidebarThreads: { threads: [live] },
        experimental_threadWork: { thr_one: serverWork("blocked", reason, ["Sam"]) },
      },
    );

    await waitFor(() => expect(cardToggle().textContent).toContain("Blocked"));
    expect(cardToggle().textContent).not.toContain("Failed");
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByText("Sam")).toBeTruthy();
    openDetails();
    const report = screen.getByRole("region", { name: "Last reported" });
    expect(within(report).getByText("Launcher logic is built and tested")).toBeTruthy();
  });

  it("keeps the agent's headline and puts its next step on the minimized line while the server agrees", async () => {
    const { data, rpc, view } = fixtures();
    data.view = {
      ...view,
      card: cardSchema.parse({
        status: "working",
        phase: "build",
        headline: "Launcher logic is built and tested",
        next: "The agent builds the dock",
      }),
    };

    renderSlot(
      { component: GlanceCard },
      { threadId: "thr_one" },
      {
        rpc,
        sidebarThreads: { threads: [thread("thr_one")] },
        experimental_threadWork: {
          thr_one: serverWork("working", "The agent is working.", ["Agent"]),
        },
      },
    );

    await waitFor(() => expect(cardToggle().textContent).toContain("Working"));
    expect(cardToggle().textContent).toContain("Launcher logic is built and tested");
    expect(cardToggle().textContent).toContain("Next: The agent builds the dock");
    expect(screen.queryByText("The agent is working.")).toBeNull();
  });

  it.each([
    ["done", false, "done"],
    ["blocked", false, "blocked"],
    ["blocked", true, "open"],
    ["working", false, "open"],
    ["needs-you", false, "open"],
  ] as const)(
    "keeps a %s card (stale=%s) as %s while the server sees an open chat",
    (status, stale, expected) => {
      const presentation = cardPresentation(
        { status, stale, headline: "Reported", next: null },
        undefined,
        serverWork("open", "Nothing is running."),
      );

      expect(presentation.status).toBe(expected);
    },
  );

  it("marks only the displayed revision and captured conversation cursor after two visible seconds", async () => {
    const { data, rpc } = fixtures();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    const slot = renderSlot(
      inlineCard(),
      {},
      { rpc, composer: { scope: { kind: "thread", threadId: "thr_one" } } },
    );

    await screen.findAllByText("Ready to review the preview");
    vi.useFakeTimers();
    data.conversationSeq = 99;
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "card.markSeen")).toBe(false);
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "card.markSeen")).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "card.markSeen")?.input).toEqual(
      { threadId: "thr_one", revision: 2, conversationSeq: 55 },
    );
    openDetails();
    expect(screen.getByRole("region", { name: "Since you last looked" })).toBeTruthy();
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 2 });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "card.markSeen").at(-1)?.input,
    ).toEqual({ threadId: "thr_one", revision: 2, conversationSeq: 99 });
  });

  it("refreshes on realtime and reconnect while retaining the visit's diff after read state changes", async () => {
    const { data, rpc, view } = fixtures();

    const slot = renderSlot(
      inlineCard(),
      {},
      { rpc, composer: { scope: { kind: "thread", threadId: "thr_one" } } },
    );

    await screen.findAllByText("Ready to review the preview");
    openDetails();
    data.diff = { ...data.diff, seenRevision: 2, changes: [], newReplies: 0 };
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 2 });
    expect(screen.getByText("Checking the preview")).toBeTruthy();
    data.view = {
      ...view,
      revision: 3,
      card: { ...view.card, headline: "The preview is verified" },
    };
    data.diff = {
      ...data.diff,
      revision: 3,
      changes: [
        {
          field: "headline",
          label: "Headline",
          before: view.card.headline,
          after: "The preview is verified",
        },
      ],
    };
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    expect(await screen.findAllByText("The preview is verified")).toHaveLength(2);
  });

  it("remounts read and expansion state when the composer switches from a high-revision chat", async () => {
    const { data, rpc, view } = fixtures();
    data.view = { ...view, revision: 20 };
    data.diff = { ...data.diff, revision: 20 };
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    const slot = renderSlot(
      inlineCard(),
      {},
      {
        pluginId: "glance",
        rpc,
        composer: { scope: { kind: "thread", threadId: "thr_one" } },
      },
    );

    await screen.findAllByText("Ready to review the preview");
    vi.useFakeTimers();
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "card.markSeen")?.input).toEqual(
      { threadId: "thr_one", revision: 20, conversationSeq: 55 },
    );
    data.view = {
      ...view,
      threadId: "thr_two",
      revision: 1,
      card: { ...view.card, headline: "Second chat" },
    };
    data.diff = { ...data.diff, revision: 1, seenRevision: null, changes: [], newReplies: 0 };
    data.conversationSeq = 7;
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_two" });
    expect(screen.queryAllByText("Ready to review the preview")).toHaveLength(0);
    expect(screen.getByText("Second chat")).toBeTruthy();
    expect(cardToggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByText("Checking the preview")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "card.markSeen").at(-1)?.input,
    ).toEqual({ threadId: "thr_two", revision: 1, conversationSeq: 7 });
  });

  it("does not attach an earlier revision's diff to a mismatched fresh card", async () => {
    const { data, rpc, view } = fixtures();

    const slot = renderSlot(
      inlineCard(),
      {},
      { rpc, composer: { scope: { kind: "thread", threadId: "thr_one" } } },
    );

    await screen.findAllByText("Ready to review the preview");
    openDetails();
    expect(screen.getByText("Checking the preview")).toBeTruthy();
    data.view = { ...view, revision: 3, card: { ...view.card, headline: "Third revision" } };
    data.diff = { ...data.diff, revision: 4 };
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 3 });
    await screen.findByText("Third revision");
    expect(screen.queryByText("Checking the preview")).toBeNull();
    expect(screen.queryByText("Updated since you last looked.", { exact: false })).toBeNull();
  });

  it("groups active cards, switches zoom and follows the real chat href without sending", async () => {
    const { data, rpc, entry } = fixtures();
    data.cards.push({
      ...entry,
      threadId: "thr_blocked",
      status: "blocked",
      headline: "Waiting for the build machine",
      blocker: "The machine is offline",
      next: "The machine reconnects",
    });
    data.cards.push({
      ...entry,
      threadId: "thr_done",
      status: "done",
      phase: "done",
      headline: "Report delivered",
      next: null,
    });

    const slot = renderSlot(
      page(),
      { subPath: "" },
      {
        rpc,
        sdk: tidy({ ids: ["thr_done"], fails: false }),
        sidebarThreads: {
          threads: [
            { ...thread("thr_one"), hasPendingInteraction: true },
            thread("thr_blocked"),
            thread("thr_done"),
            thread("thr_empty"),
          ],
        },
        sidebarRowStatuses: { thr_done: foreignRowStatus },
      },
    );

    await screen.findAllByText("A question is open in this chat");
    await waitFor(() =>
      expect(document.querySelector('[data-glance-thread="thr_done"]')?.textContent).toContain(
        "Ready to archive",
      ),
    );
    expect(document.querySelector('[data-glance-thread="thr_blocked"]')?.textContent).not.toContain(
      "Ready to archive",
    );
    expect(screen.getByRole("region", { name: "Needs you" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Blocked" })).toBeTruthy();
    expect(screen.getByText("1 active chat without a card")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cards" }));
    expect(screen.getAllByText("A question is open in this chat").length).toBeGreaterThan(0);
    expect(screen.getByText("The machine is offline")).toBeTruthy();
    const link = screen.getByRole("link", { name: /A question is open in this chat/u });
    expect(link.getAttribute("href")).toBe("/projects/proj_one/threads/thr_one");
    fireEvent.click(link);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_one" }]);
    expect(slot.inspection.composer.submits).toEqual([]);
  });

  it("shows loading and failures instead of claiming an empty healthy index", async () => {
    const { data, rpc } = fixtures();

    const slot = renderSlot(
      page(),
      { subPath: "" },
      { rpc, sidebarThreads: { status: "loading" } },
    );

    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    expect(screen.getByRole("status").textContent).toContain("Loading");
    expect(screen.queryByText(/active chats without a card/u)).toBeNull();
    data.indexFails = true;
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 2 });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("No chat cards yet.")).toBeNull();
  });

  it("updates and clears generation-owned subtitles, and tolerates an older host without the setter", async () => {
    const { data, rpc, entry } = fixtures();
    const script = app.contentScripts[0];
    const overlay = app.appOverlays[0];

    if (script === undefined || overlay === undefined)
      throw new Error("Subtitle lifecycle is not registered");

    const calls: Array<{ threadId: string; subtitle: { text: string } | null }> = [];

    const context = {
      pluginId: "glance",
      generation: 1,
      signal: new AbortController().signal,
      experimental_setThreadRowSubtitle: (threadId: string, subtitle: { text: string } | null) => {
        calls.push({ threadId, subtitle });
      },
    };

    const dispose = await script.mount(context);
    const slot = renderSlot(overlay, {}, { rpc });

    await waitFor(() =>
      expect(calls).toEqual([
        { threadId: "thr_one", subtitle: { text: "Needs you: Ready to review the preview" } },
      ]),
    );
    data.cards = [{ ...entry, stale: true }];
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 2 });
    await waitFor(() => expect(calls.at(-1)).toEqual({ threadId: "thr_one", subtitle: null }));
    data.cards = [{ ...entry, headline: "A".repeat(160) }];
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 3 });
    await waitFor(() => expect(calls.at(-1)?.subtitle?.text).toContain("AAAAA"));
    const longText = calls.at(-1)?.subtitle?.text;
    expect.soft(longText).toHaveLength(140);
    expect.soft(longText?.startsWith("Needs you: ")).toBe(true);
    expect.soft(longText?.endsWith("…")).toBe(true);
    data.cards = [
      {
        ...entry,
        status: "done",
        headline:
          "Private .52 is installed on every requested target; all runtime inventories are verified",
      },
    ];
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 4 });
    await waitFor(() =>
      expect(calls.at(-1)?.subtitle?.text).toBe(
        "Private .52 is installed on every requested target; all…",
      ),
    );
    data.cards = [
      { ...entry, status: "done", sidebarSummary: "Private .52 installed · all targets" },
    ];
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 5 });
    await waitFor(() =>
      expect(calls.at(-1)?.subtitle?.text).toBe("Private .52 installed · all targets"),
    );

    for (const [headline, expected] of [
      ["36/36 visuals matched", "36/36 visuals matched"],
      ["X".repeat(64), "X".repeat(64)],
      ["X".repeat(65), `${"X".repeat(63)}…`],
      ["🟢".repeat(65), `${"🟢".repeat(63)}…`],
    ] as const) {
      data.cards = [{ ...entry, status: "done", headline }];
      await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 6 });
      await waitFor(() => expect(calls.at(-1)?.subtitle?.text).toBe(expected));
    }

    data.cards = [];
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 7 });
    await waitFor(() => expect(calls.at(-1)).toEqual({ threadId: "thr_one", subtitle: null }));

    if (dispose !== undefined) await dispose();
    slot.unmount();

    const olderContext = {
      pluginId: "glance",
      generation: 2,
      signal: new AbortController().signal,
    };

    expect(await script.mount(olderContext)).toBeUndefined();
    const priorCalls = calls.length;
    data.cards = [{ ...fixtures().entry, status: "blocked" }];
    const olderSlot = renderSlot(overlay, {}, { rpc });

    await waitFor(() => expect(olderSlot.inspection.rpcCalls).toHaveLength(1));
    expect(calls).toHaveLength(priorCalls);
    expect(within(olderSlot.container).queryByRole("alert")).toBeNull();
  });

  it("registers the companion with composer readiness directly above the chatbox", () => {
    const registration = companion();

    expect({ id: registration.id, title: registration.title }).toEqual({
      id: "card",
      title: "Glance",
    });
    expect(app.icons.map((icon) => icon.name)).toContain(registration.icon);
    expect(composerReadiness()).toMatchObject({
      chrome: "bare",
      experimental_placement: "adjacent-to-composer",
    });
    expect(app.navPanels.map((panel) => panel.id)).toEqual(["glance"]);
    expect(app.appOverlays.map((overlay) => overlay.id)).toEqual(["subtitles"]);
    expect(app.contentScripts.map((script) => script.id)).toEqual(["subtitles"]);
  });

  it("composer readiness exposes the badge and core archive action without opening a card", async () => {
    const archive = vi.fn(async () => {});

    const slot = renderSlot(
      composerReadiness(),
      {},
      {
        pluginId: "glance",
        sdk: completionSdk(),
        composer: { scope: { kind: "thread", threadId: "thr_one" }, text: "Existing draft" },
        sidebarThreads: { threads: [thread("thr_one")] },
        experimental_threadWork: {
          thr_one: serverWork(
            "ready-to-archive",
            "The repair is deployed and verified; no further action is evident.",
          ),
        },
        threadActions: coreArchive(archive),
      },
    );

    expect(screen.queryByText("Ready to archive")).toBeNull();
    await screen.findByText("Ready to archive");
    expect(screen.getByRole("group", { name: "Ready to archive" }).textContent).toContain(
      "The repair is deployed and verified; no further action is evident.",
    );
    expect(screen.getAllByRole("button", { name: "Archive" })).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Chat card" })).toBeNull();
    expect(slot.inspection.rpcCalls).toEqual([]);
    const button = screen.getByRole("button", { name: "Archive" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(archive).toHaveBeenCalledTimes(1);
    expect(slot.inspection.composer.text).toBe("Existing draft");
    expect(slot.inspection.composer.submits).toEqual([]);
  });

  it.each([false, true])(
    "dismisses readiness from the shared menu action, failure=%s",
    async (fails) => {
      const registration = app.threadActions.find((entry) => entry.id === "not-ready");

      if (registration === undefined) throw new Error("Not ready action missing");
      let ids = ["thr_one"];
      let revision = 1;
      const calls: string[] = [];

      const sdk: PluginSdkTestFakes = {
        plugins: {
          async callRpc(args) {
            calls.push(args.method);

            if (args.method === "dismiss") {
              if (fails) throw new Error("Dismissal failed");
              expect(args.input).toEqual({ threadId: "thr_one" });
              ids = [];
              revision += 1;

              return args.outputSchema.parse({ threadId: "thr_one", dismissed: true });
            }

            return args.outputSchema.parse({ threadIds: ids, revision });
          },
        },
      };

      let sdkClient: ReturnType<typeof useSdk>;
      let navigateClient: ReturnType<typeof experimental_useAppNavigate>;
      let actionData: unknown;
      const Badge = composerReadiness().component;

      const slot = renderSlot(
        {
          component: () => {
            sdkClient = useSdk();
            navigateClient = experimental_useAppNavigate();
            actionData = registration.useData?.({ threadIds: ["thr_one"] });

            return <Badge />;
          },
        },
        {},
        {
          pluginId: "glance",
          sdk,
          composer: { scope: { kind: "thread", threadId: "thr_one" }, text: "Keep this draft" },
          sidebarThreads: { threads: [thread("thr_one")] },
          threadActions: (target) => {
            const action = registration.item({
              thread: target,
              data: actionData,
              sdk: sdkClient,
              navigate: navigateClient,
            });

            return action === null
              ? []
              : [
                  {
                    key: "glance/not-ready",
                    pluginId: "glance",
                    group: "lifecycle",
                    action: {
                      ...action,
                      run: async () => {
                        await action.run({ requestRename: () => {} });
                      },
                    },
                  },
                ];
          },
        },
      );

      await screen.findByRole("button", { name: "Not ready to archive" });
      fireEvent.click(screen.getByRole("button", { name: "Not ready to archive" }));

      if (fails) {
        expect(await screen.findByRole("alert")).toHaveProperty(
          "textContent",
          "Could not dismiss archive suggestion. Try again.",
        );
        expect(screen.getByText("Ready to archive")).toBeTruthy();
        expect(ids).toEqual(["thr_one"]);
      } else {
        await waitFor(() => expect(screen.queryByText("Ready to archive")).toBeNull());
        expect(ids).toEqual([]);
      }

      expect(calls).toContain("dismiss");
      expect(slot.inspection.composer.text).toBe("Keep this draft");
      expect(slot.inspection.composer.submits).toEqual([]);
    },
  );

  it("composer readiness withdraws immediately for new work, archived chats and lost readiness", async () => {
    const owner = tidyApp({ threadIds: ["thr_one"], revision: 2 });
    const live = thread("thr_one");
    const registration = composerReadiness();
    const Badge = registration.component;

    const slot = renderSlot(
      registration,
      {},
      {
        sdk: tidy({ ids: [], fails: true }),
        composer: { scope: { kind: "thread", threadId: "thr_one" } },
        sidebarThreads: { threads: [live] },
      },
    );

    try {
      await screen.findByText("Ready to archive");
      live.status = "active";
      live.runtimeStatus = "active";
      slot.rerender(<Badge />);
      expect(screen.queryByText("Ready to archive")).toBeNull();
      live.status = "idle";
      live.runtimeStatus = "idle";
      slot.rerender(<Badge />);
      expect(screen.getByText("Ready to archive")).toBeTruthy();
      live.isArchived = true;
      slot.rerender(<Badge />);
      expect(screen.queryByText("Ready to archive")).toBeNull();
      live.isArchived = false;
      slot.rerender(<Badge />);
      act(() => owner.mark({ threadIds: [], revision: 3 }));
      expect(screen.queryByText("Ready to archive")).toBeNull();
      act(() => owner.mark({ threadIds: ["thr_one"], revision: 4 }));
      expect(screen.getByText("Ready to archive")).toBeTruthy();
      act(() => owner.unload());
      expect(screen.queryByText("Ready to archive")).toBeNull();
    } finally {
      cleanup();
      owner.unload();
    }
  });

  it("composer readiness follows the composer scope and needs no Glance card", async () => {
    const slot = renderSlot(
      composerReadiness(),
      {},
      {
        sdk: tidy({ ids: ["thr_one", "missing"], fails: false }),
        composer: { scope: { kind: "new-thread", projectId: "proj_one" } },
        sidebarThreads: { threads: [thread("thr_one"), thread("thr_two")] },
      },
    );

    expect(screen.queryByText("Ready to archive")).toBeNull();
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_one" });
    await screen.findByText("Ready to archive");
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_two" });
    expect(screen.queryByText("Ready to archive")).toBeNull();
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "missing" });
    expect(screen.queryByText("Ready to archive")).toBeNull();
    await slot.behavior.setComposerScope({ kind: "new-thread", projectId: "proj_one" });
    expect(screen.queryByText("Ready to archive")).toBeNull();
    expect(slot.inspection.rpcCalls).toEqual([]);
  });

  it("keeps the composer card on hosts without the thread companion slot", async () => {
    const legacy = await loadPluginApp(
      definePluginApp((builder) =>
        setupGlance({
          ...builder,
          slots: { ...builder.slots, experimental_threadCompanion: undefined },
        }),
      ),
    );

    const registration = legacy.composerCustomizations.find((entry) => entry.id === "glance")
      ?.banners?.[0];

    if (registration === undefined) throw new Error("Glance composer banner is not registered");
    expect(legacy.composerCustomizations.map((entry) => entry.id)).toEqual([
      "glance-dev-servers",
      "glance",
    ]);
    expect(legacy.threadCompanions).toEqual([]);
    expect(legacy.navPanels.map((panel) => panel.id)).toEqual(["glance"]);
    const { rpc } = fixtures();

    renderSlot(
      registration,
      {},
      { rpc, composer: { scope: { kind: "thread", threadId: "thr_one" } } },
    );

    await screen.findAllByText("Ready to review the preview");
    expect(cardToggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("shows only the chat summary beside the chat and marks it seen after two visible seconds", async () => {
    const { rpc } = fixtures();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    const slot = renderSlot(companion(), companionProps("aside"), {
      rpc,
      sidebarThreads: { threads: [thread("thr_one")] },
    });

    const card = await screen.findByRole("region", { name: "Chat card" });

    await within(card).findByText("Ship the redesigned preview");

    for (const [label, value] of [
      ["About", "Chat thr_one"],
      ["Started", "Ship the redesigned preview"],
      ["Toward", "Ready to review the preview"],
    ] as const)
      expect(within(card).getByText(label).nextElementSibling?.textContent).toBe(value);

    expect(screen.queryByRole("button", { name: "Chat card" })).toBeNull();

    for (const absent of [
      "Sam selects the release scope",
      "Updated since you last looked",
      "12 passed",
      "Next",
    ])
      expect(within(card).queryByText(absent)).toBeNull();

    expect(within(card).queryByRole("button", { name: /^Details/u })).toBeNull();
    expect(within(card).queryByRole("img", { name: /^Phase/u })).toBeNull();
    vi.useFakeTimers();
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "card.markSeen")).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "card.markSeen")?.input).toEqual(
      { threadId: "thr_one", revision: 2, conversationSeq: 55 },
    );
  });

  it("shows a finished chat's result in green in the side card and leaves archive to the composer", async () => {
    const { rpc } = completedFixture();

    renderSlot(companion(), companionProps("aside"), {
      pluginId: "glance",
      rpc,
      sdk: completionSdk(),
      sidebarThreads: { threads: [thread("thr_one"), thread("thr_next")] },
    });

    const result = await screen.findByText("Completed result delivered");
    expect(screen.getByText("Done")).toBeTruthy();
    expect(result.closest("dd")?.previousElementSibling?.textContent).toBe("Result");
    expect(result.parentElement?.className).toContain("text-success-foreground");
    expect(screen.queryByText("Toward")).toBeNull();
    expect(screen.queryByRole("group", { name: "Ready to archive" })).toBeNull();
  });

  it("colors the title-bar dot blue while working, green when done and red when blocked", async () => {
    const cases = [
      [{ status: "working", phase: "build", headline: "Building the card" }, "bg-timeline-accent"],
      [
        { status: "done", phase: "done", headline: "Card shipped", sidebarSummary: "Card shipped" },
        "bg-success",
      ],
      [
        {
          status: "blocked",
          phase: "ship",
          headline: "Release stopped",
          blocker: "Apple review rejected the build",
        },
        "bg-destructive",
      ],
    ] as const;

    for (const [saved, dot] of cases) {
      const { data, rpc, view } = fixtures();
      data.view = { ...view, card: cardSchema.parse(saved) };

      const live: PluginSidebarThread = {
        ...thread("thr_one"),
        runtimeStatus: saved.status === "working" ? "active" : "idle",
      };

      const slot = renderSlot(companion(), companionProps("toolbar"), {
        rpc,
        sidebarThreads: { threads: [live] },
      });

      const pill = await screen.findByRole("button", { name: "Chat card" });
      await waitFor(() => expect(pill.querySelector(`.${dot}`)).not.toBeNull());
      fireEvent.click(pill);
      const popover = screen.getByRole("dialog", { name: "Chat card" });

      if (saved.status === "blocked") {
        const result = within(popover).getByText("Apple review rejected the build");
        expect(result.parentElement?.className).toContain("text-destructive");
      }

      slot.unmount();
    }
  });

  it("puts a one-line pill in the title bar and opens the same card below it", async () => {
    const { rpc } = fixtures();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const slot = renderSlot(companion(), companionProps("toolbar"), { rpc });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Chat card" }).textContent).toContain(
        "Ready to review the preview",
      ),
    );

    const pill = screen.getByRole("button", { name: "Chat card" });
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.getByText("Needs you. Ready to review the preview.", { exact: false }),
    ).toBeTruthy();
    expect(pill.querySelector(".bg-warning")).not.toBeNull();
    expect(screen.queryByText("Ship the redesigned preview")).toBeNull();
    vi.useFakeTimers();
    fireEvent(document, new Event("visibilitychange"));
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "card.markSeen")).toBe(false);

    fireEvent.click(pill);
    const popover = screen.getByRole("dialog", { name: "Chat card" });
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(within(popover).getByText("Ship the redesigned preview")).toBeTruthy();
    expect(within(popover).getByText("Ready to review the preview")).toBeTruthy();
    expect(within(popover).queryByText("Sam selects the release scope")).toBeNull();
    expect(within(popover).queryByRole("button", { name: /^Details/u })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "card.markSeen")?.input).toEqual(
      { threadId: "thr_one", revision: 2, conversationSeq: 55 },
    );

    fireEvent.keyDown(popover, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(pill);
    fireEvent.click(pill);
    fireEvent.pointerDown(within(screen.getByRole("dialog")).getByText("Needs you"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pill.getAttribute("aria-expanded")).toBe("false");
  });

  it("marks a server-update wait with a progress bar in the recessed title-bar capsule", async () => {
    const { data, rpc } = fixtures();
    data.view = null;
    data.diff = { ...data.diff, revision: null, changes: [], newReplies: 0 };

    const work = serverWork("waiting", "Finishing the Omnyo update", ["Server update"]);
    work.primary.reason.code = "external-wait";
    work.waits = [
      {
        id: "qmsg_update",
        reason: "Finishing the Omnyo update",
        actor: { kind: "external", id: null, label: "Server update" },
      },
    ];

    renderSlot(companion(), companionProps("toolbar"), {
      rpc,
      experimental_threadWork: { thr_one: work },
    });

    const pill = await screen.findByRole("button", { name: "Chat card" });
    expect(pill.textContent).toContain("Finishing the Omnyo update");

    for (const className of [
      "rounded-full",
      "bg-surface-recessed",
      "text-xs",
      "text-muted-foreground",
    ])
      expect(pill.className).toContain(className);

    expect(pill.querySelector("[data-glance-update-progress]")).not.toBeNull();
    expect(pill.querySelector("[data-glance-update-progress] span")?.className).toContain(
      "animate-indeterminate-progress",
    );
  });

  it("keeps other statuses in the capsule without a progress bar", async () => {
    const { data, rpc } = fixtures();
    data.view = null;
    data.diff = { ...data.diff, revision: null, changes: [], newReplies: 0 };

    const work = serverWork("waiting", "The release job is still running.", ["Release job"]);
    work.primary.reason.code = "external-wait";
    work.waits = [
      {
        id: "wait_release",
        reason: "The release job is still running.",
        actor: { kind: "external", id: null, label: "Release job" },
      },
    ];

    renderSlot(companion(), companionProps("toolbar"), {
      rpc,
      experimental_threadWork: { thr_one: work },
    });

    const pill = await screen.findByRole("button", { name: "Chat card" });
    expect(pill.textContent).toContain("The release job is still running.");
    expect(pill.className).toContain("bg-surface-recessed");
    expect(pill.querySelector("[data-glance-update-progress]")).toBeNull();
  });

  it("shows a Pursue loop in the title-bar pill and lets the card edit and stop it", async () => {
    const { rpc } = fixtures();

    let loop: { prompt: string; nextAtMs: number | null } | null = {
      prompt: "Check the soak",
      nextAtMs: Date.now() + 3 * 3_600_000,
    };

    const calls: { method: string; input: unknown }[] = [];

    const sdk: PluginSdkTestFakes = {
      plugins: {
        async callRpc(args) {
          if (args.pluginId !== "pursue") throw new Error("not under test");
          calls.push({ method: args.method, input: args.input });

          if (args.method === "pursue_clear_loop") loop = null;

          if (args.method === "pursue_edit_loop" && loop !== null)
            loop = { ...loop, prompt: "Check the soak again" };

          return args.outputSchema.parse({
            goal: null,
            loop:
              loop === null
                ? null
                : { ...loop, intervalMs: 3_600_000, iterations: 1, maxIterations: null },
          });
        },
      },
    };

    renderSlot(companion(), companionProps("toolbar"), { rpc, sdk });

    const pill = await screen.findByRole("button", { name: "Chat card" });
    await waitFor(() => expect(pill.querySelector("[data-glance-loop]")?.textContent).toBe("3h"));

    fireEvent.click(pill);
    const section = within(screen.getByRole("dialog")).getByRole("region", { name: "Loop" });
    expect(section.textContent).toContain("Next check in 3h · 1 check");
    expect(within(section).getByText("Check the soak")).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(section).getByRole("textbox", { name: "Loop prompt" }), {
      target: { value: "  Check the soak again " },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(section).getByText("Check the soak again")).toBeTruthy());
    expect(calls.find((call) => call.method === "pursue_edit_loop")?.input).toEqual({
      threadId: "thr_one",
      prompt: "Check the soak again",
    });

    fireEvent.click(within(section).getByRole("button", { name: "Stop loop" }));
    await waitFor(() => expect(pill.querySelector("[data-glance-loop]")).toBeNull());
    expect(screen.queryByRole("region", { name: "Loop" })).toBeNull();
  });

  it("shows the server's chat status in the side card and title bar when the chat has no card", async () => {
    const { data, rpc } = fixtures();
    data.view = null;
    data.diff = { ...data.diff, revision: null, changes: [], newReplies: 0 };

    const options = {
      rpc,
      experimental_threadWork: {
        thr_one: serverWork("waiting", "The release job is still running.", ["Release job"]),
      },
    };

    const aside = renderSlot(companion(), companionProps("aside"), options);
    const card = await aside.findByRole("region", { name: "Chat card" });

    expect(card.textContent).toContain("Waiting");
    expect(
      within(card).getByText("The release job is still running.").closest("dd")
        ?.previousElementSibling?.textContent,
    ).toBe("Toward");
    expect(within(card).queryByText("Release job")).toBeNull();
    aside.unmount();

    renderSlot(companion(), companionProps("toolbar"), options);
    const pill = await screen.findByRole("button", { name: "Chat card" });
    expect(pill.textContent).toContain("The release job is still running.");
    expect(pill.querySelector(".bg-timeline-accent")).not.toBeNull();
    fireEvent.click(pill);
    expect(
      within(screen.getByRole("dialog", { name: "Chat card" })).queryByText("Release job"),
    ).toBeNull();
  });
});

type SharedInboxSnapshot = NonNullable<
  ReturnType<PluginSdkApp["experimental_useInboxSnapshot"]>["snapshot"]
>;

function statusSnapshot(
  state: "finished" | "needs-you" | "failed",
  reason: string,
): SharedInboxSnapshot {
  return {
    revision: "status-test",
    generatedAt: 0,
    waiting: [],
    running: [],
    shelf: [],
    lastMove: null,
    counts: {
      needsYou: state === "needs-you" ? 1 : 0,
      inbox: 1,
      questions: 0,
      running: 0,
      waiting: 0,
      onYou: [],
      nextBackAt: null,
    },
    inbox: [
      {
        threadId: "thr_one",
        projectId: "proj_one",
        title: "Fixture",
        shelved: false,
        automationId: null,
        state,
        reason: {
          kind: state === "finished" ? "unassessed" : "ask",
          text: reason,
          threadId: "thr_one",
        },
        recap: null,
        archiveReady: false,
        optionalQuestion: null,
        pendingResults: 0,
        view: "inbox",
        card: null,
        waiting: null,
        running: null,
        runs: null,
        incident: null,
        sortAt: 0,
        latch: "fixture",
      },
    ],
  };
}

describe("shared Inbox companion status", () => {
  for (const saved of [false, true]) {
    for (const placement of ["toolbar", "aside", "inline"] as const) {
      it.each([
        ["finished", "Finished", false],
        ["needs-you", "Needs you", false],
        ["failed", "Failed", false],
        ["finished", "Finished", true],
      ] as const)(
        `${placement} uses %s (%s, stale %s) (saved ${saved})`,
        async (state, label, stale) => {
          const { data, rpc } = fixtures();

          if (!saved) data.view = null;
          const work = serverWork("open", "No completion assessment is available.");
          const live = { ...thread("thr_one"), experimental_work: work };
          const reason = "Review the prepared candidate";
          renderSlot(companion(), companionProps(placement), {
            pluginId: "glance",
            rpc,
            sidebarThreads: { threads: [live] },
            experimental_threadWork: { thr_one: work },
            inboxSnapshot: {
              snapshot: statusSnapshot(state, reason),
              stale,
              status: stale ? "error" : "ready",
            },
          });
          await screen.findAllByText(reason, { exact: false }, { timeout: 500 });
          expect(document.body.textContent).toContain(label);
          expect(
            screen.queryByText("No completion assessment is available.", { exact: false }),
          ).toBeNull();

          if (stale) expect(await screen.findAllByText("Status stale")).not.toHaveLength(0);
          expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
        },
      );
    }
  }
});

describe("shared Inbox archive readiness", () => {
  for (const saved of [false, true]) {
    it.each([false, true])(
      `gates inline archive by both sources (saved ${saved}, server %s)`,
      async (archiveReady) => {
        const { data, rpc } = fixtures();

        if (!saved) data.view = null;
        const work = serverWork("open", "No completion assessment is available.");
        const live = { ...thread("thr_one"), experimental_work: work };
        const snapshot = statusSnapshot("finished", "Candidate review finished");
        snapshot.inbox[0]!.archiveReady = archiveReady;
        renderSlot(companion(), companionProps("inline"), {
          pluginId: "glance",
          rpc,
          sdk: tidy({ ids: ["thr_one"], fails: false }),
          sidebarThreads: { threads: [live] },
          experimental_threadWork: { thr_one: work },
          inboxSnapshot: { snapshot },
        });
        await screen.findAllByText("Candidate review finished", { exact: false });

        if (archiveReady)
          expect(await screen.findByRole("button", { name: "Archive" })).toBeTruthy();
        else expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
      },
    );
  }

  it.each([false, true])(
    "gates the composer archive badge by server readiness %s",
    async (archiveReady) => {
      const snapshot = statusSnapshot("finished", "Candidate review finished");
      snapshot.inbox[0]!.archiveReady = archiveReady;
      renderSlot(
        composerReadiness(),
        {},
        {
          pluginId: "glance",
          sdk: tidy({ ids: ["thr_one"], fails: false }),
          composer: { scope: { kind: "thread", threadId: "thr_one" } },
          sidebarThreads: { threads: [thread("thr_one")] },
          inboxSnapshot: { snapshot },
        },
      );

      await act(async () => {});

      if (archiveReady)
        expect(await screen.findByRole("group", { name: "Ready to archive" })).toBeTruthy();
      else {
        await waitFor(() =>
          expect(screen.queryByRole("group", { name: "Ready to archive" })).toBeNull(),
        );
      }
    },
  );
});
