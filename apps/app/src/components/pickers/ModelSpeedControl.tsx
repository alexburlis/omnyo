import {
  DEFAULT_SERVICE_TIER,
  type ProviderOptionDescriptor,
  type ServiceTier,
} from "@omnyo/domain";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@omnyo/shared-ui/motion";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";

const TOOLTIP_DELAY_MS = 300;

const GENERIC_SPEED_DESCRIPTION =
  "Asks the provider for its faster service tier, which usually costs more per request.";

export const MODEL_SPEED_BUTTON_CLASS_NAME = cn(
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-subtle-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring aria-pressed:text-foreground disabled:pointer-events-none disabled:opacity-50",
  CONTROL_PRESS_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
);

export interface ModelSpeed {
  options: readonly ProviderOptionDescriptor[];
  value: ServiceTier | undefined;
  onChange: (value: ServiceTier) => void;
}

const FAST_SERVICE_TIER = "fast";

function speedTiers<Tier extends Pick<ProviderOptionDescriptor, "id">>(
  options: readonly Tier[],
): Tier[] {
  return [
    ...options.filter((option) => option.id === FAST_SERVICE_TIER),
    ...options.filter((option) => option.id !== FAST_SERVICE_TIER),
  ];
}

export function nextServiceTier(
  options: readonly Pick<ProviderOptionDescriptor, "id">[],
  value: ServiceTier | undefined,
): ServiceTier {
  const tiers = speedTiers(options);
  const index = tiers.findIndex((option) => option.id === value);

  return tiers[index + 1]?.id ?? DEFAULT_SERVICE_TIER;
}

export function ModelSpeedIcon({
  tier,
  active,
}: {
  tier: ServiceTier;
  active: boolean;
}) {
  const boltClassName = cn("size-3.5 shrink-0", active && "fill-current");

  return (
    <>
      <Icon name="Zap" aria-hidden className={boltClassName} />
      {tier === "ultrafast" && (
        <Icon name="Zap" aria-hidden className={cn("-ms-1.5", boltClassName)} />
      )}
    </>
  );
}

export function ModelSpeedControl({
  speed: { options, value, onChange },
  className,
}: {
  speed: ModelSpeed;
  className: string;
}) {
  const tiers = speedTiers(options);
  const index = tiers.findIndex((option) => option.id === value);
  const shown = tiers[Math.max(index, 0)];

  if (shown === undefined) return null;

  const label = `${shown.label} mode`;

  const next = tiers[index + 1];

  const action =
    index === -1
      ? `Turn on ${label}`
      : next === undefined
        ? `Turn off ${label}`
        : `Switch to ${next.label} mode`;

  const description = shown.description ?? GENERIC_SPEED_DESCRIPTION;

  return (
    <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-speed-tier={index === -1 ? DEFAULT_SERVICE_TIER : shown.id}
            aria-label={`${label}, faster responses`}
            aria-pressed={index !== -1}
            aria-description={description}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange(nextServiceTier(options, value))}
            className={className}
          >
            <ModelSpeedIcon tier={shown.id} active={index !== -1} />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <span className="block font-medium">{action}</span>
          <span className="block">{description}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
