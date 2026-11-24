import { omnyoDesktopInfoSchema } from "@omnyo/desktop-contract";
import { z } from "zod";
import { parsePromptDraftStorage } from "@omnyo/client-core/prompt-draft";

const draftSchema = z
  .object({
    text: z.string().optional(),
    mentions: z.array(z.unknown()).optional(),
    attachments: z.array(z.unknown()).optional(),
    imageAliasHighWater: z.number().int().nonnegative().optional(),
  })
  .strict();

function validateDraft(raw: string): string {
  const stored = draftSchema.parse(JSON.parse(raw));
  const parsed = parsePromptDraftStorage(raw);

  if (
    (stored.mentions?.length ?? 0) !== parsed.mentions.length ||
    (stored.attachments?.length ?? 0) !== parsed.attachments.length
  )
    throw new Error("Invalid saved draft");

  return JSON.stringify(stored);
}

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new-thread") }),
  z.object({ kind: z.literal("plugin-new-thread"), key: z.string() }),
  z.object({ kind: z.literal("automation-edit"), automationId: z.string() }),
  z.object({
    kind: z.literal("thread"),
    projectId: z.string(),
    threadId: z.string(),
    conversationKey: z.string().optional(),
  }),
]);

export const composerSubmissionEntriesSchema = z.array(
  z.object({
    id: z.string().min(1),
    scope: scopeSchema,
    draft: z.string().superRefine((raw, context) => {
      try {
        validateDraft(raw);
      } catch {
        context.addIssue({ code: "custom", message: "Invalid saved draft" });
      }
    }),
  }),
);

export const pendingChatDescriptorsSchema = z.array(
  z.object({
    id: z.string().startsWith("pending_"),
    projectId: z.string().min(1),
    realThreadId: z.string().min(1).nullable(),
  }),
);

interface StorageCopy {
  storage: Storage;
  legacyKey: string;
  canonicalKey: string;
  value: string;
  legacy: string | null;
  canonical: string | null;
}

function planCopy(
  storage: Storage,
  legacyKey: string,
  canonicalKey: string,
  normalize: (raw: string) => string,
): StorageCopy | null {
  const legacy = storage.getItem(legacyKey);
  const canonical = storage.getItem(canonicalKey);
  let legacyValue: string | null = null;
  let canonicalValue: string | null = null;

  try {
    if (legacy !== null) legacyValue = normalize(legacy);

    if (canonical !== null) canonicalValue = normalize(canonical);
  } catch {
    throw new Error(
      "Saved browser state is invalid. Both copies were preserved.",
    );
  }

  if (
    legacyValue !== null &&
    canonicalValue !== null &&
    legacyValue !== canonicalValue
  )
    throw new Error(
      "Saved browser state conflict. Both copies were preserved.",
    );

  if (legacy === null) return null;

  return {
    storage,
    legacyKey,
    canonicalKey,
    value: canonical ?? legacy,
    legacy,
    canonical,
  };
}

function commitCopies(copies: StorageCopy[]): void {
  for (const copy of copies) {
    if (
      copy.storage.getItem(copy.legacyKey) !== copy.legacy ||
      copy.storage.getItem(copy.canonicalKey) !== copy.canonical
    )
      throw new Error(
        "Saved browser state changed during migration. Reload to try again.",
      );
  }

  for (const copy of copies) {
    if (copy.canonical !== copy.value)
      copy.storage.setItem(copy.canonicalKey, copy.value);

    if (copy.storage.getItem(copy.canonicalKey) !== copy.value)
      throw new Error("Saved browser state copy could not be verified.");
  }

  for (const copy of copies) {
    if (copy.storage.getItem(copy.legacyKey) !== copy.legacy)
      throw new Error(
        "Saved browser state changed during migration. Reload to try again.",
      );
    copy.storage.removeItem(copy.legacyKey);
  }
}

const rawJsonSchema = z.json();

type RawJson = z.infer<typeof rawJsonSchema>;

function sortJson(value: RawJson): RawJson {
  if (Array.isArray(value)) return value.map(sortJson);

  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries<RawJson>(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]): [string, RawJson] => [key, sortJson(child)]),
  );
}

function jsonValue(schema: z.ZodType, raw: string): string {
  const value = rawJsonSchema.parse(JSON.parse(raw));
  schema.parse(value);

  return JSON.stringify(sortJson(value));
}

function validTab(raw: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(raw))
    throw new Error("Invalid browser tab identity");

  return raw;
}

let migrationComplete = false;

export function migrateLegacyBrowserStorageV1(input?: {
  local: Storage;
  session: Storage;
}): void {
  if (!input && (migrationComplete || typeof window === "undefined")) return;
  const copies: StorageCopy[] = [];

  const add = (copy: StorageCopy | null) => {
    if (copy) copies.push(copy);
  };

  const local = input?.local ?? window.localStorage;
  const session = input?.session ?? window.sessionStorage;
  add(
    planCopy(
      local,
      "bb.desktopUpdateLaterVersion",
      "omnyo.desktopUpdateLaterVersion",
      (raw) => omnyoDesktopInfoSchema.shape.version.parse(raw),
    ),
  );
  add(
    planCopy(
      local,
      "bb.voiceInput.audioInputDeviceId",
      "omnyo.voiceInput.audioInputDeviceId",
      (raw) => raw,
    ),
  );
  add(
    planCopy(
      local,
      "bb:branch-tree:collapsed:v1",
      "omnyo:branch-tree:collapsed:v1",
      (raw) => jsonValue(z.array(z.string()), raw),
    ),
  );
  add(
    planCopy(
      session,
      "bb.composer-submission-tab.v1",
      "omnyo.composer-submission-tab.v1",
      validTab,
    ),
  );

  const tabId =
    session.getItem("omnyo.composer-submission-tab.v1") ??
    session.getItem("bb.composer-submission-tab.v1");

  if (tabId !== null) {
    validTab(tabId);
    add(
      planCopy(
        local,
        `bb.composer-submissions.v1.${tabId}`,
        `omnyo.composer-submissions.v1.${tabId}`,
        (raw) => jsonValue(composerSubmissionEntriesSchema, raw),
      ),
    );
  }

  add(
    planCopy(session, "bb.pending-chats.v1", "omnyo.pending-chats.v1", (raw) =>
      jsonValue(pendingChatDescriptorsSchema, raw),
    ),
  );
  const draftKeys = new Set<string>();

  for (let index = 0; index < local.length; index++) {
    const key = local.key(index);

    if (key && /^(?:bb|omnyo)\.promptbox\.contents-.+-3$/u.test(key))
      draftKeys.add(key.replace(/^omnyo\./u, "bb."));
  }

  for (const legacyKey of draftKeys)
    add(
      planCopy(
        local,
        legacyKey,
        legacyKey.replace(/^bb\./u, "omnyo."),
        validateDraft,
      ),
    );
  commitCopies(copies);

  if (!input) migrationComplete = true;
}

export function assertBrowserStorageMigrationV1(): void {
  if (
    typeof document !== "undefined" &&
    document.documentElement.dataset.omnyoStorageMigrationError
  )
    throw new Error(
      "Saved browser preferences need review. Both copies were preserved.",
    );
  migrateLegacyBrowserStorageV1();
}
