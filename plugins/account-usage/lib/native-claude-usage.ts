import type { PluginApi } from "@omnyo/plugin-sdk";
import {
  providerUsageSchema,
  type ProviderUsage,
} from "@omnyo/plugin-sdk/provider-bridge";
import { z } from "zod";
import { NATIVE_CLAUDE_KIND, type AccountSummary } from "./pool-contracts.ts";

const PROFILE_USAGE_MAX_AGE_MS = 5 * 60_000;

const PROFILE_USAGE_CONCURRENCY = 3;

type ClaudeProfiles = PluginApi["sdk"]["providers"]["claudeProfiles"] & {
  usage?: (target: { hostId: string; profileId: string }) => Promise<unknown>;
};

type Profile = Awaited<ReturnType<ClaudeProfiles["list"]>>["profiles"][number];

type NativeReading = {
  accounts: AccountSummary[];
  error?: string;
  checkTimedOut?: true;
};

const profileUsageResult = z.object({
  action: z.literal("usage"),
  usage: providerUsageSchema,
});

function resetTime(value: string | null | undefined): number | null {
  const time = value == null ? NaN : Date.parse(value);

  return Number.isFinite(time) ? time : null;
}

function profileAccount(
  profile: Profile,
  usage: ProviderUsage | null,
  error: string | null,
): AccountSummary {
  const windows = usage?.status === "ok" ? usage.windows : [];
  const fiveHour = windows.find(({ label }) => label === "5H");
  const week = windows.find(({ label }) => label === "7D");
  const now = Date.now();

  const exhausted = windows.some(
    ({ usedPercent, resetsAt }) =>
      usedPercent === 100 && (resetTime(resetsAt) ?? Infinity) > now,
  );

  const identity =
    usage?.status === "ok" || usage?.status === "error" ? usage : null;

  return {
    id: profile.id,
    kind: NATIVE_CLAUDE_KIND,
    provider: "claude",
    label: profile.label,
    email: identity?.accountEmail ?? null,
    subscriptionType: identity?.planLabel ?? "Subscription",
    enabled: true,
    priority: 0,
    lastUsedAt: null,
    fiveHourUtilization:
      fiveHour === undefined ? null : fiveHour.usedPercent / 100,
    fiveHourResetAt: resetTime(fiveHour?.resetsAt),
    fiveHourStatus: null,
    sevenDayUtilization: week === undefined ? null : week.usedPercent / 100,
    sevenDayResetAt: resetTime(week?.resetsAt),
    sevenDayStatus: null,
    familyWeekly: {},
    limitWindows: [],
    observedAt: windows.length === 0 ? null : now,
    heldUntil: null,
    inFlight: 0,
    error,
    status: error !== null ? "error" : exhausted ? "exhausted" : "ready",
  };
}

async function readProfile(
  profiles: ClaudeProfiles,
  hostId: string,
  profile: Profile,
): Promise<AccountSummary> {
  if (profile.status !== "ready") {
    const message =
      profile.status === "check-timed-out"
        ? "Claude took too long to check this account. Refresh to try again."
        : profile.status === "sign-in-required" ||
            profile.status === "wrong-account"
          ? "Sign in to this Claude account in Account Pooler."
          : "This Claude profile is unavailable.";

    return profileAccount(profile, null, message);
  }

  if (typeof profiles.usage !== "function")
    return profileAccount(
      profile,
      null,
      "Claude profile usage requires a newer Omnyo runtime.",
    );

  try {
    const { usage } = profileUsageResult.parse(
      await profiles.usage({ hostId, profileId: profile.id }),
    );

    if (usage.status === "ok" && usage.windows.length > 0)
      return profileAccount(profile, usage, null);

    return profileAccount(
      profile,
      usage,
      "Claude Code could not read the subscription limits.",
    );
  } catch {
    return profileAccount(
      profile,
      null,
      "Claude profile usage could not be loaded.",
    );
  }
}

export function createNativeClaudeUsageReader(api: PluginApi) {
  let reading: { result: NativeReading; expiresAt: number } | undefined;
  let pending: Promise<NativeReading> | undefined;

  async function fetchReading(): Promise<NativeReading> {
    try {
      const profiles = api.sdk.providers.claudeProfiles;

      if (profiles === undefined) return { accounts: [] };

      const { primaryHostId, primaryHostPlatform } =
        await api.sdk.system.config();

      if (primaryHostId === null || primaryHostPlatform !== "darwin")
        return { accounts: [] };

      const inventory = await profiles.list({ hostId: primaryHostId });

      if (!inventory.supported) return { accounts: [] };

      const active = inventory.profiles.filter(
        ({ status }) => status !== "removed",
      );

      const accounts: AccountSummary[] = [];

      for (
        let offset = 0;
        offset < active.length;
        offset += PROFILE_USAGE_CONCURRENCY
      ) {
        accounts.push(
          ...(await Promise.all(
            active
              .slice(offset, offset + PROFILE_USAGE_CONCURRENCY)
              .map((profile) => readProfile(profiles, primaryHostId, profile)),
          )),
        );
      }

      return active.some(({ status }) => status === "check-timed-out")
        ? { accounts, checkTimedOut: true }
        : { accounts };
    } catch {
      return { accounts: [], error: "Claude accounts could not be loaded." };
    }
  }

  return (force = false): Promise<NativeReading> => {
    if (pending !== undefined) return pending;

    if (!force && reading !== undefined && reading.expiresAt > Date.now())
      return Promise.resolve(reading.result);

    pending = fetchReading()
      .then((result) => {
        reading =
          result.error === undefined && result.checkTimedOut === undefined
            ? { result, expiresAt: Date.now() + PROFILE_USAGE_MAX_AGE_MS }
            : undefined;

        return result;
      })
      .finally(() => {
        pending = undefined;
      });

    return pending;
  };
}
