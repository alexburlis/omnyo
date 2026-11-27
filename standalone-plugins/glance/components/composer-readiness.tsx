import {
  experimental_useThreadWork,
  experimental_useSidebarThreads,
  useComposer,
} from "@omnyo/plugin-sdk/app";
import { useInboxStates } from "./inbox-views";
import { ArchiveRow } from "./companion";
import { useReadiness } from "./readiness";
import { useCompactViewport } from "./viewport";

function ReadinessBadge({ threadId }: { threadId: string }) {
  const readiness = useReadiness(threadId);
  const work = experimental_useThreadWork(threadId);
  const serverView = useInboxStates().get(threadId);
  const { threads } = experimental_useSidebarThreads();
  const thread = threads.find((entry) => entry.id === threadId);

  if (
    readiness !== "ready" ||
    thread === undefined ||
    thread.isArchived ||
    serverView?.archiveReady === false
  )
    return null;

  return (
    <ArchiveRow
      thread={thread}
      className="mb-2 w-full"
      reason={work?.primary.label === "ready-to-archive" ? work.primary.reason.text : undefined}
    />
  );
}

export function ComposerReadiness() {
  const composer = useComposer();
  const compact = useCompactViewport();

  return !compact && composer.scope.kind === "thread" ? (
    <ReadinessBadge key={composer.scope.threadId} threadId={composer.scope.threadId} />
  ) : null;
}
