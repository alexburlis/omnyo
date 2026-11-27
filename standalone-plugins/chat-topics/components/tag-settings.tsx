import { useEffect, useState, type KeyboardEvent } from "react";
import { experimental_Icon as Icon, useRpc } from "@omnyo/plugin-sdk/app";
import type { rpcContract } from "../lib/contract.ts";
import { MAX_TAGS, type Tag, type TagPatch } from "../lib/tags.ts";
import { useTagList } from "../lib/use-tags.ts";

interface TagDraft {
  icon: string;
  label: string;
  description: string;
}

const EMPTY_DRAFT: TagDraft = { icon: "", label: "", description: "" };

function slugOf(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 24)
    .replace(/-+$/u, "");
}

function draftOf(tag: Tag): TagDraft {
  return { icon: tag.icon, label: tag.label, description: tag.description };
}

function changes(tag: Tag, draft: TagDraft): TagPatch | null {
  const patch: TagPatch = {};

  if (draft.icon !== tag.icon) patch.icon = draft.icon;

  if (draft.label !== tag.label) patch.label = draft.label;

  if (draft.description !== tag.description) patch.description = draft.description;

  return Object.keys(patch).length === 0 ? null : patch;
}

interface TagFieldsProps {
  draft: TagDraft;
  name: string;
  disabled: boolean;
  onChange: (draft: TagDraft) => void;
  onCommit: () => void;
}

function TagFields({ draft, name, disabled, onChange, onCommit }: TagFieldsProps) {
  const commitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onCommit();
    }
  };

  return (
    <>
      <input
        className="ct-tags-input ct-tags-icon"
        aria-label={`Icon for ${name}`}
        placeholder="Bug or 🏷️"
        title="An Omnyo icon name, such as Bug, or an emoji"
        maxLength={16}
        value={draft.icon}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, icon: event.currentTarget.value })}
        onKeyDown={commitOnEnter}
      />
      <input
        className="ct-tags-input"
        aria-label={`Label for ${name}`}
        placeholder="Label"
        maxLength={24}
        value={draft.label}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, label: event.currentTarget.value })}
        onKeyDown={commitOnEnter}
      />
      <input
        className="ct-tags-input"
        aria-label={`Meaning of ${name}`}
        placeholder="What it covers, for the agent"
        maxLength={80}
        value={draft.description}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, description: event.currentTarget.value })}
        onKeyDown={commitOnEnter}
      />
    </>
  );
}

interface TagRowProps {
  tag: Tag;
  index: number;
  count: number;
  busy: boolean;
  onUpdate: (id: string, patch: TagPatch) => void;
  onMove: (id: string, index: number) => void;
  onRemove: (id: string) => void;
}

function TagRow({ tag, index, count, busy, onUpdate, onMove, onRemove }: TagRowProps) {
  const [draft, setDraft] = useState(() => draftOf(tag));

  useEffect(() => setDraft(draftOf(tag)), [tag]);

  const commit = () => {
    const patch = changes(tag, draft);

    if (patch !== null) onUpdate(tag.id, patch);
  };

  return (
    <li
      className="ct-tags-row"
      data-tag={tag.id}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) commit();
      }}
    >
      <TagFields
        draft={draft}
        name={tag.label}
        disabled={busy}
        onChange={setDraft}
        onCommit={commit}
      />
      <code className="ct-tags-id" title="Id for the CLI and the agent">
        {tag.id}
      </code>
      <span className="ct-tags-actions">
        <button
          type="button"
          className="ct-tags-button"
          aria-label={`Move ${tag.label} up`}
          disabled={busy || index === 0}
          onClick={() => onMove(tag.id, index - 1)}
        >
          <Icon name="ArrowUp" aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          className="ct-tags-button"
          aria-label={`Move ${tag.label} down`}
          disabled={busy || index === count - 1}
          onClick={() => onMove(tag.id, index + 1)}
        >
          <Icon name="ArrowDown" aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          className="ct-tags-button"
          aria-label={`Delete ${tag.label}`}
          title="Delete. Its chats become untagged."
          disabled={busy}
          onClick={() => onRemove(tag.id)}
        >
          <Icon name="Trash2" aria-hidden className="size-3.5" />
        </button>
      </span>
    </li>
  );
}

export function TagSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const { tags, failed, replace } = useTagList();
  const [draft, setDraft] = useState<TagDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (work: () => Promise<{ tags: Tag[] }>): Promise<boolean> => {
    setBusy(true);
    setError(null);

    try {
      replace((await work()).tags);

      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the tags.");

      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const id = slugOf(draft.label);

    if (id === "") {
      setError("Use a label with letters or digits.");

      return;
    }

    if (await save(() => rpc.call("tags.add", { id, ...draft }))) setDraft(EMPTY_DRAFT);
  };

  const full = tags.length >= MAX_TAGS;

  return (
    <div className="ct-tags">
      <p className="ct-tags-hint">
        Tags name a chat's type of work. A new chat's agent picks one; you can change it from a
        chat's menu.
      </p>
      {failed ? (
        <p role="alert" className="ct-tags-error">
          Could not load the tags. Reload Omnyo to try again.
        </p>
      ) : null}
      <ol className="ct-tags-list" aria-label="Tags">
        {tags.map((tag, index) => (
          <TagRow
            key={tag.id}
            tag={tag}
            index={index}
            count={tags.length}
            busy={busy}
            onUpdate={(id, patch) => void save(() => rpc.call("tags.update", { id, patch }))}
            onMove={(id, to) => void save(() => rpc.call("tags.move", { id, index: to }))}
            onRemove={(id) => void save(() => rpc.call("tags.remove", { id }))}
          />
        ))}
      </ol>
      <form
        className="ct-tags-row ct-tags-new"
        aria-label="New tag"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <TagFields
          draft={draft}
          name="the new tag"
          disabled={busy || full}
          onChange={setDraft}
          onCommit={() => void add()}
        />
        <button
          type="submit"
          className="ct-tags-add"
          disabled={busy || full || draft.label.trim() === "" || draft.icon.trim() === ""}
        >
          <Icon name="Plus" aria-hidden className="size-3.5" />
          Add tag
        </button>
      </form>
      {error === null ? null : (
        <p role="alert" className="ct-tags-error">
          {error}
        </p>
      )}
    </div>
  );
}
