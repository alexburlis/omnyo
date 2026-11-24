import { usageProofSchema } from "@omnyo/domain/usage-telemetry";

const KEY = "omnyo.usage-consent.v1";

export interface ClientUsageConsent {
  active: string | null;
  proofs: string[];
}

export function readClientUsageConsent(): ClientUsageConsent {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");

    if (
      !value ||
      typeof value !== "object" ||
      !("proofs" in value) ||
      !Array.isArray(value.proofs)
    )
      return { active: null, proofs: [] };

    const proofs = value.proofs
      .filter(
        (item): item is string => usageProofSchema.safeParse(item).success,
      )
      .slice(-64);

    const active =
      "active" in value &&
      typeof value.active === "string" &&
      proofs.includes(value.active)
        ? value.active
        : null;

    return { active, proofs };
  } catch {
    return { active: null, proofs: [] };
  }
}

export function saveClientUsageConsent(value: ClientUsageConsent): void {
  localStorage.setItem(KEY, JSON.stringify(value));
}
