import type { ProviderInfo } from "@omnyo/domain";
import type { SkillProvider } from "@omnyo/server-contract";
import { ProviderIconMark } from "@/components/settings/ProviderIconMark";
import { OmnyoLogo } from "@/components/ui/omnyo-logo";
import { getProviderIconInfo } from "@/lib/provider-icon";

export function ProviderLogo({
  providerId,
  provider,
  className,
}: {
  providerId: SkillProvider;
  provider?: ProviderInfo | undefined;
  className?: string;
}) {
  const info = getProviderIconInfo("agent", providerId, provider ?? null);

  if (!info) {
    return null;
  }

  if (provider === undefined) {
    const LogoIcon = info.icon;

    return <LogoIcon className={className} />;
  }

  return (
    <ProviderIconMark
      provider={provider}
      icon={info.icon}
      className={className}
    />
  );
}

export function SkillProvenanceTooltip({
  prefix,
  providerId,
  provider,
  name,
}: {
  prefix: string;
  providerId: SkillProvider | null;
  provider?: ProviderInfo | undefined;
  name: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{prefix}</span>
      <span
        data-provider-icon={providerId ?? "omnyo"}
        aria-hidden="true"
        className="flex size-3.5 shrink-0 items-center justify-center"
      >
        {providerId === null ? (
          <OmnyoLogo className="size-3.5 brightness-0 invert" />
        ) : (
          <ProviderLogo
            providerId={providerId}
            provider={provider}
            className="size-3.5"
          />
        )}
      </span>
      <span>{name}</span>
    </span>
  );
}
