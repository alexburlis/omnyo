const legacyWireHeadersV1 = [
  "x-bb-account-pool-token",
  "x-bb-app-surface",
  "x-bb-archive-sha256",
  "x-bb-artifact-sha256",
  "x-bb-cache",
  "x-bb-cloud-dev-host",
  "x-bb-composer-prediction-token",
  "x-bb-connect-code",
  "x-bb-connect-machine",
  "x-bb-direct-proof",
  "x-bb-gate-auth",
  "x-bb-gate-machine-id",
  "x-bb-gate-owner",
  "x-bb-plugin-caller",
  "x-bb-plugin-token",
  "x-bb-relay",
  "x-bb-relay-content-length",
  "x-bb-relay-has-body",
  "x-bb-relay-method",
  "x-bb-tunnel-offline",
  "x-bb-tunnel-status",
  "x-bb-tunnel-target",
  "x-bb-web-source",
] as const;

export const legacyWireHeaderMapV1: ReadonlyMap<string, string> = new Map(
  legacyWireHeadersV1.map((name) => [name, name.replace("x-bb-", "x-omnyo-")]),
);

const currentOwnedWireHeaders = new Set(legacyWireHeaderMapV1.values());

export function importLegacyWireHeadersV1(
  headers: Record<string, string>,
): Record<string, string> {
  const result = new Map<string, string>();

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();

    const target =
      legacyWireHeaderMapV1.get(lower) ??
      (currentOwnedWireHeaders.has(lower) ? lower : name);

    if (result.has(target) && result.get(target) !== value)
      throw new Error(`Conflicting legacy and canonical wire header ${target}`);
    result.set(target, value);
  }

  return Object.fromEntries(result);
}
