import { useState } from "react";
import { generatePath, Link } from "react-router-dom";
import { arrayMove } from "@dnd-kit/sortable";
import type {
  AppSettings,
  CompletedTurnDisplay,
  ProviderInfo,
} from "@omnyo/domain";
import { allowsFastServiceTier } from "@omnyo/domain";
import { Button } from "@omnyo/shared-ui/button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { Switch } from "@omnyo/shared-ui/switch";
import {
  SettingsBadge,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import { ProviderIcon } from "@/components/plugin/ProviderIcon";
import { useSetProviderEnabled } from "@/hooks/mutations/provider-mutations";
import {
  useSystemProviderCatalog,
  useSystemProviders,
} from "@/hooks/queries/system-queries";
import { SETTINGS_PLUGIN_ROUTE_PATH } from "@/lib/route-paths";
import { ModelPickerSettings } from "./ModelPickerSettings";
import { ApprovalDefaultsSettings } from "./ApprovalDefaultsSettings";
import {
  SortableSettingsRowList,
  useSortableSettingsRow,
} from "./sortable-settings-rows";

interface ProvidersSettingsSectionProps {
  disabled: boolean;
  generalSettings: AppSettings;
  onGeneralSettingsChange: (
    patch: Partial<AppSettings>,
  ) => Promise<unknown> | void;
}

function applyProviderOrder(
  providers: readonly ProviderInfo[],
  ids: readonly string[] | null,
): readonly ProviderInfo[] {
  if (
    ids === null ||
    providers.length !== ids.length ||
    providers.some((provider) => !ids.includes(provider.id))
  ) {
    return providers;
  }

  const providersById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );

  return ids.flatMap((id) => {
    const provider = providersById.get(id);

    return provider === undefined ? [] : [provider];
  });
}

export function reorderProviderIds(
  ids: readonly string[],
  activeId: string,
  overId: string,
): string[] | null {
  const activeIndex = ids.indexOf(activeId);
  const overIndex = ids.indexOf(overId);

  if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) {
    return null;
  }

  return arrayMove([...ids], activeIndex, overIndex);
}

function withProviderCompletedTurnDisplay(
  settings: AppSettings,
  provider: ProviderInfo,
  display: CompletedTurnDisplay,
): Pick<AppSettings, "providerCompletedTurnDisplay"> {
  const overrides = Object.fromEntries(
    Object.entries(settings.providerCompletedTurnDisplay).filter(
      ([providerId]) => providerId !== provider.id,
    ),
  );

  return {
    providerCompletedTurnDisplay:
      display === provider.completedTurnDisplay
        ? overrides
        : { ...overrides, [provider.id]: display },
  };
}

function ProviderRowIcon({
  provider,
}: {
  provider: Pick<ProviderInfo, "id" | "logoUrl"> &
    Partial<Pick<ProviderInfo, "icon" | "strings">>;
}) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      <ProviderIcon
        providerKind="agent"
        provider={provider}
        className={COARSE_POINTER_ICON_SIZE_CLASS}
      />
    </span>
  );
}

