import type {
  ComposerDraftSnapshot,
  ComposerMention,
  ComposerDraftReplacement,
} from "@omnyo/plugin-sdk/app";
import type { InstalledSource } from "./library-view";

export function nativeSkillMention(source: InstalledSource, trigger: "/" | "$"): ComposerMention {
  return {
    kind: "command",
    from: 0,
    to: 0,
    label: source.name,
    name: source.name,
    source: "skill",
    origin:
      source.scope === "omnyo-builtin" || source.scope === "plugin"
        ? "builtin"
        : source.scope.endsWith("user")
          ? "user"
          : "project",
    trigger,
    argumentHint: null,
  };
}

export function replaceSkillMention(
  draft: ComposerDraftSnapshot,
  previous: ComposerMention,
  next: ComposerMention,
): ComposerDraftReplacement {
  const active = draft.mentions.find((mention) => mention === previous);

  if (!active) return draft;
  const text = next.kind === "command" ? `${next.trigger}${next.name}` : `@${next.label}`;
  const delta = text.length - (active.to - active.from);

  const mentions = draft.mentions.map((mention) =>
    mention === active
      ? { ...next, from: active.from, to: active.from + text.length }
      : mention.from >= active.to
        ? { ...mention, from: mention.from + delta, to: mention.to + delta }
        : mention,
  );

  return { text: draft.text.slice(0, active.from) + text + draft.text.slice(active.to), mentions };
}

export function sameSkillPath(left: string, right: string) {
  return (
    left.replaceAll("\\", "/").replace(/\/$/u, "") ===
    right.replaceAll("\\", "/").replace(/\/$/u, "")
  );
}
