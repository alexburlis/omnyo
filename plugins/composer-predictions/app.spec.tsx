// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installTestPluginRuntime,
  loadPluginApp,
  renderSlot,
  type RenderSlotOptions,
} from "@omnyo/plugin-sdk/testing/app";
import type { ComponentType } from "react";
import { z } from "zod";
import { experimental_threadIndicatorCases } from "@omnyo/plugin-sdk/testing";
import {
  useComposer,
  type ExperimentalComposerSuggestion,
  type ExperimentalThreadBootstrapData,
  type PluginSidebarThread,
} from "@omnyo/plugin-sdk/app";
import type { PredictionState, rpcContract } from "./contract";

const toastError = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: { error: toastError } }));

installTestPluginRuntime();

interface CommandContext {
  threadId: string | null;
  projectId: string | null;
  openPanel: () => boolean;
}

const isFunction = (value: unknown) => typeof value === "function";

const capturedCommandsSchema = z.object({
  commandPaletteActions: z.array(
    z.object({
      id: z.string(),
      isAvailable: z
        .custom<(context: CommandContext) => boolean>(isFunction)
        .optional(),
      run: z.custom<(context: CommandContext) => void | Promise<void>>(
        isFunction,
      ),
    }),
  ),
});

let Banner: ComponentType;

let Action: ComponentType;

let Sync: ComponentType;

let suggestCommand: z.infer<
  typeof capturedCommandsSchema
>["commandPaletteActions"][number];

const ready: PredictionState = {
  threadId: "thr_one",
  generation: 1,
  basis: "fixture-basis",
  status: "ready",
  text: "Verify the composer behavior.",
  noSuggestionReason: null,
  message: null,
  archiveReadiness: null,
};

function fromBootstrap(state: PredictionState) {
  return {
    "thr_one:state": {
      status: "ready" as const,
      result: state,
      updatedAt: 1,
      current: true,
    },
  };
}

const settled = {
  diagnostics: (input: { threadId: string }) => ({
    ...input,
    lastFailure: null,
    lastSkip: null,
  }),
  cancel: (input: { threadId: string; generation: number }) => ({
    ...ready,
    ...input,
    generation: input.generation + 1,
    status: "idle" as const,
    text: null,
  }),
  dismiss: (input: { threadId: string; generation: number }) => ({
    ...ready,
    ...input,
    generation: input.generation + 1,
    status: "none" as const,
    text: null,
  }),
};

type WorkSummary = NonNullable<PluginSidebarThread["experimental_work"]>;

function workFixture(
  label: WorkSummary["primary"]["label"] = "open",
): WorkSummary {
  const work = experimental_threadIndicatorCases.find(
    (entry) => entry.state.work?.primary.label === label,
  )?.state.work;

  if (work === null || work === undefined)
    throw new Error("Work fixture missing");

  return work;
}

function sidebarThread(
  work: WorkSummary | null = workFixture(),
): PluginSidebarThread {
  return {
    experimental_work: work,
    id: "thr_one",
    projectId: "project-one",
    title: "Chat",
    titleFallback: null,
    displayTitle: "Chat",
    experimental_subtitle: null,
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
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    experimental_shelvedAt: null,
    experimental_shelfSortKey: null,
    href: "/threads/thr_one",
    isHidden: false,
    environment: null,
    host: null,
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: 1,
    latestAttentionAt: 1,
    lastMessageAt: null,
    experimental_attention: {
      kind: "none",
      requiredCount: 0,
      optionalCount: 0,
      callback: null,
    },
  };
}

function HostSend() {
  const composer = useComposer();

  return (
    <button
      type="button"
      onClick={() => void composer.submit({ experimental_data: null })}
    >
      Host send
    </button>
  );
}

function mount(options: RenderSlotOptions<typeof rpcContract> = {}) {
  function ComposerSurface() {
    return (
      <>
        <Banner />
        <Action />
        <HostSend />
      </>
    );
  }

  return renderSlot<Record<string, never>, typeof rpcContract>(
    { component: ComposerSurface },
    {},
    {
      context: { threadId: "thr_one" },
      composer: {
        scope: { kind: "thread", threadId: "thr_one" },
        selection: { providerId: "codex" },
      },
      sidebarThreads: { threads: [sidebarThread()] },
      experimental_threadWork: {
        thr_one:
          options.sidebarThreads?.threads?.[0]?.experimental_work ??
          workFixture(),
      },
      threadBootstrapData: fromBootstrap(ready),
      rpc: { state: () => ready, request: () => ready, ...settled },
      ...options,
    },
  );
}

