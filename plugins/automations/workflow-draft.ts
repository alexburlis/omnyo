import type { z } from "zod";
import type {
  openSeoConnection,
  openSeoRpcContract,
} from "./src/openseo-contract";
import type { Copy } from "./workflow-panel-shared";
import type { InputValues } from "./workflow-setup";

type CopyTarget = Pick<Copy, "projectId" | "importId">;

type OpenSeoConnection = z.output<typeof openSeoConnection>;

type Read = Extract<
  z.output<(typeof openSeoRpcContract)["workflow_openseo_keywords"]["output"]>,
  { kind: "ready" }
>;

type KeywordIntent = {
  connection: OpenSeoConnection;
  keywordIds: string[];
};

type StoredResearch = {
  site: string;
  keepSaved: boolean;
  keywords?: KeywordIntent;
};

export type ResearchDraft = Omit<StoredResearch, "keywords"> & {
  pending?:
    | ({ kind: "reload" } & KeywordIntent)
    | ({
        kind: "loaded";
        read: Read;
        needsReview: boolean;
      } & KeywordIntent);
};

type StoredDraft = {
  bindingRevision: number;
  executionDigest: string;
  host: string;
  model: string;
  inputs: InputValues;
  sourceChoice: "notes" | "openseo";
  preview: boolean;
  research: StoredResearch;
};

type SetupDraft = Omit<StoredDraft, "research"> & { research: ResearchDraft };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeKeywordIntent(value: unknown): KeywordIntent | undefined {
  if (!isRecord(value)) return undefined;
  const { connection, keywordIds } = value;

  if (
    !isRecord(connection) ||
    typeof connection.site !== "string" ||
    typeof connection.openSeoProjectId !== "string" ||
    !Array.isArray(keywordIds) ||
    keywordIds.length === 0 ||
    keywordIds.length > 50 ||
    !keywordIds.every((id): id is string => typeof id === "string")
  )
    return undefined;

  return {
    connection: {
      site: connection.site,
      openSeoProjectId: connection.openSeoProjectId,
    },
    keywordIds,
  };
}

function decodeDraft(value: unknown, legacy: boolean): StoredDraft | undefined {
  if (!isRecord(value)) return undefined;

  const {
    bindingRevision,
    executionDigest,
    host,
    model,
    sourceChoice,
    preview,
    research,
  } = value;

  if (
    typeof bindingRevision !== "number" ||
    typeof executionDigest !== "string" ||
    typeof host !== "string" ||
    typeof model !== "string" ||
    !isRecord(value.inputs)
  )
    return undefined;

  const entries: [string, string | number | boolean][] = [];

  for (const [key, input] of Object.entries(value.inputs)) {
    if (input === null) entries.push([key, ""]);
    else if (
      typeof input === "string" ||
      typeof input === "number" ||
      typeof input === "boolean"
    )
      entries.push([key, input]);
    else return undefined;
  }

  const fields = {
    bindingRevision,
    executionDigest,
    host,
    model,
    inputs: Object.fromEntries(entries),
  };

  if (legacy && typeof value.site === "string")
    return {
      ...fields,
      sourceChoice: "openseo",
      preview: false,
      research: { site: value.site, keepSaved: false },
    };

  if (
    (sourceChoice !== "notes" && sourceChoice !== "openseo") ||
    typeof preview !== "boolean" ||
    !isRecord(research) ||
    typeof research.site !== "string" ||
    typeof research.keepSaved !== "boolean"
  )
    return undefined;

  const keywords = decodeKeywordIntent(research.keywords);

  if (research.keywords !== undefined && !keywords) return undefined;

  return {
    ...fields,
    sourceChoice,
    preview,
    research: {
      site: research.site,
      keepSaved: research.keepSaved,
      ...(keywords ? { keywords } : {}),
    },
  };
}

function draftKey({ projectId, importId }: CopyTarget) {
  return `omnyo.workflow.setup.${JSON.stringify([projectId, importId])}`;
}

function readStoredDraft(target: CopyTarget): StoredDraft | undefined {
  const key = draftKey(target);

  try {
    const raw = window.localStorage.getItem(key);

    if (raw) return decodeDraft(JSON.parse(raw), false);

    const legacy = window.sessionStorage.getItem(key);

    if (legacy) return decodeDraft(JSON.parse(legacy), true);
  } catch {
    return undefined;
  }
}

export function hasSetupDraft(target: CopyTarget) {
  return readStoredDraft(target) !== undefined;
}

export function restoreSetupDraft(copy: Copy): SetupDraft | undefined {
  const draft = readStoredDraft(copy);

  if (
    !draft ||
    draft.bindingRevision !== copy.bindingRevision ||
    draft.executionDigest !== copy.executionDigest
  )
    return undefined;

  const { keywords, ...research } = draft.research;

  return {
    ...draft,
    preview: draft.preview && (draft.sourceChoice === "notes" || !keywords),
    research: {
      ...research,
      ...(keywords ? { pending: { ...keywords, kind: "reload" } } : {}),
    },
  };
}

export function saveSetupDraft(target: CopyTarget, draft: SetupDraft) {
  const existing = readStoredDraft(target);

  if (existing && existing.bindingRevision > draft.bindingRevision) return true;

  const { pending, ...research } = draft.research;

  try {
    const key = draftKey(target);
    window.localStorage.setItem(
      key,
      JSON.stringify({
        ...draft,
        research: {
          ...research,
          ...(pending && pending.keywordIds.length > 0
            ? {
                keywords: {
                  connection: pending.connection,
                  keywordIds: pending.keywordIds,
                },
              }
            : {}),
        },
      }),
    );
    window.sessionStorage.removeItem(key);

    return true;
  } catch {
    return false;
  }
}

export function discardSetupDraft(copy: Copy) {
  const existing = readStoredDraft(copy);

  if (existing && existing.bindingRevision > copy.bindingRevision) return;

  try {
    const key = draftKey(copy);
    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
  } catch {
    return;
  }
}
