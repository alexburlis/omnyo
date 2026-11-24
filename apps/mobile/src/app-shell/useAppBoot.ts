import { useEffect, useState } from "react";
import { getPreferencesStorage, getProfileStore } from "@/lib/native";
import { resetLocalState, resetOnLaunch } from "./e2e";
import { revealApp } from "./LaunchSplash";

export interface AppBootState {
  ready: boolean;
}

export function useAppBoot(): AppBootState {
  const [state, setState] = useState<AppBootState>({ ready: false });
  const [failure, setFailure] = useState<Error | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await getProfileStore().load();
      getPreferencesStorage();

      if (resetOnLaunch) await resetLocalState();
    })()
      .then(() => {
        if (!cancelled) setState({ ready: true });
      })
      .catch(() => {
        if (!cancelled) {
          revealApp();
          setFailure(
            new Error(
              "Saved mobile data could not be loaded. Restart the app to try again.",
            ),
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (failure !== null) throw failure;

  return state;
}
