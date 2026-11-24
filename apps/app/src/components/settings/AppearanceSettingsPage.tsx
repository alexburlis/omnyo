import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section.js";
import {
  SETTINGS_COMPACT_DROPDOWN_TRIGGER_CLASS,
  SETTINGS_DROPDOWN_CONTENT_CLASS,
} from "./settings-dropdown";
import { useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  builtInThemes,
  defaultAppTheme,
  type AppTheme,
  type FaviconColorPreference,
  type PluginThemeMeta,
} from "@omnyo/domain";
import { DropdownMenuSeparator } from "@omnyo/shared-ui/dropdown-menu";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { OmnyoLogo } from "@/components/ui/omnyo-logo";
import {
  setPreferredTheme,
  useThemePreference,
  type ThemePreference,
} from "@/hooks/useTheme";
import { useAppThemePreview } from "@/hooks/useAppThemePreview";
import { useUpdateAppearance } from "@/hooks/mutations/settings-mutations";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  FAVICON_COLOR_VALUES,
  getFaviconGlyphHref,
} from "@/lib/favicon-color-preference";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { CodeRendererSettings } from "./CodeRendererSettings";
import { SidebarThreadListSetting } from "./SidebarThreadListSetting";
import { SidebarFooterSettings } from "./SidebarFooterSettings";
import { SplitDimmingSetting } from "./SplitDimmingSetting";
import { SETTINGS_ROW_STACK_CLASS } from "./settings-row-stack";

interface ThemePreferenceOption {
  label: string;
  value: ThemePreference;
}

interface FaviconColorOption {
  label: string;
  value: FaviconColorPreference;
}

interface FaviconColorSettingsControlProps {
  disabled: boolean;
  faviconColor: FaviconColorPreference;
  onFaviconColorChange: (faviconColor: FaviconColorPreference) => void;
}

interface AppearanceSettingsSectionProps {
  appearance: AppTheme;
  appearanceDisabled: boolean;
  customThemes: readonly string[];
  pluginThemes: readonly PluginThemeMeta[];
  faviconColor: FaviconColorPreference;
  onAppearanceThemeChange: (themeId: string) => void;
  onAppearanceThemePrefetch: (themeIds: readonly string[]) => void;
  onAppearanceThemePreview: (themeId: string | null) => void;
  onCreatePalette: () => void;
  onFaviconColorChange: (faviconColor: FaviconColorPreference) => void;
  onThemePreferenceChange: (themePreference: ThemePreference) => void;
  themePreference: ThemePreference;
}

function appPaletteLabel(
  appearance: AppTheme,
  pluginThemes: readonly PluginThemeMeta[],
): string {
  const meta = builtInThemes.find((entry) => entry.id === appearance.themeId);

  return (
    meta?.name ??
    pluginThemes.find((entry) => entry.id === appearance.themeId)?.name ??
    appearance.themeId
  );
}

const THEME_PREFERENCE_OPTIONS: ReadonlyArray<ThemePreferenceOption> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

const FAVICON_COLOR_OPTIONS: ReadonlyArray<FaviconColorOption> = [
  { label: "Default", value: "default" },
  { label: "Red", value: "red" },
  { label: "Orange", value: "orange" },
  { label: "Yellow", value: "yellow" },
  { label: "Green", value: "green" },
  { label: "Teal", value: "teal" },
  { label: "Blue", value: "blue" },
  { label: "Purple", value: "purple" },
  { label: "Pink", value: "pink" },
];

const FAVICON_COLOR_LABELS: Record<FaviconColorPreference, string> = {
  blue: "Blue",
  default: "Default",
  green: "Green",
  orange: "Orange",
  pink: "Pink",
  purple: "Purple",
  red: "Red",
  teal: "Teal",
  yellow: "Yellow",
};

const CREATE_CUSTOM_PALETTE_PROMPT =
  "Create a custom Omnyo palette. First run `omnyo theme dir` to find the custom theme directory. Ask me for the palette name and visual direction, then create `<theme-dir>/<name>/theme.css` with light and dark theme variables compatible with Omnyo's theme tokens.";

const PALETTE_SETTING_DESCRIPTION =
  "Palettes change Omnyo's colors, including syntax colors in diffs and file previews. Choose a built-in palette or create one from a prompt.";