beforeEach(async () => {
  vi.resetModules();
  toastError.mockClear();
  const definition = (await import("./app")).default;
  const registrations = await loadPluginApp(definition);

  const customization = registrations.composerCustomizations.find(
    (entry) => entry.id === "predictions",
  );

  const banner = customization?.banners?.find(
    (entry) => entry.id === "suggestion",
  );

  if (!banner)
    throw new Error("Prediction composer banner was not registered.");

  if (banner.experimental_placement !== "adjacent-to-composer")
    throw new Error("Prediction banner must sit directly above the composer.");
  Banner = banner.component;

  const action = customization?.actions?.find(
    (entry) => entry.id === "suggest-reply",
  );

  if (!action) throw new Error("Suggest reply action was not registered.");
  Action = action.component;

  const command = capturedCommandsSchema
    .parse(registrations)
    .commandPaletteActions.find((entry) => entry.id === "suggest-reply");

  if (!command) throw new Error("Suggest reply command was not registered.");
  suggestCommand = command;

  const overlay = registrations.appOverlays.find(
    (entry) => entry.id === "prediction-sync",
  );

  if (!overlay)
    throw new Error("Prediction realtime sync overlay was not registered.");
  Sync = overlay.component;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function shown(slot: {
  composer: { suggestion: ExperimentalComposerSuggestion | null };
}) {
  return slot.composer.suggestion;
}

function shownText(slot: {
  composer: { suggestion: ExperimentalComposerSuggestion | null };
}) {
  const suggestion = slot.composer.suggestion;

  return suggestion?.status === "ready" ? suggestion.text : null;
}

describe("composer predictions", () => {
  it.each([
    "open",
    "working",
    "needs-you",
    "blocked",
    "waiting",
    "external",
    "ready-to-archive",
  ] as const)(
    "leaves %s chat status to the chat card when no reply is suggested",
    (label) => {
      const work = workFixture(label);

      const prediction = {
        ...ready,
        basis: work.basis,
        text: null,
        noSuggestionReason: "The next step already has an owner.",
      };

      const slot = mount({
        sidebarThreads: { threads: [sidebarThread(work)] },
        threadBootstrapData: fromBootstrap(prediction),
      });

      expect(shown(slot)?.status ?? null).toBe(
        ["open", "working", "blocked", "waiting"].includes(label)
          ? "none"
          : null,
      );
      expect(slot.container.textContent).not.toContain(
        work.primary.reason.text,
      );
      expect(slot.rpcCalls).toEqual([]);
    },
  );

  it("leaves completed-work reasoning to the integrated archive status", () => {
    const work = workFixture("ready-to-archive");

    const slot = mount({
      sidebarThreads: { threads: [sidebarThread(work)] },
      threadBootstrapData: fromBootstrap({
        ...ready,
        basis: work.basis,
        text: null,
        noSuggestionReason: "The repair is verified.",
      }),
    });

    expect(slot.queryByRole("status")).toBeNull();
    expect(shown(slot)).toBeNull();
  });

  it.each(["external", "ready-to-archive"] as const)(
    "answers a requested reply in a %s chat with the reason none was suggested",
    async (label) => {
      const work = workFixture(label);

      const omitted = {
        ...ready,
        basis: work.basis,
        text: null,
        noSuggestionReason: "The question is answered.",
      };

      const slot = mount({
        sidebarThreads: { threads: [sidebarThread(work)] },
        experimental_threadWork: { thr_one: work },
        threadBootstrapData: fromBootstrap(omitted),
        rpc: {
          state: () => omitted,
          request: () => ({ ...omitted, generation: 2, forced: true }),
          ...settled,
        },
      });

      expect(shown(slot)).toBeNull();
      await act(async () =>
        suggestCommand.run({
          threadId: "thr_one",
          projectId: "project-one",
          openPanel: () => false,
        }),
      );

      await waitFor(() =>
        expect(shown(slot)).toMatchObject({
          status: "none",
          reason: omitted.noSuggestionReason,
        }),
      );
    },
  );

  it("explains a completed prediction that intentionally suggests no reply", () => {
    const prediction = {
      ...ready,
      text: null,
      noSuggestionReason: "Work is paused; restarting it needs a new request.",
    };

    const slot = mount({ threadBootstrapData: fromBootstrap(prediction) });

    expect(shown(slot)).toMatchObject({
      status: "none",
      reason: prediction.noSuggestionReason,
    });
    expect(slot.queryByRole("status")).toBeNull();
    expect(slot.rpcCalls).toEqual([]);
  });

  it("explains older completed predictions without an omission reason", () => {
    const slot = mount({
      threadBootstrapData: fromBootstrap({ ...ready, text: null }),
    });

    expect(shown(slot)).toMatchObject({
      status: "none",
      reason: "This prediction did not record why it omitted a reply.",
    });
    expect(slot.rpcCalls).toEqual([]);
  });

  describe("forcing a suggested reply", () => {
    const FORCED = {
      method: "request",
      input: { threadId: "thr_one", force: true },
    };

    const omitted = {
      ...ready,
      text: null,
      noSuggestionReason: "A loop owns the next step.",
    };

    const dismissed = {
      ...ready,
      status: "none" as const,
      text: null,
    };

    function deferred() {
      let resolve: (state: PredictionState) => void = () => {};

      let reject: (error: Error) => void = () => {};

      const promise = new Promise<PredictionState>((res, rej) => {
        resolve = res;
        reject = rej;
      });

      return { promise, resolve, reject };
    }

    function mountWithRequest(
      state: PredictionState,
      request: () => PredictionState | Promise<PredictionState>,
    ) {
      return mount({
        threadBootstrapData: fromBootstrap(state),
        rpc: { state: () => state, request, ...settled },
      });
    }

    it("asks for another reply from a ready suggestion and shows the wait at once", async () => {
      const pending = deferred();
      const slot = mountWithRequest(ready, () => pending.promise);
      const suggestion = shown(slot);

      if (suggestion?.status !== "ready") throw new Error("Expected a reply.");
      act(() => suggestion.onRegenerate?.());

      expect(shown(slot)?.status).toBe("loading");
      expect(slot.rpcCalls).toEqual([FORCED]);

      await act(async () =>
        pending.resolve({
          ...ready,
          generation: 2,
          text: "Try the other fix.",
        }),
      );
      await waitFor(() => expect(shownText(slot)).toBe("Try the other fix."));
    });

    it("forces a reply from a prediction that omitted one", async () => {
      const slot = mountWithRequest(omitted, () => ({
        ...ready,
        generation: 2,
        text: "Stop the loop and review it.",
      }));

      const suggestion = shown(slot);

      if (suggestion?.status !== "none") throw new Error("Expected no reply.");
      await act(async () => suggestion.onRequest());

      expect(slot.rpcCalls).toEqual([FORCED]);
      await waitFor(() =>
        expect(shownText(slot)).toBe("Stop the loop and review it."),
      );
    });

    it("shows the reason again when the model still omits a reply", async () => {
      const slot = mountWithRequest(ready, () => ({
        ...omitted,
        generation: 2,
      }));

      const suggestion = shown(slot);

      if (suggestion?.status !== "ready") throw new Error("Expected a reply.");
      await act(async () => suggestion.onRegenerate?.());

      await waitFor(() =>
        expect(shown(slot)).toMatchObject({
          status: "none",
          reason: omitted.noSuggestionReason,
        }),
      );
    });

    it("tells the user when the chat cannot take a forced request", async () => {
      const slot = mountWithRequest(ready, () => ({
        ...ready,
        generation: 2,
        status: "idle",
        text: null,
        message: "The chat was still running.",
      }));

      const suggestion = shown(slot);

      if (suggestion?.status !== "ready") throw new Error("Expected a reply.");
      await act(async () => suggestion.onRegenerate?.());

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("The chat was still running."),
      );
      expect(shown(slot)).toBeNull();
    });

    it("recovers visibly when a forced request cannot reach Omnyo", async () => {
      const pending = deferred();
      const slot = mountWithRequest(ready, () => pending.promise);
      const suggestion = shown(slot);

      if (suggestion?.status !== "ready") throw new Error("Expected a reply.");
      act(() => suggestion.onRegenerate?.());
      expect(shown(slot)?.status).toBe("loading");

      await act(async () => pending.reject(new Error("offline")));

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "Couldn’t request a suggested reply.",
        ),
      );
      expect(shownText(slot)).toBe(ready.text);
    });

    it("stops a forced request without reporting its late result", async () => {
      const pending = deferred();
      const slot = mountWithRequest(ready, () => pending.promise);
      const suggestion = shown(slot);

      if (suggestion?.status !== "ready") throw new Error("Expected a reply.");
      act(() => suggestion.onRegenerate?.());

      const waiting = shown(slot);

      if (waiting?.status !== "loading") throw new Error("Expected a wait.");
      await act(async () => waiting.onDismiss());

      expect(shown(slot)).toBeNull();
      expect(slot.rpcCalls).toContainEqual({
        method: "cancel",
        input: { threadId: "thr_one", generation: ready.generation },
      });

      await act(async () =>
        pending.resolve({
          ...ready,
          generation: 5,
          status: "idle",
          text: null,
          message: "The prediction was cancelled.",
        }),
      );
      expect(toastError).not.toHaveBeenCalled();
    });

    it("hands the wait to the loading suggestion without a spinner of its own", async () => {
      const pending = deferred();
      const slot = mountWithRequest(dismissed, () => pending.promise);
      fireEvent.click(slot.getByRole("button", { name: "Suggest a reply" }));

      expect(shown(slot)?.status).toBe("loading");
      expect(
        slot.queryByRole("button", { name: "Suggest a reply" }),
      ).toBeNull();
      expect(slot.rpcCalls).toEqual([FORCED]);

      await act(async () => pending.resolve({ ...ready, generation: 2 }));
      await waitFor(() => expect(shownText(slot)).toBe(ready.text));
      expect(
        slot.queryByRole("button", { name: "Suggest a reply" }),
      ).toBeNull();
    });

    it("offers the request again when a forced request cannot reach Omnyo", async () => {
      const pending = deferred();
      const slot = mountWithRequest(dismissed, () => pending.promise);
      fireEvent.click(slot.getByRole("button", { name: "Suggest a reply" }));

      await act(async () => pending.reject(new Error("Offline")));

      expect(shown(slot)).toBeNull();
      expect(
        slot.getByRole("button", { name: "Suggest a reply" }),
      ).not.toBeNull();
    });

    it("returns the request once the user dismisses a suggestion", async () => {
      const slot = mountWithRequest(ready, () => ready);

      expect(
        slot.queryByRole("button", { name: "Suggest a reply" }),
      ).toBeNull();

      const suggestion = shown(slot);

      if (suggestion?.status !== "ready") throw new Error("Expected a reply.");
      await act(async () => suggestion.onDismiss());

      expect(shown(slot)).toBeNull();
      expect(
        slot.getByRole("button", { name: "Suggest a reply" }),
      ).not.toBeNull();
    });

    const failed = {
      ...dismissed,
      status: "failed" as const,
      message: "Prediction failed.",
    };

    function stubCompactViewport(matches: boolean) {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
          matches,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      );
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each([
      ["a ready suggestion", ready],
      ["a running prediction", { ...dismissed, status: "predicting" as const }],
    ])("leaves %s to the suggestion's own controls", (_, state) => {
      const slot = mountWithRequest(state, () => state);

      expect(shown(slot)).not.toBeNull();
      expect(
        slot.queryByRole("button", { name: "Suggest a reply" }),
      ).toBeNull();
    });

    it.each([
      ["a reason for omitting a reply", omitted],
      ["a failed prediction", failed],
    ])(
      "keeps the request on desktop beside %s, which the composer hides once engaged",
      (_, state) => {
        stubCompactViewport(false);
        const slot = mountWithRequest(state, () => state);

        expect(shown(slot)).not.toBeNull();
        expect(
          slot.getByRole("button", { name: "Suggest a reply" }),
        ).not.toBeNull();
      },
    );

    it.each([
      ["a reason for omitting a reply", omitted],
      ["a failed prediction", failed],
    ])("leaves %s to the suggestion card on a compact viewport", (_, state) => {
      stubCompactViewport(true);
      const slot = mountWithRequest(state, () => state);

      expect(shown(slot)).not.toBeNull();
      expect(
        slot.queryByRole("button", { name: "Suggest a reply" }),
      ).toBeNull();
    });

    it("leaves the request out when predictions are disabled", () => {
      const disabled = { ...dismissed, status: "disabled" as const };
      const slot = mountWithRequest(disabled, () => disabled);

      expect(
        slot.queryByRole("button", { name: "Suggest a reply" }),
      ).toBeNull();
    });

    it("leaves the request out over a draft", () => {
      const slot = mount({
        threadBootstrapData: fromBootstrap(dismissed),
        rpc: { state: () => dismissed, request: () => ready, ...settled },
        composer: {
          scope: { kind: "thread", threadId: "thr_one" },
          selection: { providerId: "codex" },
          text: "My own reply",
        },
      });

      expect(
        slot.queryByRole("button", { name: "Suggest a reply" }),
      ).toBeNull();
    });

    it("runs from the command palette for the open chat", async () => {
      const slot = mountWithRequest(dismissed, () => ({
        ...ready,
        generation: 2,
      }));

      const context = {
        threadId: "thr_one",
        projectId: "project-one",
        openPanel: () => false,
      };

      expect(suggestCommand.isAvailable?.(context)).toBe(true);
      expect(suggestCommand.isAvailable?.({ ...context, threadId: null })).toBe(
        false,
      );

      await act(async () => suggestCommand.run(context));

      expect(slot.rpcCalls).toEqual([FORCED]);
      await waitFor(() => expect(shownText(slot)).toBe(ready.text));
    });

    it("leaves a running request alone when the command palette asks again", async () => {
      const predicting = {
        ...dismissed,
        status: "predicting" as const,
      };

      const slot = mountWithRequest(predicting, () => predicting);

      await act(async () =>
        suggestCommand.run({
          threadId: "thr_one",
          projectId: "project-one",
          openPanel: () => false,
        }),
      );

      expect(
        slot.rpcCalls.filter(({ method }) => method === "request"),
      ).toEqual([]);
      expect(shown(slot)?.status).toBe("loading");
    });

    it.each([
      ["repeats a failed forced request as forced", true, FORCED],
      [
        "retries a failed background prediction without forcing",
        false,
        { method: "request", input: { threadId: "thr_one" } },
      ],
    ])("%s", async (_, forced, call) => {
      const failed = {
        ...dismissed,
        status: "failed" as const,
        message: "Claude could not finish the prediction.",
        ...(forced ? { forced: true } : {}),
      };

      const slot = mountWithRequest(failed, () => ({
        ...ready,
        generation: 2,
        ...(forced ? { forced: true } : {}),
      }));

      const suggestion = shown(slot);

      if (suggestion?.status !== "failed")
        throw new Error("Expected a failure.");
      await act(async () => suggestion.onRetry());

      expect(slot.rpcCalls).toEqual([call]);
      await waitFor(() => expect(shownText(slot)).toBe(ready.text));
    });

    it("says so when the command has no open composer to answer it", async () => {
      await suggestCommand.run({
        threadId: "thr_elsewhere",
        projectId: null,
        openPanel: () => false,
      });

      expect(toastError).toHaveBeenCalledWith(
        "Open the chat to suggest a reply.",
      );
    });
  });

  it("hides an obsolete omission reason when the chat work changes", () => {
    const slot = mount({
      threadBootstrapData: fromBootstrap({
        ...ready,
        text: null,
        noSuggestionReason: "Work is paused.",
      }),
      experimental_threadWork: {
        thr_one: { ...workFixture(), basis: "new-basis" },
      },
    });

    expect(slot.queryByRole("status")).toBeNull();
  });

  it("hides the omission reason while the user writes a reply", async () => {
    const slot = mount({
      threadBootstrapData: fromBootstrap({
        ...ready,
        text: null,
        noSuggestionReason: "Work is paused.",
      }),
    });

    await slot.setComposerText("Resume the work");
    expect(slot.queryByRole("status")).toBeNull();
  });

  it.each(["codex", "claude-code", "acp"])(
    "publishes a prepared suggestion for %s in the first paint without reading or generating",
    (providerId) => {
      const slot = mount({
        composer: {
          scope: { kind: "thread", threadId: "thr_one" },
          selection: { providerId },
        },
        rpc: {
          state: () => {
            throw new Error("A prepared suggestion needs no read.");
          },
          request: () => {
            throw new Error("Opening a chat must not generate.");
          },
          ...settled,
        },
      });

      expect(shownText(slot)).toBe(ready.text);
      expect(slot.composer.suggestionCalls[0]).toMatchObject({
        status: "ready",
        text: ready.text,
      });
      expect(slot.rpcCalls).toEqual([]);
    },
  );

  it("renders no card of its own above the composer", () => {
    const slot = mount();
    expect(shownText(slot)).toBe(ready.text);
    expect(slot.queryByText(ready.text!)).toBeNull();
    expect(slot.queryByRole("region")).toBeNull();
  });

  it("hides an old suggestion while required input is open", () => {
    const slot = mount({
      sidebarThreads: { threads: [sidebarThread(workFixture("needs-you"))] },
    });

    expect(shown(slot)).toBeNull();
    expect(slot.rpcCalls).toEqual([]);
  });

  it("does not hide a suggestion or require an answer for optional input", () => {
    const work = {
      ...workFixture(),
      optionalInput: [
        {
          id: "optional-one",
          kind: "question" as const,
          label: "Optional preference",
        },
      ],
    };

    const slot = mount({ sidebarThreads: { threads: [sidebarThread(work)] } });
    expect(shownText(slot)).toBe(ready.text);
  });

  it("hides a suggestion when a newer work basis arrives", () => {
    const slot = mount({
      sidebarThreads: {
        threads: [
          sidebarThread({ ...workFixture("working"), basis: "new-job-basis" }),
        ],
      },
    });

    expect(shown(slot)).toBeNull();
  });

  const runningJob = {
    id: "job",
    kind: "command" as const,
    label: "Release job running.",
    phase: "running" as const,
    actor: { kind: "agent" as const, id: "job", label: "Release job" },
  };

  it("hides a suggestion while the chat owns running or waiting work", () => {
    const running = mount({
      sidebarThreads: {
        threads: [sidebarThread({ ...workFixture(), activity: [runningJob] })],
      },
    });

    expect(shown(running)).toBeNull();

    const waiting = mount({
      sidebarThreads: {
        threads: [
          sidebarThread({
            ...workFixture(),
            waits: [
              {
                id: "host",
                reason: "Waiting for the machine.",
                actor: { kind: "external", id: null, label: "Machine" },
              },
            ],
          }),
        ],
      },
    });

    expect(shown(waiting)).toBeNull();
  });

  it("keeps a suggestion the user explicitly forced while work runs", () => {
    const slot = mount({
      threadBootstrapData: fromBootstrap({ ...ready, forced: true }),
      sidebarThreads: {
        threads: [sidebarThread({ ...workFixture(), activity: [runningJob] })],
      },
    });

    expect(shownText(slot)).toBe(ready.text);
  });

  it("offers a suggestion from selected chat work when the active sidebar does not include it", () => {
    const slot = mount({
      sidebarThreads: { threads: [] },
      experimental_threadWork: { thr_one: workFixture() },
    });

    expect(shownText(slot)).toBe(ready.text);
  });

  it("keeps a suggestion across a composer remount without flashing", async () => {
    const first = mount();
    expect(shownText(first)).toBe(ready.text);
    first.unmount();

    const second = mount({
      threadBootstrapData: { "thr_one:state": { status: "pending" } },
      rpc: {
        state: () => {
          throw new Error("A remembered suggestion needs no read.");
        },
        request: () => ready,
        ...settled,
      },
    });

    expect(second.composer.suggestionCalls[0]).toMatchObject({
      status: "ready",
      text: ready.text,
    });
    await act(async () => {});
    expect(second.rpcCalls).toEqual([]);
  });

  it("receives predictions for unopened chats through the app-wide sync", async () => {
    const sync = renderSlot({ component: Sync }, {}, {});
    await sync.emitRealtime("predictions-changed", {
      ...ready,
      generation: 4,
      text: "Prepared while the chat was closed.",
    });
    sync.unmount();

    const slot = mount({
      threadBootstrapData: { "thr_one:state": { status: "pending" } },
    });

    expect(shownText(slot)).toBe("Prepared while the chat was closed.");
  });

  it("never asks for generation when the chat has no prediction yet", async () => {
    const idle = { ...ready, status: "idle" as const, text: null };

    const slot = mount({
      threadBootstrapData: fromBootstrap(idle),
      rpc: { state: () => idle, request: () => ready, ...settled },
    });

    await act(async () => {});
    expect(shown(slot)).toBeNull();
    expect(slot.rpcCalls).toEqual([
      { method: "state", input: { threadId: "thr_one" } },
    ]);
    await slot.emitRealtime("predictions-changed", {
      ...ready,
      generation: 2,
    });
    expect(shownText(slot)).toBe(ready.text);
  });

  it.each(["idle", "predicting"] as const)(
    "recovers a completion missed before subscribing from a %s snapshot",
    async (status) => {
      const slot = mount({
        threadBootstrapData: fromBootstrap({ ...ready, status, text: null }),
        rpc: {
          state: () => ({ ...ready, generation: 2 }),
          request: () => {
            throw new Error("Opening a chat must not generate.");
          },
          ...settled,
        },
      });

      await waitFor(() => expect(shownText(slot)).toBe(ready.text));
      expect(slot.rpcCalls).toEqual([
        { method: "state", input: { threadId: "thr_one" } },
      ]);
    },
  );

  it("keeps a completed suggestion when an earlier state read arrives late", async () => {
    const predicting = { ...ready, status: "predicting" as const, text: null };

    let resolveState: (state: PredictionState) => void = () => {
      throw new Error("The state read has not started.");
    };

    const slot = mount({
      threadBootstrapData: fromBootstrap(predicting),
      rpc: {
        state: () =>
          new Promise<PredictionState>((resolve) => {
            resolveState = resolve;
          }),
        request: () => ready,
        ...settled,
      },
    });

    await slot.emitRealtime("predictions-changed", ready);
    expect(shownText(slot)).toBe(ready.text);
    await act(async () => resolveState(predicting));
    expect(shownText(slot)).toBe(ready.text);
    expect(slot.rpcCalls).toEqual([
      { method: "state", input: { threadId: "thr_one" } },
    ]);
  });

  it("keeps a fallback read when the conversation bootstrap settles before its response", async () => {
    const bootstrap: Record<string, ExperimentalThreadBootstrapData> = {
      "thr_one:state": { status: "pending" },
    };

    let resolveState: (state: PredictionState) => void = () => {
      throw new Error("The state read has not started.");
    };

    const slot = mount({
      threadBootstrapData: bootstrap,
      rpc: {
        state: () =>
          new Promise<PredictionState>((resolve) => {
            resolveState = resolve;
          }),
        request: () => ready,
        ...settled,
      },
    });

    await waitFor(() => expect(slot.rpcCalls).toHaveLength(1), {
      timeout: 2500,
    });
    bootstrap["thr_one:state"] = fromBootstrap({
      ...ready,
      status: "idle",
      text: null,
    })["thr_one:state"];
    await slot.setComposerText("My unsent draft");
    await act(async () => resolveState(ready));
    expect(shownText(slot)).toBe(ready.text);
    expect(slot.composer.text).toBe("My unsent draft");
    expect(slot.rpcCalls).toEqual([
      { method: "state", input: { threadId: "thr_one" } },
    ]);
  });

  it("reads state once when the conversation bootstrap lacks prediction data", async () => {
    const slot = mount({ threadBootstrapData: {} });
    await waitFor(() => expect(shownText(slot)).toBe(ready.text));
    expect(slot.rpcCalls).toEqual([
      { method: "state", input: { threadId: "thr_one" } },
    ]);
  });

  it("shows inference in progress only when the server reports it and cancels it on dismiss", async () => {
    const predicting = { ...ready, status: "predicting" as const, text: null };
    const slot = mount({ threadBootstrapData: fromBootstrap(predicting) });
    const loading = shown(slot);
    expect(loading?.status).toBe("loading");
    await act(async () => loading?.onDismiss());
    expect(shown(slot)).toBeNull();
    expect(slot.rpcCalls).toContainEqual({
      method: "cancel",
      input: { threadId: "thr_one", generation: 1 },
    });
  });

  it("keeps publishing the suggestion while the user types and never edits or sends the draft", async () => {
    const slot = mount();
    await slot.setComposerText("My own next step");
    expect(shownText(slot)).toBe(ready.text);
    expect(slot.composer.text).toBe("My own next step");
    expect(slot.composer.submits).toEqual([]);
    expect(slot.rpcCalls.some((call) => call.method === "request")).toBe(false);
  });

  it("keeps publishing a cached suggestion beside an existing typed draft", () => {
    const slot = mount({
      composer: {
        text: "Keep this",
        scope: { kind: "thread", threadId: "thr_one" },
        selection: { providerId: "codex" },
      },
    });

    expect(shownText(slot)).toBe(ready.text);
    expect(slot.composer.text).toBe("Keep this");
    expect(slot.composer.submits).toEqual([]);
  });

  it("hides a sent suggestion as soon as the composer submits", async () => {
    const slot = mount();
    expect(shownText(slot)).toBe(ready.text);
    await slot.setComposerText("Ship it");
    fireEvent.click(slot.getByRole("button", { name: "Host send" }));
    await waitFor(() => expect(shown(slot)).toBeNull());
    expect(slot.rpcCalls.some((call) => call.method === "dismiss")).toBe(false);
    await slot.emitRealtime("predictions-changed", ready);
    expect(shown(slot)).toBeNull();
    await slot.emitRealtime("predictions-changed", {
      ...ready,
      generation: 3,
      text: "Review the follow-up.",
    });
    expect(shownText(slot)).toBe("Review the follow-up.");
  });

  it.each(["none", "disabled"] as const)(
    "hides a retained suggestion when the server marks it %s while typing",
    async (status) => {
      const slot = mount();
      await slot.setComposerText("My own next step");
      expect(shownText(slot)).toBe(ready.text);
      await slot.emitRealtime("predictions-changed", {
        ...ready,
        generation: ready.generation + 1,
        status,
        text: null,
      });
      expect(shown(slot)).toBeNull();
      expect(slot.composer.text).toBe("My own next step");
    },
  );

  it("does not restore a dismissed generation from realtime", async () => {
    const slot = mount();
    await act(async () => shown(slot)?.onDismiss());
    expect(shown(slot)).toBeNull();
    await slot.emitRealtime("predictions-changed", ready);
    expect(shown(slot)).toBeNull();
    expect(slot.rpcCalls).toContainEqual({
      method: "dismiss",
      input: { threadId: "thr_one", generation: 1 },
    });
  });

  it("keeps the newest generation when an older broadcast or snapshot arrives", async () => {
    const slot = mount();
    await slot.emitRealtime("predictions-changed", {
      ...ready,
      generation: 2,
      text: "Inspect the final result.",
    });
    await slot.emitRealtime("predictions-changed", ready);
    expect(shownText(slot)).toBe("Inspect the final result.");
    slot.unmount();
    const reopened = mount();
    expect(shownText(reopened)).toBe("Inspect the final result.");
  });

  it("publishes for a draft with attachments or mentions and leaves visibility to the composer", async () => {
    const slot = mount({
      composer: {
        attachmentCount: 1,
        text: "@thread:thr_two",
        mentions: [
          {
            from: 0,
            to: 15,
            kind: "thread" as const,
            threadId: "thr_two",
            label: "Other thread",
          },
        ],
        scope: { kind: "thread", threadId: "thr_one" },
        selection: { providerId: "codex" },
      },
    });

    expect(shownText(slot)).toBe(ready.text);
    expect(slot.composer.text).toBe("@thread:thr_two");
  });

  it.each([
    {
      name: "a running turn",
      composer: {
        isRunning: true,
        scope: { kind: "thread" as const, threadId: "thr_one" },
        selection: { providerId: "codex" },
      },
    },
    {
      name: "a submitting composer",
      composer: {
        isSubmitting: true,
        scope: { kind: "thread" as const, threadId: "thr_one" },
        selection: { providerId: "codex" },
      },
    },
    {
      name: "a queued editor",
      composer: {
        scope: {
          kind: "queued-message" as const,
          threadId: "thr_one",
          queuedMessageId: "q_one",
        },
        selection: { providerId: "codex" },
      },
    },
    {
      name: "a new thread",
      composer: {
        scope: { kind: "new-thread" as const, projectId: null },
        selection: { providerId: "codex" },
      },
    },
  ])(
    "does not publish or replace work for $name",
    async ({ name: _name, ...options }) => {
      const slot = mount(options);
      await slot.emitRealtime("predictions-changed", ready);
      expect(slot.rpcCalls.some((call) => call.method === "request")).toBe(
        false,
      );
      expect(shown(slot)).toBeNull();
    },
  );

  it("follows its composer to another chat without canceling shared work", async () => {
    const slot = mount();
    await slot.setComposerScope({ kind: "thread", threadId: "thr_two" });
    expect(shown(slot)).toBeNull();
    expect(slot.rpcCalls.some((call) => call.method === "cancel")).toBe(false);
    expect(slot.composer.text).toBe("");
  });

  it.each(["connecting", "connected"] as const)(
    "reconciles a completion missed while realtime was %s without polling",
    async (connection) => {
      const predicting = {
        ...ready,
        status: "predicting" as const,
        text: null,
      };

      let current: PredictionState = predicting;

      const slot = mount({
        threadBootstrapData: fromBootstrap(predicting),
        realtimeConnectionState: connection,
        rpc: {
          state: () => current,
          request: () => ready,
          ...settled,
        },
      });

      expect(shown(slot)?.status).toBe("loading");
      await slot.setRealtimeConnectionState("reconnecting");
      expect(slot.rpcCalls).toEqual([
        { method: "state", input: { threadId: "thr_one" } },
      ]);
      current = { ...ready, generation: 2 };
      await slot.setRealtimeConnectionState("connected");
      await waitFor(() => expect(shownText(slot)).toBe(ready.text));
      expect(slot.rpcCalls).toEqual([
        { method: "state", input: { threadId: "thr_one" } },
        { method: "state", input: { threadId: "thr_one" } },
      ]);
    },
  );

  it.each([
    { message: "Predictions need fresh included Codex allowance." },
    {
      message: "OpenAI has not enabled predictions for the selected account.",
    },
  ])(
    "publishes a safe failure and retries on demand ($message)",
    async ({ message }) => {
      const failed = {
        ...ready,
        status: "failed" as const,
        text: null,
        message,
      };

      const slot = mount({
        threadBootstrapData: fromBootstrap(failed),
        rpc: {
          state: () => failed,
          request: () => ({ ...ready, generation: 2 }),
          ...settled,
        },
      });

      const failure = shown(slot);
      expect(failure).toMatchObject({ status: "failed", message });

      if (failure?.status !== "failed") throw new Error("Expected a failure.");
      await act(async () => failure.onRetry());
      await waitFor(() => expect(shownText(slot)).toBe(ready.text));
      expect(
        slot.rpcCalls.filter((call) => call.method === "request"),
      ).toHaveLength(1);
    },
  );
});
