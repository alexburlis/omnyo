import { UsagePrivacyControls } from "./UsagePrivacyControls";
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
import { useState } from "react";
import {
  defaultAppSettings,
  managedBranchPrefixSchema,
  type AppSettings,
} from "@omnyo/domain";
import { Input } from "@omnyo/shared-ui/input";
import { Switch } from "@omnyo/shared-ui/switch";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { useUpdateGeneralSettings } from "@/hooks/mutations/settings-mutations";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { isDesktopBrowserAvailable } from "@/lib/omnyo-desktop";
import { useOpenLinksInAppBrowserPreference } from "@/lib/in-app-browser-link-preference";
import { useRewriteLocalhostLinksPreference } from "@/lib/localhost-link-rewrite-preference";
import { localhostLinkRewriteDescription } from "@/lib/localhost-link-rewrite-description";
import { useNavigateToThreadAfterCreatePreference } from "@/lib/root-compose-create-preference";
import { VoiceInputSettingsSection } from "./VoiceInputSettingsSection";
import { CliSkillsSettingsSection } from "./CliSkillsSettingsSection";
import { SETTINGS_ROW_STACK_CLASS } from "./settings-row-stack";

const COMPACT_EXPIRED_CACHE_SETTING_LABEL =
  "Offer to compact before resuming expired sessions";

interface ServerSettingsControls {
  settings: AppSettings;
  disabled: boolean;
  onSettingsChange: (patch: Partial<AppSettings>) => void;
}

interface GeneralSettingsSectionProps extends ServerSettingsControls {
  desktopBrowserAvailable: boolean;
  navigateToThreadAfterCreate: boolean;
  openLinksInAppBrowser: boolean;
  rewriteLocalhostLinks: boolean;
  onManagedBranchPrefixChange: (prefix: string) => Promise<void> | void;
  onNavigateToThreadAfterCreateChange: (enabled: boolean) => void;
  onOpenLinksInAppBrowserChange: (enabled: boolean) => void;
  onRewriteLocalhostLinksChange: (enabled: boolean) => void;
}

const IN_APP_BROWSER_LINK_SETTING_LABEL = "Open links in the in-app browser";

const REWRITE_LOCALHOST_LINKS_SETTING_LABEL = "Rewrite localhost links";

const NAVIGATE_TO_THREAD_AFTER_CREATE_SETTING_LABEL =
  "Navigate to threads on creation";

const DIAGNOSTIC_EVENTS_SETTING_LABEL = "Show diagnostic events";

const FOLLOW_UP_BEHAVIOR_SETTING_LABEL = "Default thread followup behavior";

const FOLLOW_UP_BEHAVIOR_OPTIONS = [
  {
    steerOnEnter: false,
    label: "Queue",
    description:
      "Enter adds a follow-up. It runs when the agent stops. Command+Enter (Ctrl+Enter on Windows and Linux) steers the run.",
  },
  {
    steerOnEnter: true,
    label: "Steer",
    description:
      "Enter steers the run now. Command+Enter (Ctrl+Enter on Windows and Linux) adds a follow-up for later.",
  },
] as const;

const STREAMER_MODE_SETTING_LABEL = "Streamer mode";

const MANAGED_BRANCH_PREFIX_SETTING_LABEL = "New branch prefix";

const MANAGED_BRANCH_PREFIX_EXAMPLE_SLUG = "fix-login-flow-thr_ab12cd34ef";

interface ManagedBranchPrefixSettingProps {
  disabled: boolean;
  onChange: (prefix: string) => Promise<void> | void;
  value: string;
}

function ManagedBranchPrefixSetting({
  disabled,
  onChange,
  value,
}: ManagedBranchPrefixSettingProps) {
  const [draft, setDraft] = useState(value);
  const [committedValue, setCommittedValue] = useState(value);

  if (value !== committedValue) {
    setCommittedValue(value);
    setDraft(value);
  }

  const valid = managedBranchPrefixSchema.safeParse(draft).success;

  const commit = () => {
    if (!valid) {
      setDraft(value);

      return;
    }

    if (draft !== value) {
      void Promise.resolve(onChange(draft)).catch(() => setDraft(value));
    }
  };

  return (
    <SettingsWithControl
      label={MANAGED_BRANCH_PREFIX_SETTING_LABEL}
      description={
        valid ? (
          `Omnyo puts this in front of every branch it creates for a worktree, such as ${draft}${MANAGED_BRANCH_PREFIX_EXAMPLE_SLUG}. Leave it empty for no prefix.`
        ) : (
          <span className="text-destructive" role="alert">
            This prefix cannot start a valid git branch name.
          </span>
        )
      }
      controlPlacement="below"
    >
      <Input
        value={draft}
        aria-label={MANAGED_BRANCH_PREFIX_SETTING_LABEL}
        aria-invalid={!valid}
        disabled={disabled}
        placeholder="No prefix"
        className={cn(
          "h-8 font-mono text-xs",
          !valid && "border-destructive focus-visible:ring-destructive",
        )}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }

          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value);
          }
        }}
      />
    </SettingsWithControl>
  );
}

