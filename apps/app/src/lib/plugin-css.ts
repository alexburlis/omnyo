import { useLayoutEffect, useSyncExternalStore } from "react";
import { useThreadInitialLoad } from "@/components/thread/ThreadInitialLoad";
import {
  dropHostDuplicatePluginRules,
  normalizePluginStylesheet,
} from "./plugin-css-selectors";

const CSS_MARKER = "data-omnyo-plugin-css";

const CSS_PRELOAD_MARKER = "data-omnyo-plugin-css-preload";

const CSS_RELEASE_GRACE_MS = 1_500;

interface PluginCssRecord {
  consumers: number;
  cleanupEpoch: number;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  loadedUrl: string | null;
  pendingStylesheet: HTMLLinkElement | null;
  preload: HTMLLinkElement | null;
  stylesheet: HTMLLinkElement | null;
  url: string | null;
}

const recordsByPluginId = new Map<string, PluginCssRecord>();

const settledUrls = new Set<string>();

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function settle(url: string): void {
  settledUrls.add(url);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function recordFor(pluginId: string): PluginCssRecord {
  const existing = recordsByPluginId.get(pluginId);

  if (existing !== undefined) return existing;

  const created: PluginCssRecord = {
    consumers: 0,
    cleanupEpoch: 0,
    cleanupTimer: null,
    loadedUrl: null,
    pendingStylesheet: null,
    preload: null,
    stylesheet: null,
    url: null,
  };

  recordsByPluginId.set(pluginId, created);

  return created;
}

function linkUrl(link: HTMLLinkElement | null): string | null {
  return link?.getAttribute("href") ?? null;
}

function removeLink(link: HTMLLinkElement | null): void {
  link?.remove();
}

function warnLoadFailure(pluginId: string, url: string): void {
  console.warn(`Omnyo plugin "${pluginId}": failed to load stylesheet ${url}`);
}

function startPreload(
  pluginId: string,
  record: PluginCssRecord,
  url: string,
): void {
  if (record.loadedUrl === url || linkUrl(record.preload) === url) return;
  removeLink(record.preload);
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "style";
  link.fetchPriority = "low";
  link.href = url;
  link.setAttribute(CSS_PRELOAD_MARKER, pluginId);
  record.preload = link;
  link.onload = () => {
    link.remove();

    if (record.preload === link) record.preload = null;

    if (record.url !== url) return;
    record.loadedUrl = url;

    if (record.consumers > 0) activateStylesheet(pluginId, record, url);
    notify();
  };

  link.onerror = () => {
    link.remove();

    if (record.preload === link) record.preload = null;

    if (record.url !== url) return;
    warnLoadFailure(pluginId, url);
    settle(url);
  };

  document.head.appendChild(link);
}

function hostStylesheets(): CSSStyleSheet[] {
  return [...document.styleSheets].filter(
    (sheet) =>
      !(sheet.ownerNode instanceof Element) ||
      !sheet.ownerNode.hasAttribute(CSS_MARKER),
  );
}

function activateStylesheet(
  pluginId: string,
  record: PluginCssRecord,
  url: string,
): void {
  if (linkUrl(record.pendingStylesheet) === url) return;

  if (record.stylesheet && linkUrl(record.stylesheet) === url) {
    record.stylesheet.media = "all";
    record.loadedUrl = url;
    removeLink(record.preload);
    record.preload = null;

    return;
  }

  removeLink(record.preload);
  record.preload = null;
  removeLink(record.pendingStylesheet);

  const previous = record.stylesheet;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  link.setAttribute(CSS_MARKER, pluginId);
  record.pendingStylesheet = link;
  link.onload = () => {
    if (record.pendingStylesheet !== link || record.url !== url) {
      link.remove();

      if (record.pendingStylesheet === link) record.pendingStylesheet = null;

      return;
    }

    if (link.sheet !== null) {
      normalizePluginStylesheet(link.sheet, pluginId);
      dropHostDuplicatePluginRules(link.sheet, pluginId, hostStylesheets());
    }

    previous?.remove();
    record.stylesheet = link;
    record.pendingStylesheet = null;
    record.loadedUrl = url;
    settle(url);
  };

  link.onerror = () => {
    link.remove();

    if (record.pendingStylesheet === link) record.pendingStylesheet = null;

    if (record.url !== url) return;
    warnLoadFailure(pluginId, url);
    settle(url);
  };

  document.head.appendChild(link);
}

function deactivateStylesheet(record: PluginCssRecord): void {
  removeLink(record.pendingStylesheet);
  removeLink(record.stylesheet);
  record.pendingStylesheet = null;
  record.stylesheet = null;
}

function cancelDeferredDeactivate(record: PluginCssRecord): void {
  record.cleanupEpoch += 1;

  if (record.cleanupTimer !== null) {
    clearTimeout(record.cleanupTimer);
    record.cleanupTimer = null;
  }
}

function deactivateAfterFinalRelease(
  pluginId: string,
  record: PluginCssRecord,
): void {
  cancelDeferredDeactivate(record);
  const cleanupEpoch = record.cleanupEpoch;
  record.cleanupTimer = setTimeout(() => {
    record.cleanupTimer = null;

    if (record.cleanupEpoch !== cleanupEpoch || record.consumers > 0) return;

    if (record.stylesheet && linkUrl(record.stylesheet) === record.url) {
      record.stylesheet.media = "not all";

      return;
    }

    deactivateStylesheet(record);

    if (record.url === null) {
      recordsByPluginId.delete(pluginId);

      return;
    }

    startPreload(pluginId, record, record.url);
  }, CSS_RELEASE_GRACE_MS);
}

export function applyPluginCss(pluginId: string, url: string | null): void {
  const record = recordFor(pluginId);

  if (url === null) {
    cancelDeferredDeactivate(record);
    record.url = null;
    record.loadedUrl = null;
    removeLink(record.preload);
    record.preload = null;
    deactivateStylesheet(record);

    if (record.consumers === 0) recordsByPluginId.delete(pluginId);
    notify();

    return;
  }

  if (record.url === url) {
    if (record.consumers > 0) activateStylesheet(pluginId, record, url);
    else startPreload(pluginId, record, url);

    return;
  }

  cancelDeferredDeactivate(record);
  record.url = url;
  record.loadedUrl = linkUrl(record.stylesheet) === url ? url : null;
  removeLink(record.preload);
  record.preload = null;

  if (record.consumers > 0) {
    activateStylesheet(pluginId, record, url);
  } else {
    deactivateStylesheet(record);
    startPreload(pluginId, record, url);
  }

  notify();
}

export function retainPluginCss(pluginId: string): () => void {
  const record = recordFor(pluginId);
  cancelDeferredDeactivate(record);
  record.consumers += 1;

  if (record.url !== null) activateStylesheet(pluginId, record, record.url);
  let released = false;

  return () => {
    if (released) return;
    released = true;
    record.consumers = Math.max(0, record.consumers - 1);

    if (record.consumers === 0) {
      deactivateAfterFinalRelease(pluginId, record);
    }
  };
}

export function usePluginCss(pluginId: string | null): void {
  const initialLoad = useThreadInitialLoad();
  useLayoutEffect(
    () => (pluginId === null ? undefined : retainPluginCss(pluginId)),
    [pluginId],
  );
  useLayoutEffect(() => {
    if (pluginId === null || initialLoad === null) return;
    const link = recordsByPluginId.get(pluginId)?.pendingStylesheet;

    if (!link) return;
    const finish = initialLoad.begin();
    link.addEventListener("load", finish);
    link.addEventListener("error", finish);

    return () => {
      link.removeEventListener("load", finish);
      link.removeEventListener("error", finish);
      finish();
    };
  }, [initialLoad, pluginId]);
}

function isPluginCssReady(pluginId: string | null): boolean {
  if (pluginId === null) return true;
  const record = recordsByPluginId.get(pluginId);

  return (
    record === undefined ||
    record.url === null ||
    record.stylesheet !== null ||
    settledUrls.has(record.url)
  );
}

function isAllPluginCssSettled(): boolean {
  return [...recordsByPluginId.values()].every(
    ({ loadedUrl, url }) =>
      url === null || loadedUrl === url || settledUrls.has(url),
  );
}

export function usePluginCssReady(pluginId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => isPluginCssReady(pluginId));
}

export function useAllPluginCssSettled(): boolean {
  return useSyncExternalStore(subscribe, isAllPluginCssSettled);
}

export function resetPluginCssForTest(): void {
  for (const record of recordsByPluginId.values()) {
    cancelDeferredDeactivate(record);
    removeLink(record.preload);
    deactivateStylesheet(record);
  }

  recordsByPluginId.clear();
  settledUrls.clear();

  for (const link of document.head.querySelectorAll(
    `link[${CSS_MARKER}], link[${CSS_PRELOAD_MARKER}]`,
  )) {
    link.remove();
  }
}
