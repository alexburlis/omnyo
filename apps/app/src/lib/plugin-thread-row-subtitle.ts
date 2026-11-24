import { useSyncExternalStore } from "react";
import type { ExperimentalThreadRowSubtitle } from "@omnyo/plugin-sdk";

type SubtitleOwner = string | symbol;

const subtitlesByThreadId = new Map<
  string,
  Map<SubtitleOwner, { pluginId: string; text: string }>
>();

const listeners = new Set<() => void>();

const EMPTY_SUBTITLES: ReadonlyMap<string, string> = new Map();

let snapshot: ReadonlyMap<string, string> | null = null;

function notify(): void {
  snapshot = null;

  for (const listener of [...listeners]) listener();
}

export function getPluginThreadRowSubtitle(threadId: string): string | null {
  return subtitlesByThreadId.get(threadId)?.values().next().value?.text ?? null;
}

function getSubtitles(): ReadonlyMap<string, string> {
  if (snapshot !== null) return snapshot;
  const next = new Map<string, string>();

  for (const threadId of subtitlesByThreadId.keys()) {
    const text = getPluginThreadRowSubtitle(threadId);

    if (text !== null) next.set(threadId, text);
  }

  snapshot = next.size === 0 ? EMPTY_SUBTITLES : next;

  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function setPluginThreadRowSubtitle(
  threadId: string,
  pluginId: string,
  subtitle: ExperimentalThreadRowSubtitle | null,
  owner: SubtitleOwner = pluginId,
): void {
  const previous = getPluginThreadRowSubtitle(threadId);
  let subtitles = subtitlesByThreadId.get(threadId);

  if (subtitle === null) {
    subtitles?.delete(owner);

    if (subtitles?.size === 0) subtitlesByThreadId.delete(threadId);
  } else {
    if (subtitles === undefined) {
      subtitles = new Map();
      subtitlesByThreadId.set(threadId, subtitles);
    }

    subtitles.set(owner, { pluginId, text: subtitle.text });
  }

  if (getPluginThreadRowSubtitle(threadId) !== previous) notify();
}

function clearSubtitles(
  matches: (owner: SubtitleOwner, pluginId: string) => boolean,
): void {
  let changed = false;

  for (const [threadId, subtitles] of subtitlesByThreadId) {
    const previous = getPluginThreadRowSubtitle(threadId);

    for (const [owner, entry] of subtitles) {
      if (matches(owner, entry.pluginId)) subtitles.delete(owner);
    }

    if (subtitles.size === 0) subtitlesByThreadId.delete(threadId);

    if (getPluginThreadRowSubtitle(threadId) !== previous) changed = true;
  }

  if (changed) notify();
}

export function clearPluginThreadRowSubtitles(pluginId: string): void {
  clearSubtitles((_owner, id) => id === pluginId);
}

export function clearPluginThreadRowSubtitlesByOwner(
  owner: SubtitleOwner,
): void {
  clearSubtitles((candidate) => candidate === owner);
}

export function usePluginThreadRowSubtitles(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, getSubtitles, getSubtitles);
}
