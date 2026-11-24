import { z } from "zod";
import {
  isPromptDraftEmpty,
  parseRecoverablePromptDraftStorage,
  serializePromptDraftStorage,
  withPromptImageAliasHighWater,
  type PromptDraftState,
} from "@omnyo/client-core/prompt-draft";

import {
  composerSubmissionEntriesSchema,
  pendingChatDescriptorsSchema,
  migrateLegacyBrowserStorageV1,
} from "./legacy-browser-storage-v1";

const [firstSubmissionScope, ...remainingSubmissionScopes] =
  composerSubmissionEntriesSchema.element.shape.scope.options;

export const consumableComposerSubmissionEntriesSchema = z.array(
  composerSubmissionEntriesSchema.element
    .extend({
      draft: composerSubmissionEntriesSchema.element.shape.draft.superRefine(
        (raw, context) => {
          try {
            parseRecoverablePromptDraftStorage(raw);
          } catch {
            context.addIssue({
              code: "custom",
              message: "Saved recovery draft contains unsupported fields",
            });
          }
        },
      ),
      scope: z.discriminatedUnion("kind", [
        firstSubmissionScope.strict(),
        ...remainingSubmissionScopes.map((scope) => scope.strict()),
      ]),
    })
    .strict(),
);

export type PromptDraftScope = z.infer<
  typeof consumableComposerSubmissionEntriesSchema
>[number]["scope"];

export function promptDraftStorageKeyV1(scope: PromptDraftScope): string {
  const segment = (value: string) => encodeURIComponent(value.trim());
  const prefix = "omnyo.promptbox.contents";

  if (scope.kind === "automation-edit")
    return `${prefix}-automation-edit-${segment(scope.automationId)}-3`;

  if (scope.kind === "new-thread") return `${prefix}-draft-3`;

  if (scope.kind === "plugin-new-thread")
    return `${prefix}-plugin-draft-${segment(scope.key)}-3`;

  const conversation =
    scope.conversationKey === undefined
      ? ""
      : `-conversation-${segment(scope.conversationKey)}`;

  return `${prefix}-${segment(scope.projectId)}-${segment(scope.threadId)}${conversation}-3`;
}

export function serializePersistedPromptDraftV1(
  draft: PromptDraftState,
): string | null {
  return isPromptDraftEmpty(draft) && (draft.imageAliasHighWater ?? 0) > 0
    ? JSON.stringify({
        text: "",
        attachments: [],
        imageAliasHighWater: draft.imageAliasHighWater,
      })
    : serializePromptDraftStorage(draft);
}

export function mergeRecoveredPromptDraftV1(
  current: PromptDraftState,
  draft: PromptDraftState,
): PromptDraftState {
  if (isPromptDraftEmpty(draft)) return current;

  if (isPromptDraftEmpty(current))
    return withPromptImageAliasHighWater(current, draft);

  const separator =
    current.text.length > 0 && draft.text.length > 0 ? "\n\n" : "";

  const offset = current.text.length + separator.length;
  const attachments = [...current.attachments];

  for (const attachment of draft.attachments) {
    if (
      !attachments.some(
        (existing) =>
          existing.path === attachment.path &&
          existing.hostId === attachment.hostId &&
          existing.sourceProjectId === attachment.sourceProjectId,
      )
    )
      attachments.push(attachment);
  }

  return withPromptImageAliasHighWater(current, {
    text: `${current.text}${separator}${draft.text}`,
    mentions: [
      ...current.mentions,
      ...draft.mentions.map((mention) => ({
        ...mention,
        start: mention.start + offset,
        end: mention.end + offset,
      })),
    ],
    attachments,
  });
}

export function pendingThreadDraftDestinationV1(
  scope: PromptDraftScope,
  pending: {
    projectId: string;
    realThreadId: string | null;
    status:
      | "creating"
      | "opening"
      | "open-failed"
      | "ready"
      | "failed"
      | "interrupted";
  } | null,
): PromptDraftScope {
  if (scope.kind !== "thread" || !scope.threadId.startsWith("pending_"))
    return scope;

  if (pending?.realThreadId)
    return {
      ...scope,
      projectId: pending.projectId,
      threadId: pending.realThreadId,
    };

  if (
    pending?.status === "creating" ||
    pending?.status === "opening" ||
    pending?.status === "open-failed"
  )
    return scope;

  if (scope.conversationKey !== undefined)
    throw new Error(
      "The saved conversation draft has no accepted pending destination. Its original input was preserved.",
    );

  return { kind: "new-thread" };
}

export function preserveComposerSubmissionTabV1(
  session: Storage,
  expected: string | null,
): void {
  if (expected === null) return;

  const key = "omnyo.composer-submission-tab.v1";
  const current = session.getItem(key);
  const legacy = session.getItem("bb.composer-submission-tab.v1");

  if (
    (current !== null && current !== expected) ||
    (legacy !== null && legacy !== expected)
  )
    throw new Error(
      "The native window has a different current composer identity",
    );

  if (current === null) session.setItem(key, expected);

  if (session.getItem(key) !== expected)
    throw new Error("The native window composer identity did not persist");
}

export function recoverComposerSubmissionEntriesV1(
  entries: readonly { id: string; scope: PromptDraftScope; draft: string }[],
  restore: (scope: PromptDraftScope, draft: PromptDraftState) => void,
  recoveredEntry: (id: string) => void,
): { recovered: number; failed: number } {
  let recovered = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      restore(entry.scope, parseRecoverablePromptDraftStorage(entry.draft));
    } catch (error) {
      failed += 1;
      console.warn("Could not restore an interrupted message", error);
      continue;
    }

    recoveredEntry(entry.id);
    recovered += 1;
  }

  return { recovered, failed };
}

