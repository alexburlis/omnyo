import { usePluginEnabledMutation } from "@/components/plugin/usePluginEnabledMutation";
import { useEffect, useId, useState, type FocusEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PluginSettingsSections } from "@/components/plugin/PluginSettingsSections";
import { Button } from "@omnyo/shared-ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@omnyo/shared-ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  CONTROL_HOVER_TRANSITION,
  DISCLOSURE_CHEVRON_TRANSITION,
} from "@omnyo/shared-ui/motion";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { Input } from "@omnyo/shared-ui/input";
import { Textarea } from "@omnyo/shared-ui/textarea";
import { Link } from "react-router-dom";
import { SettingsWithControl } from "@/components/ui/settings-section.js";
import { getPluginDetailRoutePath } from "@/lib/route-paths";
import { Skeleton } from "@omnyo/shared-ui/skeleton";
import { Switch } from "@omnyo/shared-ui/switch";
import {
  ResourceDetailConfigurationSection,
  ResourceDetailPanel,
  ResourceDetailStack,
} from "@omnyo/shared-ui/resource-list";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import { applyPluginSettingsView } from "@/hooks/cache-owners/plugin-cache-owner";
import {
  updatePluginSettings,
  usePluginList,
  usePluginSettingsView,
  type PluginListItem,
  type PluginSettingFieldDescriptor,
} from "@/hooks/queries/plugin-settings-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { usePluginSlots } from "@/lib/plugin-slots";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { PluginMachineServerAccessNotice } from "@/components/machines/MachineServerAccessNotice";
import { invalidateMachineProviders } from "@/hooks/cache-owners/system-cache-effects";
import {
  SETTINGS_DROPDOWN_CONTENT_CLASS,
  SETTINGS_DROPDOWN_TRIGGER_CLASS,
} from "@/components/settings/settings-dropdown";

const MULTILINE_MIN_ROWS = 6;

const MULTILINE_MAX_ROWS = 24;

const INVALID_NUMBER_DRAFT = Symbol();

const MULTILINE_TEXTAREA_CLASS =
  "max-h-96 min-h-32 w-full resize-y overflow-y-auto font-mono text-xs field-sizing-content";

function multilineRows(value: string): number {
  const lines = value.split("\n").length;

  return Math.min(MULTILINE_MAX_ROWS, Math.max(MULTILINE_MIN_ROWS, lines + 1));
}

function isSecretSet(storedValue: unknown): boolean {
  return (
    typeof storedValue === "object" &&
    storedValue !== null &&
    "set" in storedValue &&
    storedValue.set === true
  );
}

function isSettingConfigured(
  descriptor: PluginSettingFieldDescriptor,
  storedValue: unknown,
): boolean {
  if (descriptor.type === "string" && descriptor.secret === true) {
    return isSecretSet(storedValue);
  }

  if (storedValue === undefined || storedValue === "") return false;

  return storedValue !== descriptor.default;
}

function isMultilineSetting(descriptor: PluginSettingFieldDescriptor): boolean {
  return (
    descriptor.type === "string" &&
    descriptor.experimental_multiline === true &&
    descriptor.secret !== true
  );
}

interface SettingOptionPickerProps {
  ariaDescribedBy: string | undefined;
  ariaInvalid: boolean;
  ariaLabel: string;
  onSelect: (value: string) => void;
  options: readonly { label: string; value: string }[];
  valueLabel: string;
}

function SettingOptionPicker({
  ariaDescribedBy,
  ariaInvalid,
  ariaLabel,
  onSelect,
  options,
  valueLabel,
}: SettingOptionPickerProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
        >
          <span className="min-w-0 truncate">{valueLabel}</span>
          <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={SETTINGS_DROPDOWN_CONTENT_CLASS}
      >
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onSelect(option.value)}
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface PluginSettingFieldProps {
  ariaDescribedBy: string | undefined;
  ariaInvalid: boolean;
  descriptor: PluginSettingFieldDescriptor;
  draft: string | boolean;
  onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onChange: (value: string | boolean) => void;
  storedValue: unknown;
}

