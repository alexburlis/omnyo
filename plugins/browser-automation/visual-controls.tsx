import { useEffect, useState } from "react";
import {
  useComposers,
  useRpc,
  useSdk,
  type ComposerAttachment,
} from "@omnyo/plugin-sdk/app";
import type {
  PreviewFrame,
  VisualElement,
  ViewportPreset,
  rpcContract,
} from "./contracts.js";
import { selectVisualElement, visualNoteText } from "./visual-selection.js";

type FrozenImage = {
  observation: import("./contracts.js").VisualObservation;
  image: import("./contracts.js").VisualImage;
};

const buttonClass =
  "min-h-9 rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-50";

export function VisualControls({
  threadId,
  sessionId,
  frame,
  onFrozenChange,
}: {
  threadId: string;
  sessionId: string;
  frame: PreviewFrame | null;
  onFrozenChange: (frozen: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const composers = useComposers();

  const composer = composers.find(
    (candidate) =>
      candidate.scope.kind === "thread" &&
      candidate.scope.threadId === threadId,
  );

  const [frozen, setFrozen] = useState<FrozenImage | null>(null);
  const [selected, setSelected] = useState<VisualElement | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<ViewportPreset | null>(null);

  const [added, setAdded] = useState<
    Array<{ id: string; path: string; comment: string }>
  >([]);

  useEffect(() => {
    onFrozenChange(frozen !== null);

    return () => onFrozenChange(false);
  }, [frozen, onFrozenChange]);

  useEffect(
    () =>
      composer?.experimental_onSubmittedDraft((draft) => {
        setAdded((notes) =>
          notes.filter(
            (note) =>
              !(
                draft.text.includes(`[Visual note ${note.id}]`) &&
                draft.attachments.some((image) => image.path === note.path)
              ),
          ),
        );
      }),
    [composer],
  );

  const targetId = frame?.targetId;

  useEffect(() => {
    if (targetId !== undefined) setPreset(null);
  }, [targetId]);

  async function freeze() {
    if (!frame || busy) return;
    setBusy(true);
    setError("");

    try {
      const result = await rpc.call("observe", {
        threadId,
        sessionId,
        targetId: frame.targetId,
      });

      setFrozen(result);
      setSelected(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not freeze this preview. Your note is kept.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function changePreset(value: ViewportPreset) {
    if (!frame || busy) return;
    setBusy(true);
    setError("");

    try {
      await rpc.call("viewport", {
        threadId,
        sessionId,
        targetId: frame.targetId,
        preset: value,
      });
      setPreset(value === "original" ? null : value);
      setFrozen(null);
      setSelected(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not change the viewport. Your note is kept.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    if (!frozen || !selected || !comment.trim() || busy) return;

    if (!composer) {
      setError("Open the originating chat to add this note to its draft.");

      return;
    }

    if (added.length >= 24) {
      setError("Send the current batch before adding more notes.");

      return;
    }

    const boundComposer = composer;
    const note = comment;
    const id = crypto.randomUUID();
    setBusy(true);
    setError("");

    try {
      const inspected = await rpc.call("inspect", {
        threadId,
        sessionId,
        targetId: frozen.observation.targetId,
        observationId: frozen.observation.id,
        elementId: selected.id,
      });

      const thread = await sdk.threads.get({ threadId });
      const binary = atob(inspected.image.data);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

      const uploaded = await sdk.projects.attachments.upload({
        projectId: thread.projectId,
        filename: `visual-note-${id}.jpg`,
        mimeType: "image/jpeg",
        clientFile: bytes,
      });

      const attachment: ComposerAttachment = {
        ...uploaded,
        type: "localImage",
        sourceProjectId: thread.projectId,
      };

      const text = visualNoteText({
        id,
        comment: note,
        observation: inspected.observation,
        element: inspected.element,
        projectId: thread.projectId,
        path: uploaded.path,
      });

      boundComposer.replace((current) => ({
        ...current,
        text: current.text + text,
        attachments: [...current.attachments, attachment],
      }));
      setAdded((notes) => [
        ...notes,
        { id, path: uploaded.path, comment: note },
      ]);
      setComment((current) => (current === note ? "" : current));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not add this note. Your note is kept.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Visual preview controls"
      >
        {(["phone", "tablet", "desktop"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={buttonClass}
            disabled={busy || !frame}
            aria-pressed={preset === value}
            onClick={() => void changePreset(value)}
          >
            {value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
        {preset ? (
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !frame}
            onClick={() => void changePreset("original")}
          >
            Restore viewport
          </button>
        ) : null}
        <button
          type="button"
          className={buttonClass}
          disabled={busy || !frame}
          onClick={() => void freeze()}
        >
          {frozen ? "Refresh selection" : "Annotate"}
        </button>
        {frozen ? (
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => {
              setFrozen(null);
              setSelected(null);
            }}
          >
            Live view
          </button>
        ) : null}
      </div>
      {frozen ? (
        <>
          <button
            type="button"
            className="block max-h-[60dvh] w-full overflow-hidden rounded-md border border-border bg-background"
            aria-label="Select an element in the frozen image"
            disabled={busy}
            onClick={(event) => {
              const image = event.currentTarget.querySelector("img");

              if (!image) return;
              setSelected(
                selectVisualElement({
                  observation: frozen.observation,
                  clientX: event.clientX,
                  clientY: event.clientY,
                  bounds: image.getBoundingClientRect(),
                  bitmap: frozen.image,
                }),
              );
            }}
          >
            <img
              className="mx-auto block max-h-[60dvh] max-w-full object-contain"
              draggable={false}
              alt="Frozen browser view for annotation"
              src={`data:${frozen.image.mimeType};base64,${frozen.image.data}`}
            />
          </button>
          <label className="flex flex-col gap-1 text-xs">
            Element
            <select
              aria-label="Element to annotate"
              value={selected?.id ?? ""}
              disabled={busy}
              className="min-h-9 rounded-md border border-border bg-background px-2"
              onChange={(event) =>
                setSelected(
                  frozen.observation.elements.find(
                    (element) => element.id === event.target.value,
                  ) ?? null,
                )
              }
            >
              <option value="">Select in the image or choose an element</option>
              {frozen.observation.elements.map((element) => (
                <option key={element.id} value={element.id}>
                  {`${element.selector} ${element.text}`.slice(0, 120)}
                </option>
              ))}
            </select>
          </label>
          <textarea
            aria-label="Visual note"
            className="min-h-20 w-full resize-y rounded-md border border-border bg-background p-2 text-sm"
            maxLength={2000}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="What should change?"
          />
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !selected || !comment.trim()}
            onClick={() => void addNote()}
          >
            {busy ? "Saving…" : "Add note to chat"}
          </button>
        </>
      ) : null}
      {added.length ? (
        <div className="text-xs text-muted-foreground" role="status">
          {added.length} {added.length === 1 ? "note" : "notes"} in the
          originating chat draft. {added.map((note) => note.comment).join("; ")}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}
