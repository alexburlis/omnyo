import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@omnyo/shared-ui/popover";
import { useHosts } from "@/hooks/queries/host-queries";
import { COMPOSER_TOOL_BUTTON_CLASS } from "./composer-tool-button";

export function ThreadExecutionMachine({ hostId }: { hostId: string }) {
  const hosts = useHosts();
  const host = hosts.data?.find((candidate) => candidate.id === hostId);
  const name = host?.name ?? "Unresolved machine";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={COMPOSER_TOOL_BUTTON_CLASS}
          aria-label={`Execution machine: ${name}`}
        >
          <Icon name="Laptop" className="size-3.5" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3 text-xs">
        <p className="font-medium">{name}</p>
        <p className="mt-1 text-muted-foreground">
          {host
            ? `${host.status === "connected" ? "Connected" : "Disconnected"}. This chat runs on this machine.`
            : hosts.isPending
              ? "Loading this chat's execution machine…"
              : "This chat's execution machine is unavailable."}
        </p>
      </PopoverContent>
    </Popover>
  );
}
