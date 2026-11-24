import { useEffect, useRef } from "react";
import { useAtomValue, useStore } from "jotai";
import {
  experimental_usePluginId,
  useRealtime,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import type { threadListRpcContract } from "../../server.js";
import { PREFERENCES_CHANGED_CHANNEL } from "../../shared/preferences.js";
import {
  applyRemotePreferenceSignal,
  attachPreferencesStore,
  hydratePreferences,
  hydratePreferencesFromMirror,
  preferencesReadyAtom,
  preferencesErrorAtom,
  reportPreferencesSyncError,
  clearPreferencesSyncError,
} from "./preferences-sync.js";

export function usePreferencesReady(): boolean {
  return useAtomValue(preferencesReadyAtom());
}

let syncOwnerCount = 0;

export function usePreferencesSync(retryAfterError: boolean): boolean {
  const rpc = useRpc<typeof threadListRpcContract>();
  const store = useStore();
  const pluginId = experimental_usePluginId();
  const attempted = useRef(false);
  useEffect(() => {
    attachPreferencesStore(store, pluginId);
    syncOwnerCount += 1;
    attempted.current = true;

    if (
      syncOwnerCount === 1 ||
      (retryAfterError && store.get(preferencesErrorAtom()) !== null)
    ) {
      clearPreferencesSyncError();

      try {
        hydratePreferencesFromMirror();
        void hydratePreferences(rpc).catch(reportPreferencesSyncError);
      } catch (error: unknown) {
        reportPreferencesSyncError(error);
      }
    }

    return () => {
      syncOwnerCount -= 1;
    };
  }, [pluginId, retryAfterError, rpc, store]);
  useRealtime(PREFERENCES_CHANGED_CHANNEL, applyRemotePreferenceSignal);

  return attempted.current;
}

export function PreferencesSync() {
  const attempted = usePreferencesSync(true);
  const error = useAtomValue(preferencesErrorAtom());

  if (error !== null && attempted) throw error;

  return null;
}

export function PreferencesSyncController() {
  usePreferencesSync(false);

  return null;
}