function ProviderActionsMenu({
  provider,
  isDefault,
  disabled,
  onDisable,
  onMakeDefault,
}: {
  provider: Pick<ProviderInfo, "displayName">;
  isDefault: boolean;
  disabled: boolean;
  onDisable: () => void;
  onMakeDefault: (() => void) | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground data-[state=open]:bg-state-active data-[state=open]:text-foreground"
          aria-label={`Actions for ${provider.displayName}`}
        >
          <Icon name="MoreHorizontal" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" mobileTitle={provider.displayName}>
        <DropdownMenuItem
          disabled={disabled || isDefault || onMakeDefault === null}
          onSelect={() => onMakeDefault?.()}
        >
          Make default
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onSelect={onDisable}
          variant="destructive"
        >
          Disable
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderUnavailableLink({ pluginId }: { pluginId: string }) {
  return (
    <Link
      to={generatePath(SETTINGS_PLUGIN_ROUTE_PATH, { pluginId })}
      className="shrink-0 text-xs text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      Plugin didn't load
    </Link>
  );
}

interface SortableProviderRowProps {
  disabled: boolean;
  generalSettings: AppSettings;
  index: number;
  onGeneralSettingsChange: ProvidersSettingsSectionProps["onGeneralSettingsChange"];
  provider: ProviderInfo;
  onDisable: () => void;
}

function SortableProviderRow({
  disabled,
  generalSettings,
  index,
  onGeneralSettingsChange,
  provider,
  onDisable,
}: SortableProviderRowProps) {
  const { setNodeRef, style, handle, liftClassName } = useSortableSettingsRow({
    id: provider.id,
    disabled,
    label: provider.displayName,
  });

  const isDefault =
    generalSettings.defaultProviderId === provider.id ||
    (generalSettings.defaultProviderId === null && index === 0);

  return (
    <SettingsRow
      ref={setNodeRef}
      style={style}
      className={cn("group/provider-row", liftClassName)}
    >
      {handle}
      <ProviderRowIcon provider={provider} />
      <span className="min-w-0 flex-1 truncate font-medium">
        {provider.displayName}
      </span>
      {!provider.available ? (
        <ProviderUnavailableLink pluginId={provider.pluginId} />
      ) : isDefault ? (
        <SettingsBadge>Default</SettingsBadge>
      ) : null}
      <ProviderActionsMenu
        provider={provider}
        isDefault={isDefault}
        disabled={disabled}
        onDisable={onDisable}
        onMakeDefault={
          provider.available
            ? () => {
                void onGeneralSettingsChange({
                  defaultProviderId: provider.id,
                });
              }
            : null
        }
      />
    </SettingsRow>
  );
}

interface CompletedTurnDisplayRowProps {
  disabled: boolean;
  generalSettings: AppSettings;
  onGeneralSettingsChange: ProvidersSettingsSectionProps["onGeneralSettingsChange"];
  provider: ProviderInfo;
}

function CompletedTurnDisplayRow({
  disabled,
  generalSettings,
  onGeneralSettingsChange,
  provider,
}: CompletedTurnDisplayRowProps) {
  const display =
    generalSettings.providerCompletedTurnDisplay[provider.id] ??
    provider.completedTurnDisplay;

  return (
    <SettingsRow>
      <ProviderRowIcon provider={provider} />
      <span className="min-w-0 flex-1 truncate font-medium">
        {provider.displayName}
      </span>
      <Switch
        checked={display === "collapse"}
        disabled={disabled}
        aria-label={`Collapse finished ${provider.displayName} turns`}
        onCheckedChange={(checked) =>
          onGeneralSettingsChange(
            withProviderCompletedTurnDisplay(
              generalSettings,
              provider,
              checked ? "collapse" : "flat",
            ),
          )
        }
      />
    </SettingsRow>
  );
}

export function ProvidersSettingsSection({
  disabled,
  generalSettings,
  onGeneralSettingsChange,
}: ProvidersSettingsSectionProps) {
  const providersQuery = useSystemProviders();
  const catalogQuery = useSystemProviderCatalog();
  const setEnabled = useSetProviderEnabled();
  const catalog = catalogQuery.data ?? [];

  const disabledProviders = catalog.filter(
    (provider) => !provider.enabled || !provider.pluginEnabled,
  );

  const controlsDisabled = disabled || setEnabled.isPending;
  const serverProviders: ProviderInfo[] = providersQuery.data ?? [];
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null);
  const providers = applyProviderOrder(serverProviders, optimisticOrder);
  const ids = providers.map((provider) => provider.id);

  const handleReorder = (activeId: string, overId: string): void => {
    const next = reorderProviderIds(ids, activeId, overId);

    if (next === null) return;
    setOptimisticOrder(next);
    let write: Promise<unknown> | void;

    try {
      write = onGeneralSettingsChange({
        providerOrder: next,
      });
    } catch {
      setOptimisticOrder(null);

      return;
    }

    void Promise.resolve(write)
      .catch(() => undefined)
      .finally(() => setOptimisticOrder(null));
  };

  const fastModeProviders = providers.filter(
    (provider) => provider.capabilities.supportsServiceTier,
  );

  return (
    <>
      <ApprovalDefaultsSettings
        disabled={disabled}
        providers={providers}
        settings={generalSettings}
        onChange={onGeneralSettingsChange}
      />
      <SettingsSection
        title="Providers"
        description="New chats start with the default provider unless their project last used another. Drag to set the order of providers in the model picker and its favorites."
      >
        {providersQuery.isPending ? (
          <p className="text-sm text-muted-foreground">Loading providers…</p>
        ) : providers.length === 0 && disabledProviders.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No providers available. Install a provider plugin in Settings →
            Plugins.
          </p>
        ) : (
          <>
            <SortableSettingsRowList
              ids={ids}
              disabled={disabled}
              onReorder={handleReorder}
            >
              {providers.map((provider, index) => (
                <SortableProviderRow
                  key={provider.id}
                  disabled={controlsDisabled}
                  onDisable={() =>
                    setEnabled.mutate({
                      providerId: provider.id,
                      enabled: false,
                    })
                  }
                  generalSettings={generalSettings}
                  index={index}
                  onGeneralSettingsChange={onGeneralSettingsChange}
                  provider={provider}
                />
              ))}
            </SortableSettingsRowList>
            {disabledProviders.length === 0 ? null : (
              <div
                role="group"
                aria-label="Disabled providers"
                className={cn(
                  providers.length > 0 && "mt-3 border-t border-border pt-3",
                )}
              >
                <p className="pb-1 text-xs font-medium text-muted-foreground">
                  Disabled
                </p>
                <SettingsRowList>
                  {disabledProviders.map((provider) => (
                    <SettingsRow
                      key={provider.id}
                      className="text-muted-foreground"
                    >
                      <span className="-ml-2 w-7 shrink-0" aria-hidden="true" />
                      <span className="shrink-0 opacity-60 grayscale">
                        <ProviderRowIcon provider={provider.info ?? provider} />
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {provider.displayName}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={controlsDisabled}
                        aria-label={`Enable ${provider.displayName}`}
                        onClick={() =>
                          setEnabled.mutate({
                            providerId: provider.id,
                            enabled: true,
                          })
                        }
                      >
                        Enable
                      </Button>
                    </SettingsRow>
                  ))}
                </SettingsRowList>
              </div>
            )}
          </>
        )}
      </SettingsSection>
      {providers.length === 0 ? null : (
        <ModelPickerSettings
          providers={providers}
          generalSettings={generalSettings}
        />
      )}
      {fastModeProviders.length === 0 ? null : (
        <SettingsSection
          title="Fast mode"
          description="Shows ⚡ beside the model so you can switch to a faster tier. Off keeps every new turn on the standard tier, including queued messages and automations."
        >
          <SettingsRowList>
            {fastModeProviders.map((provider) => (
              <SettingsRow key={provider.id}>
                <ProviderRowIcon provider={provider} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {provider.displayName}
                </span>
                <Switch
                  checked={allowsFastServiceTier(generalSettings, provider.id)}
                  disabled={disabled}
                  onCheckedChange={(enabled) =>
                    onGeneralSettingsChange({
                      providerAllowFastServiceTier: {
                        ...generalSettings.providerAllowFastServiceTier,
                        [provider.id]: enabled,
                      },
                    })
                  }
                  aria-label={`Allow faster ${provider.displayName} service tiers`}
                />
              </SettingsRow>
            ))}
          </SettingsRowList>
        </SettingsSection>
      )}
      {providers.length === 0 ? null : (
        <SettingsSection
          title="Collapse finished turns"
          description="Folds a finished turn's steps into one activity line and keeps the final answer visible. Off shows every step."
        >
          <SettingsRowList>
            {providers.map((provider) => (
              <CompletedTurnDisplayRow
                key={provider.id}
                disabled={disabled}
                generalSettings={generalSettings}
                onGeneralSettingsChange={onGeneralSettingsChange}
                provider={provider}
              />
            ))}
          </SettingsRowList>
        </SettingsSection>
      )}
    </>
  );
}
