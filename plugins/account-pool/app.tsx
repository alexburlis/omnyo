import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  definePluginApp,
  experimental_copyToClipboard,
  experimental_useAppNavigate,
  useRealtime,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  DISCLOSURE_CHEVRON_TRANSITION,
  getSortableTransition,
  usePrefersReducedMotion,
} from "@/components/ui/motion";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import type {
  AccountSummary,
  AccountPoolConfig,
  AccountPoolConfigSetInput,
  FamilyQuota,
  LimitWindow,
  LoginTarget,
  ModelFamily,
  PoolAvailability,
  PoolProvider,
  PoolStatus,
} from "./src/contracts.js";
import type { accountPoolRpcContract } from "./src/rpc.js";
import type { CodexDeviceLoginStart } from "./src/codex-device-login.js";
import {
  AccountListRow,
  SettingsBadge,
  type QuotaSlot,
} from "./AccountListRow.js";
import {
  NativeClaudeProfiles,
  type ClaudeSetup,
} from "./NativeClaudeProfiles.js";
import {
  CLAUDE_POOL_LOGIN_RETIRED,
  DEFAULT_ACCOUNT_POOL_CONFIG,
  isLegacyClaudeAccount,
  modelFamilySchema,
  statusSchema,
} from "./src/contracts.js";
import { rejoinAt } from "./src/quota.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./src/realtime.js";

type DialogState =
  | { kind: "account" | "priority" | "remove"; accountId: string }
  | { kind: "codex-login"; target: LoginTarget }
  | { kind: "api-key"; provider: PoolProvider }
  | null;

const NEW_LOGIN: LoginTarget = { kind: "add", label: null, priority: 100 };

type ConfigField = Exclude<keyof AccountPoolConfig, "parentMode">;

const CONFIG_FIELDS: readonly ConfigField[] = [
  "anthropicUpstreamBaseUrl",
  "codexUpstreamBaseUrl",
  "switchThreshold",
];

const ACCOUNT_ACTIONS = [
  "toggle",
  "priority",
  "refresh",
  "relogin",
  "remove",
] as const;

const PROVIDERS: Array<{
  id: PoolProvider;
  title: string;
  description: string;
}> = [
  {
    id: "claude",
    title: "Claude",
    description:
      "Use a Claude subscription or route through an Anthropic API key.",
  },
  {
    id: "codex",
    title: "Codex",
    description:
      "Route Codex threads through ChatGPT accounts or OpenAI API keys.",
  },
];

const FAMILY_LABELS: Record<ModelFamily, string> = {
  fable: "Fable 7 day",
  sonnet: "Sonnet 7 day",
  opus: "Opus 7 day",
  haiku: "Haiku 7 day",
  other: "Other 7 day",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpUrlError(value: string): string | null {
  try {
    const protocol = new URL(value).protocol;

    return protocol === "http:" || protocol === "https:"
      ? null
      : "Must be an HTTP or HTTPS URL.";
  } catch {
    return "Must be a valid URL.";
  }
}

function configDrafts(config: AccountPoolConfig): Record<ConfigField, string> {
  return {
    anthropicUpstreamBaseUrl: config.anthropicUpstreamBaseUrl,
    codexUpstreamBaseUrl: config.codexUpstreamBaseUrl,
    switchThreshold: String(config.switchThreshold),
  };
}

function parentHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function parentBannerBody(parent: NonNullable<PoolStatus["parent"]>): string {
  const host = parentHost(parent.baseUrl);

  if (parent.mode !== "proxy") {
    return `This server was started from a thread on ${host}. Turn this on to use its Anthropic API keys and Codex accounts.`;
  }

  const served = PROVIDERS.filter(
    (provider) => parent.availability[provider.id],
  ).map((provider) => provider.title);

  if (served.length === 0) {
    return `${host} has no accounts available right now, so nothing is being sent there. Requests fall back to each provider's own credentials.`;
  }

  const missing = PROVIDERS.filter(
    (provider) => !parent.availability[provider.id],
  ).map((provider) => provider.title);

  const routed = `${served.join(" and ")} requests are sent to the pool on ${host}.`;

  return missing.length === 0
    ? `${routed} Accounts on this server are not used while this is on.`
    : `${routed} ${missing.join(" and ")} has no accounts there, so those requests fall back to their own credentials.`;
}

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function relative(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));

  if (minutes < 1) return "just now";

  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);

  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function windowShortLabel(window: LimitWindow): string {
  if (window.windowMinutes === null)
    return window.slot === "primary" ? "LIMIT" : "LIMIT 2";

  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440}D`;

  if (window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60}H`;

  return `${window.windowMinutes}M`;
}

function windowLongLabel(window: LimitWindow): string {
  if (window.windowMinutes === null)
    return window.slot === "primary" ? "Usage limit" : "Secondary limit";

  if (window.windowMinutes === 7 * 24 * 60) return "Weekly";

  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440} day`;

  if (window.windowMinutes % 60 === 0)
    return `${window.windowMinutes / 60} hour`;

  return `${window.windowMinutes} minute`;
}

function resetLabel(timestamp: number | null): string {
  if (timestamp === null) return "";
  const minutes = Math.max(1, Math.round((timestamp - Date.now()) / 60_000));

  if (minutes < 1_440)
    return `resets in ${minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`}`;

  return `resets ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp)}`;
}

const STATUS_CACHE_KEY = "account-pool:status";

