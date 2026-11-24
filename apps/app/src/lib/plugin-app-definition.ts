import type { PluginAppDefinition, PluginAppSetup } from "@omnyo/plugin-sdk";
import { collectPluginAppRegistrations } from "@omnyo/plugin-sdk/internal/plugin-app-collector";

export { collectPluginAppRegistrations };

export function definePluginApp(setup: PluginAppSetup): PluginAppDefinition {
  if (typeof setup !== "function") {
    throw new Error("definePluginApp expects a setup function");
  }

  return Object.freeze({ __omnyoPluginApp: true as const, setup });
}

export function isPluginAppDefinition(
  value: unknown,
): value is PluginAppDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __omnyoPluginApp?: unknown }).__omnyoPluginApp === true &&
    typeof (value as { setup?: unknown }).setup === "function"
  );
}