function PluginSettingField({
  ariaDescribedBy,
  ariaInvalid,
  descriptor,
  draft,
  onBlur,
  onChange,
  storedValue,
}: PluginSettingFieldProps) {
  const projects = useSidebarNavigation({
    enabled: descriptor.type === "project",
  });

  if (descriptor.type === "boolean") {
    const checked =
      typeof draft === "boolean"
        ? draft
        : typeof storedValue === "boolean"
          ? storedValue
          : false;

    return (
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={descriptor.label}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
      />
    );
  }

  if (descriptor.type === "select") {
    const value =
      typeof draft === "string"
        ? draft
        : typeof storedValue === "string"
          ? storedValue
          : "";

    return (
      <SettingOptionPicker
        ariaDescribedBy={ariaDescribedBy}
        ariaInvalid={ariaInvalid}
        ariaLabel={descriptor.label}
        valueLabel={
          value.length > 0
            ? (descriptor.experimental_optionLabels?.[value] ?? value)
            : "Select…"
        }
        options={descriptor.options.map((option) => ({
          label: descriptor.experimental_optionLabels?.[option] ?? option,
          value: option,
        }))}
        onSelect={onChange}
      />
    );
  }

  if (descriptor.type === "project") {
    const value =
      typeof draft === "string"
        ? draft
        : typeof storedValue === "string"
          ? storedValue
          : "";

    const navigation = projects.data;

    const options = navigation
      ? [
          {
            label: navigation.personalProject.name,
            value: navigation.personalProject.id,
          },
          ...navigation.projects.map((project) => ({
            label: project.name,
            value: project.id,
          })),
        ]
      : [];

    const valueLabel =
      options.find((option) => option.value === value)?.label ??
      (value.length > 0 ? value : "Select a project…");

    return (
      <SettingOptionPicker
        ariaDescribedBy={ariaDescribedBy}
        ariaInvalid={ariaInvalid}
        ariaLabel={descriptor.label}
        valueLabel={valueLabel}
        options={options}
        onSelect={onChange}
      />
    );
  }

  if (descriptor.type === "number") {
    const value =
      typeof draft === "string"
        ? draft
        : typeof storedValue === "number"
          ? String(storedValue)
          : "";

    return (
      <Input
        type="number"
        inputMode="decimal"
        step="any"
        value={value}
        placeholder={descriptor.experimental_placeholder}
        aria-label={descriptor.label}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className="h-7 w-full text-xs @min-[36rem]/settings:w-64"
      />
    );
  }

  const isSecret = descriptor.secret === true;

  const secretIsSet = isSecret && isSecretSet(storedValue);

  const value =
    typeof draft === "string"
      ? draft
      : !isSecret && typeof storedValue === "string"
        ? storedValue
        : "";

  if (isMultilineSetting(descriptor)) {
    return (
      <Textarea
        value={value}
        aria-label={descriptor.label}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        rows={multilineRows(value)}
        placeholder={descriptor.experimental_placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className={MULTILINE_TEXTAREA_CLASS}
      />
    );
  }

  return (
    <Input
      type={isSecret ? "password" : "text"}
      value={value}
      aria-label={descriptor.label}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      placeholder={
        secretIsSet
          ? "Saved · type to replace"
          : (descriptor.experimental_placeholder ??
            (isSecret ? "Not set" : undefined))
      }
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      className="h-7 w-full text-xs @min-[36rem]/settings:w-64"
    />
  );
}

function initialSettingDraft(
  descriptor: PluginSettingFieldDescriptor,
  storedValue: unknown,
): string | boolean {
  if (descriptor.type === "boolean") {
    return typeof storedValue === "boolean" ? storedValue : false;
  }

  if (descriptor.type === "number") {
    return typeof storedValue === "number" ? String(storedValue) : "";
  }

  if (descriptor.type === "string" && descriptor.secret === true) return "";

  return typeof storedValue === "string" ? storedValue : "";
}

interface AutosavingPluginSettingProps {
  descriptor: PluginSettingFieldDescriptor;
  pluginId: string;
  settingKey: string;
  storedValue: unknown;
}

function AutosavingPluginSetting({
  descriptor,
  pluginId,
  settingKey,
  storedValue,
}: AutosavingPluginSettingProps) {
  const queryClient = useQueryClient();
  const messageId = useId();
  const initialDraft = initialSettingDraft(descriptor, storedValue);

  const [draftState, setDraftState] = useState({
    value: initialDraft,
    hasNewerDraft: false,
  });

  const draft = draftState.value;

  const save = useMutation({
    scope: { id: `plugin-setting:${pluginId}:${settingKey}` },
    mutationFn: (value: string | boolean | typeof INVALID_NUMBER_DRAFT) => {
      if (value === INVALID_NUMBER_DRAFT)
        throw new Error("Enter a finite number");
      let settingValue: string | number | boolean | null = value;

      if (descriptor.type === "number") {
        const trimmed = typeof value === "string" ? value.trim() : "";
        const parsed = Number(trimmed);

        if (trimmed.length > 0 && !Number.isFinite(parsed)) {
          throw new Error("Enter a finite number");
        }

        settingValue = trimmed.length === 0 ? null : parsed;
      }

      return updatePluginSettings(fetch, pluginId, {
        [settingKey]: settingValue,
      });
    },
    onSuccess: (view) => {
      applyPluginSettingsView({ queryClient, pluginId, view });
      void invalidateMachineProviders({ queryClient });
    },
  });

  useEffect(() => {
    if (!draftState.hasNewerDraft && !save.isPending && !save.isError) {
      setDraftState({ value: initialDraft, hasNewerDraft: false });
    }
  }, [draftState.hasNewerDraft, initialDraft, save.isError, save.isPending]);

  function changeDraft(value: string | boolean): void {
    setDraftState({
      value,
      hasNewerDraft:
        descriptor.type === "string" || descriptor.type === "number",
    });

    if (!save.isPending) save.reset();

    if (descriptor.type !== "string" && descriptor.type !== "number") {
      save.mutate(value);
    }
  }

  function saveDraft(
    event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): void {
    if (descriptor.type !== "string" && descriptor.type !== "number") return;

    if (descriptor.type === "number" && event.currentTarget.validity.badInput) {
      setDraftState({ value: initialDraft, hasNewerDraft: false });
      save.mutate(INVALID_NUMBER_DRAFT);

      return;
    }

    if (descriptor.type === "number") {
      const trimmed = typeof draft === "string" ? draft.trim() : "";
      const parsed = Number(trimmed);

      if (
        (trimmed.length === 0 && storedValue === undefined) ||
        (trimmed.length > 0 && parsed === storedValue && !save.isPending)
      ) {
        setDraftState({ value: draft, hasNewerDraft: false });

        return;
      }
    }

    if (
      (draft === storedValue && !save.isPending) ||
      (descriptor.type === "string" &&
        descriptor.secret === true &&
        draft === "")
    ) {
      setDraftState({ value: draft, hasNewerDraft: false });

      return;
    }

    setDraftState({ value: draft, hasNewerDraft: false });
    save.mutate(draft);
  }

  const saveError = save.isError
    ? getMutationErrorMessage({
        error: save.error,
        fallbackMessage: "Could not save this setting",
      })
    : null;

  return (
    <SettingsWithControl
      label={descriptor.label}
      labelBadge={
        descriptor.type === "string" && descriptor.secret === true
          ? "secret"
          : undefined
      }
      controlPlacement={
        descriptor.type === "boolean"
          ? "trailing"
          : isMultilineSetting(descriptor)
            ? "below"
            : "inline"
      }
      {...(descriptor.description !== undefined
        ? { description: descriptor.description }
        : {})}
    >
      <div className="space-y-1">
        <PluginSettingField
          ariaDescribedBy={saveError !== null ? messageId : undefined}
          ariaInvalid={saveError !== null}
          descriptor={descriptor}
          storedValue={storedValue}
          draft={draft}
          onBlur={saveDraft}
          onChange={changeDraft}
        />
        {saveError !== null ? (
          <p id={messageId} className="text-xs text-destructive" role="alert">
            {saveError}
          </p>
        ) : null}
      </div>
    </SettingsWithControl>
  );
}

interface PluginSettingEntry {
  key: string;
  descriptor: PluginSettingFieldDescriptor;
}

interface PluginSettingGroup {
  title: string;
  description: string | undefined;
  entries: PluginSettingEntry[];
}

function groupPluginSettings(
  schema: Record<string, PluginSettingFieldDescriptor>,
): { ungrouped: PluginSettingEntry[]; groups: PluginSettingGroup[] } {
  const ungrouped: PluginSettingEntry[] = [];
  const groups = new Map<string, PluginSettingGroup>();

  for (const [key, descriptor] of Object.entries(schema)) {
    const section = descriptor.experimental_section;

    if (section === undefined) {
      ungrouped.push({ key, descriptor });
      continue;
    }

    const group = groups.get(section.title) ?? {
      title: section.title,
      description: section.description,
      entries: [],
    };

    group.entries.push({ key, descriptor });
    groups.set(section.title, group);
  }

  return { ungrouped, groups: [...groups.values()] };
}

function PluginSettingGroupDisclosure({
  group,
  pluginId,
  values,
}: {
  group: PluginSettingGroup;
  pluginId: string;
  values: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);

  const configured = group.entries.some(({ key, descriptor }) =>
    isSettingConfigured(descriptor, values[key]),
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="py-1 first:pt-0 last:pb-0"
    >
      <CollapsibleTrigger
        className={cn(
          "-mx-1.5 flex w-[calc(100%+0.75rem)] cursor-pointer items-center gap-3 rounded-md px-1.5 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring",
          CONTROL_HOVER_TRANSITION,
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-foreground">{group.title}</span>
          {group.description !== undefined ? (
            <span className="mt-0.5 block text-xs leading-snug text-subtle-foreground">
              {group.description}
            </span>
          ) : null}
        </span>
        {configured ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-foreground">
            <Icon name="Check" aria-hidden className="size-3.5" />
            Set up
          </span>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">
            Not set up
          </span>
        )}
        <Icon
          name="ChevronRight"
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            DISCLOSURE_CHEVRON_TRANSITION,
            open && "rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-4 pb-2 pt-3">
          {group.entries.map(({ key, descriptor }) => (
            <AutosavingPluginSetting
              key={key}
              descriptor={descriptor}
              pluginId={pluginId}
              settingKey={key}
              storedValue={values[key]}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function PluginSettingsForm({ pluginId }: { pluginId: string }) {
  const viewQuery = usePluginSettingsView(pluginId, { enabled: true });
  const view = viewQuery.data ?? null;

  if (view === null || Object.keys(view.schema).length === 0) return null;

  const { ungrouped, groups } = groupPluginSettings(view.schema);

  return (
    <div className="space-y-4">
      {ungrouped.map(({ key, descriptor }) => (
        <AutosavingPluginSetting
          key={key}
          descriptor={descriptor}
          pluginId={pluginId}
          settingKey={key}
          storedValue={view.values[key]}
        />
      ))}
      {groups.length > 0 ? (
        <div
          className={cn(
            "divide-y divide-border",
            ungrouped.length > 0 && "border-t border-border pt-3",
          )}
        >
          {groups.map((group) => (
            <PluginSettingGroupDisclosure
              key={group.title}
              group={group}
              pluginId={pluginId}
              values={view.values}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const PLUGIN_STATUSES_WITH_SETTINGS = [
  "running",
  "needs-configuration",
  "degraded",
];

function PluginSettingsFieldSkeleton() {
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex h-5 items-center">
        <Skeleton className="h-3.5 w-40 max-w-[60%]" />
      </div>
      <div className="flex h-4 items-center">
        <Skeleton className="h-3 w-72 max-w-full" />
      </div>
    </div>
  );
}

function PluginSettingsPageSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-5xl"
      data-testid="plugin-settings-skeleton"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">Loading plugin settings…</span>
      <div aria-hidden>
        <header className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Skeleton className="size-9 shrink-0" />
            <div className="min-w-0">
              <div className="flex h-7 items-center">
                <Skeleton className="h-4 w-44 max-w-full" />
              </div>
              <div className="flex h-4 items-center">
                <Skeleton className="h-3 w-80 max-w-full" />
              </div>
            </div>
          </div>
          <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
        </header>
        <ResourceDetailStack className="mt-6">
          <ResourceDetailConfigurationSection
            label={<Skeleton className="h-3.5 w-24" />}
          >
            <ResourceDetailPanel surface="recessed" className="px-3 py-3">
              <div className="space-y-4">
                <PluginSettingsFieldSkeleton />
                <PluginSettingsFieldSkeleton />
              </div>
            </ResourceDetailPanel>
          </ResourceDetailConfigurationSection>
        </ResourceDetailStack>
      </div>
    </div>
  );
}

export function PluginSettingsPage({
  pluginId,
  onBackToDetails,
}: {
  pluginId: string;
  onBackToDetails?: () => void;
}) {
  const listQuery = usePluginList({ enabled: true });

  const plugin =
    listQuery.data?.plugins.find(
      (entry: PluginListItem) => entry.id === pluginId,
    ) ?? null;

  if (listQuery.data === undefined && !listQuery.isError) {
    return <PluginSettingsPageSkeleton />;
  }

  if (listQuery.data === undefined && listQuery.isError) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Could not load plugin settings.
      </p>
    );
  }

  if (plugin === null) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        This plugin is not installed.
      </p>
    );
  }

  return (
    <PluginSettingsContent
      key={plugin.id}
      plugin={plugin}
      onBackToDetails={onBackToDetails}
    />
  );
}

function PluginSettingsDetailsLink({
  pluginId,
  onBackToDetails,
}: {
  pluginId: string;
  onBackToDetails?: () => void;
}) {
  const content = (
    <>
      <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
      Plugin details
    </>
  );

  const className =
    "-ml-2 mb-3 h-7 gap-1 px-2 text-xs font-normal text-muted-foreground hover:text-foreground";

  return onBackToDetails ? (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      onClick={onBackToDetails}
    >
      {content}
    </Button>
  ) : (
    <Button variant="ghost" size="sm" className={className} asChild>
      <Link to={getPluginDetailRoutePath({ pluginId, view: "installed" })}>
        {content}
      </Link>
    </Button>
  );
}

function PluginSettingsContent({
  plugin,
  onBackToDetails,
}: {
  plugin: PluginListItem;
  onBackToDetails?: () => void;
}) {
  const queryClient = useQueryClient();
  const { settingsSections } = usePluginSlots();

  const { toggle, enabled } = usePluginEnabledMutation(plugin, () =>
    invalidateMachineProviders({ queryClient }),
  );

  const hasAvailableSettings =
    plugin.hasSettings ||
    settingsSections.some((section) => section.pluginId === plugin.id);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PluginSettingsDetailsLink
        pluginId={plugin.id}
        onBackToDetails={onBackToDetails}
      />
      <header className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-9 shrink-0">
            <PluginIcon
              pluginId={plugin.id}
              icon={plugin.icon}
              className="size-full"
            />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-foreground">
              {plugin.name ?? plugin.id}
            </h1>
            {plugin.description ? (
              <p className="truncate text-xs text-subtle-foreground">
                {plugin.description}
              </p>
            ) : null}
          </div>
        </div>
        <Switch
          className="mr-[13px]"
          checked={enabled}
          disabled={toggle.isPending}
          onCheckedChange={(next) => toggle.mutate(next)}
          aria-label={`${enabled ? "Disable" : "Enable"} ${plugin.id}`}
        />
      </header>
      <ResourceDetailStack className="mt-6">
        {enabled && plugin.enabled ? (
          <PluginMachineServerAccessNotice pluginId={plugin.id} />
        ) : null}
        {enabled && plugin.enabled && hasAvailableSettings ? (
          <ResourceDetailConfigurationSection label="Configuration">
            <PluginSettingsDetail plugin={plugin} />
          </ResourceDetailConfigurationSection>
        ) : null}
      </ResourceDetailStack>
    </div>
  );
}

export function PluginSettingsDetail({ plugin }: { plugin: PluginListItem }) {
  const { settingsSections } = usePluginSlots();

  const hasSettingsSections = settingsSections.some(
    (section) => section.pluginId === plugin.id,
  );

  const settingsAvailable =
    plugin.enabled && PLUGIN_STATUSES_WITH_SETTINGS.includes(plugin.status);

  if (!plugin.hasSettings && !hasSettingsSections) return null;

  return (
    <div className="space-y-6" data-testid={`plugin-detail-${plugin.id}`}>
      {plugin.hasSettings || !settingsAvailable ? (
        <ResourceDetailPanel surface="recessed" className="px-3 py-3">
          {settingsAvailable ? (
            <PluginSettingsForm key={plugin.id} pluginId={plugin.id} />
          ) : (
            <p className="text-xs text-muted-foreground">
              {plugin.enabled
                ? `Settings are unavailable while the plugin is ${plugin.status}.`
                : "Enable this plugin to edit its settings."}
            </p>
          )}
        </ResourceDetailPanel>
      ) : null}
      {settingsAvailable ? (
        <PluginSettingsSections pluginId={plugin.id} />
      ) : null}
    </div>
  );
}
