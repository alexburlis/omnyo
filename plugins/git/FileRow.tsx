import { cn } from "@/lib/utils";
import { DiffTally } from "./DiffTally";
import { GIT_TONE_TEXT_CLASS, type GitFileRow } from "./model";

export function FileRow({
  file,
  onOpen,
}: {
  file: GitFileRow;
  onOpen: (file: GitFileRow) => void;
}) {
  return (
    <button
      type="button"
      title={`${file.status.label} · ${file.path}`}
      aria-label={`${file.status.label}: ${file.path}`}
      onClick={() => onOpen(file)}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded bg-state-hover font-mono text-2xs font-semibold",
          GIT_TONE_TEXT_CLASS[file.status.tone],
        )}
      >
        {file.status.letter}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="max-w-full shrink-0 truncate text-foreground">
          {file.basename}
        </span>
        {file.directory ? (
          <span className="min-w-0 truncate text-subtle-foreground">
            {file.directory}
          </span>
        ) : null}
      </span>
      {file.insertions !== null && file.deletions !== null ? (
        <DiffTally
          tally={{
            insertions: file.insertions,
            deletions: file.deletions,
            complete: true,
          }}
        />
      ) : null}
    </button>
  );
}
