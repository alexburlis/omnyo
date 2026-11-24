import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@/components/ui/chrome-style-tokens";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  definePluginApp,
  useComposer,
  useSdk,
  experimental_usePluginId,
  type ComposerDraftSnapshot,
  useRpc,
  type ExperimentalPluginBrowserPage,
  type ExperimentalPluginBrowserToolbarActionProps,
  type JsonValue,
} from "@omnyo/plugin-sdk/app";
import {
  ANNOTATION_MENTION_PROVIDER_ID,
  annotationMentionLabel,
  pageMessageSchema,
  pageStateSchema,
  reactProbeSchema,
  type AnnotationRecord,
  type PageAnnotation,
  type PageState,
  type ReactComponent,
} from "./annotations.js";
import {
  THEME_TOKENS,
  buildActivateExpression,
  buildClearAcceptedExpression,
  buildControllerExpression,
  buildReactProbeExpression,
} from "./page-script.js";
import { captureElement, type VisualBaseline } from "./visual-capture.js";
import {
  readTabReferences,
  retainTabQueue,
  tabQueue,
  tabStateKey,
  writeTabReferences,
} from "./tab-state.js";
import type { agentAnnotationsRpcContract } from "./server.js";

const INACTIVE_STATE: PageState = { active: false, count: 0 };

