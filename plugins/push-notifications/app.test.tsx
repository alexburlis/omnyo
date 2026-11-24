// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useLayoutEffect } from "react";
import { Toaster } from "sonner";
import type {
  PluginThreadAction,
  PluginThreadActionTarget,
  PluginSidebarThread,
} from "@omnyo/plugin-sdk/app";
import {
  loadPluginApp,
  renderSlot,
  type RenderSlotOptions,
} from "@omnyo/plugin-sdk/testing/app";
import { makeThreadResponse } from "@omnyo/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeQuestion } from "./chat-notice-model.js";
import {
  CLIENT_NOTIFICATION_CHANNEL,
  pushNotificationsRpcContract,
} from "./contract.js";
import type { ThreadNotificationInputs } from "./preferences.js";

const originalNotificationLocks = Object.getOwnPropertyDescriptor(
  navigator,
  "locks",
);

function notificationLocksFixture() {
  const pending = new Map<string, Promise<unknown>>();

  return {
    request: vi.fn(
      <T,>(name: string, callback: (lock: Lock) => T | PromiseLike<T>) => {
        const lock: Lock = { name, mode: "exclusive" };

        const operation = (pending.get(name) ?? Promise.resolve()).then(() =>
          callback(lock),
        );

        pending.set(
          name,
          operation.catch(() => undefined),
        );

        return operation;
      },
    ),
  };
}

function restoreNotificationLocks() {
  if (originalNotificationLocks === undefined)
    Reflect.deleteProperty(navigator, "locks");
  else Object.defineProperty(navigator, "locks", originalNotificationLocks);
}

const app = await loadPluginApp(() => import("./app.js"));

beforeEach(() => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: notificationLocksFixture(),
  });
});

