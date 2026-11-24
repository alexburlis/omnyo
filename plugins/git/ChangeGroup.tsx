import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Icon } from "@/components/ui/icon";
import { DISCLOSURE_CHEVRON_TRANSITION } from "@/components/ui/motion";
import { DiffTally } from "./DiffTally";
import { FileRow } from "./FileRow";
import { pluralize, type GitChangeGroup, type GitFileRow } from "./model";

export function ChangeGroup({
  group,
  detail,
  onOpenFile,
  onOpenDiffPanel,
}: {
  group: GitChangeGroup;
  detail: string;
  onOpenFile: (file: GitFileRow) => void;
  onOpenDiffPanel: () => void;
}) {
  return (
    <Collapsible defaultOpen={group.defaultOpen}>
      <CollapsibleTrigger className="group/change-group flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none">
        <Icon
          name="ChevronRight"
          aria-hidden="true"
          className={`size-3 shrink-0 text-subtle-foreground group-data-[state=open]/change-group:rotate-90 ${DISCLOSURE_CHEVRON_TRANSITION}`}
        />
        <span className="shrink-0 font-medium text-foreground">
          {group.label}
        </span>
        <span className="min-w-0 truncate text-subtle-foreground tabular-nums">
          {detail}
        </span>
        <DiffTally tally={group.tally} className="ml-auto" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-1">
        {group.commits.length > 0 ? (
          <ol className="mb-1 ml-5 border-l border-border/70 py-0.5 pl-2">
            {group.commits.map((commit) => (
              <li
                key={commit.sha}
                className="flex min-w-0 items-baseline gap-2 py-0.5 text-xs"
                title={`${commit.subject} (${commit.authorName})`}
              >
                <span className="shrink-0 font-mono text-2xs text-subtle-foreground">
                  {commit.shortSha}
                </span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {commit.subject}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        <ul>
          {group.files.map((file) => (
            <li key={file.path}>
              <FileRow file={file} onOpen={onOpenFile} />
            </li>
          ))}
        </ul>
        {group.hiddenFileCount > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onOpenDiffPanel}
            className="mt-0.5 ml-5 text-muted-foreground"
          >
            {pluralize(group.hiddenFileCount, "more file", "more files")}
            <Icon name="ArrowRight" aria-hidden="true" className="size-3" />
          </Button>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
