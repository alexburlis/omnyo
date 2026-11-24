import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";

interface PickerEmptyStateProps {
  icon: IconName;
  message: string;
  hint?: string;
  className?: string;
}

export function pickerNoMatchMessage(noun: string, query: string): string {
  return `No ${noun} match “${query.trim()}”`;
}

export function PickerEmptyState({
  icon,
  message,
  hint,
  className,
}: PickerEmptyStateProps) {
  return (
    <div
      role="status"
      data-picker-empty-state=""
      className={cn(
        "flex flex-col items-center gap-1 px-3 py-4 text-center text-xs text-muted-foreground max-md:pointer-coarse:py-5",
        className,
      )}
    >
      <Icon name={icon} aria-hidden className="mb-0.5 size-4 shrink-0" />
      <span className="max-w-full break-words [overflow-wrap:anywhere]">
        {message}
      </span>
      {hint === undefined ? null : (
        <span className="max-w-full break-words text-subtle-foreground">
          {hint}
        </span>
      )}
    </div>
  );
}