afterEach(() => {
  restoreNotificationLocks();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("device notification settings", () => {
  it("requests permission only on a click and uses the server test route", async () => {
    const requestPermission = vi.fn(async () => "granted");
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    vi.stubGlobal("isSecureContext", true);

    const view = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        settings: { webEnabled: true },
        rpc: { "notifications.test": () => ({ ok: true }) },
      },
    );

    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(
      await view.findByRole("button", { name: "Allow notifications" }),
    );
    fireEvent.click(
      await view.findByRole("button", { name: "Send test notification" }),
    );
    await waitFor(() =>
      expect(view.inspection.rpcCalls).toEqual([
        { method: "notifications.test", input: { channel: "web" } },
      ]),
    );
  });

  it("explains denied permission without prompting repeatedly", async () => {
    const requestPermission = vi.fn();
    vi.stubGlobal("Notification", { permission: "denied", requestPermission });
    vi.stubGlobal("isSecureContext", true);

    const view = renderSlot(
      app.settingsSections[0]!,
      {},
      { settings: { webEnabled: true } },
    );

    expect(await view.findByText(/Notifications are blocked/)).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

const { experimental_useAppNavigate, useSdk } =
  await import("@omnyo/plugin-sdk/app");

const { notificationsThreadAction } = await import("./notificationsAction.js");

function makeTarget(
  overrides: Partial<PluginThreadActionTarget> = {},
): PluginThreadActionTarget {
  return {
    id: "thr_top",
    projectId: "proj_test",
    parentThreadId: null,
    archivedAt: null,
    pinnedAt: null,
    shelvedAt: null,
    sectionId: null,
    isUnread: false,
    status: "idle",
    environment: null,
    ...overrides,
  };
}

type ItemFor = (thread: PluginThreadActionTarget) => PluginThreadAction | null;

function Probe({
  threadIds,
  onItem,
}: {
  threadIds: readonly string[];
  onItem(item: ItemFor): void;
}) {
  const data = notificationsThreadAction.useData!({ threadIds });
  const sdk = useSdk();
  const navigate = experimental_useAppNavigate();
  useLayoutEffect(() => {
    onItem((thread) =>
      notificationsThreadAction.item({ thread, data, sdk, navigate }),
    );
  });

  return null;
}

function renderNotifications(
  stored: Record<string, ThreadNotificationInputs>,
  threadIds: readonly string[],
) {
  let itemFor: ItemFor | null = null;

  const onItem = (next: ItemFor) => {
    itemFor = next;
  };

  let current = stored;
  let held: Promise<void> | null = null;

  const listInput =
    pushNotificationsRpcContract["threadNotifications.list"].input;

  const view = renderSlot(
    { component: Probe },
    { threadIds, onItem },
    {
      settings: { defaultLevel: "all", childLevel: "input-only" },
      rpc: {
        "threadNotifications.list": async (input) => {
          const threads = Object.fromEntries(
            listInput
              .parse(input)
              .threadIds.flatMap((id) =>
                current[id] === undefined ? [] : [[id, current[id]]],
              ),
          );

          await held;

          return { threads };
        },
        "threadNotifications.set": (input) => ({
          own: pushNotificationsRpcContract[
            "threadNotifications.set"
          ].input.parse(input).level,
          ancestorCap: null,
        }),
      },
    },
  );

  const item = (overrides: Partial<PluginThreadActionTarget> = {}) =>
    itemFor?.(makeTarget(overrides)) ?? null;

  const summary = (overrides: Partial<PluginThreadActionTarget> = {}) => {
    const action = item(overrides);

    return action === null
      ? null
      : {
          detail: action.detail ?? null,
          icon: action.icon,
          inheritLabel:
            action.choices?.items.find((choice) => choice.id === "inherit")
              ?.label ?? null,
          hint: action.choices?.hint ?? null,
          selected:
            action.choices?.items.find((choice) => choice.selected)?.id ?? null,
        };
  };

  return {
    view,
    item,
    summary,
    show(ids: readonly string[]) {
      view.rerender(<Probe threadIds={ids} onItem={onItem} />);
    },
    listCalls: () =>
      view.inspection.rpcCalls
        .filter((call) => call.method === "threadNotifications.list")
        .map((call) => call.input),
    restore(next: Record<string, ThreadNotificationInputs>) {
      current = next;
    },
    holdReads() {
      let release = () => {};

      held = new Promise((resolve) => {
        release = () => {
          held = null;
          resolve();
        };
      });

      return async () => {
        release();
        await act(async () => {});
      };
    },
  };
}

describe("thread notifications action", () => {
  it("resolves each shown thread's level and hint", async () => {
    const { summary, listCalls } = renderNotifications(
      {
        thr_top: { own: "muted", ancestorCap: null },
        thr_child: {
          own: "inherit",
          ancestorCap: { level: "muted", threadId: "thr_top" },
        },
        thr_grandchild: {
          own: "inherit",
          ancestorCap: { level: "muted", threadId: "thr_top" },
        },
      },
      ["thr_child", "thr_grandchild", "thr_new", "thr_other", "thr_top"],
    );

    await waitFor(() => expect(summary()?.selected).toBe("muted"));
    expect(summary()).toEqual({
      detail: "Muted",
      icon: "push-notifications/off",
      inheritLabel: "Default (All activity)",
      hint: null,
      selected: "muted",
    });
    expect(summary({ id: "thr_child", parentThreadId: "thr_top" })).toEqual({
      detail: "Muted",
      icon: "push-notifications/off",
      inheritLabel: "Default (Needs input only)",
      hint: "Limited by a parent thread",
      selected: "inherit",
    });
    expect(
      summary({ id: "thr_grandchild", parentThreadId: "thr_child" }),
    ).toEqual({
      detail: "Muted",
      icon: "push-notifications/off",
      inheritLabel: "Default (Needs input only)",
      hint: "Limited by an ancestor thread",
      selected: "inherit",
    });
    expect(summary({ id: "thr_other", parentThreadId: "thr_top" })).toEqual({
      detail: "Needs input only",
      icon: "BellDot",
      inheritLabel: "Default (Needs input only)",
      hint: null,
      selected: "inherit",
    });
    expect(summary({ id: "thr_new" })).toEqual({
      detail: "All activity",
      icon: "push-notifications/ringing",
      inheritLabel: "Default (All activity)",
      hint: null,
      selected: "inherit",
    });
    expect(summary({ id: "thr_unshown" })).toEqual({
      detail: "All activity",
      icon: "push-notifications/ringing",
      inheritLabel: "Default (All activity)",
      hint: null,
      selected: "inherit",
    });
    expect(summary({ archivedAt: 1 })).toBeNull();
    expect(listCalls()).toEqual([
      {
        threadIds: [
          "thr_child",
          "thr_grandchild",
          "thr_new",
          "thr_other",
          "thr_top",
        ],
      },
    ]);
  });

  it("fetches only ids it has not loaded, once each, and none for an empty list", async () => {
    const { show, listCalls } = renderNotifications({}, []);
    await act(async () => {});
    expect(listCalls()).toEqual([]);
    show(["thr_a", "thr_b"]);
    await waitFor(() => expect(listCalls()).toHaveLength(1));
    show(["thr_a", "thr_b", "thr_c"]);
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    show(["thr_a"]);
    show(["thr_a", "thr_b", "thr_c"]);
    await act(async () => {});
    const many = Array.from({ length: 250 }, (_, index) => `thr_${index}`);
    show(many);
    await waitFor(() => expect(listCalls()).toHaveLength(4));
    expect(listCalls()).toEqual([
      { threadIds: ["thr_a", "thr_b"] },
      { threadIds: ["thr_c"] },
      { threadIds: many.slice(0, 200) },
      { threadIds: many.slice(200) },
    ]);
  });

  it("shows an unarchived thread's stored level without a reload", async () => {
    const { show, summary } = renderNotifications(
      { thr_top: { own: "muted", ancestorCap: null } },
      [],
    );

    expect(summary({ archivedAt: 1 })).toBeNull();
    show(["thr_top"]);
    await waitFor(() => expect(summary()?.selected).toBe("muted"));
  });

  it("applies its own write, realtime rows, and a reload after reconnecting", async () => {
    const { view, item, summary, restore, listCalls } = renderNotifications(
      {},
      ["thr_top"],
    );

    await waitFor(() => expect(summary()?.selected).toBe("inherit"));

    await act(() => item()!.run({ value: "muted", requestRename: () => {} }));
    expect(view.inspection.rpcCalls.at(-1)).toEqual({
      method: "threadNotifications.set",
      input: { threadId: "thr_top", level: "muted" },
    });
    expect(summary()?.selected).toBe("muted");

    await view.behavior.emitRealtime("threadNotifications", {
      threads: { thr_top: { own: "inherit", ancestorCap: null } },
    });
    expect(summary()?.selected).toBe("inherit");

    restore({ thr_top: { own: "all", ancestorCap: null } });
    await view.behavior.setRealtimeConnectionState("reconnecting");
    await view.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(summary()?.selected).toBe("all"));
    expect(listCalls()).toHaveLength(2);
  });

  it("keeps a level cleared to Default when a read from before the clear lands", async () => {
    const muted = { own: "muted", ancestorCap: null } as const;

    const { view, show, item, summary, restore, listCalls, holdReads } =
      renderNotifications({ thr_a: muted, thr_b: muted }, []);

    const release = holdReads();
    show(["thr_a", "thr_b"]);
    await waitFor(() => expect(listCalls()).toHaveLength(1));

    restore({ thr_b: muted });
    await act(() =>
      item({ id: "thr_a" })!.run({ value: "inherit", requestRename: () => {} }),
    );
    restore({});
    await view.behavior.emitRealtime("threadNotifications", {
      threads: { thr_b: { own: "inherit", ancestorCap: null } },
    });
    await release();

    expect(summary({ id: "thr_a" })?.selected).toBe("inherit");
    expect(summary({ id: "thr_b" })?.selected).toBe("inherit");
    expect(listCalls()).toHaveLength(1);
  });

  it("applies a parent's change to its children on screen without a request", async () => {
    const { view, summary, listCalls } = renderNotifications({}, [
      "thr_child",
      "thr_top",
    ]);

    await waitFor(() => expect(listCalls()).toHaveLength(1));
    const child = { id: "thr_child", parentThreadId: "thr_top" };
    expect(summary(child)?.detail).toBe("Needs input only");

    await view.behavior.emitRealtime("threadNotifications", {
      threads: {
        thr_top: { own: "muted", ancestorCap: null },
        thr_child: {
          own: "inherit",
          ancestorCap: { level: "muted", threadId: "thr_top" },
        },
      },
    });
    expect(summary(child)).toMatchObject({
      detail: "Muted",
      hint: "Limited by a parent thread",
    });
    expect(summary()?.selected).toBe("muted");
    expect(listCalls()).toHaveLength(1);
  });

  it("sends no request for rows already seen, including reads still in flight", async () => {
    const { view, show, summary, listCalls, holdReads } = renderNotifications(
      {},
      [],
    );

    const release = holdReads();
    show(["thr_a", "thr_b"]);
    await waitFor(() => expect(listCalls()).toHaveLength(1));
    show(["thr_b", "thr_c"]);
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    await view.behavior.emitRealtime("threadNotifications", {
      threads: { thr_b: { own: "muted", ancestorCap: null } },
    });
    await release();

    expect(summary({ id: "thr_b" })?.selected).toBe("muted");
    show(["thr_c"]);
    show(["thr_a", "thr_b", "thr_c"]);
    await act(async () => {});
    expect(listCalls()).toEqual([
      { threadIds: ["thr_a", "thr_b"] },
      { threadIds: ["thr_c"] },
    ]);
  });

  it("updates rows held off screen and fetches rows it never held when shown", async () => {
    const muted = { own: "muted", ancestorCap: null } as const;

    const { view, show, summary, listCalls } = renderNotifications(
      { thr_a: muted, thr_b: muted, thr_new: muted },
      ["thr_a", "thr_b"],
    );

    await waitFor(() =>
      expect(summary({ id: "thr_b" })?.selected).toBe("muted"),
    );
    show(["thr_a"]);

    await view.behavior.emitRealtime("threadNotifications", {
      threads: {
        thr_b: { own: "all", ancestorCap: null },
        thr_new: { own: "all", ancestorCap: null },
      },
    });
    show(["thr_a", "thr_b", "thr_new"]);
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    await waitFor(() =>
      expect(summary({ id: "thr_new" })?.selected).toBe("muted"),
    );
    expect(summary({ id: "thr_b" })?.selected).toBe("all");
    expect(listCalls()).toEqual([
      { threadIds: ["thr_a", "thr_b"] },
      { threadIds: ["thr_new"] },
    ]);
  });

  it("refetches threads that were off screen during a reconnect when they return", async () => {
    const { view, show, summary, restore, listCalls } = renderNotifications(
      {
        thr_a: { own: "muted", ancestorCap: null },
        thr_b: { own: "muted", ancestorCap: null },
        thr_c: { own: "muted", ancestorCap: null },
      },
      ["thr_a", "thr_b", "thr_c"],
    );

    await waitFor(() =>
      expect(summary({ id: "thr_c" })?.selected).toBe("muted"),
    );
    show(["thr_a"]);

    restore({
      thr_a: { own: "muted", ancestorCap: null },
      thr_b: { own: "all", ancestorCap: null },
    });
    await view.behavior.setRealtimeConnectionState("reconnecting");
    await view.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(listCalls()).toHaveLength(2));

    show(["thr_a", "thr_b", "thr_c"]);
    await waitFor(() => expect(summary({ id: "thr_b" })?.selected).toBe("all"));
    expect(summary({ id: "thr_c" })?.selected).toBe("inherit");
    expect(summary({ id: "thr_a" })?.selected).toBe("muted");
    expect(listCalls()).toEqual([
      { threadIds: ["thr_a", "thr_b", "thr_c"] },
      { threadIds: ["thr_a"] },
      { threadIds: ["thr_b", "thr_c"] },
    ]);
  });
});

describe("durable queued notification delivery", () => {
  it("leaves delegated desktop acknowledgment with the native owner", async () => {
    vi.stubGlobal("omnyoDesktop", { platform: "macos" });
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.stubGlobal("isSecureContext", true);
    const deliver = vi.fn(async () => true);
    vi.stubGlobal("omnyoDesktopNotifications", { deliver });

    const message = {
      id: "native-owned-notice",
      title: "Ready",
      body: "Native delivery owns its acknowledgment",
      threadId: null,
      channels: ["desktop"],
    };

    const view = renderSlot(
      app.appOverlays[0]!,
      {},
      {
        settings: { desktopEnabled: true },
        rpc: {
          "notifications.pending": () => ({ messages: [message] }),
          "notifications.ack": () => ({ ok: true, acceptedTargetCount: 1 }),
        },
      },
    );

    await waitFor(() => expect(deliver).toHaveBeenCalledWith(message.id));
    expect(
      view.inspection.rpcCalls.filter(
        ({ method }) => method === "notifications.ack",
      ),
    ).toHaveLength(0);
  });

  it("drains a pending notice on mount and acknowledges only accepted delivery", async () => {
    const shown: string[] = [];

    class ExistingNotification {
      static permission: NotificationPermission = "denied";
      onclick = null;
      onclose = null;
      close() {}
      constructor(title: string) {
        shown.push(title);
      }
    }

    vi.stubGlobal("Notification", ExistingNotification);
    vi.stubGlobal("isSecureContext", true);
    localStorage.clear();

    const message = {
      id: "private-upstream:mount-proof",
      title: "Omnyo upstream update",
      body: "Review the new identity.",
      threadId: null,
      channels: ["web", "desktop"],
    };

    const view = renderSlot(
      app.appOverlays[0]!,
      {},
      {
        settings: { webEnabled: true },
        rpc: {
          "notifications.pending": () => ({ messages: [message] }),
          "notifications.ack": () => ({ ok: true, acceptedTargetCount: 1 }),
        },
      },
    );

    await waitFor(() =>
      expect(
        view.inspection.rpcCalls.some(
          (call) => call.method === "notifications.pending",
        ),
      ).toBe(true),
    );
    expect(
      view.inspection.rpcCalls.filter(
        (call) => call.method === "notifications.ack",
      ),
    ).toHaveLength(0);
    ExistingNotification.permission = "granted";
    fireEvent.focus(window);
    await waitFor(() =>
      expect(
        view.inspection.rpcCalls.filter(
          (call) => call.method === "notifications.ack",
        ),
      ).toHaveLength(1),
    );
    expect(shown).toEqual([message.title]);
    expect(
      view.inspection.rpcCalls.find(
        (call) => call.method === "notifications.ack",
      )?.input,
    ).toMatchObject({ id: message.id, channel: "web" });
  });
});

describe("chat notice cards", () => {
  const project = {
    id: "project-1",
    name: "omnyo",
    isPersonal: false,
    href: "/projects/project-1",
    settingsHref: "/projects/project-1/settings",
  };

  const needsYou = {
    hasPendingInteraction: true,
    status: "active",
    runtimeStatus: "active",
  } as const;

  function attention(
    kind:
      | "callback-waiting"
      | "required-answer"
      | "optional-input"
      | "dependency-failed",
  ) {
    return {
      kind,
      requiredCount: kind === "required-answer" ? 1 : 0,
      optionalCount: kind === "optional-input" ? 1 : 0,
      callback: null,
    };
  }

  function sidebarThread(
    id: string,
    overrides: Partial<PluginSidebarThread> = {},
  ): PluginSidebarThread {
    return {
      ...makeThreadResponse({ id }),
      displayTitle: id,
      experimental_subtitle: null,
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
      isUnread: true,
      isPinned: false,
      pinSortKey: null,
      isArchived: false,
      experimental_shelvedAt: null,
      experimental_shelfSortKey: null,
      href: `/threads/${id}`,
      isHidden: false,
      environment: null,
      host: null,
      ...overrides,
    };
  }

  function choice(value: string, label: string, recommended = false) {
    return { value, label, description: null, preview: null, recommended };
  }

  function nativeQuestion(
    overrides: Partial<NativeQuestion["question"]> & {
      id?: string;
      revision?: number;
      state?: NativeQuestion["state"];
    } = {},
  ): NativeQuestion {
    const { id = "q1", revision = 3, state = "open", ...question } = overrides;

    return {
      id,
      threadId: "thr_q",
      revision,
      question: {
        key: null,
        prompt: "SQLite on the VPS, or keep Postgres?",
        context: null,
        shortLabel: "Database",
        mode: "required",
        multiSelect: false,
        allowFreeText: true,
        additiveNotes: true,
        delegable: false,
        options: [
          choice("sqlite", "SQLite", true),
          choice("postgres", "Keep Postgres"),
        ],
        ...question,
      },
      state,
      answer: null,
      queuedMessageId: null,
      answeredBy: null,
      createdAt: 1,
      updatedAt: 1,
    };
  }

  function foreground() {
    localStorage.clear();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.stubGlobal("Notification", { permission: "denied" });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: () => ({ currentTime: 0, pause() {}, cancel() {} }),
    });
  }

  const nativeAnimate = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "animate",
  );

  afterEach(() => {
    if (nativeAnimate === undefined)
      Reflect.deleteProperty(Element.prototype, "animate");
    else Object.defineProperty(Element.prototype, "animate", nativeAnimate);

    for (const shell of document.querySelectorAll("[data-app-content-shell]"))
      shell.remove();
  });

  function placeAt(
    element: Element,
    left: number,
    top: number,
    width: number,
    height: number,
  ) {
    Object.defineProperty(element, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left,
        top,
        width,
        height,
        x: left,
        y: top,
        right: left + width,
        bottom: top + height,
        toJSON: () => ({}),
      }),
    });
  }

  function roomBesideTheChat() {
    const shell = document.createElement("div");
    const viewport = document.createElement("div");
    const column = document.createElement("div");
    shell.setAttribute("data-app-content-shell", "");
    viewport.setAttribute("data-page-scroll-viewport", "");
    column.setAttribute("data-page-content-column", "");
    viewport.append(column);
    shell.append(viewport);
    document.body.append(shell);
    placeAt(shell, 260, 0, 1600, 900);
    placeAt(viewport, 260, 48, 1600, 852);
    placeAt(column, 680, 48, 760, 852);
  }

  const notice = (
    id: string,
    threadId: string,
    title: string,
    body = "Waiting for your input",
  ) => ({ id, threadId, title, body, channels: ["web", "desktop"] });

  function renderCards(
    threads: PluginSidebarThread[],
    options: Pick<RenderSlotOptions, "context" | "sdk" | "rpc"> = {},
  ) {
    return renderSlot(
      app.appOverlays[0]!,
      {},
      {
        settings: { webEnabled: true },
        sidebarThreads: { threads, projects: [project] },
        rpc: {
          "notifications.pending": () => ({ messages: [] }),
          "notifications.ack": () => ({ ok: true, acceptedTargetCount: 1 }),
        },
        ...options,
        sdk: {
          experimental_attention: {
            history: async () => ({ questions: [], callbacks: [] }),
          },
          ...options.sdk,
        },
      },
    );
  }

  function cards() {
    return screen
      .queryAllByRole("article")
      .map((card) => card.getAttribute("aria-label"));
  }

  function card(title: string) {
    return screen.getByRole("article", { name: title });
  }

  function acks(view: { inspection: { rpcCalls: { method: string }[] } }) {
    return view.inspection.rpcCalls.filter(
      ({ method }) => method === "notifications.ack",
    );
  }

  function pendingQuestions() {
    let answer: (questions: NativeQuestion[]) => void = () => {};

    const questions = new Promise<NativeQuestion[]>((resolve) => {
      answer = resolve;
    });

    return {
      history: async () => ({ questions: await questions, callbacks: [] }),
      answer: (asked: NativeQuestion[]) => act(async () => answer(asked)),
    };
  }

  const askingThread = sidebarThread("thr_q", {
    displayTitle: "DB migration plan",
    experimental_attention: attention("required-answer"),
  });

  it("shows an approval card instead of a toast and opens its whole surface", async () => {
    foreground();
    render(<Toaster />);

    const view = renderCards([
      sidebarThread("thr_ask", { displayTitle: "Deploy plan", ...needsYou }),
    ]);

    await view.behavior.emitRealtime(
      CLIENT_NOTIFICATION_CHANNEL,
      notice("one", "thr_ask", "Deploy plan", "Approve command: pnpm deploy"),
    );

    const shown = await screen.findByRole("article", { name: "Deploy plan" });
    expect(shown.textContent).toContain("Needs you · omnyo · now");
    expect(
      within(shown).getByText("Approve command: pnpm deploy"),
    ).toBeTruthy();
    expect(
      within(shown).getByRole("button", { name: "Open chat" }),
    ).toBeTruthy();
    expect(within(shown).getByRole("button", { name: "Later" })).toBeTruthy();
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0);
    fireEvent.click(
      within(shown).getByRole("button", { name: "Open chat: Deploy plan" }),
    );
    expect(view.inspection.navigateCalls).toEqual([
      {
        method: "toThread",
        threadId: "thr_ask",
        options: { experimental_userInitiated: true },
      },
    ]);
  });

  it("offers one-tap answers for an optional question a running chat asks", async () => {
    foreground();

    const view = renderCards(
      [
        sidebarThread("thr_q", {
          displayTitle: "Global voice plan",
          status: "active",
          runtimeStatus: "active",
          experimental_attention: attention("optional-input"),
        }),
      ],
      {
        sdk: {
          experimental_attention: {
            history: async () => ({
              questions: [
                nativeQuestion({
                  mode: "optional",
                  prompt: "Which cleanup should the plan include?",
                }),
              ],
              callbacks: [],
            }),
          },
        },
      },
    );

    await view.behavior.emitRealtime(
      CLIENT_NOTIFICATION_CHANNEL,
      notice("one", "thr_q", "Global voice plan"),
    );

    const shown = await screen.findByRole("article", {
      name: "Global voice plan",
    });

    expect(shown.textContent).toContain("Needs you");
    expect(
      await within(shown).findByText("Which cleanup should the plan include?"),
    ).toBeTruthy();
    expect(
      within(shown).getByRole("button", { name: "Keep Postgres" }),
    ).toBeTruthy();
  });

  it("keeps an approval's own text when an older question is still open", async () => {
    foreground();

    const view = renderCards(
      [
        sidebarThread("thr_ask", {
          displayTitle: "Deploy plan",
          ...needsYou,
          experimental_attention: attention("optional-input"),
        }),
      ],
      {
        sdk: {
          experimental_attention: {
            history: async () => ({
              questions: [
                nativeQuestion({ mode: "optional", prompt: "Stale question" }),
              ],
              callbacks: [],
            }),
          },
        },
      },
    );

    await view.behavior.emitRealtime(
      CLIENT_NOTIFICATION_CHANNEL,
      notice("one", "thr_ask", "Deploy plan", "Approve command: pnpm deploy"),
    );

    const shown = await screen.findByRole("article", { name: "Deploy plan" });

    expect(
      await within(shown).findByText("Approve command: pnpm deploy"),
    ).toBeTruthy();
    expect(within(shown).queryByText("Stale question")).toBeNull();
  });

  it("answers a one-tap question with the attention command core sends, confirms, then leaves", async () => {
    foreground();

    const asked = nativeQuestion();
    let answered = false;

    const command = vi.fn(async () => {
      answered = true;

      return {
        questions: [{ ...asked, state: "answered" as const }],
        callbacks: [],
        cleared: true,
        callbackMarker: null,
        routedToThreadId: null,
      };
    });

    const threads = [
      sidebarThread("thr_q", {
        displayTitle: "DB migration plan",
        experimental_attention: attention("required-answer"),
      }),
    ];

    const view = renderCards(threads, {
      sdk: {
        experimental_attention: {
          history: async () => ({
            questions: [
              nativeQuestion({
                id: "q0",
                state: "answered",
                prompt: "Which branch?",
              }),
              nativeQuestion({
                id: "q-optional",
                mode: "optional",
                prompt: "Anything else?",
              }),
              answered ? { ...asked, state: "answered" } : asked,
            ],
            callbacks: [],
          }),
          command,
        },
      },
    });

    const Component = app.appOverlays[0]!.component;

    await view.behavior.emitRealtime(
      CLIENT_NOTIFICATION_CHANNEL,
      notice("one", "thr_q", "DB migration plan"),
    );

    const shown = await screen.findByRole("article", {
      name: "DB migration plan",
    });

    expect(
      await within(shown).findByText("SQLite on the VPS, or keep Postgres?"),
    ).toBeTruthy();
    expect(
      within(shown).getByRole("button", { name: "Keep Postgres" }),
    ).toBeTruthy();
    fireEvent.click(
      within(shown).getByRole("button", { name: "SQLite (Recommended)" }),
    );

    expect(
      view.inspection.sdkCalls.filter(
        ({ method }) => method === "experimental_attention.command",
      ),
    ).toEqual([
      {
        method: "experimental_attention.command",
        args: [
          {
            threadId: "thr_q",
            command: {
              action: "answer",
              id: "q1",
              revision: 3,
              answer: { selected: ["sqlite"] },
            },
          },
        ],
      },
    ]);
    expect(await within(shown).findByText("Sent “SQLite”")).toBeTruthy();
    expect(view.inspection.navigateCalls).toEqual([]);
    threads[0] = sidebarThread("thr_q", {
      displayTitle: "DB migration plan",
      status: "active",
      runtimeStatus: "active",
    });
    view.rerender(<Component />);
    await act(async () => {});
    expect(within(shown).getByText("Sent “SQLite”")).toBeTruthy();
    expect(
      within(shown).getByText("SQLite on the VPS, or keep Postgres?"),
    ).toBeTruthy();
    await waitFor(() => expect(cards()).toEqual([]), { timeout: 3_000 });
  });

  it("keeps a failed answer in the card with an inline error", async () => {
    foreground();

    const view = renderCards(
      [
        sidebarThread("thr_q", {
          displayTitle: "DB migration plan",
          experimental_attention: attention("required-answer"),
        }),
      ],
      {
        sdk: {
          experimental_attention: {
            history: async () => ({
              questions: [nativeQuestion()],
              callbacks: [],
            }),
            command: async () => {
              throw new Error("revision conflict");
            },
          },
        },
      },
    );

    await view.behavior.emitRealtime(
      CLIENT_NOTIFICATION_CHANNEL,
      notice("one", "thr_q", "DB migration plan"),
    );

    const shown = await screen.findByRole("article", {
      name: "DB migration plan",
    });

    fireEvent.click(
      await within(shown).findByRole("button", { name: "Keep Postgres" }),
    );
    expect((await within(shown).findByRole("alert")).textContent).toBe(
      "Could not send. Try again.",
    );
    expect(
      within(shown).getByRole("button", { name: "Keep Postgres" }),
    ).toHaveProperty("disabled", false);
  });

  it("opens the full answer form inside the card when one tap cannot answer", async () => {
    foreground();

    const view = renderCards(
      [
        sidebarThread("thr_q", {
          displayTitle: "Release scope",
          experimental_attention: attention("required-answer"),
        }),
      ],
      {
        sdk: {
          experimental_attention: {
            history: async () => ({
              questions: [
                nativeQuestion({
                  prompt: "Which surfaces ship?",
                  multiSelect: true,
                  options: [
                    choice("server", "Server"),
                    choice("web", "Web"),
                    choice("mac", "Mac app"),
                  ],
                }),
              ],
              callbacks: [],
            }),
          },
        },
      },
    );

    await view.behavior.emitRealtime(
      CLIENT_NOTIFICATION_CHANNEL,
      notice("one", "thr_q", "Release scope"),
    );

    const shown = await screen.findByRole("article", { name: "Release scope" });
    expect(await within(shown).findByText("Which surfaces ship?")).toBeTruthy();
    expect(within(shown).queryByRole("button", { name: "Server" })).toBeNull();
    expect(
      shown.querySelector('[data-native-thread-attention="thr_q"]'),
    ).toBeNull();
    fireEvent.click(within(shown).getByRole("button", { name: "Answer here" }));
    expect(
      shown.querySelector('[data-native-thread-attention="thr_q"]'),
    ).not.toBeNull();
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("hands a finished chat to the system while the Mac window is focused, except the chat on screen", async () => {
    foreground();
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("omnyoDesktop", { platform: "macos" });
    const native = vi.fn(async () => true);
    vi.stubGlobal("omnyoDesktopNotifications", { deliver: native });

    const view = renderSlot(
      app.appOverlays[0]!,
      {},
      {
        context: { threadId: "thr_current" },
        settings: { desktopEnabled: true },
        sidebarThreads: {
          threads: [
            sidebarThread("thr_done", { displayTitle: "Finished chat" }),
            sidebarThread("thr_current", { displayTitle: "Open chat" }),
            sidebarThread("thr_ask", {
              displayTitle: "Waiting chat",
              ...needsYou,
            }),
          ],
          projects: [project],
        },
        rpc: {
          "notifications.pending": () => ({ messages: [] }),
          "notifications.ack": () => ({ ok: true, acceptedTargetCount: 1 }),
        },
        sdk: {
          experimental_attention: {
            history: async () => ({ questions: [], callbacks: [] }),
          },
        },
      },
    );

    await view.behavior.emitRealtime(CLIENT_NOTIFICATION_CHANNEL, {
      ...notice("open", "thr_current", "Open chat", "Finished"),
      kind: "turn-finished",
    });
    await waitFor(() => expect(acks(view)).toHaveLength(1));

    await view.behavior.emitRealtime(CLIENT_NOTIFICATION_CHANNEL, {
      ...notice("done", "thr_done", "Finished chat", "Finished"),
      kind: "turn-finished",
    });
    await waitFor(() => expect(native).toHaveBeenCalledWith("done"));
    expect(cards()).toEqual([]);

    await view.behavior.emitRealtime(CLIENT_NOTIFICATION_CHANNEL, {
      ...notice("ask", "thr_ask", "Waiting chat"),
      kind: "pending-interaction",
    });
    await waitFor(() => expect(cards()).toEqual(["Waiting chat"]));
    await waitFor(() => expect(acks(view)).toHaveLength(2));
    expect(native.mock.calls).toEqual([["done"]]);
  });

  it("shows one card at a time over the chat, cycles the rest, and hides a dismissed card", async () => {
    foreground();

    const threads = ["First", "Second", "Third"].map((title, index) =>
      sidebarThread(`thr_${index}`, { displayTitle: title, ...needsYou }),
    );

    const view = renderCards(threads);

    for (const thread of threads)
      await view.behavior.emitRealtime(
        CLIENT_NOTIFICATION_CHANNEL,
        notice(thread.id, thread.id, thread.displayTitle),
      );

    await waitFor(() => expect(cards()).toEqual(["First"]));
    fireEvent.click(screen.getByRole("button", { name: "+2 more waiting" }));
    await waitFor(() => expect(cards()).toEqual(["Second"]));
    fireEvent.click(
      within(card("Second")).getByRole("button", { name: "Later" }),
    );
    await waitFor(() => expect(cards()).toEqual(["Third"]));
    expect(
      screen.getByRole("button", { name: "+1 more waiting" }),
    ).toBeTruthy();
    fireEvent.click(
      within(card("Third")).getByRole("button", { name: "Dismiss" }),
    );
    await waitFor(() => expect(cards()).toEqual(["First"]));
    expect(screen.queryByRole("button", { name: /more waiting/ })).toBeNull();
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("docks two cards beside the chat and keeps them without a countdown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    try {
      foreground();
      roomBesideTheChat();

      const threads = ["First", "Second", "Third"].map((title, index) =>
        sidebarThread(`thr_${index}`, { displayTitle: title, ...needsYou }),
      );

      const view = renderCards(threads);

      for (const thread of threads)
        await view.behavior.emitRealtime(
          CLIENT_NOTIFICATION_CHANNEL,
          notice(thread.id, thread.id, thread.displayTitle),
        );

      expect(cards()).toEqual(["First", "Second"]);
      expect(document.querySelector("[data-countdown-ring]")).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(cards()).toEqual(["First", "Second"]);
      expect(
        screen.getByRole("button", { name: "+1 more waiting" }),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts an overlay card down for 8 seconds, paused while hovered, then shows the next", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    try {
      foreground();

      const threads = ["First", "Second"].map((title, index) =>
        sidebarThread(`thr_${index}`, { displayTitle: title, ...needsYou }),
      );

      const view = renderCards(threads);

      for (const thread of threads)
        await view.behavior.emitRealtime(
          CLIENT_NOTIFICATION_CHANNEL,
          notice(thread.id, thread.id, thread.displayTitle),
        );

      expect(cards()).toEqual(["First"]);
      expect(
        card("First").querySelector("[data-countdown-ring]"),
      ).not.toBeNull();
      fireEvent.pointerEnter(card("First"));
      await act(() => vi.advanceTimersByTimeAsync(20_000));
      expect(cards()).toEqual(["First"]);
      fireEvent.pointerLeave(card("First"));
      await act(() => vi.advanceTimersByTimeAsync(7_900));
      expect(cards()).toEqual(["First"]);
      await act(() => vi.advanceTimersByTimeAsync(100));
      await act(() => vi.advanceTimersByTimeAsync(350));
      expect(cards()).toEqual(["Second"]);
      expect(
        card("Second").querySelector("[data-countdown-ring]"),
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a card that needs you off screen until its question loads, then shows the question with its choices", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    try {
      foreground();
      const read = pendingQuestions();

      const view = renderCards(
        [
          askingThread,
          sidebarThread("thr_next", { displayTitle: "Next chat", ...needsYou }),
        ],
        { sdk: { experimental_attention: { history: read.history } } },
      );

      await view.behavior.emitRealtime(
        CLIENT_NOTIFICATION_CHANNEL,
        notice("one", "thr_q", "DB migration plan"),
      );
      await view.behavior.emitRealtime(
        CLIENT_NOTIFICATION_CHANNEL,
        notice("next", "thr_next", "Next chat"),
      );

      expect(
        view.inspection.sdkCalls.filter(
          ({ method }) => method === "experimental_attention.history",
        ),
      ).toHaveLength(1);
      expect(cards()).toEqual([]);
      expect(screen.queryByRole("button", { name: /more waiting/ })).toBeNull();

      await read.answer([nativeQuestion()]);
      const shown = card("DB migration plan");
      expect(
        within(shown).getByText("SQLite on the VPS, or keep Postgres?"),
      ).toBeTruthy();
      expect(
        within(shown).getByRole("button", { name: "SQLite (Recommended)" }),
      ).toBeTruthy();
      expect(
        within(shown).getByRole("button", { name: "Keep Postgres" }),
      ).toBeTruthy();
      expect(within(shown).queryByText("Waiting for your input")).toBeNull();
      expect(
        screen.getByRole("button", { name: "+1 more waiting" }),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a card with its notice text when its question takes over 1.5 seconds, then updates it to the question", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    try {
      foreground();
      const read = pendingQuestions();

      const view = renderCards([askingThread], {
        sdk: { experimental_attention: { history: read.history } },
      });

      await view.behavior.emitRealtime(
        CLIENT_NOTIFICATION_CHANNEL,
        notice("one", "thr_q", "DB migration plan"),
      );
      await act(() => vi.advanceTimersByTimeAsync(1_499));
      expect(cards()).toEqual([]);
      await act(() => vi.advanceTimersByTimeAsync(1));
      const shown = card("DB migration plan");
      expect(within(shown).getByText("Waiting for your input")).toBeTruthy();

      await read.answer([nativeQuestion()]);
      expect(card("DB migration plan")).toBe(shown);
      expect(
        within(shown).getByText("SQLite on the VPS, or keep Postgres?"),
      ).toBeTruthy();
      expect(
        within(shown).getByRole("button", { name: "Keep Postgres" }),
      ).toBeTruthy();
      expect(within(shown).queryByText("Waiting for your input")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts an overlay card's 8 second countdown only once the card is drawn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    try {
      foreground();
      const read = pendingQuestions();

      const view = renderCards([askingThread], {
        sdk: { experimental_attention: { history: read.history } },
      });

      await view.behavior.emitRealtime(
        CLIENT_NOTIFICATION_CHANNEL,
        notice("one", "thr_q", "DB migration plan"),
      );
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(cards()).toEqual([]);

      await read.answer([nativeQuestion()]);
      expect(
        card("DB migration plan").querySelector("[data-countdown-ring]"),
      ).not.toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(7_999));
      expect(
        card("DB migration plan").querySelector("[data-countdown-ring]"),
      ).not.toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(1));
      await act(() => vi.advanceTimersByTimeAsync(350));
      expect(cards()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      when: "a retry is available",
      state: {
        available: true,
        pending: false,
        action: "retry",
        message: "Provider session ended: rate limit (429)",
      },
      message: "Provider session ended: rate limit (429)",
      offersContinue: true,
      recovering: false,
    },
    {
      when: "recovery is already pending",
      state: {
        available: true,
        pending: true,
        action: "retry",
        message: "Retrying after the rate limit",
      },
      message: "Retrying after the rate limit",
      offersContinue: false,
      recovering: true,
    },
    {
      when: "nothing can continue it",
      state: {
        available: false,
        pending: false,
        action: "unavailable",
        message: null,
      },
      message: "The thread hit an error",
      offersContinue: false,
      recovering: false,
    },
  ] as const)(
    "offers Continue on a failed chat only when $when",
    async ({ state, message, offersContinue, recovering }) => {
      foreground();

      const view = renderCards(
        [
          sidebarThread("thr_fail", {
            displayTitle: "Sentry triage",
            status: "error",
            runtimeStatus: "error",
          }),
        ],
        {
          sdk: {
            threads: {
              experimental_continuationState: async ({ threadId }) => ({
                threadId,
                ...state,
              }),
              experimental_continue: async ({ threadId }) => ({
                threadId,
                outcome: "sent",
                queuedMessageId: null,
                message: null,
              }),
            },
          },
        },
      );

      await view.behavior.emitRealtime(
        CLIENT_NOTIFICATION_CHANNEL,
        notice("fail", "thr_fail", "Sentry triage", "The thread hit an error"),
      );

      const shown = await screen.findByRole("article", {
        name: "Sentry triage",
      });

      expect(shown.textContent).toContain("Failed · omnyo · now");
      expect(await within(shown).findByText(message)).toBeTruthy();
      await waitFor(() =>
        expect(
          view.inspection.sdkCalls.some(
            ({ method }) => method === "threads.experimental_continuationState",
          ),
        ).toBe(true),
      );
      await act(async () => {});
      expect(
        within(shown).queryByText("Automatic recovery pending") !== null,
      ).toBe(recovering);

      const resume = within(shown).queryByRole("button", { name: "Continue" });
      expect(resume !== null).toBe(offersContinue);

      if (resume === null) return;
      fireEvent.click(resume);
      expect(await within(shown).findByText("Continuing")).toBeTruthy();
      expect(view.inspection.navigateCalls).toEqual([]);
      expect(
        view.inspection.sdkCalls.filter(
          ({ method }) => method === "threads.experimental_continue",
        ),
      ).toEqual([
        {
          method: "threads.experimental_continue",
          args: [{ threadId: "thr_fail" }],
        },
      ]);
    },
  );

  it("coalesces by chat, opens a chat from its card, keeps dismissal across reconnect, and clears on unmount", async () => {
    foreground();
    roomBesideTheChat();

    const view = renderCards(
      [
        sidebarThread("thr_one", { displayTitle: "First chat", ...needsYou }),
        sidebarThread("thr_two", { displayTitle: "Second chat", ...needsYou }),
        sidebarThread("thr_three", { displayTitle: "Third chat", ...needsYou }),
      ],
      {
        rpc: {
          "notifications.pending": () => ({
            messages: [
              notice("one", "thr_one", "First chat"),
              notice("two", "thr_two", "Second chat"),
            ],
          }),
          "notifications.ack": () => ({ ok: true, acceptedTargetCount: 1 }),
        },
      },
    );

    await waitFor(() => expect(cards()).toEqual(["First chat", "Second chat"]));
    fireEvent.click(
      within(card("First chat")).getByRole("button", { name: "Open chat" }),
    );
    expect(view.inspection.navigateCalls).toEqual([
      {
        method: "toThread",
        threadId: "thr_one",
        options: { experimental_userInitiated: true },
      },
    ]);
    await waitFor(() => expect(cards()).toEqual(["Second chat"]));
    await view.behavior.emitRealtime(
      CLIENT_NOTIFICATION_CHANNEL,
      notice("two-new", "thr_two", "Second chat", "Approve file changes"),
    );
    expect(
      await within(card("Second chat")).findByText("Approve file changes"),
    ).toBeTruthy();
    expect(cards()).toEqual(["Second chat"]);
    fireEvent.click(
      within(card("Second chat")).getByRole("button", { name: "Dismiss" }),
    );
    await waitFor(() => expect(cards()).toEqual([]));
    await view.behavior.setRealtimeConnectionState("reconnecting");
    await view.behavior.setRealtimeConnectionState("connected");
    await view.behavior.emitRealtime(
      CLIENT_NOTIFICATION_CHANNEL,
      notice("three", "thr_three", "Third chat"),
    );
    await waitFor(() => expect(cards()).toEqual(["Third chat"]));
    expect(acks(view).length).toBeGreaterThanOrEqual(3);
    expect(view.inspection.navigateCalls).toHaveLength(1);
    view.unmount();
    expect(cards()).toEqual([]);
  });

  it("consumes current-chat events and renderer-acknowledges foreground desktop notices despite denied permission", async () => {
    foreground();
    vi.stubGlobal("omnyoDesktop", { platform: "macos" });
    const native = vi.fn(async () => true);
    vi.stubGlobal("omnyoDesktopNotifications", { deliver: native });

    const view = renderSlot(
      app.appOverlays[0]!,
      {},
      {
        context: { threadId: "thr_current" },
        settings: { desktopEnabled: true },
        sidebarThreads: {
          threads: [
            sidebarThread("thr_current", {
              displayTitle: "Current chat",
              ...needsYou,
            }),
            sidebarThread("thr_other", {
              displayTitle: "Other chat",
              ...needsYou,
            }),
          ],
          projects: [project],
        },
        rpc: {
          "notifications.pending": () => ({ messages: [] }),
          "notifications.ack": () => ({ ok: true, acceptedTargetCount: 1 }),
        },
      },
    );

    await view.behavior.emitRealtime(
      CLIENT_NOTIFICATION_CHANNEL,
      notice("current", "thr_current", "Current chat"),
    );
    await view.behavior.emitRealtime(
      CLIENT_NOTIFICATION_CHANNEL,
      notice("other", "thr_other", "Other chat"),
    );
    await waitFor(() => expect(cards()).toEqual(["Other chat"]));
    await waitFor(() => expect(acks(view)).toHaveLength(2));
    expect(native).not.toHaveBeenCalled();
  });

  it("shows cards only for chats that need you or failed", async () => {
    foreground();

    const threads = [
      sidebarThread("running", { status: "active", runtimeStatus: "active" }),
      sidebarThread("scheduled", { queuedWork: "waiting" }),
      sidebarThread("callback", {
        experimental_attention: attention("callback-waiting"),
      }),
      sidebarThread("workflow", {
        activity: {
          workflows: 1,
          backgroundAgents: 0,
          backgroundCommands: 0,
          planMode: 0,
          goals: 0,
        },
      }),
      sidebarThread("optional", {
        status: "active",
        runtimeStatus: "active",
        experimental_attention: attention("optional-input"),
      }),
      sidebarThread("recovering-error", {
        status: "error",
        runtimeStatus: "error",
        queuedWork: "waiting",
      }),
      sidebarThread("done"),
      sidebarThread("archived", { ...needsYou, isArchived: true }),
      sidebarThread("hidden", { ...needsYou, isHidden: true }),
      sidebarThread("needs-answer", {
        status: "active",
        runtimeStatus: "active",
        queuedWork: "waiting",
        experimental_attention: attention("required-answer"),
      }),
      sidebarThread("approval", needsYou),
      sidebarThread("dependency", {
        experimental_attention: attention("dependency-failed"),
      }),
      sidebarThread("errored", { status: "error", runtimeStatus: "error" }),
      sidebarThread("send-failed", { queuedWork: "failed" }),
    ];

    const view = renderCards(threads, {
      sdk: {
        experimental_attention: {
          history: async () => ({ questions: [], callbacks: [] }),
        },
        threads: {
          experimental_continuationState: async ({ threadId }) => ({
            threadId,
            available: false,
            pending: false,
            action: "none",
            message: null,
          }),
        },
      },
    });

    for (const thread of threads)
      await view.behavior.emitRealtime(
        CLIENT_NOTIFICATION_CHANNEL,
        notice(thread.id, thread.id, thread.id),
      );

    await waitFor(() => expect(cards()).toEqual(["optional"]));
    const seen: [string | null, string | null][] = [];

    for (let shown = 0; shown < 6; shown += 1) {
      const [current] = screen.getAllByRole("article");
      seen.push([
        current!.getAttribute("aria-label"),
        within(current!).getByText(/^(Needs you|Failed)$/).textContent,
      ]);
      const more = screen.queryByRole("button", { name: /more waiting/ });

      if (more === null) break;
      fireEvent.click(more);
      await waitFor(() => {
        expect(cards()).toHaveLength(1);
        expect(cards()).not.toEqual([current!.getAttribute("aria-label")]);
      });
    }

    expect(seen).toEqual([
      ["optional", "Needs you"],
      ["needs-answer", "Needs you"],
      ["approval", "Needs you"],
      ["dependency", "Needs you"],
      ["errored", "Failed"],
      ["send-failed", "Failed"],
    ]);
  });

  it("removes a card when its chat stops needing you and never brings it back", async () => {
    foreground();

    const threads = [
      sidebarThread("chat", { displayTitle: "Chat", ...needsYou }),
    ];

    const view = renderCards(threads);
    const Component = app.appOverlays[0]!.component;

    await view.behavior.emitRealtime(
      CLIENT_NOTIFICATION_CHANNEL,
      notice("first", "chat", "Chat"),
    );
    await waitFor(() => expect(cards()).toEqual(["Chat"]));
    threads[0] = sidebarThread("chat", {
      displayTitle: "Chat",
      status: "active",
      runtimeStatus: "active",
    });
    view.rerender(<Component />);
    await waitFor(() => expect(cards()).toEqual([]));
    threads[0] = sidebarThread("chat", { displayTitle: "Chat", ...needsYou });
    view.rerender(<Component />);
    await act(async () => {});
    expect(cards()).toEqual([]);
    await view.behavior.emitRealtime(
      CLIENT_NOTIFICATION_CHANNEL,
      notice("second", "chat", "Chat"),
    );
    await waitFor(() => expect(cards()).toEqual(["Chat"]));
  });

  it("waits for live state to catch up before showing a card", async () => {
    foreground();

    const threads = [
      sidebarThread("chat", {
        displayTitle: "Chat",
        status: "active",
        runtimeStatus: "active",
      }),
    ];

    const view = renderCards(threads);
    const Component = app.appOverlays[0]!.component;

    await view.behavior.emitRealtime(
      CLIENT_NOTIFICATION_CHANNEL,
      notice("ask", "chat", "Chat"),
    );
    await waitFor(() => expect(acks(view)).toHaveLength(1));
    expect(cards()).toEqual([]);
    threads[0] = sidebarThread("chat", { displayTitle: "Chat", ...needsYou });
    view.rerender(<Component />);
    await waitFor(() => expect(cards()).toEqual(["Chat"]));
  });
});

describe("notification identity migration admission", () => {
  afterEach(() => localStorage.clear());

  it("acknowledges with the same imported ID across a reconnect", async () => {
    localStorage.clear();
    localStorage.setItem(
      "bb.push-notifications.client-id",
      "preserved-client-id",
    );
    localStorage.setItem("opaque.user.preference", "untouched");
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal(
      "Notification",
      class {
        static permission = "granted";
        onclick = null;
        onclose = null;
        close() {}
      },
    );

    const message = {
      id: "identity-continuity-event",
      title: "Ready",
      body: "The existing notification is ready.",
      threadId: null,
      channels: ["web"],
    };

    const view = renderSlot(
      app.appOverlays[0]!,
      {},
      {
        settings: { webEnabled: true },
        rpc: {
          "notifications.pending": () => ({ messages: [message] }),
          "notifications.ack": () => ({ ok: true, acceptedTargetCount: 1 }),
        },
      },
    );

    await waitFor(() =>
      expect(
        view.inspection.rpcCalls.some(
          (call) => call.method === "notifications.ack",
        ),
      ).toBe(true),
    );
    await view.behavior.setRealtimeConnectionState("reconnecting");
    await view.behavior.setRealtimeConnectionState("connected");
    await waitFor(() =>
      expect(
        view.inspection.rpcCalls.filter(
          (call) => call.method === "notifications.ack",
        ).length,
      ).toBeGreaterThan(1),
    );

    const acknowledgments = view.inspection.rpcCalls
      .filter((call) => call.method === "notifications.ack")
      .map((call) =>
        pushNotificationsRpcContract["notifications.ack"].input.parse(
          call.input,
        ),
      );

    expect(acknowledgments).toEqual(
      expect.arrayContaining([
        { id: message.id, channel: "web", clientId: "preserved-client-id" },
      ]),
    );
    expect(
      acknowledgments.every(
        (input) => input.clientId === "preserved-client-id",
      ),
    ).toBe(true);
    expect(localStorage.getItem("omnyo.push-notifications.client-id")).toBe(
      "preserved-client-id",
    );
    expect(localStorage.getItem("bb.push-notifications.client-id")).toBeNull();
    expect(localStorage.getItem("opaque.user.preference")).toBe("untouched");
  });

  it.each(["collision", "malformed"])(
    "stops delivery before pending or ACK when identity is %s",
    async (kind) => {
      localStorage.clear();
      localStorage.setItem(
        "bb.push-notifications.client-id",
        "preserved-client-id",
      );
      localStorage.setItem(
        "omnyo.push-notifications.client-id",
        kind === "collision" ? "different-client-id" : "",
      );
      const pending = vi.fn(() => ({ messages: [] }));
      const acknowledge = vi.fn(() => ({ ok: true, acceptedTargetCount: 1 }));
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const view = renderSlot(
        app.appOverlays[0]!,
        {},
        {
          settings: { webEnabled: true },
          rpc: {
            "notifications.pending": pending,
            "notifications.ack": acknowledge,
          },
        },
      );

      await view.findByRole("alert");
      expect(pending).not.toHaveBeenCalled();
      expect(acknowledge).not.toHaveBeenCalled();
      expect(localStorage.getItem("bb.push-notifications.client-id")).toBe(
        "preserved-client-id",
      );
      expect(localStorage.getItem("omnyo.push-notifications.client-id")).toBe(
        kind === "collision" ? "different-client-id" : "",
      );
    },
  );
});
