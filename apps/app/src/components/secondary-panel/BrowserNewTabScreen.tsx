import { Button } from "@omnyo/shared-ui/button";
import { COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { getBrowserUrlHost } from "@/lib/browser-url";
import { formatRelativeTime } from "@/lib/relative-time";
import type { BrowserHistoryEntry } from "@/lib/browser-history";
import { BrowserStatePage } from "./BrowserStatePage";
import {
  LAUNCHER_ROW_BASE_CLASS,
  LAUNCHER_ROW_ICON_CLASS,
  LauncherRowTrailing,
  LauncherSectionHeader,
} from "./launcherRow";

interface BrowserNewTabScreenProps {
  onNavigateInput: (rawInput: string) => void;
  recent: readonly BrowserHistoryEntry[];
  onClearRecent: () => void;
  onFocusAddress: () => void;
  showStartPrompt: boolean;
}

interface BrowserRecentRowProps {
  entry: BrowserHistoryEntry;
  now: number;
  onNavigate: (url: string) => void;
}

function BrowserRecentRow({ entry, now, onNavigate }: BrowserRecentRowProps) {
  const host = getBrowserUrlHost(entry.url);
  const title = entry.title?.trim();
  const primary = title && title.length > 0 ? title : host;
  const relativeTime = formatRelativeTime({ timestamp: entry.visitedAt, now });

  return (
    <button
      type="button"
      onClick={() => onNavigate(entry.url)}
      title={entry.url}
      className={cn(LAUNCHER_ROW_BASE_CLASS, "hover:bg-state-hover")}
    >
      <span className={LAUNCHER_ROW_ICON_CLASS}>
        <Icon
          name="Browser"
          className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
          aria-hidden
        />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-foreground">{primary}</span>
        {primary !== host ? (
          <span className="truncate font-mono text-muted-foreground [flex-shrink:9999]">
            {host}
          </span>
        ) : null}
      </span>
      <LauncherRowTrailing idle={relativeTime} isActive={false} />
    </button>
  );
}

export function BrowserNewTabScreen({
  onNavigateInput,
  recent,
  onClearRecent,
  onFocusAddress,
  showStartPrompt,
}: BrowserNewTabScreenProps) {
  const now = Date.now();

  if (recent.length === 0) {
    return showStartPrompt ? (
      <BrowserStatePage
        icon="Globe"
        title="Open a web page"
        description="Type an address or a search in the bar above. Local servers such as localhost:5173 open here too."
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onFocusAddress}
          >
            <Icon name="Search" aria-hidden />
            Enter an address
          </Button>
        }
      />
    ) : null;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 pb-6 pt-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <section>
          <LauncherSectionHeader
            label="Recently visited"
            count={recent.length}
            action={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onClearRecent}
                aria-label="Clear recently visited"
                className="-my-1 self-center text-muted-foreground"
              >
                Clear
              </Button>
            }
          />
          <ul aria-label="Recently visited" className="flex flex-col gap-px">
            {recent.map((entry) => (
              <li key={entry.url}>
                <BrowserRecentRow
                  entry={entry}
                  now={now}
                  onNavigate={onNavigateInput}
                />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