export function GeneralSettingsSection({
  settings,
  disabled,
  onSettingsChange,
  desktopBrowserAvailable,
  navigateToThreadAfterCreate,
  openLinksInAppBrowser,
  rewriteLocalhostLinks,
  onManagedBranchPrefixChange,
  onNavigateToThreadAfterCreateChange,
  onOpenLinksInAppBrowserChange,
  onRewriteLocalhostLinksChange,
}: GeneralSettingsSectionProps) {
  const localhostRewriteDescription = localhostLinkRewriteDescription(
    typeof window === "undefined" ? undefined : window.location.hostname,
  );

  return (
    <>
      <SettingsSection title="Threads & editing">
        <div className={SETTINGS_ROW_STACK_CLASS}>
          <SettingsWithControl
            label={NAVIGATE_TO_THREAD_AFTER_CREATE_SETTING_LABEL}
          >
            <Switch
              checked={navigateToThreadAfterCreate}
              onCheckedChange={onNavigateToThreadAfterCreateChange}
              aria-label={NAVIGATE_TO_THREAD_AFTER_CREATE_SETTING_LABEL}
            />
          </SettingsWithControl>

          <SettingsWithControl
            label="Show Git status"
            description="Show branch, changes, pull request and Commit in the thread header."
          >
            <Switch
              checked={settings.showGitChanges}
              disabled={disabled}
              onCheckedChange={(value) =>
                onSettingsChange({ showGitChanges: value })
              }
              aria-label="Show Git status"
            />
          </SettingsWithControl>

          <SettingsWithControl
            label={FOLLOW_UP_BEHAVIOR_SETTING_LABEL}
            description="What Enter does in the prompt box while the thread runs."
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={SETTINGS_COMPACT_DROPDOWN_TRIGGER_CLASS}
                  disabled={disabled}
                  aria-label={FOLLOW_UP_BEHAVIOR_SETTING_LABEL}
                >
                  {settings.steerActiveThreadOnEnter ? "Steer" : "Queue"}
                  <Icon
                    name="ChevronDown"
                    className="size-3.5 text-muted-foreground"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={cn(SETTINGS_DROPDOWN_CONTENT_CLASS, "max-w-72")}
              >
                {FOLLOW_UP_BEHAVIOR_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.label}
                    className="items-start"
                    onSelect={() =>
                      onSettingsChange({
                        steerActiveThreadOnEnter: option.steerOnEnter,
                      })
                    }
                  >
                    <span className="min-w-0">
                      <span className="block">{option.label}</span>
                      <span className="block text-2xs leading-snug text-subtle-foreground">
                        {option.description}
                      </span>
                    </span>
                    <Icon
                      name="Check"
                      className={cn(
                        "ml-auto",
                        settings.steerActiveThreadOnEnter !==
                          option.steerOnEnter && "opacity-0",
                        COARSE_POINTER_ICON_SIZE_CLASS,
                      )}
                    />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsWithControl>

          <SettingsWithControl
            label="Thread archive confirmation"
            description="Ask before archiving a thread with unarchived child threads."
          >
            <Switch
              checked={settings.confirmThreadArchive}
              disabled={disabled}
              onCheckedChange={(value) =>
                onSettingsChange({ confirmThreadArchive: value })
              }
              aria-label="Thread archive confirmation"
            />
          </SettingsWithControl>

          <SettingsWithControl
            label="Show messages from before a context clear"
            description="Earlier messages stay in the thread for you to read. The agent doesn't see them."
          >
            <Switch
              checked={settings.keepHistoryAfterContextClear}
              disabled={disabled}
              onCheckedChange={(value) =>
                onSettingsChange({ keepHistoryAfterContextClear: value })
              }
              aria-label="Show messages from before a context clear"
            />
          </SettingsWithControl>

          <SettingsWithControl
            label={COMPACT_EXPIRED_CACHE_SETTING_LABEL}
            description="When a long idle thread's prompt cache has expired, offer to compact before your next message. Works with providers that support compaction."
          >
            <Switch
              checked={settings.compactExpiredCache}
              disabled={disabled}
              onCheckedChange={(value) =>
                onSettingsChange({ compactExpiredCache: value })
              }
              aria-label={COMPACT_EXPIRED_CACHE_SETTING_LABEL}
            />
          </SettingsWithControl>

          <SettingsWithControl
            label="Setup guide"
            description="Walk through connecting an agent, adding projects, importing chats, plugins, and devices again."
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => onSettingsChange({ onboardingCompletedAt: null })}
            >
              Show setup guide
            </Button>
          </SettingsWithControl>
        </div>
      </SettingsSection>
      {desktopBrowserAvailable || localhostRewriteDescription !== null ? (
        <SettingsSection title="Links">
          <div className={SETTINGS_ROW_STACK_CLASS}>
            {desktopBrowserAvailable ? (
              <SettingsWithControl
                label={IN_APP_BROWSER_LINK_SETTING_LABEL}
                description="Open web links inside Omnyo."
              >
                <Switch
                  checked={openLinksInAppBrowser}
                  onCheckedChange={onOpenLinksInAppBrowserChange}
                  aria-label={IN_APP_BROWSER_LINK_SETTING_LABEL}
                />
              </SettingsWithControl>
            ) : null}

            {localhostRewriteDescription !== null ? (
              <SettingsWithControl
                label={REWRITE_LOCALHOST_LINKS_SETTING_LABEL}
                description={
                  <span className="break-words [overflow-wrap:anywhere]">
                    {localhostRewriteDescription}
                  </span>
                }
              >
                <Switch
                  checked={rewriteLocalhostLinks}
                  onCheckedChange={onRewriteLocalhostLinksChange}
                  aria-label={REWRITE_LOCALHOST_LINKS_SETTING_LABEL}
                />
              </SettingsWithControl>
            ) : null}
          </div>
        </SettingsSection>
      ) : null}
      <SettingsSection title="Git">
        <div className={SETTINGS_ROW_STACK_CLASS}>
          <ManagedBranchPrefixSetting
            value={settings.managedBranchPrefix}
            disabled={disabled}
            onChange={onManagedBranchPrefixChange}
          />
        </div>
      </SettingsSection>
    </>
  );
}

