import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Icon } from "./icon";
import { CONTROL_HOVER_TRANSITION } from "./motion";

export interface ChosenFile {
  name: string;
  size: number;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function matchesAccept(file: File, accept: string | undefined): boolean {
  if (accept === undefined || accept.trim() === "") return true;

  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();

  return accept
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "")
    .some((entry) => {
      if (entry.startsWith(".")) return name.endsWith(entry);

      if (entry.endsWith("/*")) return type.startsWith(entry.slice(0, -1));

      return type === entry;
    });
}

export function FileDropZone({
  accept,
  maxBytes,
  file,
  onFileSelect,
  onFileReject,
  onClear,
  disabled = false,
  busy = false,
  title = "Drop a file here",
  hint,
  className,
}: {
  accept?: string;
  maxBytes?: number;
  file: ChosenFile | null;
  onFileSelect: (file: File) => void;
  onFileReject?: (message: string) => void;
  onClear?: () => void;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  hint?: string;
  className?: string;
}) {
  const inputId = useId();
  const hintId = useId();
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const inactive = disabled || busy;

  const take = (candidate: File | undefined) => {
    if (candidate === undefined) return;

    if (!matchesAccept(candidate, accept)) {
      onFileReject?.(
        `${candidate.name} is not a supported file. Choose a ${accept} file.`,
      );

      return;
    }

    if (maxBytes !== undefined && candidate.size > maxBytes) {
      onFileReject?.(
        `${candidate.name} is ${formatFileSize(candidate.size)}. Choose a file no larger than ${formatFileSize(maxBytes)}.`,
      );

      return;
    }

    onFileSelect(candidate);
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    take(event.currentTarget.files?.[0]);
    event.currentTarget.value = "";
  };

  const onDragEnter = (event: DragEvent<HTMLElement>) => {
    if (inactive || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (inactive || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);

    if (dragDepth.current === 0) setDragging(false);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (inactive) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    take(event.dataTransfer.files[0]);
  };

  if (file !== null) {
    return (
      <div
        className={cn(
          "flex min-w-0 items-center gap-3 rounded-lg border border-border bg-surface-raised px-3 py-2.5 shadow-control",
          className,
        )}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-state-hover text-muted-foreground">
          <Icon
            name={busy ? "Spinner" : "FileText"}
            aria-hidden="true"
            className={cn("size-4", busy && "animate-spin")}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {file.name}
          </span>
          <span className="block text-xs text-subtle-foreground">
            {busy ? "Checking…" : formatFileSize(file.size)}
          </span>
        </span>
        {onClear === undefined ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label={`Remove ${file.name}`}
            onClick={onClear}
            className="text-muted-foreground"
          >
            <Icon name="X" aria-hidden="true" />
          </Button>
        )}
      </div>
    );
  }

  return (
    <label
      htmlFor={inputId}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-dragging={dragging ? "true" : undefined}
      className={cn(
        "group/drop flex min-w-0 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-[1.5px] border-dashed border-border bg-surface-raised px-4 py-6 text-center hover:border-input hover:bg-state-hover has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring/60 data-[dragging=true]:border-foreground/50 data-[dragging=true]:bg-state-active",
        CONTROL_HOVER_TRANSITION,
        inactive && "pointer-events-none opacity-60",
        className,
      )}
    >
      <input
        id={inputId}
        type="file"
        accept={accept}
        disabled={inactive}
        aria-describedby={hint === undefined ? undefined : hintId}
        onChange={onChange}
        className="sr-only"
      />
      <span className="grid size-9 place-items-center rounded-full bg-background text-muted-foreground shadow-control ring-1 ring-border group-data-[dragging=true]/drop:text-foreground">
        <Icon name="Download" aria-hidden="true" className="size-4" />
      </span>
      <span className="text-sm font-medium text-foreground">
        {dragging ? "Release to add the file" : title}
      </span>
      <span className="text-xs text-muted-foreground">
        or{" "}
        <span className="font-medium text-foreground underline decoration-border underline-offset-2 group-hover/drop:decoration-foreground">
          choose a file
        </span>
      </span>
      {hint === undefined ? null : (
        <span id={hintId} className="text-xs text-subtle-foreground">
          {hint}
        </span>
      )}
    </label>
  );
}
