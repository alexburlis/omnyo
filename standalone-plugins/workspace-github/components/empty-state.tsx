import { Icon } from "./ui/icon";

export function EmptyState({
  message,
  title,
  icon,
}: {
  message: string;
  title?: string;
  icon?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {icon === undefined ? null : (
        <span className="grid size-11 place-items-center rounded-full bg-state-hover text-muted-foreground ring-1 ring-border">
          <Icon name={icon} aria-hidden="true" className="size-5" />
        </span>
      )}
      <div className="flex max-w-md flex-col gap-1">
        {title === undefined ? null : (
          <p className="text-base font-semibold text-foreground">{title}</p>
        )}
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
