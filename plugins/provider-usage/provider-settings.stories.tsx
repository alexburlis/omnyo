import { UsageSettingsContent } from "./settings.js";
import type {
  ProviderUsage,
  UsageMachine,
  UsageProvider,
} from "./usage-schema.js";

export default { title: "plugins/Provider usage accounts" };

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60_000).toISOString();
}

function measured(
  email: string,
  planLabel: string,
  windows: readonly [label: string, usedPercent: number, hours: number][],
): ProviderUsage {
  return {
    status: "ok",
    accountEmail: email,
    planLabel,
    windows: windows.map(([label, usedPercent, hours]) => ({
      label,
      usedPercent,
      resetsAt: hoursFromNow(hours),
      cost: null,
    })),
  };
}

function account(
  id: string,
  providerId: "codex" | "claude-code",
  usage: ProviderUsage | null,
): UsageProvider {
  const claude = providerId === "claude-code";

  return {
    id,
    providerId,
    accountLabel: `${id}@example.com`,
    displayName: claude ? "Claude Code" : "Codex",
    logoUrl: null,
    icon: null,
    strings: { iconTint: null },
    signInHint: "Sign in to this account in the provider’s settings.",
    expiredHint: "Sign in again in the provider’s settings.",
    usage,
  };
}

function pool(providers: UsageProvider[]): UsageMachine[] {
  return [
    {
      id: "source:pool",
      displayName: "Account Pooler",
      status: "connected",
      error: null,
      providers,
    },
    {
      id: "host",
      displayName: "Mac Pro",
      status: "connected",
      error: null,
      providers: [],
    },
  ];
}

function Settings({
  machines,
  loading = false,
}: {
  machines: UsageMachine[];
  loading?: boolean;
}) {
  return (
    <div className="w-full max-w-xl p-6">
      <UsageSettingsContent
        machines={machines}
        selectedId="source:pool"
        loading={loading}
        error={false}
        onSelect={() => {}}
        onRefresh={() => {}}
      />
    </div>
  );
}

export function SeveralAccountsPerProvider() {
  return (
    <Settings
      machines={pool([
        account(
          "alex",
          "codex",
          measured("alex@example.com", "Pro", [
            ["Five-hour limit", 12, 3],
            ["Weekly limit", 28, 80],
          ]),
        ),
        account(
          "sam",
          "codex",
          measured("sam@example.com", "Team", [["Weekly limit", 86, 80]]),
        ),
        account(
          "team",
          "claude-code",
          measured("team@example.com", "Max (5x)", [["Weekly limit", 97, 18]]),
        ),
      ])}
    />
  );
}

export function SignInAndErrors() {
  return (
    <Settings
      machines={pool([
        account("ops", "codex", { status: "unauthenticated" }),
        account("expired", "codex", { status: "expired" }),
        account("research", "claude-code", {
          status: "error",
          message: "Anthropic answered 529: the service is overloaded.",
        }),
        account("free", "claude-code", {
          status: "ok",
          accountEmail: "free@example.com",
          planLabel: "Free",
          windows: [],
        }),
      ])}
    />
  );
}

export function AccountsLoading() {
  return (
    <Settings
      loading
      machines={pool([
        account("alex", "codex", null),
        account("sam", "codex", null),
        account("team", "claude-code", null),
      ])}
    />
  );
}