function readCachedStatus(): PoolStatus | null {
  try {
    const raw = window.localStorage.getItem(STATUS_CACHE_KEY);

    if (raw === null) return null;
    const parsed = statusSchema.safeParse(JSON.parse(raw));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeCachedStatus(status: PoolStatus): void {
  try {
    window.localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify(status));
  } catch {
    return;
  }
}

function statusPresentation(
  account: AccountSummary,
  threshold: number,
): {
  label: string;
  dot: string;
} {
  if (account.status === "held")
    return {
      label: `Held${account.heldUntil === null ? "" : ` · retry at ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(account.heldUntil)}`}`,
      dot: "bg-warning",
    };

  if (account.status === "exhausted") {
    const resetAt = rejoinAt(account, null, threshold, Date.now());

    return {
      label: `Exhausted${resetAt === null ? "" : ` · ${resetLabel(resetAt)}`}`,
      dot: "bg-destructive",
    };
  }

  if (account.status === "error")
    return { label: "Error", dot: "bg-destructive" };

  if (account.status === "disabled")
    return { label: "Disabled", dot: "bg-muted-foreground" };

  return { label: "Ready", dot: "bg-success" };
}

function tier(account: AccountSummary): string {
  return (
    account.subscriptionType ??
    (account.kind === "api-key" ? "API key" : "OAuth")
  );
}

function secondaryEmail(account: AccountSummary): string | null {
  return account.email === null || account.email === account.label
    ? null
    : account.email;
}

function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="@container/pool-section space-y-3">
      <div className="flex flex-col gap-3 @min-[36rem]/pool-section:flex-row @min-[36rem]/pool-section:items-start @min-[36rem]/pool-section:justify-between @min-[36rem]/pool-section:gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">
            {description}
          </p>
        </div>
        <div className="shrink-0 self-start">{action}</div>
      </div>
      <div className="border-t border-border">{children}</div>
    </section>
  );
}

function quotaSlots(account: AccountSummary): QuotaSlot[] {
  if (account.provider === "codex") {
    if (account.limitWindows.length === 0)
      return [
        { key: "primary", label: "LIMIT", utilization: null, status: null },
      ];

    return account.limitWindows.map((window) => ({
      key: window.slot,
      label: windowShortLabel(window),
      utilization: window.utilization,
      status: window.status,
    }));
  }

  return [
    {
      key: "five-hour",
      label: "5H",
      utilization: account.fiveHourUtilization,
      status: account.fiveHourStatus,
    },
    {
      key: "seven-day",
      label: "7D",
      utilization: account.sevenDayUtilization,
      status: account.sevenDayStatus,
    },
    {
      key: "fable",
      label: "FABLE",
      utilization: account.familyWeekly.fable?.utilization ?? null,
      status: account.familyWeekly.fable?.status ?? null,
    },
  ];
}

const restrictAccountDragToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

const accountDragModifiers: Modifier[] = [restrictAccountDragToVerticalAxis];

function AccountRow({
  account,
  threshold,
  pending,
  refreshing,
  onAction,
  onOpen,
  reorderDisabled,
}: {
  account: AccountSummary;
  threshold: number;
  pending: boolean;
  refreshing: boolean;
  onAction: (action: (typeof ACCOUNT_ACTIONS)[number]) => void;
  onOpen: () => void;
  reorderDisabled: boolean;
}) {
  const status = statusPresentation(account, threshold);
  const slots = quotaSlots(account);
  const email = secondaryEmail(account);
  const reducedMotion = usePrefersReducedMotion();

  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: account.id,
    disabled: pending || reorderDisabled,
    transition: getSortableTransition(reducedMotion),
  });

  return (
    <AccountListRow
      name={account.label}
      secondaryName={email}
      badges={
        <>
          <SettingsBadge>{tier(account)}</SettingsBadge>
          {account.extraUsage?.status === "allowed" ? (
            <SettingsBadge>Extra usage available</SettingsBadge>
          ) : null}
        </>
      }
      status={status}
      statusDetail={
        <>
          {account.lastUsedAt === null ? null : (
            <span>used {relative(account.lastUsedAt)}</span>
          )}
          {refreshing ? <span>refreshing usage…</span> : null}
        </>
      }
      slots={slots}
      threshold={threshold}
      refreshing={refreshing}
      disabled={!account.enabled}
      onOpen={onOpen}
      rowRef={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      dragging={isDragging}
      leading={
        <Button
          ref={setActivatorNodeRef}
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 touch-none text-muted-foreground enabled:cursor-grab enabled:active:cursor-grabbing"
          disabled={pending || reorderDisabled}
          aria-label={`Reorder ${account.label}`}
          {...attributes}
          {...listeners}
        >
          <Icon name="DragDropVertical" aria-hidden="true" />
        </Button>
      }
      actions={
        <>
          <DropdownMenuItem
            disabled={pending || isLegacyClaudeAccount(account)}
            onSelect={() => onAction("toggle")}
          >
            <Icon name={account.enabled ? "Circle" : "CircleCheck"} />
            {account.enabled ? "Disable" : "Enable"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pending}
            onSelect={() => onAction("priority")}
          >
            <Icon name="ListView" />
            Set priority…
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pending || isLegacyClaudeAccount(account)}
            onSelect={() => onAction("refresh")}
          >
            <Icon name="RotateCcw" />
            Refresh usage
          </DropdownMenuItem>
          {account.provider === "codex" && account.kind === "oauth" ? (
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("relogin")}
            >
              <Icon name="UserRound" />
              Sign in again…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={pending}
            onSelect={() => onAction("remove")}
          >
            <Icon name="Trash2" />
            Remove
          </DropdownMenuItem>
        </>
      }
    />
  );
}

