import { useHosts } from "@/hooks/queries/host-queries";
import { useResumeHost } from "@/hooks/mutations/host-mutations";
import type { SystemMachineProvider } from "@omnyo/server-contract";
import {
  MachineIcon,
  type MachineLabelHost,
} from "@/components/machines/MachineLabel";
import { useSystemMachineProviders } from "@/hooks/queries/machine-provider-queries";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  BannerActionSlot,
  PromptBannerActionButton,
} from "./prompt-banner-actions";
import {
  PromptStackCard,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PROMPT_STACK_INLAY_INSET_CLASS,
  PROMPT_STACK_INLAY_SEGMENT_CLASS,
} from "./PromptStackCard";
import { getMutationErrorMessage } from "@/lib/mutation-errors";

export function ThreadMachineStatus({ hostId }: { hostId: string }) {
  const hosts = useHosts();
  const { providers } = useSystemMachineProviders();
  const resume = useResumeHost();
  const host = hosts.data?.find((candidate) => candidate.id === hostId);

  if (!host || host.machineProviderId === null) return null;
  const phase = host.lifecycle.phase;

  if (phase !== "suspending" && phase !== "suspended" && phase !== "resuming")
    return null;

  return (
    <ThreadMachineStatusBanner
      host={host}
      provider={providers?.find(
        (provider) => provider.id === host.machineProviderId,
      )}
      phase={phase}
      error={
        resume.error
          ? getMutationErrorMessage({
              error: resume.error,
              fallbackMessage: "Could not resume the machine.",
            })
          : null
      }
      onResume={() => resume.mutate(hostId)}
    />
  );
}

export function ThreadMachineStatusBanner({
  host,
  provider,
  phase,
  error,
  onResume,
}: {
  host: MachineLabelHost;
  provider: SystemMachineProvider | undefined;
  phase: "suspending" | "suspended" | "resuming";
  error: string | null;
  onResume: () => void;
}) {
  const phaseWord =
    phase === "resuming"
      ? "resuming…"
      : phase === "suspending"
        ? "pausing…"
        : "paused";

  const detail = error && phase !== "resuming" ? error : null;
  const failed = detail !== null;

  const status = failed
    ? "Couldn’t resume the machine"
    : `Machine is ${phaseWord}`;

  return (
    <PromptStackCard
      ariaLabel="Machine status"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div
        className={cn(
          "flex items-center gap-0.5 text-xs text-muted-foreground",
          PROMPT_STACK_INLAY_INSET_CLASS,
        )}
      >
        <div
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-xs",
            PROMPT_STACK_INLAY_SEGMENT_CLASS,
            failed && "font-medium text-destructive-text",
          )}
          role="status"
        >
          {failed ? (
            <Icon
              name="AlertCircle"
              className="size-3.5 shrink-0"
              aria-hidden="true"
            />
          ) : (
            <MachineIcon host={host} machineProvider={provider} />
          )}
          <span className="min-w-0 truncate">{status}</span>
        </div>
        {phase === "suspended" ? (
          <BannerActionSlot hideInTiny={false}>
            <PromptBannerActionButton onClick={onResume}>
              {failed ? "Try again" : "Resume"}
            </PromptBannerActionButton>
          </BannerActionSlot>
        ) : null}
      </div>
      {failed ? (
        <p
          role="alert"
          className="border-t border-border-hairline px-3 pb-2 pt-1.5 text-xs leading-relaxed text-muted-foreground"
        >
          {detail}
        </p>
      ) : null}
    </PromptStackCard>
  );
}
