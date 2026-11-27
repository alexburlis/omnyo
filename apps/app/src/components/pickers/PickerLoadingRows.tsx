import { DelayedLoading } from "@omnyo/shared-ui/delayed-loading";
import { Skeleton } from "@omnyo/shared-ui/skeleton";
import { cn } from "@omnyo/shared-ui/lib/utils";

const PICKER_LOADING_ROW_WIDTHS = ["w-20", "w-28", "w-24", "w-32"] as const;

export function ReasoningLoadingIndicator() {
  return (
    <span
      role="status"
      aria-label="Loading reasoning levels"
      data-promptbox-hide-compact=""
      className="inline-flex h-3 w-8 shrink-0"
    >
      <DelayedLoading>
        <Skeleton className="size-full rounded-sm" />
      </DelayedLoading>
    </span>
  );
}

interface PickerLoadingRowsProps {
  label: string;
  rowDataAttribute: `data-${string}`;
}

export function PickerLoadingRows({
  label,
  rowDataAttribute,
}: PickerLoadingRowsProps) {
  const rowDataAttributes = { [rowDataAttribute]: "" };

  return (
    <div role="status" aria-label={label} className="pb-1">
      <span className="sr-only">{label}</span>
      {PICKER_LOADING_ROW_WIDTHS.map((widthClassName) => (
        <div
          key={widthClassName}
          {...rowDataAttributes}
          aria-hidden
          className="flex items-center rounded-sm px-2 py-[0.3125rem] max-md:pointer-coarse:py-2"
        >
          <span className="flex h-3 w-full items-center">
            <DelayedLoading>
              <span className="flex w-full">
                <Skeleton
                  className={cn("h-3 max-w-[75%] rounded-sm", widthClassName)}
                />
              </span>
            </DelayedLoading>
          </span>
        </div>
      ))}
    </div>
  );
}
