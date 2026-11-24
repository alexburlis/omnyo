import {
  promptTextMentionSchema,
  promptMentionResourceSchema,
  type PromptInput,
  type PromptTextMention,
} from "@omnyo/domain";
import { uploadedPromptAttachmentSchema } from "@omnyo/server-contract";
import { z } from "zod";

const PROMPT_IMAGE_ALIAS_PATTERN = /^Img([1-9]\d{0,5})$/u;

const PROMPT_IMAGE_ALIAS_TEXT_PATTERN = /\bImg([1-9]\d{0,5})\b/gu;

const draftAttachmentFields = uploadedPromptAttachmentSchema
  .omit({ sourceProjectId: true })
  .extend({
    sizeBytes: z.number().nonnegative().optional(),
    alias: z
      .string()
      .regex(PROMPT_IMAGE_ALIAS_PATTERN)
      .optional()
      .catch(undefined),
  });

const promptDraftAttachmentSchema = z.union([
  draftAttachmentFields.extend({
    hostId: z.string().min(1),
    sourceProjectId: z.undefined().optional(),
  }),
  draftAttachmentFields.extend({
    sourceProjectId: z.string().min(1).optional(),
    hostId: z.undefined().optional(),
  }),
]);

export type PromptDraftAttachment = z.infer<typeof promptDraftAttachmentSchema>;

function attachmentOwner(attachment: {
  sourceProjectId?: string;
  hostId?: string;
}) {
  if (attachment.hostId !== undefined) return { hostId: attachment.hostId };

  return attachment.sourceProjectId === undefined
    ? {}
    : { sourceProjectId: attachment.sourceProjectId };
}

export interface PromptDraftState {
  text: string;
  mentions: PromptTextMention[];
  attachments: PromptDraftAttachment[];
  imageAliasHighWater?: number;
}

const promptDraftStorageSchema = z.object({
  text: z.string().default(""),
  imageAliasHighWater: z.number().int().positive().optional().catch(undefined),
  mentions: z
    .array(z.unknown())
    .default([])
    .transform((items) =>
      items.flatMap((item) => {
        const result = promptTextMentionSchema.safeParse(item);

        return result.success ? [result.data] : [];
      }),
    ),
  attachments: z
    .array(z.unknown())
    .default([])
    .transform((items) =>
      items.flatMap((item) => {
        const result = promptDraftAttachmentSchema.safeParse(item);

        if (!result.success) return [];
        const { sizeBytes, ...attachment } = result.data;

        return [
          sizeBytes === undefined || sizeBytes === 0
            ? attachment
            : { ...attachment, sizeBytes },
        ];
      }),
    ),
});

const [firstMentionResource, ...remainingMentionResources] =
  promptMentionResourceSchema.out.options;

const recoverableMentionResourceSchema = z.pipe(
  promptMentionResourceSchema.in,
  z.discriminatedUnion("kind", [
    firstMentionResource.strict(),
    ...remainingMentionResources.map((resource) => resource.strict()),
  ]),
);

const recoverableDraftStorageSchema = promptDraftStorageSchema
  .extend({
    mentions: z
      .array(
        promptTextMentionSchema
          .extend({ resource: recoverableMentionResourceSchema })
          .strict(),
      )
      .default([]),
    attachments: z
      .array(
        z.union(
          promptDraftAttachmentSchema.options.map((attachment) =>
            attachment.strict(),
          ),
        ),
      )
      .default([]),
  })
  .strict();

export function parseRecoverablePromptDraftStorage(
  rawValue: string | null,
): PromptDraftState {
  if (rawValue === null) return emptyPromptDraftState();
  const parsed: unknown = JSON.parse(rawValue);
  recoverableDraftStorageSchema.parse(parsed);

  return promptDraftStorageSchema.parse(parsed);
}

export function emptyPromptDraftState(): PromptDraftState {
  return {
    text: "",
    mentions: [],
    attachments: [],
  };
}

function existingAliasForQuotedImage(
  mention: PromptTextMention,
  text: string,
  attachments: readonly PromptDraftAttachment[],
): string | undefined {
  const { resource } = mention;

  if (
    resource.kind !== "attachment" ||
    !isPromptImageAnchorMention(mention, text)
  )
    return undefined;

  const images = attachments.filter(
    (attachment) =>
      attachment.type === "localImage" && attachment.path === resource.path,
  );

  return images.length === 1 ? images[0]?.alias : undefined;
}

