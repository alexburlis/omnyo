import type { PluginApi } from "@omnyo/plugin-sdk";
import { piProviderDeclaration } from "./src/declaration.js";

export default function plugin(api: PluginApi): void {
  const registered = api.providers.register(piProviderDeclaration());
  api.onDispose(() => {
    registered.dispose();
  });
}