function AddAccountMenu({
  provider,
  proxying,
  signIn,
  adopt,
  addApiKey,
}: {
  provider: PoolProvider;
  proxying: boolean;
  signIn: () => void;
  adopt: () => void;
  addApiKey: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={proxying && provider === "codex"}
        >
          <Icon name="Plus" className="size-3.5" />
          Add account
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem className="items-start py-2" onSelect={signIn}>
          <Icon name="UserRound" className="mt-0.5" />
          <span>
            <span className="block">
              {provider === "claude" ? "Sign in to Claude" : "Sign in to Codex"}
            </span>
            {provider === "codex" ? (
              <span className="block text-xs text-muted-foreground">
                Opens ChatGPT with a device code
              </span>
            ) : null}
          </span>
        </DropdownMenuItem>
        {provider === "claude" ? (
          <DropdownMenuItem onSelect={adopt}>
            <Icon name="UserRound" />
            Use existing Claude sign-in
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={proxying} onSelect={addApiKey}>
          Add API key
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StepIndicator({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="flex gap-1.5" aria-label={`Step ${step} of 3`}>
      {[1, 2, 3].map((value) => (
        <span
          key={value}
          className={cn(
            "h-1 flex-1 rounded-full",
            value <= step ? "bg-primary" : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}

function QuotaDetail({
  label,
  quota,
  threshold,
}: {
  label: string;
  quota: FamilyQuota | null;
  threshold: number;
}) {
  const utilization = quota?.utilization ?? null;

  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-3 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0">
        <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full",
              utilization !== null && utilization >= 1
                ? "bg-destructive"
                : utilization !== null && utilization >= threshold - 0.1
                  ? "bg-warning"
                  : "bg-primary",
            )}
            style={{
              width: `${Math.min(100, Math.max(0, (utilization ?? 0) * 100))}%`,
            }}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          {percent(utilization)}
          {quota?.resetAt === null || quota === null
            ? ""
            : ` · ${resetLabel(quota.resetAt)}`}{" "}
          · new conversations prefer another account at{" "}
          {Math.round(threshold * 100)}%
        </div>
      </div>
    </div>
  );
}

type CopyState = "idle" | "copied" | "manual";

function useCopyToClipboard(text: string, selectFallback: () => void) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setCopyState("idle");
  }, [text]);

  const copy = useCallback(() => {
    void experimental_copyToClipboard({ text }).then((copied) => {
      if (!copied) {
        selectFallback();
        setCopyState("manual");

        return;
      }

      setCopyState("copied");

      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopyState("idle"), 1500);
    });
  }, [text, selectFallback]);

  return { copyState, copy };
}

function UserCodeBlock({ userCode }: { userCode: string }) {
  const codeRef = useRef<HTMLSpanElement>(null);

  const selectCode = useCallback(() => {
    const element = codeRef.current;

    if (element === null) return;
    const selection = window.getSelection();

    if (selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const { copyState, copy } = useCopyToClipboard(userCode, selectCode);

  return (
    <div className="rounded-lg border border-border bg-surface-recessed px-4 py-4">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center">
        <span
          ref={codeRef}
          className="col-start-2 select-all text-center font-mono text-2xl font-semibold tracking-widest"
          aria-label="Codex user code"
        >
          {userCode}
        </span>
        <Button
          type="button"
          variant="ghost"
          aria-label="Copy Codex sign-in code"
          className="col-start-3 size-9 justify-self-start text-muted-foreground hover:text-foreground max-sm:pointer-coarse:size-11"
          onClick={copy}
        >
          <Icon name={copyState === "copied" ? "Check" : "Copy"} />
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copyState === "copied"
          ? "Sign-in code copied"
          : copyState === "manual"
            ? "Your browser blocked copying. The code is selected; copy it manually."
            : ""}
      </span>
    </div>
  );
}

function AuthorizationUrlRow({
  name,
  url,
  openUrl,
}: {
  name: string;
  url: string;
  openUrl: (url: string) => boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const selectUrl = useCallback(() => {
    inputRef.current?.select();
  }, []);

  const { copyState, copy } = useCopyToClipboard(url, selectUrl);

  return (
    <div>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          readOnly
          value={url}
          aria-label={`${name} authorization URL`}
        />
        <Button
          variant="outline"
          className="shrink-0"
          aria-label={`Copy ${name} authorization URL`}
          onClick={copy}
        >
          {copyState === "copied" ? "Copied" : "Copy"}
        </Button>
        <Button className="shrink-0" onClick={() => openUrl(url)}>
          Open
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copyState === "copied"
          ? "Authorization URL copied"
          : copyState === "manual"
            ? "Your browser blocked copying. The URL is selected; copy it manually."
            : ""}
      </span>
    </div>
  );
}

function DialogFrame({
  title,
  children,
  footer,
  className,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  className?: string;
}) {
  return (
    <DialogContent
      hideCloseButton
      className={cn(
        "max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto]",
        className,
      )}
    >
      <DialogHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <DialogTitle>{title}</DialogTitle>
        <DialogClose className="-mr-1 shrink-0 cursor-pointer rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
          <Icon name="X" className="size-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
      </DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto">{children}</div>
      {footer === null ? null : (
        <DialogFooter className="flex-row items-center gap-2 sm:space-x-0">
          {footer}
        </DialogFooter>
      )}
    </DialogContent>
  );
}

function ConfigFieldRow({
  label,
  description,
  error,
  children,
}: {
  label: string;
  description: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {description}
        </div>
      </div>
      <div className="w-80 max-w-[50%] shrink-0">
        {children}
        {error === null ? null : (
          <p className="mt-1 text-xs text-destructive-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function AccountPoolSettings() {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const navigate = experimental_useAppNavigate();
  const [status, setStatus] = useState<PoolStatus | null>(readCachedStatus);
  const [statusIsCached, setStatusIsCached] = useState(status !== null);
  const [config, setConfig] = useState<AccountPoolConfig | null>(null);

  const [drafts, setDrafts] = useState<Record<ConfigField, string>>({
    anthropicUpstreamBaseUrl: "",
    codexUpstreamBaseUrl: "",
    switchThreshold: "",
  });

  const [configErrors, setConfigErrors] = useState<
    Record<ConfigField, string | null>
  >({
    anthropicUpstreamBaseUrl: null,
    codexUpstreamBaseUrl: null,
    switchThreshold: null,
  });

  const [dialog, setDialog] = useState<DialogState>(null);
  const [error, setError] = useState<string | null>(null);

  const [pending, setPending] = useState<ReadonlyMap<string, boolean | null>>(
    () => new Map(),
  );

  const configSaving = CONFIG_FIELDS.some((field) =>
    pending.has(`config-${field}`),
  );

  const [optimisticOrder, setOptimisticOrder] = useState<{
    provider: PoolProvider;
    ids: string[];
  } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const [codexStep, setCodexStep] = useState<CodexDeviceLoginStart | null>(
    null,
  );

  const [loginDone, setLoginDone] = useState<string | null>(null);
  const [claudeSetup, setClaudeSetup] = useState<ClaudeSetup | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState("100");
  const [countdown, setCountdown] = useState(0);
  const mounted = useRef(true);

  const threshold =
    config?.switchThreshold ?? DEFAULT_ACCOUNT_POOL_CONFIG.switchThreshold;

  const applyConfig = useCallback((next: AccountPoolConfig) => {
    setConfig(next);
    setDrafts(configDrafts(next));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await rpc.call("status.get", null);
      writeCachedStatus(next);

      if (!mounted.current) return;
      setStatus(next);
      setStatusIsCached(false);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [rpc]);

  const refreshConfig = useCallback(async () => {
    try {
      const next = await rpc.call("config.get", null);

      if (mounted.current) applyConfig(next);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [applyConfig, rpc]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    void refreshConfig();

    return () => {
      mounted.current = false;
    };
  }, [refresh, refreshConfig]);
  useRealtime(ACCOUNT_POOL_ACCOUNTS_CHANGED, () => {
    void refresh();
  });
  useRealtime(ACCOUNT_POOL_CONFIG_CHANGED, () => {
    void refreshConfig();
  });
  useEffect(() => {
    if (codexStep === null || loginDone !== null) return;

    const update = () =>
      setCountdown(
        Math.max(0, Math.ceil((codexStep.expiresAt - Date.now()) / 1_000)),
      );

    update();
    const interval = window.setInterval(update, 1_000);

    return () => window.clearInterval(interval);
  }, [codexStep, loginDone]);
  useEffect(() => {
    if (codexStep === null || loginDone !== null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const result = await rpc.call("codexLogin.poll", {
          sessionId: codexStep.sessionId,
        });

        if (cancelled) return;

        if (result.status === "complete") {
          setLoginDone(result.account.label);
          setCodexStep(null);
          await refresh();
        } else if (result.status === "error") {
          setCodexStep(null);
          setError(result.message);
        } else timer = setTimeout(poll, codexStep.intervalMs);
      } catch (pollError) {
        if (!cancelled) setError(errorText(pollError));
      }
    };

    timer = setTimeout(poll, codexStep.intervalMs);

    return () => {
      cancelled = true;

      if (timer !== null) clearTimeout(timer);
    };
  }, [codexStep, loginDone, refresh, rpc]);
  const accounts = status?.accounts ?? [];

  const loginTarget = dialog?.kind === "codex-login" ? dialog.target : null;

  const reloginId =
    loginTarget?.kind === "relogin" ? loginTarget.accountId : null;

  const reloginAccount =
    accounts.find((account) => account.id === reloginId) ?? null;

  const selectedAccount =
    dialog?.kind === "account" ||
    dialog?.kind === "priority" ||
    dialog?.kind === "remove"
      ? (accounts.find((account) => account.id === dialog.accountId) ?? null)
      : null;

  function markPending(key: string, target: boolean | null): void {
    setPending((current) => new Map(current).set(key, target));
  }

  function clearPending(key: string): void {
    setPending((current) => {
      const next = new Map(current);
      next.delete(key);

      return next;
    });
  }

  async function run(
    key: string,
    action: () => Promise<void>,
    target: boolean | null = null,
  ): Promise<void> {
    if (pending.has(key)) return;
    markPending(key, target);
    setError(null);

    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      clearPending(key);
    }
  }

  function switchValue(key: string, stored: boolean): boolean {
    return pending.get(key) ?? stored;
  }

  function accountPending(accountId: string): boolean {
    return ACCOUNT_ACTIONS.some((action) =>
      pending.has(`${action}-${accountId}`),
    );
  }

  function updateConfigDraft(field: ConfigField, value: string): void {
    setDrafts((current) => ({ ...current, [field]: value }));
    setConfigErrors((current) => ({ ...current, [field]: null }));
  }

  async function saveConfigField(field: ConfigField): Promise<void> {
    if (config === null || configSaving) return;
    let update: AccountPoolConfigSetInput;

    if (field === "switchThreshold") {
      const raw = drafts.switchThreshold.trim();
      const value = Number(raw);

      if (
        raw.length === 0 ||
        !Number.isFinite(value) ||
        value <= 0 ||
        value > 1
      ) {
        setConfigErrors((current) => ({
          ...current,
          switchThreshold: "Must be greater than 0 and at most 1.",
        }));

        return;
      }

      if (value === config.switchThreshold) return;
      update = { switchThreshold: value };
    } else {
      const value = drafts[field].trim();
      const validationError = httpUrlError(value);

      if (validationError !== null) {
        setConfigErrors((current) => ({
          ...current,
          [field]: validationError,
        }));

        return;
      }

      if (value === config[field]) return;
      update =
        field === "anthropicUpstreamBaseUrl"
          ? { anthropicUpstreamBaseUrl: value }
          : { codexUpstreamBaseUrl: value };
    }

    markPending(`config-${field}`, null);
    setConfigErrors((current) => ({ ...current, [field]: null }));

    try {
      applyConfig(await rpc.call("config.set", update));
    } catch (saveError) {
      setConfigErrors((current) => ({
        ...current,
        [field]: errorText(saveError),
      }));
    } finally {
      clearPending(`config-${field}`);
    }
  }

  async function startCodex(target: LoginTarget): Promise<void> {
    setDialog({ kind: "codex-login", target });

    setLoginDone(null);
    await run("codex-login", async () => {
      setCodexStep(await rpc.call("codexLogin.start", target));
    });
  }

  async function accountAction(
    account: AccountSummary,
    action: (typeof ACCOUNT_ACTIONS)[number],
  ): Promise<void> {
    if (action === "priority") {
      setPriority(String(account.priority));
      setDialog({ kind: "priority", accountId: account.id });

      return;
    }

    if (action === "remove") {
      setDialog({ kind: "remove", accountId: account.id });

      return;
    }

    if (action === "relogin") {
      await startCodex({
        kind: "relogin",
        accountId: account.id,
      });

      return;
    }

    await run(`${action}-${account.id}`, async () => {
      if (action === "toggle")
        await rpc.call(account.enabled ? "account.disable" : "account.enable", {
          id: account.id,
        });

      if (action === "refresh")
        await rpc.call("account.refreshUsage", { accountId: account.id });
    });
  }

  async function reorderAccounts(
    provider: PoolProvider,
    event: DragEndEvent,
  ): Promise<void> {
    if (pending.has(`order-${provider}`) || event.over === null) return;

    const ids = accounts
      .filter((account) => account.provider === provider)
      .map((account) => account.id);

    const from = ids.findIndex((id) => id === event.active.id);
    const to = ids.findIndex((id) => id === event.over?.id);

    if (from < 0 || to < 0 || from === to) return;
    const accountIds = arrayMove(ids, from, to);
    setOptimisticOrder({ provider, ids: accountIds });

    try {
      await run(`order-${provider}`, async () => {
        await rpc.call("account.reorder", { provider, accountIds });
      });
    } finally {
      setOptimisticOrder(null);
    }
  }

  function closeDialog(): void {
    if (dialog?.kind === "api-key" && pending.has("api-key")) return;

    if (dialog?.kind === "codex-login" && codexStep !== null)
      void rpc.call("codexLogin.cancel", { sessionId: codexStep.sessionId });
    setDialog(null);
    setCodexStep(null);
    setLoginDone(null);
    setApiKey("");
    setError(null);
  }

  const hubHosts =
    status?.hosts.map((host) => host.hostName ?? host.hostId).join(", ") ||
    "no machines";

  const parent = status?.parent ?? null;
  const proxying = parent !== null && parent.mode === "proxy";

  const apiKeyVendor =
    dialog?.kind === "api-key" && dialog.provider === "codex"
      ? "OpenAI"
      : "Anthropic";

  return (
    <div className="w-full space-y-6">
      {parent === null ? null : (
        <div className="rounded-lg border border-border px-4 py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">
                {proxying
                  ? "Using the parent Account Pooler"
                  : "Parent Account Pooler available"}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {parentBannerBody(parent)}
              </p>
            </div>
            <Switch
              checked={switchValue("parent-mode", proxying)}
              aria-label="Use the parent Account Pooler"
              onCheckedChange={(enabled) =>
                void run(
                  "parent-mode",
                  async () => {
                    await rpc.call("config.set", {
                      parentMode: enabled ? "proxy" : "isolate",
                    });
                  },
                  enabled,
                )
              }
            />
          </div>
        </div>
      )}
      <div className="space-y-6">
        <p className="text-xs text-subtle-foreground">
          Hub {status?.accepting ? "accepting" : "not accepting"} ·{" "}
          {status?.inFlight ?? 0} in flight · used by {hubHosts}
          {statusIsCached ? " · refreshing…" : null}
        </p>
        {error === null || dialog?.kind === "api-key" ? null : (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-surface-destructive px-3 py-2 text-sm text-destructive-text"
          >
            {error}
          </div>
        )}
        {PROVIDERS.map((provider) => {
          const serverAccounts = accounts.filter(
            (account) => account.provider === provider.id,
          );

          const order =
            optimisticOrder?.provider === provider.id
              ? optimisticOrder.ids
              : null;

          const providerAccounts =
            order !== null &&
            order.length === serverAccounts.length &&
            serverAccounts.every((account) => order.includes(account.id))
              ? order.flatMap((id) =>
                  serverAccounts.filter((account) => account.id === id),
                )
              : serverAccounts;

          return (
            <SettingsSection
              key={provider.id}
              title={provider.title}
              description={provider.description}
              action={
                <div className="flex items-center gap-2">
                  <Switch
                    disabled={proxying}
                    checked={switchValue(
                      `routing-${provider.id}`,
                      status?.routing[provider.id] ?? true,
                    )}
                    aria-label={`Route ${provider.title} threads`}
                    onCheckedChange={(enabled) =>
                      void run(
                        `routing-${provider.id}`,
                        async () => {
                          await rpc.call("routing.set", {
                            provider: provider.id,
                            enabled,
                          });
                        },
                        enabled,
                      )
                    }
                  />
                  <AddAccountMenu
                    provider={provider.id}
                    proxying={proxying}
                    signIn={() => {
                      if (provider.id === "claude") setClaudeSetup("sign-in");
                      else void startCodex(NEW_LOGIN);
                    }}
                    adopt={() => setClaudeSetup("adopt")}
                    addApiKey={() => {
                      setError(null);
                      setDialog({ kind: "api-key", provider: provider.id });
                    }}
                  />
                </div>
              }
            >
              {provider.id === "claude" ? (
                <NativeClaudeProfiles
                  setup={claudeSetup}
                  onCloseSetup={() => setClaudeSetup(null)}
                  showEmpty={status !== null && providerAccounts.length === 0}
                  threshold={threshold}
                />
              ) : null}
              <div
                inert={proxying}
                className={proxying ? "opacity-50" : undefined}
              >
                {status === null ? (
                  <p className="py-2.5 text-sm text-muted-foreground">
                    Loading…
                  </p>
                ) : providerAccounts.length === 0 ? (
                  provider.id === "claude" ? null : (
                    <p className="py-2.5 text-sm text-subtle-foreground">
                      No accounts yet.
                    </p>
                  )
                ) : (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    modifiers={accountDragModifiers}
                    onDragEnd={(event: DragEndEvent) =>
                      void reorderAccounts(provider.id, event)
                    }
                  >
                    <SortableContext
                      items={providerAccounts.map((account) => account.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="divide-y divide-border">
                        {providerAccounts.map((account) => (
                          <AccountRow
                            key={account.id}
                            account={account}
                            threshold={threshold}
                            pending={accountPending(account.id)}
                            refreshing={
                              statusIsCached ||
                              pending.has(`refresh-${account.id}`)
                            }
                            reorderDisabled={
                              providerAccounts.length < 2 ||
                              pending.has(`order-${provider.id}`)
                            }
                            onAction={(action) =>
                              void accountAction(account, action)
                            }
                            onOpen={() =>
                              setDialog({
                                kind: "account",
                                accountId: account.id,
                              })
                            }
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                )}
              </div>
            </SettingsSection>
          );
        })}
        <Collapsible
          inert={proxying}
          className={cn(
            "rounded-lg border border-border px-4",
            proxying && "opacity-50",
          )}
        >
          <CollapsibleTrigger className="flex w-full items-center gap-2 py-2.5 text-sm font-medium text-foreground">
            <Icon
              name="ChevronRight"
              className={cn(
                "size-4 [[data-state=open]>&]:rotate-90",
                DISCLOSURE_CHEVRON_TRANSITION,
              )}
            />
            Advanced
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="divide-y divide-border border-t border-border">
              <ConfigFieldRow
                label="Anthropic upstream base URL"
                description="QA override for Anthropic traffic."
                error={configErrors.anthropicUpstreamBaseUrl}
              >
                <Input
                  aria-label="Anthropic upstream base URL"
                  aria-invalid={
                    configErrors.anthropicUpstreamBaseUrl === null
                      ? undefined
                      : true
                  }
                  disabled={config === null || configSaving}
                  value={drafts.anthropicUpstreamBaseUrl}
                  onChange={(event) =>
                    updateConfigDraft(
                      "anthropicUpstreamBaseUrl",
                      event.target.value,
                    )
                  }
                  onBlur={() =>
                    void saveConfigField("anthropicUpstreamBaseUrl")
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </ConfigFieldRow>
              <ConfigFieldRow
                label="Codex upstream base URL"
                description="QA override for ChatGPT Codex traffic."
                error={configErrors.codexUpstreamBaseUrl}
              >
                <Input
                  aria-label="Codex upstream base URL"
                  aria-invalid={
                    configErrors.codexUpstreamBaseUrl === null
                      ? undefined
                      : true
                  }
                  disabled={config === null || configSaving}
                  value={drafts.codexUpstreamBaseUrl}
                  onChange={(event) =>
                    updateConfigDraft(
                      "codexUpstreamBaseUrl",
                      event.target.value,
                    )
                  }
                  onBlur={() => void saveConfigField("codexUpstreamBaseUrl")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </ConfigFieldRow>
              <ConfigFieldRow
                label="Quota switch threshold"
                description="Prefer another account for new conversations at this quota fraction."
                error={configErrors.switchThreshold}
              >
                <Input
                  type="number"
                  min="0.01"
                  max="1"
                  step="0.01"
                  aria-label="Quota switch threshold"
                  aria-invalid={
                    configErrors.switchThreshold === null ? undefined : true
                  }
                  disabled={config === null || configSaving}
                  value={drafts.switchThreshold}
                  onChange={(event) =>
                    updateConfigDraft("switchThreshold", event.target.value)
                  }
                  onBlur={() => void saveConfigField("switchThreshold")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </ConfigFieldRow>
              <div className="flex items-start justify-between gap-4">
                <div className="py-2.5">
                  <div className="text-sm text-foreground">Machine tokens</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {hubHosts}
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2 py-2.5">
                  {status?.hosts.map((host) => (
                    <Button
                      key={host.hostId}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void run(`rotate-${host.hostId}`, async () => {
                          await rpc.call("token.rotate", {
                            machine: host.hostId,
                          });
                        })
                      }
                    >
                      Rotate {host.hostName ?? host.hostId}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        {dialog?.kind === "account" && selectedAccount !== null ? (
          <AccountDialog
            account={selectedAccount}
            threshold={threshold}
            act={(action) => void accountAction(selectedAccount, action)}
          />
        ) : null}
        {dialog?.kind === "priority" && selectedAccount !== null ? (
          <DialogFrame
            title="Set priority"
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    !Number.isInteger(Number(priority)) ||
                    pending.has(`priority-${selectedAccount.id}`)
                  }
                  onClick={() =>
                    void run(`priority-${selectedAccount.id}`, async () => {
                      await rpc.call("account.setPriority", {
                        accountId: selectedAccount.id,
                        priority: Number(priority),
                      });
                      setDialog(null);
                    })
                  }
                >
                  Save
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Lower numbers come first in the failover order. Ties follow the
              order accounts were added. Existing conversations stay pinned.
            </p>
            <Input
              type="number"
              aria-label="Account priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </DialogFrame>
        ) : null}
        {dialog?.kind === "api-key" ? (
          <DialogFrame
            title={`Add an ${apiKeyVendor} API key`}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    apiKey.trim().length === 0 || pending.has("api-key")
                  }
                  onClick={() =>
                    void run("api-key", async () => {
                      await rpc.call("account.add", {
                        provider: dialog.provider,
                        apiKey: apiKey.trim(),
                        label: null,
                        priority: 100,
                      });
                      setApiKey("");
                      setDialog(null);
                    })
                  }
                >
                  Add API key
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              {apiKeyVendor} bills requests served by this key.
            </p>
            <Input
              type="password"
              autoComplete="off"
              aria-label={`${apiKeyVendor} API key`}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            {error === null ? null : (
              <p role="alert" className="text-sm text-destructive-text">
                {error}
              </p>
            )}
          </DialogFrame>
        ) : null}
        {dialog?.kind === "remove" && selectedAccount !== null ? (
          <DialogFrame
            title={`Remove ${selectedAccount.label}?`}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={pending.has(`remove-${selectedAccount.id}`)}
                  onClick={() =>
                    void run(`remove-${selectedAccount.id}`, async () => {
                      await rpc.call("account.remove", {
                        id: selectedAccount.id,
                      });
                      setDialog(null);
                    })
                  }
                >
                  Remove
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              This deletes the account&apos;s secret file. Threads fall back to
              their machine login when no other pooled account is available.
            </p>
          </DialogFrame>
        ) : null}
        {dialog?.kind === "codex-login" ? (
          <LoginDialog
            relogin={reloginAccount}
            codexStep={codexStep}
            loginDone={loginDone}
            countdown={countdown}
            error={error}
            close={closeDialog}
            openUrl={navigate.openUrl}
            restart={() => void startCodex(dialog.target)}
            addAnother={() => void startCodex(NEW_LOGIN)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function AccountDialog({
  account,
  threshold,
  act,
}: {
  account: AccountSummary;
  threshold: number;
  act: (action: "toggle" | "refresh" | "relogin" | "remove") => void;
}) {
  const shared = (
    utilization: number | null,
    resetAt: number | null,
    status: string | null,
  ): FamilyQuota => ({
    utilization,
    resetAt,
    status,
    observedAt: account.observedAt ?? 0,
    source: "header",
  });

  const providerId =
    account.provider === "claude"
      ? account.accountUuid
      : account.codexAccountId;

  return (
    <DialogFrame
      title={account.label}
      className="sm:max-w-xl"
      footer={
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={isLegacyClaudeAccount(account)}
            onClick={() => act("toggle")}
          >
            {account.enabled ? "Disable" : "Enable"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isLegacyClaudeAccount(account)}
            onClick={() => act("refresh")}
          >
            Refresh usage
          </Button>
          {account.provider === "codex" && account.kind === "oauth" ? (
            <Button size="sm" variant="outline" onClick={() => act("relogin")}>
              Sign in again
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive-text"
            onClick={() => act("remove")}
          >
            Remove
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <SettingsBadge>{tier(account)}</SettingsBadge>
        <SettingsBadge>
          {statusPresentation(account, threshold).label}
        </SettingsBadge>
      </div>
      {isLegacyClaudeAccount(account) ? (
        <p className="text-sm text-muted-foreground">
          {CLAUDE_POOL_LOGIN_RETIRED}
        </p>
      ) : null}
      <div className="space-y-4">
        {account.provider === "codex" ? (
          account.limitWindows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No usage limits observed yet.
            </div>
          ) : (
            account.limitWindows.map((window) => (
              <QuotaDetail
                key={window.slot}
                label={windowLongLabel(window)}
                quota={window}
                threshold={threshold}
              />
            ))
          )
        ) : (
          <>
            <QuotaDetail
              label="5 hour"
              quota={shared(
                account.fiveHourUtilization,
                account.fiveHourResetAt,
                account.fiveHourStatus,
              )}
              threshold={threshold}
            />
            <QuotaDetail
              label="7 day"
              quota={shared(
                account.sevenDayUtilization,
                account.sevenDayResetAt,
                account.sevenDayStatus,
              )}
              threshold={threshold}
            />
            {modelFamilySchema.options.flatMap((family) =>
              account.familyWeekly[family] === null
                ? []
                : [
                    <QuotaDetail
                      key={family}
                      label={FAMILY_LABELS[family]}
                      quota={account.familyWeekly[family]}
                      threshold={threshold}
                    />,
                  ],
            )}
          </>
        )}
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 border-t border-border pt-4 text-sm">
        {account.email === null ? null : (
          <>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="break-all">{account.email}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Kind</dt>
        <dd>
          {account.kind === "oauth"
            ? `OAuth · ${account.provider === "claude" ? "claude.ai" : "ChatGPT"}`
            : "API key"}
        </dd>
        <dt className="text-muted-foreground">Priority</dt>
        <dd>{account.priority}</dd>
        <dt className="text-muted-foreground">Last used</dt>
        <dd>
          {account.lastUsedAt === null
            ? "Never"
            : `${relative(account.lastUsedAt)}${account.lastUsedHostName === null ? "" : ` · ${account.lastUsedHostName}`}`}
        </dd>
        <dt className="text-muted-foreground">Usage refreshed</dt>
        <dd>
          {account.observedAt === null ? "Never" : relative(account.observedAt)}
        </dd>
        {providerId === null || providerId === undefined ? null : (
          <>
            <dt className="text-muted-foreground">Account id</dt>
            <dd className="font-mono text-xs">{`${providerId.slice(0, 4)}…${providerId.slice(-4)}`}</dd>
          </>
        )}
      </dl>
    </DialogFrame>
  );
}

function LoginError({
  message,
  restart,
}: {
  message: string;
  restart: () => void;
}) {
  return (
    <p className="text-sm text-destructive-text">
      {message.replace(/\s*Start again\.$/u, "")}{" "}
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 align-baseline text-sm text-foreground underline underline-offset-4"
        onClick={restart}
      >
        Start again
      </Button>
    </p>
  );
}

function LoginDialog({
  relogin,
  codexStep,
  loginDone,
  countdown,
  error,
  close,
  openUrl,
  restart,
  addAnother,
}: {
  relogin: AccountSummary | null;
  codexStep: CodexDeviceLoginStart | null;
  loginDone: string | null;
  countdown: number;
  error: string | null;
  close: () => void;
  openUrl: (url: string) => boolean;
  restart: () => void;
  addAnother: () => void;
}) {
  const url = codexStep?.verificationUri;

  return (
    <DialogFrame
      title={
        relogin === null
          ? "Sign in to Codex"
          : `Sign in again to ${relogin.label}`
      }
      className="sm:max-w-xl"
      footer={
        loginDone !== null ? (
          <>
            <span className="flex-1" />
            {relogin === null ? (
              <Button variant="outline" onClick={addAnother}>
                Add another
              </Button>
            ) : null}
            <Button onClick={close}>Done</Button>
          </>
        ) : null
      }
    >
      <StepIndicator step={loginDone === null ? 2 : 3} />
      {loginDone !== null ? (
        relogin === null ? (
          <div>
            <h3 className="text-base font-semibold">Connected {loginDone}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Codex threads on every machine now route through this account.
              Usage refreshes in the background.
            </p>
          </div>
        ) : (
          <div>
            <h3 className="text-base font-semibold">
              Signed in again to {loginDone}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Its priority, enabled state, and pinned conversations are
              unchanged.
            </p>
          </div>
        )
      ) : url === undefined ? (
        error !== null ? (
          <LoginError message={error} restart={restart} />
        ) : (
          <p className="text-sm text-muted-foreground">Starting sign-in…</p>
        )
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {relogin === null
              ? null
              : `Sign in as ${relogin.email ?? relogin.label}. `}
            Open the verification page, sign in to ChatGPT, and enter this code.
          </p>
          {codexStep === null ? null : (
            <UserCodeBlock userCode={codexStep.userCode} />
          )}
          <AuthorizationUrlRow name="Codex" url={url} openUrl={openUrl} />
          <p className="text-center text-sm text-muted-foreground">
            Waiting for you to authorize… expires in{" "}
            {Math.floor(countdown / 60)}:
            {String(countdown % 60).padStart(2, "0")}
          </p>
        </>
      )}
    </DialogFrame>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "accounts",
    component: AccountPoolSettings,
  });
});