function formatPromptQuote({
  draftText,
  text,
  mentions = [],
  attachments = [],
}: {
  draftText: string;
  text: string;
  mentions?: readonly PromptTextMention[];
  attachments?: readonly PromptDraftAttachment[];
}) {
  const pieces = text.split(/(\r\n?|\n)/u);
  const lines: { text: string; start: number }[] = [];
  let sourceOffset = 0;
  let first = -1;
  let last = -1;

  for (const [index, line] of pieces.entries()) {
    if (index % 2 !== 0) continue;
    const next = { text: line, start: sourceOffset };
    sourceOffset += line.length + (pieces[index + 1]?.length ?? 0);

    if (line.trim().length > 0) {
      if (first === -1) first = lines.length;
      last = lines.length;
    } else if (
      lines.at(-1)?.text.startsWith(">") === true &&
      pieces[index + 2]?.startsWith(">") === true
    ) {
      continue;
    }

    lines.push(next);
  }

  if (first === -1) return null;

  const orderedMentions = normalizePromptTextMentions(mentions, text.length);
  const quotedMentions: PromptTextMention[] = [];
  let nextMention = 0;
  let quotedText = draftText === "" ? "" : draftText + "\n";

  for (const [index, line] of lines.entries()) {
    if (index < first) continue;

    if (index > last) break;
    const head = index === first ? line.text.trimStart() : line.text;
    const visible = index === last ? head.trimEnd() : head;
    const start = line.start + line.text.length - head.length;
    const end = start + visible.length;
    let cursor = start;
    quotedText += visible.length === 0 ? ">" : "> ";

    for (
      let mention = orderedMentions[nextMention];
      mention !== undefined && mention.start < end;
      mention = orderedMentions[++nextMention]
    ) {
      if (mention.start < cursor || mention.end > end) continue;

      const alias = existingAliasForQuotedImage(mention, text, attachments);

      const token =
        alias === undefined
          ? text.slice(mention.start, mention.end)
          : promptImageAnchorText(alias);

      const resource =
        alias === undefined
          ? mention.resource
          : { ...mention.resource, label: alias };

      quotedText += text.slice(cursor, mention.start);
      const quoteStart = quotedText.length;
      quotedText += token;
      quotedMentions.push({
        start: quoteStart,
        end: quoteStart + token.length,
        resource,
      });
      cursor = mention.end;
    }

    quotedText += text.slice(cursor, end) + "\n";
  }

  return { text: quotedText, mentions: quotedMentions };
}

export function appendQuoteToDraftText<Draft extends { text: string }>(
  state: Draft,
  text: string,
): Draft {
  const quote = formatPromptQuote({ draftText: state.text, text });

  return quote === null ? state : { ...state, text: quote.text };
}

export function appendQuoteAndAttachmentsToDraft<
  Draft extends { text: string; attachments: readonly PromptDraftAttachment[] },
>(
  state: Draft,
  text: string,
  attachments: readonly PromptDraftAttachment[],
): Draft {
  return mergeDraftAttachments(
    appendQuoteToDraftText(state, text),
    attachments,
  );
}

export function appendStructuredQuoteToDraft(
  state: PromptDraftState,
  text: string,
  attachments: readonly PromptDraftAttachment[],
  mentions: readonly PromptTextMention[],
): PromptDraftState {
  const quote = formatPromptQuote({
    draftText: state.text,
    text,
    mentions,
    attachments: state.attachments,
  });

  const quotedState =
    quote === null
      ? state
      : {
          ...state,
          text: quote.text,
          mentions:
            quote.mentions.length === 0
              ? state.mentions
              : [...state.mentions, ...quote.mentions],
        };

  return mergeDraftAttachments(quotedState, attachments);
}

function mergeDraftAttachments<
  Draft extends { attachments: readonly PromptDraftAttachment[] },
>(state: Draft, attachments: readonly PromptDraftAttachment[]): Draft {
  if (attachments.length === 0) return state;

  const existingAttachmentPaths = new Set(
    state.attachments.map((attachment) => attachment.path),
  );

  const mergedAttachments = [...state.attachments];

  for (const attachment of attachments) {
    if (existingAttachmentPaths.has(attachment.path)) {
      continue;
    }

    existingAttachmentPaths.add(attachment.path);
    mergedAttachments.push(attachment);
  }

  if (mergedAttachments.length === state.attachments.length) {
    return state;
  }

  return { ...state, attachments: mergedAttachments };
}

export function isPromptDraftEmpty(draft: PromptDraftState): boolean {
  return (
    draft.text.length === 0 &&
    draft.mentions.length === 0 &&
    draft.attachments.length === 0
  );
}

