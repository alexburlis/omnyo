import { cn } from "@/lib/utils";
import { formatCount, type GitTally } from "./model";

export function DiffTally({
  tally,
  className,
}: {
  tally: GitTally;
  className?: string;
}) {
  if (tally.insertions === 0 && tally.deletions === 0) return null;

  return (
    <span
      className={cn("shrink-0 whitespace-nowrap tabular-nums", className)}
      title={tally.complete ? undefined : "Some files have no line counts"}
    >
      {tally.insertions > 0 ? (
        <span className="text-diff-added">
          +{formatCount(tally.insertions)}
        </span>
      ) : null}
      {tally.insertions > 0 && tally.deletions > 0 ? " " : null}
      {tally.deletions > 0 ? (
        <span className="text-diff-removed">
          −{formatCount(tally.deletions)}
        </span>
      ) : null}
    </span>
  );
}
