import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import type { JSONContent } from "@tiptap/react";
import {
  promptImageAliasNumber,
  promptImageAnchorText,
} from "@omnyo/client-core";
import { AttachmentHistoryStep } from "./attachment-history";
import { parsePromptEditorMentionAttrs } from "./prompt-editor-serialization";

export const PENDING_IMAGE_ANCHOR_PREFIX = "pending-image:";

export const IMAGE_ANCHOR_DRAG_TYPE = "application/x-omnyo-image-anchor";

const promptImageAnchorSyncKey = new PluginKey("promptImageAnchorSync");

export interface PromptImageAnchorRef {
  label: string;
  path: string;
}

export interface PromptImageAnchorSyncHandlers {
  resolvePending: (path: string) => PromptImageAnchorRef | "failed" | null;
  onAnchorsRemoved: (anchors: PromptImageAnchorRef[]) => string[];
  onAnchorsAdded: (anchors: PromptImageAnchorRef[]) => string[];
}

export function promptImageAnchorFromAttrs(
  attrs: ProseMirrorNode["attrs"],
): PromptImageAnchorRef | null {
  const parsed = parsePromptEditorMentionAttrs(attrs);

  if (!parsed || parsed.resource.kind !== "attachment") return null;
  const { label, path } = parsed.resource;

  return promptImageAliasNumber(label) !== null &&
    parsed.serializedText === promptImageAnchorText(label)
    ? { label, path }
    : null;
}

export function promptImageAnchorContent(
  anchor: PromptImageAnchorRef,
): JSONContent {
  return {
    type: "mention",
    attrs: {
      resource: { kind: "attachment", path: anchor.path, label: anchor.label },
      serializedText: promptImageAnchorText(anchor.label),
    },
  };
}

export function pendingImageAnchorPath(batchId: string, index: number): string {
  return `${PENDING_IMAGE_ANCHOR_PREFIX}${batchId}:${index}`;
}

const pendingImageAnchorFiles = new WeakMap<File, string>();

export function registerPendingImageAnchorFile(file: File, path: string) {
  pendingImageAnchorFiles.set(file, path);
}

export function pendingImageAnchorPathForFile(file: File): string | null {
  return pendingImageAnchorFiles.get(file) ?? null;
}

export function isPendingImageAnchorPath(path: string): boolean {
  return path.startsWith(PENDING_IMAGE_ANCHOR_PREFIX);
}

export function collectPromptImageAnchors(
  doc: ProseMirrorNode,
): { pos: number; node: ProseMirrorNode; anchor: PromptImageAnchorRef }[] {
  const anchors: {
    pos: number;
    node: ProseMirrorNode;
    anchor: PromptImageAnchorRef;
  }[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name !== "mention") return;
    const anchor = promptImageAnchorFromAttrs(node.attrs);

    if (anchor) anchors.push({ pos, node, anchor });
  });

  return anchors;
}

export function markPromptImageAnchorSync(tr: Transaction): Transaction {
  return tr.setMeta(promptImageAnchorSyncKey, true);
}

function trackedAnchors(doc: ProseMirrorNode) {
  const anchors = new Map<string, PromptImageAnchorRef>();

  for (const { anchor } of collectPromptImageAnchors(doc))
    anchors.set(`${anchor.label}\0${anchor.path}`, anchor);

  return anchors;
}

function isUserEdit(transaction: Transaction): boolean {
  return (
    transaction.getMeta("history$") === undefined &&
    transaction.getMeta("addToHistory") !== false &&
    transaction.getMeta(promptImageAnchorSyncKey) !== true
  );
}

export const PromptImageAnchorSync = Extension.create<{
  handlers: PromptImageAnchorSyncHandlers | null;
}>({
  name: "promptImageAnchorSync",
  addOptions() {
    return { handlers: null };
  },
  addProseMirrorPlugins() {
    const getHandlers = () => this.options.handlers;

    return [
      new Plugin({
        key: promptImageAnchorSyncKey,
        appendTransaction(transactions, oldState, newState) {
          const handlers = getHandlers();

          if (!handlers) return null;

          if (
            transactions.some((transaction) => transaction.docChanged) &&
            transactions.every(isUserEdit)
          ) {
            const before = trackedAnchors(oldState.doc);
            const after = trackedAnchors(newState.doc);

            const removed = [...before].flatMap(([key, anchor]) =>
              after.has(key) ? [] : [anchor],
            );

            const added = [...after].flatMap(([key, anchor]) =>
              before.has(key) ? [] : [anchor],
            );

            const steps = [
              ...(removed.length > 0
                ? handlers.onAnchorsRemoved(removed)
                : []
              ).map((id) => new AttachmentHistoryStep(id, false)),
              ...(added.length > 0 ? handlers.onAnchorsAdded(added) : []).map(
                (id) => new AttachmentHistoryStep(id, true),
              ),
            ];

            if (steps.length > 0) {
              const tr = newState.tr;

              for (const step of steps) tr.step(step);

              return tr;
            }
          }

          const tr = newState.tr;

          for (const { pos, node, anchor } of collectPromptImageAnchors(
            newState.doc,
          )) {
            if (!isPendingImageAnchorPath(anchor.path)) continue;
            const resolved = handlers.resolvePending(anchor.path);

            if (resolved === null) continue;
            const from = tr.mapping.map(pos);

            if (resolved === "failed") {
              tr.delete(from, from + node.nodeSize);
              continue;
            }

            tr.setNodeMarkup(from, undefined, {
              ...node.attrs,
              ...promptImageAnchorContent(resolved).attrs,
            });
          }

          return tr.docChanged
            ? markPromptImageAnchorSync(tr.setMeta("addToHistory", false))
            : null;
        },
      }),
    ];
  },
});
