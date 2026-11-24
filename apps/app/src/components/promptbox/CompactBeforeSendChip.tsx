import { Button } from "@omnyo/shared-ui/button";
import { COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { Switch } from "@omnyo/shared-ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { formatCompactTokenCount } from "@/components/thread/timeline/thread-context-window-usage";
import { PromptStackCard } from "./banner/PromptStackCard";

export interface CompactBeforeSendOffer {
  compactFirst: boolean;
  onCompactFirstChange: (compactFirst: boolean) => void;
  tokens: number;
}

export interface AutoCompactionOffer {
  at: number;
  keepFullHistory: boolean;
  pending: boolean;
  onKeepFullHistoryChange: (keepFullHistory: boolean) => void;
}

const PILL_CLASS = "rounded-full border";

const COMPACT_TONE_CLASS =
  "border-warning/20 bg-warning/5 text-warning-text hover:bg-warning/10 hover:text-warning-text aria-pressed:bg-warning/5 aria-pressed:text-warning-text aria-pressed:hover:bg-warning/10 data-[state=open]:bg-warning/10 data-[state=open]:text-warning-text";

const KEEP_TONE_CLASS =
  "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground";

export function CompactBeforeSendChip({
  compactFirst,
  onCompactFirstChange,
  tokens,
}: CompactBeforeSendOffer) {
  const tokensLabel = formatCompactTokenCount(tokens);

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-pressed={compactFirst}
            aria-label={
              compactFirst
                ? `Compact ${tokensLabel} tokens before sending`
                : `Keep all ${tokensLabel} tokens of history`
            }
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onCompactFirstChange(!compactFirst)}
            className={cn(
              COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
              PILL_CLASS,
              "gap-1.5 [&_[data-icon-root]]:size-3.5",
              compactFirst ? COMPACT_TONE_CLASS : KEEP_TONE_CLASS,
            )}
          >
            <Icon name="CircleArrowShrink" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {compactFirst
            ? `The prompt cache expired. The next send compacts ${tokensLabel} tokens first. Click to keep full history`
            : `The next send keeps all ${tokensLabel} tokens. Click to compact first`}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function CompactBeforeSendNotice({
  tokens,
  onCompactFirstChange,
}: Pick<CompactBeforeSendOffer, "tokens" | "onCompactFirstChange">) {
  return (
    <PromptStackCard ariaLabel="Compact before sending">
      <div className="flex min-h-8 items-center gap-1.5 py-0.5 pr-1 pl-3 text-xs">
        <Icon
          name="CircleArrowShrink"
          className="size-3.5 shrink-0 text-subtle-foreground"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {`Next send compacts ${formatCompactTokenCount(tokens)} tokens`}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 max-md:pointer-coarse:h-9"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCompactFirstChange(false)}
        >
          Keep history
        </Button>
      </div>
    </PromptStackCard>
  );
}

export function formatAutoCompactionTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function AutoCompactionChip({
  at,
  keepFullHistory,
  pending,
  onKeepFullHistoryChange,
}: AutoCompactionOffer) {
  return (
    <span
      data-auto-compaction-chip=""
      className="flex min-w-0 items-center gap-1.5 px-1 text-2xs text-subtle-foreground"
    >
      <Icon name="CircleArrowShrink" className="size-3 shrink-0" aria-hidden />
      {keepFullHistory ? null : (
        <>
          <span className="min-w-0 truncate">
            {`Compacts automatically at ${formatAutoCompactionTime(at)}`}
          </span>
          <span aria-hidden className="shrink-0">
            ·
          </span>
        </>
      )}
      <label className="flex shrink-0 cursor-pointer items-center gap-1">
        <span>Keep full history</span>
        <Switch
          checked={keepFullHistory}
          disabled={pending}
          onMouseDown={(event) => event.preventDefault()}
          onCheckedChange={onKeepFullHistoryChange}
        />
      </label>
    </span>
  );
}
