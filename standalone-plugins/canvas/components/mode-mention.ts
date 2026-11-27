import type { ComposerMention, PluginComposerApi } from "@omnyo/plugin-sdk/app";
import { mentionProvider } from "../contract";

export function hasModeMention(mentions: readonly ComposerMention[], pluginId: string): boolean {
  return mentions.some((mention) => isModeMention(mention, pluginId));
}

function isModeMention(mention: ComposerMention, pluginId: string): boolean {
  return (
    mention.kind === "plugin" &&
    mention.pluginId === pluginId &&
    mention.provider === mentionProvider.provider &&
    mention.id === mentionProvider.id
  );
}

type DraftPart = { kind: "text"; text: string } | { kind: "mention"; mention: ComposerMention };

function insertable(part: DraftPart): string | ComposerMention {
  return part.kind === "text" ? part.text : part.mention;
}

function draftParts(text: string, mentions: readonly ComposerMention[]): DraftPart[] {
  const parts: DraftPart[] = [];

  let cursor = 0;

  for (const mention of [...mentions].sort((a, b) => a.from - b.from)) {
    if (mention.from > cursor) parts.push({ kind: "text", text: text.slice(cursor, mention.from) });
    parts.push({ kind: "mention", mention });
    cursor = mention.to;
  }

  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });

  return parts;
}

export function addModeMention(composer: PluginComposerApi, pluginId: string): void {
  const { text, mentions } = composer.draft;

  if (hasModeMention(mentions, pluginId)) return;

  const parts = draftParts(text, mentions);

  composer.replace({ text: "", mentions: [] });
  composer.insert(
    [{ ...mentionProvider }, text.startsWith(" ") ? "" : " ", ...parts.map(insertable)],
    { at: "end" },
  );
}

export function removeModeMention(composer: PluginComposerApi, pluginId: string): void {
  const { text, mentions } = composer.draft;

  if (!hasModeMention(mentions, pluginId)) return;

  const kept: DraftPart[] = [];

  let afterPill = false;

  for (const part of draftParts(text, mentions)) {
    if (part.kind === "mention" && isModeMention(part.mention, pluginId)) {
      afterPill = true;
      continue;
    }

    const rest = afterPill && part.kind === "text" ? part.text.replace(/^ /u, "") : null;

    afterPill = false;

    if (rest === null) kept.push(part);
    else if (rest !== "") kept.push({ kind: "text", text: rest });
  }

  composer.replace({ text: "", mentions: [] });

  if (kept.length > 0) composer.insert(kept.map(insertable), { at: "end" });
}
