import { useCallback, useEffect, useState } from "react";
import { sdk } from "@/lib/sdk";
import { OmnyoHttpError } from "@omnyo/sdk/browser";

type ProfilesClient = typeof sdk.providers.claudeProfiles;

export type ProfileList = Awaited<ReturnType<ProfilesClient["list"]>>;

export type ClaudeProfileSelection = Parameters<
  ProfilesClient["defaultsSet"]
>[0]["selection"];

export function useClaudeAccounts({
  hostId,
  projectId,
  enabled,
}: {
  hostId: string | null;
  projectId: string;
  enabled: boolean;
}) {
  const [result, setResult] = useState<{
    key: string;
    data: ProfileList | null;
    error: boolean;
  } | null>(null);

  const key = `${hostId ?? ""}:${projectId}`;
  useEffect(() => {
    if (!enabled || !hostId || sdk.providers?.claudeProfiles === undefined)
      return;
    let current = true;
    void sdk.providers.claudeProfiles.list({ hostId, projectId }).then(
      (data) => {
        if (current) setResult({ key, data, error: false });
      },
      (error: unknown) => {
        if (!current) return;
        setResult({
          key,
          data: null,
          error: !(error instanceof OmnyoHttpError && error.status === 404),
        });
      },
    );

    return () => {
      current = false;
    };
  }, [enabled, hostId, key, projectId]);

  const setProjectDefault = useCallback(
    async (selection: ClaudeProfileSelection) => {
      if (!hostId) return;

      try {
        await sdk.providers.claudeProfiles.defaultsSet({
          hostId,
          projectId,
          selection,
        });

        const data = await sdk.providers.claudeProfiles.list({
          hostId,
          projectId,
        });

        setResult((current) =>
          current?.key === key ? { key, data, error: false } : current,
        );
      } catch {
        setResult((current) =>
          current?.key === key ? { ...current, error: true } : current,
        );
      }
    },
    [hostId, key, projectId],
  );

  return {
    data: enabled && result?.key === key ? result.data : null,
    error: enabled && result?.key === key && result.error,
    key,
    ready:
      !enabled ||
      !hostId ||
      sdk.providers?.claudeProfiles === undefined ||
      result?.key === key,
    setProjectDefault,
  };
}
