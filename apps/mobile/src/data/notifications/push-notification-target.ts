import { migrateLegacyRelayServerUrl } from "@omnyo/connect-client";
import { z } from "zod";
import {
  matchProfileForWebLink,
  type LinkProfileLike,
} from "@/lib/links/incoming-link";

export interface PushNotificationTarget {
  threadId: string;
  projectId: string | null;
  serverUrl: string | null;
}

const pushDataSchema = z.object({
  threadId: z.string().min(1),
  projectId: z.string().min(1).nullish(),
  serverUrl: z.string().min(1).nullish(),
  url: z.string().min(1).nullish(),
});

function normalizedHint(value: string, preservePath: boolean): string | null {
  try {
    const url = new URL(migrateLegacyRelayServerUrl(value) ?? value);

    if (!preservePath || url.pathname === "/") return url.origin;

    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return null;
  }
}

export function parsePushNotificationData(
  data: unknown,
): PushNotificationTarget | null {
  const parsed = pushDataSchema.safeParse(data);

  if (!parsed.success) return null;
  const serverUrl = parsed.data.serverUrl ?? null;
  const fallbackUrl = parsed.data.url ?? null;

  return {
    threadId: parsed.data.threadId,
    projectId: parsed.data.projectId ?? null,
    serverUrl: serverUrl
      ? normalizedHint(serverUrl, true)
      : fallbackUrl
        ? normalizedHint(fallbackUrl, false)
        : null,
  };
}

export interface PushTargetProfile extends LinkProfileLike {
  mode: "direct" | "connect";
}

export type ThreadProbe = "found" | "missing" | "unknown";

export interface ResolvePushTargetProfileDeps {
  profiles: readonly PushTargetProfile[];
  activeProfileId: string | null;
  probeThread(serverUrl: string, threadId: string): Promise<ThreadProbe>;
}

function hintedProfile(
  profiles: readonly PushTargetProfile[],
  serverUrl: string | null,
): PushTargetProfile | null {
  if (!serverUrl) return null;

  try {
    const hint = new URL(serverUrl);

    return (
      matchProfileForWebLink(profiles, hint.origin, hint.pathname)?.profile ??
      null
    );
  } catch {
    return null;
  }
}

export async function resolvePushTargetProfile(
  target: PushNotificationTarget,
  deps: ResolvePushTargetProfileDeps,
): Promise<PushTargetProfile | null> {
  const { profiles } = deps;

  if (profiles.length === 0) return null;
  const hinted = hintedProfile(profiles, target.serverUrl);

  if (hinted) {
    const active = profiles.find(
      (profile) => profile.id === deps.activeProfileId,
    );

    if (active === undefined || active.mode !== "connect" || active === hinted)
      return hinted;

    const activeProbe = await deps
      .probeThread(active.serverUrl, target.threadId)
      .catch((): ThreadProbe => "unknown");

    return activeProbe === "missing" ? hinted : active;
  }

  const ordered = [
    ...profiles.filter((profile) => profile.id === deps.activeProfileId),
    ...profiles.filter((profile) => profile.id !== deps.activeProfileId),
  ];

  for (const profile of ordered) {
    try {
      if (
        (await deps.probeThread(profile.serverUrl, target.threadId)) === "found"
      ) {
        return profile;
      }
    } catch {}
  }

  return null;
}
