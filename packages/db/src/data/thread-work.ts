import { inArray } from "drizzle-orm";
import {
  parsePersistedPluginMetadata,
  threadWorkAssessmentSchema,
  threadWorkSignalsSchema,
  type PublishThreadWork,
  type JsonValue,
  type ThreadWorkSignals,
  type ThreadWorkAssessment,
} from "@omnyo/domain";
import type { DbConnection } from "../connection.js";
import { threadPluginMetadata } from "../schema.js";
import {
  getThreadConversationSequences,
  type ThreadConversationSequences,
} from "./events.js";
import {
  getThreadPluginMetadata,
  patchThreadPluginMetadata,
} from "./thread-plugin-metadata.js";

const coreNamespace = "omnyo-core-work";

const revisionKey = "obligationRevision";

const historyRewriteKey = "historyRewriteRevision";

const signalsKey = "experimental_work_signals";

const assessmentKey = "experimental_work_assessment";

function storedObservation(
  value: JsonValue | undefined,
): { version: number; value: JsonValue; intentRevision: number | null } | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 0 ||
    value.value === undefined
  )
    return null;

  return {
    version: value.version,
    value: value.value,
    intentRevision:
      typeof value.intentRevision === "number" &&
      Number.isSafeInteger(value.intentRevision)
        ? value.intentRevision
        : null,
  };
}

export interface StoredThreadWork {
  obligationRevision: number;
  historyRewriteRevision: number;
  conversation: ThreadConversationSequences;
  signals: Array<{
    version: number;
    value: ThreadWorkSignals;
    pluginId: string;
    intentRevision: number | null;
  }>;
  assessments: Array<{
    version: number;
    value: ThreadWorkAssessment;
    pluginId: string;
  }>;
  corrupt: boolean;
}

export function readStoredThreadWork(
  db: DbConnection,
  ids: readonly string[],
): Map<string, StoredThreadWork> {
  const result = new Map<string, StoredThreadWork>(
    ids.map((id) => [
      id,
      {
        obligationRevision: 0,
        historyRewriteRevision: 0,
        conversation: { lastInput: 0, lastStarted: 0, lastCompleted: 0 },
        signals: [],
        assessments: [],
        corrupt: false,
      },
    ]),
  );

  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);

    for (const [threadId, conversation] of Object.entries(
      getThreadConversationSequences(db, batch),
    )) {
      const state = result.get(threadId);

      if (state) state.conversation = conversation;
    }

    for (const row of db
      .select()
      .from(threadPluginMetadata)
      .where(inArray(threadPluginMetadata.threadId, batch))
      .all()) {
      const state = result.get(row.threadId);

      if (!state) continue;
      const metadata = parsePersistedPluginMetadata(row.metadataJson);

      if (metadata === undefined) {
        state.corrupt ||=
          row.pluginId === coreNamespace ||
          row.metadataJson.includes(signalsKey) ||
          row.metadataJson.includes(assessmentKey);
        continue;
      }

      if (row.pluginId === coreNamespace) {
        const revision = metadata[revisionKey];

        if (
          typeof revision === "number" &&
          Number.isSafeInteger(revision) &&
          revision >= 0
        )
          state.obligationRevision = revision;
        else state.corrupt = true;

        const rewrites = metadata[historyRewriteKey];

        if (typeof rewrites === "number" && Number.isSafeInteger(rewrites))
          state.historyRewriteRevision = rewrites;
      }

      if (signalsKey in metadata) {
        const observation = storedObservation(metadata[signalsKey]);
        const parsed = threadWorkSignalsSchema.safeParse(observation?.value);

        if (observation !== null && parsed.success)
          state.signals.push({
            version: observation.version,
            value: parsed.data,
            pluginId: row.pluginId,
            intentRevision: observation.intentRevision,
          });
        else state.corrupt = true;
      }

      if (assessmentKey in metadata) {
        const observation = storedObservation(metadata[assessmentKey]);
        const parsed = threadWorkAssessmentSchema.safeParse(observation?.value);

        if (observation !== null && parsed.success)
          state.assessments.push({
            version: observation.version,
            value: parsed.data,
            pluginId: row.pluginId,
          });
        else state.corrupt = true;
      }
    }
  }

  return result;
}

function advanceCoreRevision(
  db: DbConnection,
  threadId: string,
  key: string,
): void {
  const current = getThreadPluginMetadata(db, threadId, coreNamespace);
  const revision = current.metadata[key];
  patchThreadPluginMetadata(db, {
    threadId,
    pluginId: coreNamespace,
    set: {
      [key]:
        (typeof revision === "number" &&
        Number.isSafeInteger(revision) &&
        revision >= 0
          ? revision
          : 0) + 1,
    },
    remove: [],
  });
}

export function advanceThreadWorkObligationRevision(
  db: DbConnection,
  threadId: string,
): void {
  advanceCoreRevision(db, threadId, revisionKey);
}

export function advanceThreadHistoryRewriteRevision(
  db: DbConnection,
  threadId: string,
): void {
  advanceCoreRevision(db, threadId, historyRewriteKey);
}

export function publishThreadWork(
  db: DbConnection,
  threadId: string,
  input: PublishThreadWork,
): boolean {
  const key =
    input.contribution.kind === "assessment" ? assessmentKey : signalsKey;

  const value =
    input.contribution.kind === "assessment"
      ? input.contribution.assessment
      : input.contribution.signals;

  const current = getThreadPluginMetadata(db, threadId, input.pluginId);

  const revision = getThreadPluginMetadata(db, threadId, coreNamespace)
    .metadata[revisionKey];

  const nextRevision =
    (typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision >= 0
      ? revision
      : 0) + 1;

  const previous = current.metadata[key];
  const parsed = storedObservation(previous);

  if (
    parsed !== null &&
    JSON.stringify(parsed.value) === JSON.stringify(value) &&
    (input.contribution.kind === "assessment" ||
      input.contribution.signals.postponement === null ||
      parsed.intentRevision === nextRevision - 1)
  )
    return false;

  const result = patchThreadPluginMetadata(db, {
    threadId,
    pluginId: input.pluginId,
    set: {
      [key]: {
        version: (parsed?.version ?? 0) + 1,
        value,
        intentRevision:
          input.contribution.kind === "signals" ? nextRevision : null,
      },
    },
    remove: [],
  });

  if (!result.ok)
    throw new Error("Work observation exceeds the thread metadata limit");

  if (input.contribution.kind === "signals")
    advanceThreadWorkObligationRevision(db, threadId);

  return true;
}
