import type {
  ComposerDraftSnapshot,
  PluginComposerScope,
} from "@omnyo/plugin-sdk";
import { composerScopeIdentity } from "@/components/plugin/plugin-composer-host";

const listeners = new Map<
  string,
  Set<(draft?: ComposerDraftSnapshot) => void>
>();

export function subscribeComposerSubmitted(
  scope: PluginComposerScope,
  listener: (draft?: ComposerDraftSnapshot) => void,
): () => void {
  const key = composerScopeIdentity(scope);
  const entries = listeners.get(key) ?? new Set();
  entries.add(listener);
  listeners.set(key, entries);

  return () => {
    entries.delete(listener);

    if (entries.size === 0) listeners.delete(key);
  };
}

export function notifyComposerSubmitted(
  scope: PluginComposerScope,
  draft?: ComposerDraftSnapshot,
): void {
  for (const listener of [
    ...(listeners.get(composerScopeIdentity(scope)) ?? []),
  ]) {
    try {
      listener(draft);
    } catch (error) {
      console.error("Composer submission listener failed", error);
    }
  }
}