interface PaletteMenuItemProps {
  active: boolean;
  children: ReactNode;
  onPreview: (themeId: string | null) => void;
  onSelect: (themeId: string) => void;
  themeId: string;
}

function PaletteMenuItem({
  active,
  children,
  onPreview,
  onSelect,
  themeId,
}: PaletteMenuItemProps) {
  return (
    <DropdownMenuItem
      onFocus={() => onPreview(themeId)}
      onBlur={() => onPreview(null)}
      onSelect={() => onSelect(themeId)}
    >
      {children}
      <Icon
        name="Check"
        className={cn(
          "ml-auto",
          !active && "opacity-0",
          COARSE_POINTER_ICON_SIZE_CLASS,
        )}
      />
    </DropdownMenuItem>
  );
}

function FaviconColorPreview({ value }: { value: FaviconColorPreference }) {
  if (value === "default") return <OmnyoLogo className="size-4 shrink-0" />;

  return (
    <span
      aria-hidden
      className="size-4 shrink-0"
      style={{
        mask: `url("${getFaviconGlyphHref()}") center / contain no-repeat`,
        backgroundColor: FAVICON_COLOR_VALUES[value],
      }}
    />
  );
}

function FaviconColorSettingsControl({
  disabled,
  faviconColor,
  onFaviconColorChange,
}: FaviconColorSettingsControlProps) {
  return (
    <SettingsWithControl
      label="Favicon color"
      description="Tint browser tabs to tell instances apart."
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={SETTINGS_COMPACT_DROPDOWN_TRIGGER_CLASS}
            aria-label="Favicon color"
            disabled={disabled}
          >
            <span className="flex min-w-0 items-center gap-2">
              <FaviconColorPreview value={faviconColor} />
              <span className="min-w-0 truncate">
                {FAVICON_COLOR_LABELS[faviconColor]}
              </span>
            </span>
            <Icon
              name="ChevronDown"
              className="size-3.5 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={SETTINGS_DROPDOWN_CONTENT_CLASS}
        >
          {FAVICON_COLOR_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => onFaviconColorChange(option.value)}
            >
              <FaviconColorPreview value={option.value} />
              {option.label}
              <Icon
                name="Check"
                className={cn(
                  "ml-auto",
                  faviconColor !== option.value && "opacity-0",
                  COARSE_POINTER_ICON_SIZE_CLASS,
                )}
              />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsWithControl>
  );
}

