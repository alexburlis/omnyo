export interface ClearWebsiteDataDeps {
  clearCookies(useWebKit: boolean): Promise<unknown>;
  clearSessionCache(profileId: string): Promise<void>;
  renewSession(profileId: string): Promise<void>;
}

export async function clearWebsiteData(
  connectProfileId: string | null,
  deps: ClearWebsiteDataDeps,
): Promise<void> {
  await Promise.all([
    deps.clearCookies(false),
    deps.clearCookies(true),
    connectProfileId === null
      ? undefined
      : deps.clearSessionCache(connectProfileId),
  ]);

  if (connectProfileId !== null) await deps.renewSession(connectProfileId);
}