export function parsePromptDraftStorage(
  rawValue: string | null,
): PromptDraftState {
  if (!rawValue) return emptyPromptDraftState();

  try {
    const parsed: unknown = JSON.parse(rawValue);
    const result = promptDraftStorageSchema.safeParse(parsed);

    return result.success ? result.data : emptyPromptDraftState();
  } catch {
    return emptyPromptDraftState();
  }
}

export function serializePromptDraftStorage(
  draft: PromptDraftState,
): string | null {
  const text = draft.text;
  const mentions = draft.mentions;
  const attachments = draft.attachments;

  if (isPromptDraftEmpty(draft)) {
    return null;
  }

  return JSON.stringify({
    text,
    ...(mentions.length > 0 ? { mentions } : {}),
    attachments,
    ...(draft.imageAliasHighWater === undefined
      ? {}
      : { imageAliasHighWater: draft.imageAliasHighWater }),
  });
}

function sortObjectKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function canonicalPromptDraftJson(draft: PromptDraftState): string {
  return JSON.stringify(
    {
      text: draft.text,
      mentions: draft.mentions,
      attachments: draft.attachments,
      imageAliasHighWater: draft.imageAliasHighWater,
    },
    sortObjectKeys,
  );
}

export function arePromptDraftStatesEqual(
  left: PromptDraftState,
  right: PromptDraftState,
): boolean {
  return canonicalPromptDraftJson(left) === canonicalPromptDraftJson(right);
}

function getFileNameFromPath(path: string): string {
  const trimmedPath = path.trim();

  if (trimmedPath.length === 0) {
    return "Attachment";
  }

  const segments = trimmedPath.split("/");
  const lastSegment = segments[segments.length - 1];

  return lastSegment && lastSegment.length > 0 ? lastSegment : trimmedPath;
}

