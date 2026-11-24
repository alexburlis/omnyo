import { useRef } from "react";
import type { Thread } from "@omnyo/domain";
import { Button } from "@omnyo/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@omnyo/shared-ui/dialog";
import { formatChildThreadCount } from "@/lib/child-thread-copy";

const INSTANT_CLOSE_CLASS_NAME = "data-[state=closed]:animate-none!";

export interface ThreadArchiveDialogTarget {
  thread: Thread;
  childThreadCount: number;
}

interface ThreadArchiveDialogProps {
  target: ThreadArchiveDialogTarget | null;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive: (target: ThreadArchiveDialogTarget) => void;
}

export function ThreadArchiveDialog({
  target,
  pending = false,
  onOpenChange,
  onArchive,
}: ThreadArchiveDialogProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        className={INSTANT_CLOSE_CLASS_NAME}
        overlayClassName={INSTANT_CLOSE_CLASS_NAME}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current
            ?.querySelector<HTMLButtonElement>('button[type="submit"]')
            ?.focus();
        }}
      >
        {target ? (
          <ThreadArchiveDialogContent
            target={target}
            pending={pending}
            onOpenChange={onOpenChange}
            onArchive={onArchive}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface ThreadArchiveDialogContentProps {
  target: ThreadArchiveDialogTarget;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive: (target: ThreadArchiveDialogTarget) => void;
}

export function ThreadArchiveDialogContent({
  target,
  pending,
  onOpenChange,
  onArchive,
}: ThreadArchiveDialogContentProps) {
  const { childThreadCount } = target;

  const active =
    target.thread.status === "starting" ||
    target.thread.status === "active" ||
    target.thread.status === "stopping";

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();

        if (!pending) {
          onArchive(target);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>Archive thread?</DialogTitle>
        <DialogDescription>
          {active ? "This will stop current work. " : null}
          Its{" "}
          <span className="font-semibold">
            {formatChildThreadCount(childThreadCount)}
          </span>{" "}
          will be archived too. Archived threads stay available and can be
          unarchived.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          Archive
        </Button>
      </DialogFooter>
    </form>
  );
}
