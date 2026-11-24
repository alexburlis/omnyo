import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  experimental_useSidebarThreads,
  useSettings,
} from "@omnyo/plugin-sdk/app";
import type { PluginSidebarThread } from "@omnyo/plugin-sdk/app";
import { HIGHLIGHT_CSS } from "./highlight-css";
import { useCallbackWaits } from "./callback-ui";
import { buildLinkGraph } from "./callback-links";
import {
  CallbackLinksDecorator,
  type LinkData,
  type LinkNodeInfo,
} from "./callback-links-dom";
import {
  NEEDS_YOU_DEFAULTS,
  NEEDS_YOU_INTENSITIES,
  NEEDS_YOU_KEYS,
  type NeedsYouIntensity,
  type NeedsYouSettings,
} from "./settings-contract";

const STYLE_ID = "needs-you-sidebar-highlight";

const ATTR_STATE = "data-needs-you";

const ATTR_QUEUED = "data-needs-you-queued";

const ATTR_INTENSITY = "data-needs-you-intensity";

const ROW_ANCHOR = "a[data-sidebar-thread-id]";

const SCROLL_ROOT = '[data-sidebar="content"]';

const OBSERVER_INIT: MutationObserverInit = { childList: true, subtree: true };

type HookMark =
  | "needs-input"
  | "unread-failed"
  | "unread-success"
  | "working"
  | "callback"
  | "queued-failed"
  | "queued-waiting";

type SyncMode = "apply" | "hold" | "clear";

let warnedDecoratorFailed = false;

function warnDecoratorFailed(cause: unknown): void {
  if (warnedDecoratorFailed) return;
  warnedDecoratorFailed = true;
  console.warn(
    "[needs-you] sidebar highlighting stopped after an error:",
    cause,
  );
}

function queryAll(scope: ParentNode, selector: string): Element[] {
  return Array.from(scope.querySelectorAll(selector));
}