export function normalizePromptTextMentions(
  mentions: readonly PromptTextMention[],
  textLength: number,
): PromptTextMention[] {
  return mentions
    .filter(
      (mention) =>
        mention.start >= 0 &&
        mention.end > mention.start &&
        mention.end <= textLength,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

export function promptImageAliasNumber(alias: string): number | null {
  const match = PROMPT_IMAGE_ALIAS_PATTERN.exec(alias);

  return match ? Number(match[1]) : null;
}

export function promptImageAnchorText(alias: string): string {
  return `[${alias}]`;
}

export function isPromptImageAnchorMention(
  mention: PromptTextMention,
  text: string,
): boolean {
  return (
    mention.resource.kind === "attachment" &&
    promptImageAliasNumber(mention.resource.label) !== null &&
    text.slice(mention.start, mention.end) ===
      promptImageAnchorText(mention.resource.label)
  );
}

export function nextPromptImageAlias({
  text,
  attachments,
  highWater = 0,
  reservedAliases = [],
}: {
  text: string;
  attachments: readonly PromptDraftAttachment[];
  highWater?: number;
  reservedAliases?: Iterable<string>;
}): string {
  let highest = highWater;

  const consider = (alias: string | undefined) => {
    const value = alias === undefined ? null : promptImageAliasNumber(alias);

    if (value !== null && value > highest) highest = value;
  };

  for (const attachment of attachments) consider(attachment.alias);

  for (const alias of reservedAliases) consider(alias);

  for (const match of text.matchAll(PROMPT_IMAGE_ALIAS_TEXT_PATTERN))
    consider(`Img${match[1]}`);

  return `Img${highest + 1}`;
}

function highestPromptImageAlias(
  draft: Pick<PromptDraftState, "text" | "attachments">,
): number {
  return (
    promptImageAliasNumber(
      nextPromptImageAlias({
        text: draft.text,
        attachments: draft.attachments,
      }),
    )! - 1
  );
}

export function withPromptImageAliasHighWater(
  previous: PromptDraftState | null,
  next: PromptDraftState,
): PromptDraftState {
  const highWater = Math.max(
    previous?.imageAliasHighWater ?? 0,
    previous ? highestPromptImageAlias(previous) : 0,
    next.imageAliasHighWater ?? 0,
    highestPromptImageAlias(next),
  );

  return highWater === 0 || highWater === next.imageAliasHighWater
    ? next
    : { ...next, imageAliasHighWater: highWater };
}

export type PromptImageAnchorBinding<
  Attachment extends PromptDraftAttachment = PromptDraftAttachment,
> =
  | { status: "bound"; attachment: Attachment }
  | { status: "ambiguous" }
  | { status: "missing" };

export function resolvePromptImageAnchor<
  Attachment extends PromptDraftAttachment,
>(
  attachments: readonly Attachment[],
  anchor: { path: string; label: string },
): PromptImageAnchorBinding<Attachment> {
  const images = attachments.filter(
    (attachment) =>
      attachment.type === "localImage" && attachment.path === anchor.path,
  );

  const aliased = images.filter(
    (attachment) => attachment.alias === anchor.label,
  );

  if (aliased.length === 1) return { status: "bound", attachment: aliased[0]! };

  if (aliased.length > 1) return { status: "ambiguous" };

  const unaliased = images.filter(
    (attachment) => attachment.alias === undefined,
  );

  if (unaliased.length === 1 && images.length === 1)
    return { status: "bound", attachment: unaliased[0]! };

  return images.length > 0 ? { status: "ambiguous" } : { status: "missing" };
}

export function hasAmbiguousPromptImageAnchors(
  draft: PromptDraftState,
): boolean {
  return draft.mentions.some(
    (mention) =>
      mention.resource.kind === "attachment" &&
      isPromptImageAnchorMention(mention, draft.text) &&
      resolvePromptImageAnchor(draft.attachments, mention.resource).status ===
        "ambiguous",
  );
}

export function isSamePromptDraftAttachment(
  left: PromptDraftAttachment,
  right: PromptDraftAttachment,
): boolean {
  return (
    left.path === right.path &&
    left.hostId === right.hostId &&
    left.sourceProjectId === right.sourceProjectId &&
    left.alias === right.alias
  );
}

function attachmentToInput(attachment: PromptDraftAttachment): PromptInput {
  if (attachment.type === "localImage") {
    return {
      type: "localImage",
      path: attachment.path,
      ...attachmentOwner(attachment),
    };
  }

  return {
    type: "localFile",
    path: attachment.path,
    ...attachmentOwner(attachment),
    name: attachment.name,
    ...(attachment.sizeBytes ? { sizeBytes: attachment.sizeBytes } : {}),
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
  };
}

export function promptDraftToInput(draft: PromptDraftState): PromptInput[] {
  const input: PromptInput[] = [];
  const emitted: PromptDraftAttachment[] = [];

  const trimStartLength = draft.text.length - draft.text.trimStart().length;
  const trimEndIndex = draft.text.trimEnd().length;
  const text = draft.text.slice(trimStartLength, trimEndIndex);

  if (text.length > 0) {
    const attachedPaths = new Set(
      draft.attachments.map((attachment) => attachment.path),
    );

    const mentions = normalizePromptTextMentions(
      draft.mentions.flatMap((mention) => {
        if (
          mention.resource.kind === "attachment" &&
          !attachedPaths.has(mention.resource.path)
        ) {
          return [];
        }

        const visibleStart = Math.max(mention.start, trimStartLength);
        const visibleEnd = Math.min(mention.end, trimEndIndex);

        return visibleStart < visibleEnd
          ? [
              {
                ...mention,
                start: visibleStart - trimStartLength,
                end: visibleEnd - trimStartLength,
              },
            ]
          : [];
      }),
      text.length,
    );

    const splits: { end: number; attachment: PromptDraftAttachment }[] = [];

    for (const mention of mentions) {
      if (
        mention.resource.kind !== "attachment" ||
        !isPromptImageAnchorMention(mention, text)
      ) {
        continue;
      }

      const binding = resolvePromptImageAnchor(
        draft.attachments,
        mention.resource,
      );

      if (
        binding.status !== "bound" ||
        splits.some(({ attachment }) => attachment === binding.attachment)
      ) {
        continue;
      }

      splits.push({ end: mention.end, attachment: binding.attachment });
    }

    let segmentStart = 0;

    const pushText = (end: number) => {
      if (end <= segmentStart) return;

      input.push({
        type: "text",
        text: text.slice(segmentStart, end),
        mentions: mentions
          .filter(
            (mention) => mention.start >= segmentStart && mention.end <= end,
          )
          .map((mention) => ({
            ...mention,
            start: mention.start - segmentStart,
            end: mention.end - segmentStart,
          })),
      });
      segmentStart = end;
    };

    for (const split of splits) {
      pushText(split.end);
      input.push(attachmentToInput(split.attachment));
      emitted.push(split.attachment);
    }

    pushText(text.length);
  }

  for (const attachment of draft.attachments) {
    if (emitted.includes(attachment)) continue;
    input.push(attachmentToInput(attachment));
  }

  return input;
}

function anchoredImageAlias(
  previous: PromptInput | undefined,
  image: Extract<PromptInput, { type: "localImage" }>,
): string | null {
  if (previous?.type !== "text") return null;

  const anchor = previous.mentions.find(
    (mention) =>
      mention.end === previous.text.length &&
      mention.resource.kind === "attachment" &&
      mention.resource.path === image.path &&
      isPromptImageAnchorMention(mention, previous.text),
  );

  return anchor?.resource.kind === "attachment" ? anchor.resource.label : null;
}

function anchoredPromptInputToDraft(
  input: readonly PromptInput[],
  aliases: ReadonlyMap<number, string>,
): PromptDraftState {
  let text = "";
  const mentions: PromptTextMention[] = [];
  const attachments: PromptDraftState["attachments"] = [];

  input.forEach((chunk, index) => {
    if (chunk.type === "text") {
      for (const mention of chunk.mentions) {
        if (
          mention.start >= 0 &&
          mention.end > mention.start &&
          mention.end <= chunk.text.length
        ) {
          mentions.push({
            ...mention,
            start: text.length + mention.start,
            end: text.length + mention.end,
          });
        }
      }

      text += chunk.text;

      return;
    }

    if (chunk.type === "localImage") {
      const alias = aliases.get(index);

      const attachment: PromptDraftAttachment = {
        type: "localImage",
        path: chunk.path,
        ...attachmentOwner(chunk),
        name: getFileNameFromPath(chunk.path),
        ...(alias === undefined ? {} : { alias }),
      };

      if (
        !attachments.some((existing) =>
          isSamePromptDraftAttachment(existing, attachment),
        )
      )
        attachments.push(attachment);

      return;
    }

    if (chunk.type === "localFile") attachments.push(localFileDraft(chunk));
  });

  return { text, mentions, attachments };
}

function localFileDraft(
  chunk: Extract<PromptInput, { type: "localFile" }>,
): PromptDraftAttachment {
  return {
    type: "localFile",
    path: chunk.path,
    ...attachmentOwner(chunk),
    name: chunk.name ?? getFileNameFromPath(chunk.path),
    ...(chunk.sizeBytes === undefined ? {} : { sizeBytes: chunk.sizeBytes }),
    ...(chunk.mimeType ? { mimeType: chunk.mimeType } : {}),
  };
}

export function promptInputToDraft(
  input: readonly PromptInput[],
): PromptDraftState {
  const aliases = new Map<number, string>();

  input.forEach((chunk, index) => {
    if (chunk.type !== "localImage") return;
    const alias = anchoredImageAlias(input[index - 1], chunk);

    if (alias !== null) aliases.set(index, alias);
  });

  if (aliases.size > 0)
    return withPromptImageAliasHighWater(
      null,
      anchoredPromptInputToDraft(input, aliases),
    );

  const textSegments: string[] = [];
  const mentions: PromptTextMention[] = [];
  const attachments: PromptDraftState["attachments"] = [];
  let textOffset = 0;

  for (const chunk of input) {
    if (chunk.type === "text") {
      if (chunk.text.trim().length > 0) {
        if (textSegments.length > 0) {
          textOffset += 2;
        }

        for (const mention of chunk.mentions) {
          if (
            mention.start >= 0 &&
            mention.end > mention.start &&
            mention.end <= chunk.text.length
          ) {
            mentions.push({
              ...mention,
              start: textOffset + mention.start,
              end: textOffset + mention.end,
            });
          }
        }

        textSegments.push(chunk.text);
        textOffset += chunk.text.length;
      }

      continue;
    }

    if (chunk.type === "localImage") {
      attachments.push({
        type: "localImage",
        path: chunk.path,
        ...attachmentOwner(chunk),
        name: getFileNameFromPath(chunk.path),
      });
      continue;
    }

    if (chunk.type === "localFile") attachments.push(localFileDraft(chunk));
  }

  return {
    text: textSegments.join("\n\n"),
    mentions,
    attachments,
  };
}

export function getProjectStoredPromptAttachmentPaths(
  attachments: readonly PromptDraftAttachment[],
): string[] {
  return [
    ...new Set(
      attachments.flatMap((attachment) => {
        if (attachment.sourceProjectId !== undefined) return [];
        const path = attachment.path;

        const isRuntimeReadable =
          /^[\\/]/u.test(path) ||
          /^[a-zA-Z]:[\\/]/u.test(path) ||
          /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(path);

        return isRuntimeReadable ? [] : [path];
      }),
    ),
  ];
}