function readTheme(): Record<string, string> {
  const computed = getComputedStyle(document.documentElement);

  return Object.fromEntries(
    THEME_TOKENS.flatMap((token) => {
      const value = computed.getPropertyValue(`--${token}`).trim();

      return value.length > 0 ? [[`--omnyo-${token}`, value]] : [];
    }),
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function readReactComponents(
  page: ExperimentalPluginBrowserPage,
  annotationId: string,
): Promise<ReactComponent[]> {
  try {
    const parsed = reactProbeSchema.safeParse(
      await page.evaluate(buildReactProbeExpression(annotationId), {
        world: "main",
      }),
    );

    return parsed.success && parsed.data !== null ? parsed.data.components : [];
  } catch {
    return [];
  }
}

function withoutAnnotation(
  draft: ComposerDraftSnapshot,
  pluginId: string,
  id: string,
): ComposerDraftSnapshot {
  const removed = draft.mentions
    .filter(
      (mention) =>
        mention.kind === "plugin" &&
        mention.pluginId === pluginId &&
        mention.provider === ANNOTATION_MENTION_PROVIDER_ID &&
        mention.id === id,
    )
    .sort((a, b) => b.from - a.from);

  let next = draft;

  for (const match of removed) {
    const length = match.to - match.from;
    next = {
      ...next,
      text: next.text.slice(0, match.from) + next.text.slice(match.to),
      mentions: next.mentions
        .filter((mention) => mention !== match)
        .map((mention) =>
          mention.from >= match.to
            ? {
                ...mention,
                from: mention.from - length,
                to: mention.to - length,
              }
            : mention,
        ),
    };
  }

  return next;
}

interface SavedNote {
  record: AnnotationRecord;
  revisionId: string;
  pageRevision: number;
}

interface VisualReview {
  record: AnnotationRecord;
  observation: VisualBaseline;
  revisionId: string;
}

function AnnotationTabAction({
  url,
  experimental_page: page,
  threadId,
  tabId,
}: ExperimentalPluginBrowserToolbarActionProps) {
  const composer = useComposer();
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const rpc = useRpc<typeof agentAnnotationsRpcContract>();

  const stateKey = useMemo(
    () => tabStateKey(pluginId, threadId, tabId),
    [pluginId, threadId, tabId],
  );

  const pendingSaves = useMemo(() => tabQueue(stateKey), [stateKey]);
  const notes = useRef(new Map<string, SavedNote>());
  const pendingNotes = useRef(new Map<string, PageAnnotation>());
  const [state, setState] = useState<PageState>(INACTIVE_STATE);
  const [error, setError] = useState<string | null>(null);
  const [designMode, setDesignMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviews, setReviews] = useState<VisualReview[]>([]);
  const reviewsRef = useRef<VisualReview[]>([]);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const reviewIdRef = useRef<string | null>(null);
  const designModeRef = useRef(false);

  const persist = useCallback(() => {
    writeTabReferences(stateKey, {
      notes: [...notes.current].map(([id, note]) => ({
        id,
        revisionId: note.revisionId,
        pageRevision: note.pageRevision,
      })),
      reviews: reviewsRef.current.flatMap((item) =>
        item.record.visual === undefined
          ? []
          : [
              {
                id: item.record.visual.visualRequestId,
                revisionId: item.revisionId,
              },
            ],
      ),
      pending: [...pendingNotes.current.values()],
      reviewId: reviewIdRef.current,
      designMode: designModeRef.current,
    });
  }, [stateKey]);

  const replaceReviews = useCallback((items: VisualReview[]) => {
    reviewsRef.current = items;
    setReviews(items);

    if (
      !items.some(
        (item) => item.record.visual?.visualRequestId === reviewIdRef.current,
      )
    ) {
      reviewIdRef.current =
        items.at(-1)?.record.visual?.visualRequestId ?? null;
      setReviewId(reviewIdRef.current);
    }
  }, []);

  useEffect(
    () => retainTabQueue(stateKey, pendingSaves),
    [pendingSaves, stateKey],
  );
  useEffect(() => {
    pendingSaves.current = pendingSaves.current
      .then(async () => {
        const saved = readTabReferences(stateKey);

        if (saved === null) return;

        const ids = [
          ...new Set([
            ...saved.notes.map((item) => item.revisionId),
            ...saved.reviews.map((item) => item.revisionId),
          ]),
        ];

        const records = new Map<string, AnnotationRecord>();

        for (let offset = 0; offset < ids.length; offset += 24) {
          const batch = await rpc.call("readRevisions", {
            ids: ids.slice(offset, offset + 24),
          });

          for (const item of batch) records.set(item.id, item.record);
        }

        for (const item of saved.notes) {
          const record = records.get(item.revisionId);

          if (record !== undefined)
            notes.current.set(item.id, {
              record,
              revisionId: item.revisionId,
              pageRevision: item.pageRevision,
            });
        }

        for (const item of saved.pending)
          pendingNotes.current.set(item.id, item);
        setRetryId(saved.pending.at(-1)?.id ?? null);
        replaceReviews(
          saved.reviews.flatMap((item) => {
            const record = records.get(item.revisionId);

            return record?.visual === undefined
              ? []
              : [
                  {
                    record,
                    revisionId: item.revisionId,
                    observation: {
                      url: record.url,
                      viewport: record.visual.viewport,
                      rect: record.element.rect,
                    },
                  },
                ];
          }),
        );
        reviewIdRef.current = saved.reviewId;
        setReviewId(saved.reviewId);
        designModeRef.current = saved.designMode;
        setDesignMode(saved.designMode);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [pendingSaves, replaceReviews, rpc, stateKey]);

  const review =
    reviews.find((item) => item.record.visual?.visualRequestId === reviewId) ??
    null;

  const [retryId, setRetryId] = useState<string | null>(null);

  const applyState = useCallback((value: JsonValue) => {
    const parsed = pageStateSchema.safeParse(value);
    setState(parsed.success ? parsed.data : INACTIVE_STATE);
  }, []);

  const insertRecord = useCallback(
    (id: string, record: AnnotationRecord) => {
      composer.insert(
        [
          composer.text.length === 0 || /\s$/.test(composer.text) ? "" : " ",
          {
            provider: ANNOTATION_MENTION_PROVIDER_ID,
            id,
            label: annotationMentionLabel(record),
          },
          " ",
        ],
        { at: "end" },
      );
    },
    [composer],
  );

  const addToPrompt = useCallback(
    async (annotation: PageAnnotation, pageRevision = 0) => {
      if (page === null) return;
      pendingNotes.current.set(annotation.id, annotation);
      setBusy(true);

      try {
        persist();
        const components = await readReactComponents(page, annotation.id);
        let record: AnnotationRecord = { ...annotation, components };

        if (designModeRef.current) {
          if (notes.current.size >= 24)
            throw new Error(
              "Send this batch before adding more Design Mode notes.",
            );
          const captured = await captureElement(page, annotation);
          const thread = await sdk.threads.get({ threadId });
          const visualRequestId = crypto.randomUUID();

          const uploaded = await sdk.projects.attachments.upload({
            projectId: thread.projectId,
            clientFile: captured.blob,
            filename: `design-before-${visualRequestId}.jpg`,
            mimeType: "image/jpeg",
          });

          record = {
            ...record,
            visual: {
              visualRequestId,
              before: {
                kind: "project-image",
                projectId: thread.projectId,
                path: uploaded.path,
                mimeType: "image/jpeg",
                alt: `Before: ${annotation.element.name}`,
              },
              viewport: captured.observation.viewport,
            },
          };
          const saved = await rpc.call("saveRevision", record);
          notes.current.set(annotation.id, {
            record,
            revisionId: saved.id,
            pageRevision,
          });
          composer.replace((draft) => ({
            ...draft,
            attachments: [
              ...draft.attachments,
              { ...uploaded, sourceProjectId: thread.projectId },
            ],
          }));
          insertRecord(saved.id, record);
          replaceReviews(
            [
              ...reviewsRef.current,
              {
                record,
                revisionId: saved.id,
                observation: captured.observation,
              },
            ].slice(-24),
          );
          reviewIdRef.current = visualRequestId;
          setReviewId(visualRequestId);
        } else {
          const saved = await rpc.call("saveRevision", record);
          notes.current.set(annotation.id, {
            record,
            revisionId: saved.id,
            pageRevision,
          });
          insertRecord(saved.id, record);
        }

        pendingNotes.current.delete(annotation.id);
        persist();
        setRetryId(null);
        composer.focus();
      } catch (cause) {
        setRetryId(annotation.id);
        throw cause;
      } finally {
        setBusy(false);
      }
    },
    [composer, insertRecord, page, persist, replaceReviews, rpc, sdk, threadId],
  );

  useEffect(() => {
    if (page === null) return;

    return page.onMessage((data) => {
      const parsed = pageMessageSchema.safeParse(data);

      if (!parsed.success) return;

      if (parsed.data.type === "state") {
        setState({ active: parsed.data.active, count: parsed.data.count });

        return;
      }

      const message = parsed.data;
      pendingSaves.current = pendingSaves.current
        .then(async () => {
          if (message.type === "annotation-delete") {
            const note = notes.current.get(message.id);

            if (note !== undefined)
              composer.replace((draft) => {
                const next = withoutAnnotation(
                  draft,
                  pluginId,
                  note.revisionId,
                );

                const visual = note.record.visual;

                return visual === undefined
                  ? next
                  : {
                      ...next,
                      attachments: next.attachments.filter(
                        (attachment) =>
                          ![
                            visual.before,
                            ...(visual.result === undefined
                              ? []
                              : [visual.result]),
                          ].some(
                            (image) =>
                              attachment.sourceProjectId === image.projectId &&
                              attachment.path === image.path,
                          ),
                      ),
                    };
              });
            notes.current.delete(message.id);
            pendingNotes.current.delete(message.id);
            replaceReviews(
              reviewsRef.current.filter(
                (item) => item.record.id !== message.id,
              ),
            );
          } else if (message.type === "annotation-update") {
            const note = notes.current.get(message.id);
            const pending = pendingNotes.current.get(message.id);

            if (pending !== undefined)
              pendingNotes.current.set(message.id, {
                ...pending,
                comment: message.comment,
              });

            if (note === undefined) {
              if (pending !== undefined)
                await addToPrompt(
                  { ...pending, comment: message.comment },
                  message.revision ?? 0,
                );
            } else {
              const saved = await rpc.call("revise", {
                id: note.revisionId,
                comment: message.comment,
              });

              const record = { ...note.record, comment: message.comment };

              const exists = composer.draft.mentions.some(
                (mention) =>
                  mention.kind === "plugin" &&
                  mention.pluginId === pluginId &&
                  mention.provider === ANNOTATION_MENTION_PROVIDER_ID &&
                  mention.id === note.revisionId,
              );

              composer.replace((draft) => ({
                ...draft,
                mentions: draft.mentions.map((mention) =>
                  mention.kind === "plugin" &&
                  mention.pluginId === pluginId &&
                  mention.provider === ANNOTATION_MENTION_PROVIDER_ID &&
                  mention.id === note.revisionId
                    ? { ...mention, id: saved.id }
                    : mention,
                ),
              }));

              if (!exists) insertRecord(saved.id, record);
              notes.current.set(message.id, {
                record,
                revisionId: saved.id,
                pageRevision: message.revision ?? note.pageRevision + 1,
              });
              replaceReviews(
                reviewsRef.current.map((item) =>
                  item.record.id === message.id
                    ? { ...item, record, revisionId: saved.id }
                    : item,
                ),
              );
            }
          } else {
            await addToPrompt(message.annotation);
          }

          persist();
          setError(null);
        })
        .catch((cause: unknown) => setError(errorMessage(cause)));
    });
  }, [
    addToPrompt,
    composer,
    insertRecord,
    page,
    pendingSaves,
    persist,
    pluginId,
    replaceReviews,
    rpc,
  ]);

  useEffect(() => {
    if (page !== null)
      page
        .evaluate(buildControllerExpression("state"))
        .then(applyState, () => setState(INACTIVE_STATE));
  }, [applyState, page, url]);
  useEffect(
    () => () => {
      page
        ?.evaluate(buildControllerExpression("deactivate"))
        .catch(() => undefined);
    },
    [page],
  );
  useEffect(
    () =>
      composer.experimental_onSubmittedDraft((draft) => {
        const delivered = new Set(
          draft.mentions.flatMap((mention) =>
            mention.kind === "plugin" &&
            mention.pluginId === pluginId &&
            mention.provider === ANNOTATION_MENTION_PROVIDER_ID
              ? [mention.id]
              : [],
          ),
        );

        pendingSaves.current = pendingSaves.current
          .then(async () => {
            const entries = [...notes.current].flatMap(([id, note]) =>
              delivered.has(note.revisionId)
                ? [{ id, revision: note.pageRevision }]
                : [],
            );

            if (entries.length > 0 && page !== null)
              applyState(
                await page.evaluate(buildClearAcceptedExpression(entries)),
              );

            for (const entry of entries) {
              const current = notes.current.get(entry.id);

              if (current !== undefined && delivered.has(current.revisionId)) {
                notes.current.delete(entry.id);
                pendingNotes.current.delete(entry.id);
              }
            }

            persist();
          })
          .catch((cause: unknown) => setError(errorMessage(cause)));
      }),
    [applyState, composer, page, pendingSaves, persist, pluginId],
  );

  const toggle = useCallback(() => {
    if (page === null) return;
    setError(null);
    page
      .evaluate(
        state.active
          ? buildControllerExpression("deactivate")
          : buildActivateExpression(readTheme()),
      )
      .then(applyState, (cause: unknown) => setError(errorMessage(cause)));
  }, [applyState, page, state.active]);

  const captureResult = useCallback(() => {
    if (page === null || review === null || review.record.visual === undefined)
      return;
    const selectedId = review.record.visual.visualRequestId;
    pendingSaves.current = pendingSaves.current
      .then(async () => {
        const current = reviewsRef.current.find(
          (item) => item.record.visual?.visualRequestId === selectedId,
        );

        if (current === undefined) return;
        setBusy(true);

        try {
          const captured = await captureElement(
            page,
            current.record,
            current.observation,
          );

          const visual = current.record.visual;

          if (visual === undefined) return;

          const uploaded = await sdk.projects.attachments.upload({
            projectId: visual.before.projectId,
            clientFile: captured.blob,
            filename: `design-result-${visual.visualRequestId}.jpg`,
            mimeType: "image/jpeg",
          });

          const record: AnnotationRecord = {
            ...current.record,
            visual: {
              ...visual,
              result: {
                kind: "project-image",
                projectId: visual.before.projectId,
                path: uploaded.path,
                mimeType: "image/jpeg",
                alt: `Result: ${current.record.element.name}`,
              },
            },
          };

          const saved = await rpc.call("saveRevision", record);
          const previous = notes.current.get(record.id);
          composer.replace((draft) => ({
            ...withoutAnnotation(
              draft,
              pluginId,
              previous?.revisionId ?? current.revisionId,
            ),
            attachments: [
              ...draft.attachments.filter(
                (attachment) =>
                  ![
                    visual.before,
                    ...(visual.result === undefined ? [] : [visual.result]),
                  ].some(
                    (image) =>
                      attachment.sourceProjectId === image.projectId &&
                      attachment.path === image.path,
                  ),
              ),
              {
                type: "localImage",
                path: visual.before.path,
                name: `design-before-${visual.visualRequestId}.jpg`,
                mimeType: visual.before.mimeType,
                sourceProjectId: visual.before.projectId,
              },
              { ...uploaded, sourceProjectId: visual.before.projectId },
            ],
          }));
          notes.current.set(record.id, {
            record,
            revisionId: saved.id,
            pageRevision: previous?.pageRevision ?? 0,
          });
          insertRecord(saved.id, record);
          replaceReviews(
            reviewsRef.current.map((item) =>
              item.record.visual?.visualRequestId === visual.visualRequestId
                ? { ...item, record, revisionId: saved.id }
                : item,
            ),
          );
          persist();
          composer.focus();
          setError(null);
        } finally {
          setBusy(false);
        }
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [
    composer,
    insertRecord,
    page,
    pendingSaves,
    persist,
    pluginId,
    replaceReviews,
    review,
    rpc,
    sdk,
  ]);

  const label =
    page === null
      ? "Annotate elements is available in the desktop app"
      : state.active
        ? "Stop annotating"
        : "Annotate elements";

  const buttonClass = cn(
    "relative flex shrink-0 items-center justify-center rounded-md transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
    COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
  );

  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-pressed={state.active}
        disabled={page === null}
        onClick={toggle}
        title={error ?? label}
        className={cn(
          buttonClass,
          state.active
            ? "bg-state-active text-foreground"
            : CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
          error !== null && "text-destructive",
        )}
      >
        <Icon name="MessageSquarePlus" aria-hidden />
        {state.count > 0 ? (
          <span
            data-testid="agent-annotations-count"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-xs leading-none text-primary-foreground"
          >
            {state.count}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label="Design Mode"
        aria-pressed={designMode}
        disabled={
          page === null || page.experimental_capture === undefined || busy
        }
        title="Attach a crop with each note"
        onClick={() => {
          designModeRef.current = !designModeRef.current;
          setDesignMode(designModeRef.current);

          try {
            persist();
          } catch (cause) {
            setError(errorMessage(cause));
          }

          if (!state.active) toggle();
        }}
        className={cn(
          buttonClass,
          designMode && "bg-state-active text-foreground",
        )}
      >
        <Icon name="Paintbrush" aria-hidden />
      </button>
      {reviews.length > 1 ? (
        <select
          aria-label="Visual request"
          value={reviewId ?? ""}
          onChange={(event) => {
            reviewIdRef.current = event.target.value;
            setReviewId(event.target.value);

            try {
              persist();
            } catch (cause) {
              setError(errorMessage(cause));
            }
          }}
          className="max-w-40 rounded border border-border bg-canvas px-1 text-xs"
        >
          {reviews.map((item) => (
            <option
              key={item.record.visual?.visualRequestId}
              value={item.record.visual?.visualRequestId}
            >
              {annotationMentionLabel(item.record)}
            </option>
          ))}
        </select>
      ) : null}
      {review !== null ? (
        <button
          type="button"
          aria-label="Capture result for visual review"
          disabled={busy || page === null}
          onClick={captureResult}
          title="Add the original crop and a fresh result to the prompt"
          className={buttonClass}
        >
          <Icon name="Images" aria-hidden />
        </button>
      ) : null}
      {retryId !== null ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const annotation = pendingNotes.current.get(retryId);

            if (annotation !== undefined)
              pendingSaves.current = pendingSaves.current
                .then(() => addToPrompt(annotation))
                .then(
                  () => setError(null),
                  (cause: unknown) => setError(errorMessage(cause)),
                );
          }}
          className="px-2 text-xs"
        >
          Retry capture
        </button>
      ) : null}
      {busy ? (
        <span role="status" className="px-2 text-xs text-muted-foreground">
          Capturing…
        </span>
      ) : null}
      {error !== null ? (
        <span
          role="alert"
          className="max-w-64 truncate px-2 text-xs text-destructive"
          title={error}
        >
          {error}
        </span>
      ) : null}
    </>
  );
}

export function AnnotateAction(
  props: ExperimentalPluginBrowserToolbarActionProps,
) {
  return (
    <AnnotationTabAction key={`${props.threadId}:${props.tabId}`} {...props} />
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_browserToolbarAction({
    id: "annotate",
    title: "Agent annotations",
    component: AnnotateAction,
  });
});