export function AppearanceSettingsSection({
  appearance,
  appearanceDisabled,
  customThemes,
  pluginThemes,
  faviconColor,
  onAppearanceThemeChange,
  onAppearanceThemePrefetch,
  onAppearanceThemePreview,
  onFaviconColorChange,
  onCreatePalette,
  onThemePreferenceChange,
  themePreference,
}: AppearanceSettingsSectionProps) {
  const paletteSelectedRef = useRef(false);

  const previewPalette = (themeId: string | null) => {
    if (themeId === null && paletteSelectedRef.current) return;
    onAppearanceThemePreview(themeId);
  };

  const selectPalette = (themeId: string) => {
    paletteSelectedRef.current = true;
    onAppearanceThemeChange(themeId);
  };

  return (
    <div className="space-y-6">
      <SettingsSection title="Appearance">
        <div className={SETTINGS_ROW_STACK_CLASS}>
          <SettingsWithControl label="Theme">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={SETTINGS_COMPACT_DROPDOWN_TRIGGER_CLASS}
                  aria-label="Theme"
                >
                  {THEME_PREFERENCE_LABELS[themePreference]}
                  <Icon
                    name="ChevronDown"
                    className="size-3.5 text-muted-foreground"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={SETTINGS_DROPDOWN_CONTENT_CLASS}
              >
                {THEME_PREFERENCE_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onSelect={() => onThemePreferenceChange(option.value)}
                  >
                    {option.label}
                    <Icon
                      name="Check"
                      className={cn(
                        "ml-auto",
                        themePreference !== option.value && "opacity-0",
                        COARSE_POINTER_ICON_SIZE_CLASS,
                      )}
                    />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsWithControl>

          <SettingsWithControl
            label="Palette"
            description={PALETTE_SETTING_DESCRIPTION}
          >
            <DropdownMenu
              onOpenChange={(open) => {
                if (open) {
                  paletteSelectedRef.current = false;
                  onAppearanceThemePrefetch([
                    ...builtInThemes.map((entry) => entry.id),
                    ...customThemes,
                    ...pluginThemes.map((theme) => theme.id),
                  ]);

                  return;
                }

                previewPalette(null);
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={SETTINGS_COMPACT_DROPDOWN_TRIGGER_CLASS}
                  aria-label="Palette"
                  disabled={appearanceDisabled}
                >
                  <span className="min-w-0 truncate">
                    {appPaletteLabel(appearance, pluginThemes)}
                  </span>
                  <Icon
                    name="ChevronDown"
                    className="size-3.5 text-muted-foreground"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={SETTINGS_DROPDOWN_CONTENT_CLASS}
              >
                {builtInThemes.map((entry) => (
                  <PaletteMenuItem
                    key={entry.id}
                    themeId={entry.id}
                    active={appearance.themeId === entry.id}
                    onPreview={previewPalette}
                    onSelect={selectPalette}
                  >
                    {entry.name}
                  </PaletteMenuItem>
                ))}
                {customThemes.map((name) => (
                  <PaletteMenuItem
                    key={`custom:${name}`}
                    themeId={name}
                    active={appearance.themeId === name}
                    onPreview={previewPalette}
                    onSelect={selectPalette}
                  >
                    {name}
                  </PaletteMenuItem>
                ))}
                {pluginThemes.map((theme) => (
                  <PaletteMenuItem
                    key={theme.id}
                    themeId={theme.id}
                    active={appearance.themeId === theme.id}
                    onPreview={previewPalette}
                    onSelect={selectPalette}
                  >
                    {theme.name}
                    <span className="text-muted-foreground">
                      ({theme.pluginId})
                    </span>
                  </PaletteMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onCreatePalette}>
                  <Icon
                    name="Plus"
                    className={COARSE_POINTER_ICON_SIZE_CLASS}
                  />
                  Create
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsWithControl>

          <FaviconColorSettingsControl
            disabled={appearanceDisabled}
            faviconColor={faviconColor}
            onFaviconColorChange={onFaviconColorChange}
          />
          <SplitDimmingSetting />
        </div>
      </SettingsSection>
      <SettingsSection title="Interface">
        <div className={SETTINGS_ROW_STACK_CLASS}>
          <SidebarThreadListSetting />
          <CodeRendererSettings />
          <SidebarFooterSettings />
        </div>
      </SettingsSection>
    </div>
  );
}

export function AppearanceSettingsPage() {
  const navigate = useNavigate();
  const themePreference = useThemePreference();
  const systemConfigQuery = useSystemConfig();
  const appearance = systemConfigQuery.data?.appearance ?? defaultAppTheme;
  const updateAppearanceMutation = useUpdateAppearance();
  const appThemePreview = useAppThemePreview();

  return (
    <AppearanceSettingsSection
      appearance={appearance}
      appearanceDisabled={
        systemConfigQuery.data === undefined ||
        updateAppearanceMutation.isPending
      }
      customThemes={systemConfigQuery.data?.customThemes ?? []}
      pluginThemes={systemConfigQuery.data?.pluginThemes ?? []}
      faviconColor={appearance.faviconColor}
      themePreference={themePreference}
      onAppearanceThemeChange={(themeId) =>
        updateAppearanceMutation.mutate(
          {
            themeId,
            faviconColor: appearance.faviconColor,
          },
          { onError: () => appThemePreview.previewTheme(null) },
        )
      }
      onAppearanceThemePrefetch={appThemePreview.prefetchThemes}
      onAppearanceThemePreview={appThemePreview.previewTheme}
      onCreatePalette={() =>
        navigate(getRootComposeRoutePath(), {
          state: {
            focusPrompt: true,
            initialPrompt: CREATE_CUSTOM_PALETTE_PROMPT,
          },
        })
      }
      onFaviconColorChange={(faviconColor) =>
        updateAppearanceMutation.mutate({
          themeId: appearance.themeId,
          faviconColor,
        })
      }
      onThemePreferenceChange={setPreferredTheme}
    />
  );
}