export function PrivacySettingsSection({
  settings,
  disabled,
  onSettingsChange,
}: ServerSettingsControls) {
  return (
    <SettingsSection title="Privacy & diagnostics">
      <div className={SETTINGS_ROW_STACK_CLASS}>
        <SettingsWithControl
          label={STREAMER_MODE_SETTING_LABEL}
          description="Hide the custom models from config.json in every model picker, so a screen share does not show them."
        >
          <Switch
            checked={settings.streamerMode}
            disabled={disabled}
            onCheckedChange={(value) =>
              onSettingsChange({ streamerMode: value })
            }
            aria-label={STREAMER_MODE_SETTING_LABEL}
          />
        </SettingsWithControl>

        <UsagePrivacyControls disabled={disabled} />

        <SettingsWithControl
          label="Crash reports"
          description="Send error reports from the app, this server and its machines to help fix crashes."
        >
          <Switch
            checked={settings.crashReportsEnabled}
            disabled={disabled}
            onCheckedChange={(value) =>
              onSettingsChange({ crashReportsEnabled: value })
            }
            aria-label="Crash reports"
          />
        </SettingsWithControl>

        <SettingsWithControl
          label={DIAGNOSTIC_EVENTS_SETTING_LABEL}
          description="Show provider environment resolution and unhandled provider events for troubleshooting."
        >
          <Switch
            checked={settings.showDiagnosticEvents}
            disabled={disabled}
            onCheckedChange={(value) =>
              onSettingsChange({ showDiagnosticEvents: value })
            }
            aria-label={DIAGNOSTIC_EVENTS_SETTING_LABEL}
          />
        </SettingsWithControl>
      </div>
    </SettingsSection>
  );
}

export function GeneralSettingsPage() {
  const systemConfigQuery = useSystemConfig();

  const [openLinksInAppBrowser, setOpenLinksInAppBrowser] =
    useOpenLinksInAppBrowserPreference();

  const [rewriteLocalhostLinks, setRewriteLocalhostLinks] =
    useRewriteLocalhostLinksPreference();

  const [navigateToThreadAfterCreate, setNavigateToThreadAfterCreate] =
    useNavigateToThreadAfterCreatePreference();

  const [desktopBrowserAvailable] = useState(isDesktopBrowserAvailable);

  const generalSettings =
    systemConfigQuery.data?.generalSettings ?? defaultAppSettings;

  const updateGeneralSettingsMutation = useUpdateGeneralSettings();

  return (
    <>
      <GeneralSettingsSection
        settings={generalSettings}
        disabled={systemConfigQuery.data === undefined}
        onSettingsChange={updateGeneralSettingsMutation.mutate}
        desktopBrowserAvailable={desktopBrowserAvailable}
        onManagedBranchPrefixChange={async (prefix) => {
          await updateGeneralSettingsMutation.mutateAsync({
            managedBranchPrefix: prefix,
          });
        }}
        navigateToThreadAfterCreate={navigateToThreadAfterCreate}
        onNavigateToThreadAfterCreateChange={setNavigateToThreadAfterCreate}
        openLinksInAppBrowser={openLinksInAppBrowser}
        onOpenLinksInAppBrowserChange={setOpenLinksInAppBrowser}
        rewriteLocalhostLinks={rewriteLocalhostLinks}
        onRewriteLocalhostLinksChange={setRewriteLocalhostLinks}
      />
      <CliSkillsSettingsSection />
      <VoiceInputSettingsSection />
      <PrivacySettingsSection
        settings={generalSettings}
        disabled={systemConfigQuery.data === undefined}
        onSettingsChange={updateGeneralSettingsMutation.mutate}
      />
    </>
  );
}
