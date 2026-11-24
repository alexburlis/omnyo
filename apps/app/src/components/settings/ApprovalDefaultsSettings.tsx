import { useState } from "react";
import type { AppSettings, PermissionMode, ProviderInfo } from "@omnyo/domain";
import { Button } from "@omnyo/shared-ui/button";
import { OptionPicker } from "@/components/pickers/OptionPicker";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { useSystemExecutionOptions } from "@/hooks/queries/system-queries";
import {
  SettingsRowList,
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section";

export function ApprovalDefaultsSettings({
  disabled,
  providers,
  settings,
  onChange,
}: {
  disabled: boolean;
  providers: readonly ProviderInfo[];
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => Promise<unknown> | void;
}) {
  const [chosenProviderId, setChosenProviderId] = useState("");
  const [model, setModel] = useState("");
  const providerId = chosenProviderId || providers[0]?.id || "";
  const provider = providers.find((item) => item.id === providerId);

  const catalog = useSystemExecutionOptions({
    providerId,
    enabled: providerId !== "",
  });

  const supportedModes =
    provider?.capabilities.permissionModes ??
    PERMISSION_MODE_OPTIONS.map((option) => option.value);

  const modelOptions = Array.from(
    new Map(
      [
        ...(catalog.data?.models ?? []),
        ...(catalog.data?.selectedOnlyModels ?? []),
      ].map((item) => [
        item.model,
        { value: item.model, label: item.displayName || item.model },
      ]),
    ).values(),
  );

  const override = settings.modelPermissionModes[providerId]?.[model];

  const setOverride = (value: PermissionMode | null) => {
    const overrides = { ...settings.modelPermissionModes[providerId] };

    if (value === null) delete overrides[model];
    else overrides[model] = value;
    void onChange({
      modelPermissionModes: {
        ...settings.modelPermissionModes,
        [providerId]: overrides,
      },
    });
  };

  return (
    <SettingsSection
      title="Approval defaults"
      description="Applies to new chats. Explicit chat choices, parent permissions and remembered project choices take precedence. Existing chats keep their permissions."
    >
      <SettingsRowList>
        <SettingsWithControl label="Default approval mode">
          <PermissionModePicker
            value={settings.defaultPermissionMode}
            options={PERMISSION_MODE_OPTIONS}
            supported
            disabled={disabled}
            onChange={(value) =>
              void onChange({ defaultPermissionMode: value })
            }
          />
        </SettingsWithControl>
        {providers.length > 0 ? (
          <SettingsWithControl
            label="Model override"
            description="A model inherits the default unless you choose an override. Provider limits still apply."
          >
            <div className="flex flex-wrap items-center justify-end gap-1">
              <OptionPicker
                label="Approval override provider"
                value={providerId}
                options={providers.map((item) => ({
                  value: item.id,
                  label: item.displayName,
                }))}
                disabled={disabled}
                onChange={(value) => {
                  setChosenProviderId(value);
                  setModel("");
                }}
              />
              <OptionPicker
                label="Approval override model"
                value={model}
                options={modelOptions}
                disabled={
                  disabled || catalog.isPending || modelOptions.length === 0
                }
                displayOverride={
                  model === ""
                    ? {
                        label: catalog.isPending
                          ? "Loading models…"
                          : "Choose model",
                      }
                    : undefined
                }
                onChange={setModel}
              />
              {model !== "" ? (
                <>
                  <OptionPicker
                    label="Model approval mode"
                    value={override ?? "inherit"}
                    options={[
                      { value: "inherit", label: "Use default" },
                      ...PERMISSION_MODE_OPTIONS.map((option) => ({
                        ...option,
                        disabled: !supportedModes.includes(option.value),
                        disabledReason: !supportedModes.includes(option.value)
                          ? "This provider does not support this approval mode"
                          : undefined,
                      })),
                    ]}
                    disabled={disabled}
                    onChange={(value) => {
                      if (value === "inherit") setOverride(null);
                      else if (
                        value === "accept-edits" ||
                        value === "auto" ||
                        value === "full"
                      )
                        setOverride(value);
                    }}
                  />
                  {override !== undefined ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() => setOverride(null)}
                    >
                      Reset
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
          </SettingsWithControl>
        ) : null}
      </SettingsRowList>
      {catalog.isError || catalog.data?.modelLoadError ? (
        <p role="status" className="text-xs text-muted-foreground">
          Model choices are unavailable. Check the provider and machine status
          to configure a model override.
        </p>
      ) : null}
    </SettingsSection>
  );
}
