import { Skeleton } from "@omnyo/shared-ui/skeleton";
import { defineSplit, SplitLoadFailure } from "@/lib/define-split";
import type { LauncherComposerProps } from "./LauncherComposer";

function LauncherComposerPlaceholder({
  retry,
}: LauncherComposerProps & { retry?: () => void }) {
  if (retry) return <SplitLoadFailure retry={retry} />;

  return (
    <div
      role="status"
      aria-label="Loading new chat"
      className="flex flex-col gap-3 p-4"
    >
      <Skeleton className="h-12 w-full rounded-xl" />
      <div className="grid grid-cols-6 gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-14 rounded-xl" />
        ))}
      </div>
      <Skeleton className="mx-auto h-8 w-2/3 rounded-lg" />
    </div>
  );
}

export const LazyLauncherComposer = defineSplit<LauncherComposerProps>({
  id: "new-chat-launcher-composer",
  load: () =>
    import("./LauncherComposer").then((module) => module.LauncherComposer),
  loading: LauncherComposerPlaceholder,
  error: LauncherComposerPlaceholder,
});
