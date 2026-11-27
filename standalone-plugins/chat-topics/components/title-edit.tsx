import { useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, useSdk } from "@omnyo/plugin-sdk/app";
import type { PluginSidebarThread } from "@omnyo/plugin-sdk/app";

interface TitleEdit {
  original: string;
  value: string;
  error: string | null;
}

export interface InlineTitleEdit {
  isEditing: boolean;
  error: string | null;
  start: () => void;
  editor: ReactNode;
}

interface InlineTextEditOptions {
  read: () => string | null;
  commit: (value: string) => Promise<void>;
  label: string;
  emptyError: string;
  failure: string | null;
  className: string;
}

export function useInlineTextEdit({
  read,
  commit,
  label,
  emptyError,
  failure: failureText,
  className,
}: InlineTextEditOptions): InlineTitleEdit {
  const [edit, setEdit] = useState<TitleEdit | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const editRef = useRef<TitleEdit | null>(null);
  const attempt = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const isEditing = edit !== null;

  const update = (next: TitleEdit | null) => {
    editRef.current = next;
    setEdit(next);
  };

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const start = () => {
    const value = read();

    if (value === null || editRef.current !== null) return;
    setFailure(null);
    update({ original: value, value, error: null });
  };

  const save = () => {
    const current = editRef.current;

    if (current === null) return;
    const value = current.value.trim();

    if (value === "") {
      update({ ...current, error: emptyError });

      return;
    }

    update(null);

    if (value === current.original.trim()) return;
    attempt.current += 1;
    const sent = attempt.current;

    commit(value).catch(() => {
      if (attempt.current === sent) setFailure(failureText);
    });
  };

  const editor =
    edit === null ? null : (
      <input
        ref={inputRef}
        className={className}
        data-sidebar-rename-editor=""
        aria-label={label}
        aria-invalid={edit.error !== null}
        value={edit.value}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onChange={(event) => {
          const current = editRef.current;

          if (current !== null)
            update({ ...current, value: event.currentTarget.value, error: null });
        }}
        onBlur={save}
        onKeyDown={(event) => {
          event.stopPropagation();

          if (event.key === "Escape") {
            event.preventDefault();
            update(null);
          } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            save();
          }
        }}
      />
    );

  return { isEditing, error: edit?.error ?? failure, start, editor };
}

export function useInlineTitleEdit(
  thread: PluginSidebarThread | undefined,
  className = "ct-row-title-input",
): InlineTitleEdit {
  const sdk = useSdk();

  return useInlineTextEdit({
    read: () => (thread === undefined ? null : (thread.title ?? thread.displayTitle)),
    commit: async (title) => {
      if (thread !== undefined) await sdk.threads.update({ threadId: thread.id, title });
    },
    label: "Chat title",
    emptyError: "Enter a chat title.",
    failure: "Could not rename the chat.",
    className,
  });
}

export function RenameAlert({ edit }: { edit: InlineTitleEdit }) {
  if (edit.isEditing || edit.error === null) return null;

  return (
    <span role="alert" className="ct-row-alert" title={edit.error} aria-label={edit.error}>
      <Icon name="AlertCircle" className="size-3.5" />
    </span>
  );
}
