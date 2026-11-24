import { useState } from "react";
import type { ThreadStartMachinesResponse } from "@omnyo/server-contract";
import { Button } from "@omnyo/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { appToast } from "@/components/ui/app-toast";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import {
  useMoveThreadStart,
  useThreadStartMachines,
} from "@/hooks/queries/thread-start-machine-queries";

type StartMachine = ThreadStartMachinesResponse["machines"][number];

const MOVE_FAILED_MESSAGE =
  "Couldn't start this chat on that machine. Try again.";

function StartOnMachineItem({
  machine,
  providerName,
  onPick,
}: {
  machine: StartMachine;
  providerName: string | null;
  onPick: (machine: StartMachine) => void;
}) {
  return (
    <DropdownMenuItem
      disabled={!machine.eligible}
      onSelect={() => onPick(machine)}
    >
      <Icon
        name="Laptop"
        className="size-4 text-muted-foreground"
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{machine.name}</span>
        {machine.reason === null ? null : (
          <span
            data-start-on-reason=""
            className="text-2xs text-subtle-foreground"
          >
            {machine.reason}
          </span>
        )}
      </span>
      {providerName === null ? null : (
        <span className="shrink-0 text-xs text-subtle-foreground">
          {providerName}
        </span>
      )}
    </DropdownMenuItem>
  );
}

function StartOnMenuBody({
  listing,
  loading,
  failed,
  onPick,
}: {
  listing: ThreadStartMachinesResponse | undefined;
  loading: boolean;
  failed: boolean;
  onPick: (machine: StartMachine, originHostId: string) => void;
}) {
  const { providers } = useSystemEnvironmentProviders();

  if (failed) {
    return (
      <DropdownMenuItem disabled>
        Couldn't check the machines. Try again.
      </DropdownMenuItem>
    );
  }

  if (loading || listing === undefined) {
    return <DropdownMenuItem disabled>Checking machines…</DropdownMenuItem>;
  }

  const { originHostId, machines } = listing;

  if (originHostId === null) {
    return (
      <DropdownMenuItem disabled>
        Only a waiting new chat can move.
      </DropdownMenuItem>
    );
  }

  if (machines.length === 0) {
    return (
      <DropdownMenuItem disabled>
        No other machines are set up.
      </DropdownMenuItem>
    );
  }

  return machines.map((machine) => (
    <StartOnMachineItem
      key={machine.hostId}
      machine={machine}
      providerName={
        machine.environmentProviderId === null
          ? null
          : (providers?.find(
              (provider) => provider.id === machine.environmentProviderId,
            )?.displayName ?? null)
      }
      onPick={(picked) => onPick(picked, originHostId)}
    />
  ));
}

export function QueuedMessageStartOnMenu({
  threadId,
  compact,
  disabled,
}: {
  threadId: string;
  compact: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const listing = useThreadStartMachines(threadId, open);
  const moveStart = useMoveThreadStart();

  const pick = (machine: StartMachine, originHostId: string) => {
    moveStart.mutate(
      { threadId, hostId: machine.hostId, expectedHostId: originHostId },
      {
        onSuccess: (result) => {
          if (result.kind === "refused") appToast.error(result.message);
        },
        onError: () => appToast.error(MOVE_FAILED_MESSAGE),
      },
    );
  };

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <Tooltip>
        <DropdownMenuTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className={cn(
                "shrink-0 text-muted-foreground",
                compact ? "size-7" : "size-8",
              )}
              disabled={disabled || moveStart.isPending}
              aria-label="Start on another machine"
            >
              <Icon name="Laptop" className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
        </DropdownMenuTrigger>
        <TooltipContent className="max-md:hidden">Start on…</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        mobileTitle="Start on"
        className="min-w-64 max-w-80"
      >
        <StartOnMenuBody
          listing={listing.data}
          loading={listing.isPending}
          failed={listing.isError}
          onPick={pick}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