function setAttribute(
  element: Element,
  name: string,
  value: string | null,
): void {
  if (value === null) {
    if (element.hasAttribute(name)) element.removeAttribute(name);

    return;
  }

  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function readSettings(
  values: Record<string, string | number | boolean> | undefined,
): NeedsYouSettings | null {
  if (values === undefined) return null;

  const bool = (key: keyof NeedsYouSettings, fallback: boolean): boolean => {
    const raw = values[key];

    return raw === true || raw === false ? raw : fallback;
  };

  const rawIntensity = values[NEEDS_YOU_KEYS.intensity];

  const intensity =
    NEEDS_YOU_INTENSITIES.find((allowed) => rawIntensity === allowed) ??
    NEEDS_YOU_DEFAULTS.intensity;

  return {
    needsInput: bool(NEEDS_YOU_KEYS.needsInput, NEEDS_YOU_DEFAULTS.needsInput),
    unreadFailed: bool(
      NEEDS_YOU_KEYS.unreadFailed,
      NEEDS_YOU_DEFAULTS.unreadFailed,
    ),
    unreadSuccess: bool(
      NEEDS_YOU_KEYS.unreadSuccess,
      NEEDS_YOU_DEFAULTS.unreadSuccess,
    ),
    queued: bool(NEEDS_YOU_KEYS.queued, NEEDS_YOU_DEFAULTS.queued),
    working: bool(NEEDS_YOU_KEYS.working, NEEDS_YOU_DEFAULTS.working),
    callbacks: bool(NEEDS_YOU_KEYS.callbacks, NEEDS_YOU_DEFAULTS.callbacks),
    callbackLinks: bool(
      NEEDS_YOU_KEYS.callbackLinks,
      NEEDS_YOU_DEFAULTS.callbackLinks,
    ),
    intensity,
  };
}

function visualMarks(
  threads: readonly PluginSidebarThread[],
  settings: NeedsYouSettings | null,
): Map<string, HookMark> {
  const marks = new Map<string, HookMark>();

  if (settings === null) return marks;

  type VisualTreatment = {
    mark: HookMark;
    enabled: boolean;
  };

  const visuals = new Map<PluginSidebarThread["indicator"], VisualTreatment>([
    ["unread-error", { mark: "unread-failed", enabled: settings.unreadFailed }],
    [
      "waiting-for-input",
      { mark: "needs-input", enabled: settings.needsInput },
    ],
    ["input-welcome", { mark: "needs-input", enabled: settings.needsInput }],
    [
      "dependency-failed",
      { mark: "needs-input", enabled: settings.needsInput },
    ],
    ["callback-waiting", { mark: "callback", enabled: settings.callbacks }],
    [
      "unread-success",
      { mark: "unread-success", enabled: settings.unreadSuccess },
    ],
    ["queued-failed", { mark: "queued-failed", enabled: settings.queued }],
    ["queued-waiting", { mark: "queued-waiting", enabled: settings.queued }],
  ]);

  for (const kind of [
    "runtime",
    "workflow",
    "background-agent",
    "background-command",
    "plan-mode",
    "goal",
    "working-draft",
  ] as const)
    visuals.set(kind, { mark: "working", enabled: settings.working });

  for (const thread of threads) {
    const visual = visuals.get(thread.indicator);

    if (visual?.enabled) marks.set(thread.id, visual.mark);
  }

  return marks;
}

class SidebarDecorator {
  private marks: Map<string, HookMark> = new Map();
  private mode: SyncMode = "hold";
  private rowObserver: MutationObserver | null = null;
  private shellObserver: MutationObserver | null = null;
  private observedRoots: Element[] = [];
  private frame = 0;
  private stopped = false;
  private failed = false;
  start(): void {
    try {
      this.injectStyle();
      this.rowObserver = new MutationObserver(() => {
        this.schedule();
      });
      this.shellObserver = new MutationObserver(() => {
        if (
          this.observedRoots.length > 0 &&
          this.observedRoots.every((root) => root.isConnected)
        ) {
          return;
        }

        this.schedule();
      });
      this.shellObserver.observe(document.body, OBSERVER_INIT);
      this.schedule();
    } catch (cause) {
      this.fail(cause);
    }
  }
  setData(
    marks: Map<string, HookMark>,
    intensity: NeedsYouIntensity | null,
    mode: SyncMode,
  ): void {
    try {
      this.marks = marks;
      this.mode = mode;
      setAttribute(document.documentElement, ATTR_INTENSITY, intensity);
      this.schedule();
    } catch (cause) {
      this.fail(cause);
    }
  }
  stop(): void {
    this.stopped = true;

    try {
      if (this.frame !== 0) cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.rowObserver?.disconnect();
      this.rowObserver = null;
      this.shellObserver?.disconnect();
      this.shellObserver = null;
      this.observedRoots = [];
      this.clearAllMarks();
      setAttribute(document.documentElement, ATTR_INTENSITY, null);
      document.getElementById(STYLE_ID)?.remove();
    } catch (cause) {
      warnDecoratorFailed(cause);
    }
  }
  private fail(cause: unknown): void {
    this.failed = true;
    warnDecoratorFailed(cause);

    try {
      this.rowObserver?.disconnect();
      this.shellObserver?.disconnect();
      this.clearAllMarks();
    } catch {}
  }
  private schedule(): void {
    if (this.stopped || this.failed || this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;

      if (this.stopped || this.failed) return;

      try {
        this.sync();
      } catch (cause) {
        this.fail(cause);
      }
    });
  }
  private injectStyle(): void {
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = HIGHLIGHT_CSS;
    document.head.appendChild(style);
  }
  private roots(): Element[] {
    return queryAll(document, SCROLL_ROOT);
  }
  private reobserve(): void {
    const observer = this.rowObserver;

    if (observer === null) return;
    const roots = this.roots();

    const unchanged =
      roots.length === this.observedRoots.length &&
      roots.every((root, index) => root === this.observedRoots[index]);

    if (unchanged) return;
    observer.disconnect();
    this.observedRoots = roots;

    for (const root of roots) observer.observe(root, OBSERVER_INIT);
  }
  private sync(): void {
    this.reobserve();

    if (this.mode === "hold") return;

    if (this.mode === "clear") {
      this.clearAllMarks();

      return;
    }

    if (this.observedRoots.length === 0) return;

    for (const scope of this.observedRoots) {
      for (const anchor of queryAll(scope, ROW_ANCHOR)) this.paint(anchor);
    }
  }
  private paint(anchor: Element): void {
    const threadId = anchor.getAttribute("data-sidebar-thread-id");
    const mark = threadId === null ? undefined : this.marks.get(threadId);

    const queued =
      mark === "queued-failed"
        ? "failed"
        : mark === "queued-waiting"
          ? "waiting"
          : null;

    setAttribute(anchor, ATTR_STATE, queued === null ? (mark ?? null) : null);
    setAttribute(anchor, ATTR_QUEUED, queued);
  }
  private clearAllMarks(): void {
    for (const element of queryAll(
      document,
      `[${ATTR_STATE}], [${ATTR_QUEUED}]`,
    )) {
      element.removeAttribute(ATTR_STATE);
      element.removeAttribute(ATTR_QUEUED);
    }
  }
}