class RecoveryStorage implements Storage {
  private readonly values: Map<string, string>;
  constructor(entries: readonly (readonly [string, string])[]) {
    this.values = new Map(entries);

    if (this.values.size !== entries.length)
      throw new Error("Recovery storage contains duplicate keys");
  }
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
  snapshot(): [string, string][] {
    return [...this.values].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
  }
}

export function originRecoveryMutationsV1(
  before: readonly (readonly [string, string])[],
  after: readonly (readonly [string, string])[],
) {
  const previous = new Map(before);
  const next = new Map(after);

  return [...new Set([...previous.keys(), ...next.keys()])]
    .sort()
    .flatMap((key) => {
      const before = previous.get(key) ?? null;
      const after = next.get(key) ?? null;

      return before === after ? [] : [{ key, before, after }];
    });
}

export function planOriginComposerRecoveryV1(args: {
  local: readonly (readonly [string, string])[];
  windows: readonly {
    windowKey: string;
    session: readonly (readonly [string, string])[];
  }[];
}) {
  if (
    args.windows.length < 1 ||
    args.windows.length > 32 ||
    new Set(args.windows.map((window) => window.windowKey)).size !==
      args.windows.length
  )
    throw new Error(
      "First-entry recovery requires the exact distinct local window set",
    );

  const local = new RecoveryStorage(args.local);

  const normalized = args.windows.map((window) => {
    const session = new RecoveryStorage(window.session);
    migrateLegacyBrowserStorageV1({ local, session });

    return {
      windowKey: window.windowKey,
      session: session.snapshot(),
    };
  });

  const tabIds = new Set<string>();
  const pendingIds = new Set<string>();
  let recoveredSubmissions = 0;
  let movedDrafts = 0;

  const restoreDraft = (scope: PromptDraftScope, draft: PromptDraftState) => {
    const key = promptDraftStorageKeyV1(scope);

    const value = serializePersistedPromptDraftV1(
      mergeRecoveredPromptDraftV1(
        parseRecoverablePromptDraftStorage(local.getItem(key)),
        draft,
      ),
    );

    if (value === null) local.removeItem(key);
    else local.setItem(key, value);
  };

  for (const window of normalized) {
    const session = new RecoveryStorage(window.session);

    const descriptors = pendingChatDescriptorsSchema.parse(
      JSON.parse(session.getItem("omnyo.pending-chats.v1") ?? "[]"),
    );

    for (const descriptor of descriptors) {
      if (pendingIds.has(descriptor.id))
        throw new Error(
          "Selected windows share an ambiguous pending destination",
        );
      pendingIds.add(descriptor.id);
    }

    const resolve = (scope: PromptDraftScope) =>
      pendingThreadDraftDestinationV1(
        scope,
        scope.kind === "thread" && scope.threadId.startsWith("pending_")
          ? (() => {
              const descriptor = descriptors.find(
                (item) => item.id === scope.threadId,
              );

              return descriptor
                ? {
                    ...descriptor,
                    status:
                      descriptor.realThreadId === null
                        ? ("interrupted" as const)
                        : ("ready" as const),
                  }
                : null;
            })()
          : null,
      );

    const tabId = session.getItem("omnyo.composer-submission-tab.v1");

    if (tabId !== null) {
      if (!tabId || tabId.length > 200 || tabIds.has(tabId))
        throw new Error(
          "Selected windows share an ambiguous composer tab identity",
        );
      tabIds.add(tabId);
      const key = `omnyo.composer-submissions.v1.${tabId}`;

      let entries = consumableComposerSubmissionEntriesSchema.parse(
        JSON.parse(local.getItem(key) ?? "[]"),
      );

      const result = recoverComposerSubmissionEntriesV1(
        entries,
        (scope, draft) => restoreDraft(resolve(scope), draft),
        (id) => {
          entries = entries.filter((entry) => entry.id !== id);

          if (entries.length) local.setItem(key, JSON.stringify(entries));
          else local.removeItem(key);
        },
      );

      if (result.failed)
        throw new Error(
          "Selected pending input could not be planned without mutation",
        );
      recoveredSubmissions += result.recovered;
    }

    for (const descriptor of descriptors) {
      const from: PromptDraftScope = {
        kind: "thread",
        projectId: descriptor.projectId,
        threadId: descriptor.id,
      };

      const to = resolve(from);
      const fromKey = promptDraftStorageKeyV1(from);

      if (fromKey === promptDraftStorageKeyV1(to)) continue;
      const draft = parseRecoverablePromptDraftStorage(local.getItem(fromKey));

      if (isPromptDraftEmpty(draft)) continue;
      restoreDraft(to, draft);
      local.removeItem(fromKey);
      movedDrafts += 1;
    }
  }

  for (const [key, value] of local.snapshot()) {
    if (
      (key.startsWith("omnyo.composer-submissions.v1.") ||
        key.startsWith("bb.composer-submissions.v1.")) &&
      composerSubmissionEntriesSchema.parse(JSON.parse(value)).length > 0
    )
      throw new Error("A saved composer journal has no selected source window");
  }

  const after = local.snapshot();

  return {
    mutations: originRecoveryMutationsV1(args.local, after),
    localAfter: after,
    windows: normalized.map((window, index) => ({
      windowKey: window.windowKey,
      session: window.session,
      mutations: originRecoveryMutationsV1(
        args.windows[index].session,
        window.session,
      ),
    })),
    recoveredSubmissions,
    movedDrafts,
  };
}
