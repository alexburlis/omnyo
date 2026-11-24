import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "jotai";
import { useUiPreferences } from "@/hooks/queries/system-queries";
import {
  reconcileUiPreferences,
  startUiPreferencesSync,
} from "./ui-preferences-sync";

type UiPreferencesLoadState = "loading" | "loaded" | "failed";

export function useUiPreferencesLoadState(): UiPreferencesLoadState {
  const { data, errorUpdateCount } = useUiPreferences();

  if (data !== undefined) return "loaded";

  return errorUpdateCount > 0 ? "failed" : "loading";
}

export function useUiPreferencesReady(): boolean {
  return useUiPreferencesLoadState() !== "loading";
}

export function UiPreferencesSync() {
  const queryClient = useQueryClient();
  const store = useStore();
  const { data } = useUiPreferences();

  useEffect(
    () => startUiPreferencesSync({ queryClient, store }),
    [queryClient, store],
  );

  useEffect(() => {
    if (data !== undefined) reconcileUiPreferences(data);
  }, [data]);

  return null;
}
