import type { z } from "zod";
import {
  serializePromptDraftStorage,
  type PromptDraftState,
} from "@omnyo/client-core/prompt-draft";
import type { PromptDraftScope } from "@/hooks/usePromptDraftStorage";
import { assertBrowserStorageMigrationV1 } from "./legacy-browser-storage-v1";

import {
  consumableComposerSubmissionEntriesSchema as entriesSchema,
  recoverComposerSubmissionEntriesV1,
  preserveComposerSubmissionTabV1,
} from "./prompt-draft-recovery-v1";

type Entry = z.infer<typeof entriesSchema>[number];

let sessionKey: string | undefined;

let entries: Entry[] | undefined;

function storageKey(): string | null {
  if (typeof window === "undefined") return null;
  assertBrowserStorageMigrationV1();

  if (sessionKey !== undefined) return sessionKey;

  try {
    const tabKey = "omnyo.composer-submission-tab.v1";
    const tabId = window.sessionStorage.getItem(tabKey) ?? crypto.randomUUID();
    preserveComposerSubmissionTabV1(window.sessionStorage, tabId);
    sessionKey = `omnyo.composer-submissions.v1.${tabId}`;

    return sessionKey;
  } catch {
    return null;
  }
}

function readEntries(): Entry[] {
  if (entries !== undefined) return entries;
  const key = storageKey();

  if (key === null) {
    entries = [];

    return entries;
  }

  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw === null ? [] : entriesSchema.parse(JSON.parse(raw));
    entries = parsed;

    return entries;
  } catch {
    throw new Error(
      "Saved pending messages contain unsupported data. Their original bytes were preserved.",
    );
  }
}

function persist(): void {
  const key = storageKey();

  if (key === null) return;

  try {
    if (entries?.length) {
      window.localStorage.setItem(key, JSON.stringify(entries));
    } else {
      window.localStorage.removeItem(key);
    }
  } catch (error) {
    console.warn("Pending messages are retained in memory only", error);
  }
}

export function beginComposerSubmission({
  scope,
  draft,
}: {
  scope: PromptDraftScope;
  draft: PromptDraftState;
}): { complete(): void } {
  const serialized = serializePromptDraftStorage(draft);

  if (serialized === null) return { complete() {} };

  const id = crypto.randomUUID();
  readEntries().push({ id, scope, draft: serialized });
  persist();

  return {
    complete() {
      entries = readEntries().filter((entry) => entry.id !== id);
      persist();
    },
  };
}

export function recoverInterruptedComposerSubmissions(
  restore: (scope: PromptDraftScope, draft: PromptDraftState) => void,
): { recovered: number; failed: number } {
  return recoverComposerSubmissionEntriesV1(
    [...readEntries()],
    restore,
    (id) => {
      entries = readEntries().filter((pending) => pending.id !== id);
      persist();
    },
  );
}