export function NeedsYouOverlay(): null {
  const callbacks = useCallbackWaits();
  const { values } = useSettings();
  const sidebar = experimental_useSidebarThreads();
  const settings = useMemo(() => readSettings(values), [values]);

  const marks = useMemo(
    () => visualMarks(sidebar.threads, settings),
    [sidebar.threads, settings],
  );

  const unread = useMemo(() => {
    const ids = new Set<string>();

    for (const [id, mark] of marks) {
      if (mark === "unread-success" || mark === "unread-failed") ids.add(id);
    }

    return ids;
  }, [marks]);

  const mode: SyncMode =
    settings === null || sidebar.status === "loading"
      ? "hold"
      : sidebar.status === "error"
        ? "clear"
        : "apply";

  useLayoutEffect(() => {
    if (mode === "hold") return;
    document.documentElement.setAttribute(
      "data-omnyo-sidebar-unread-targets",
      JSON.stringify(mode === "clear" ? [] : Array.from(unread)),
    );
    window.dispatchEvent(new Event("omnyo-sidebar-unread-targets"));
  }, [mode, unread]);
  useEffect(
    () => () => {
      document.documentElement.removeAttribute(
        "data-omnyo-sidebar-unread-targets",
      );
      window.dispatchEvent(new Event("omnyo-sidebar-unread-targets"));
    },
    [],
  );
  const decoratorRef = useRef<SidebarDecorator | null>(null);
  useEffect(() => {
    const decorator = new SidebarDecorator();
    decoratorRef.current = decorator;
    decorator.start();

    return () => {
      if (decoratorRef.current === decorator) decoratorRef.current = null;
      decorator.stop();
    };
  }, []);
  useEffect(() => {
    decoratorRef.current?.setData(marks, settings?.intensity ?? null, mode);
  }, [marks, settings, mode]);

  const links = useMemo((): LinkData | null => {
    if (mode !== "apply" || !settings?.callbacks || !settings.callbackLinks)
      return null;
    const graph = buildLinkGraph(callbacks.waits);

    const projects = new Map(
      sidebar.projects.map((project) => [project.id, project.name]),
    );

    const info = new Map<string, LinkNodeInfo>();

    for (const thread of sidebar.threads) {
      if (graph.groupOf.has(thread.id))
        info.set(thread.id, {
          title: thread.displayTitle,
          projectName: projects.get(thread.projectId) ?? null,
        });
    }

    for (const wait of callbacks.waits) {
      if (wait.sourceThreadId !== null && !info.has(wait.sourceThreadId))
        info.set(wait.sourceThreadId, {
          title: wait.sourceTitle,
          projectName: null,
        });
    }

    return { graph, info };
  }, [mode, settings, callbacks, sidebar.threads, sidebar.projects]);

  const linksRef = useRef<CallbackLinksDecorator | null>(null);
  useEffect(() => {
    const decorator = new CallbackLinksDecorator();
    linksRef.current = decorator;
    decorator.start();

    return () => {
      if (linksRef.current === decorator) linksRef.current = null;
      decorator.stop();
    };
  }, []);
  useEffect(() => {
    linksRef.current?.setData(links);
  }, [links]);

  return null;
}
