import { useEffect, useSyncExternalStore } from "react";
import { defineSplit } from "@/lib/define-split";
import {
  isToasterRequested,
  markToasterUnavailable,
  subscribeToasterRequest,
} from "./ui/app-toast-runtime";

function ToasterUnavailable({ retry }: { retry: () => void }) {
  useEffect(() => markToasterUnavailable(retry), [retry]);

  return null;
}

const AppToasterSplit = defineSplit<object>({
  id: "app-toaster",
  load: () =>
    import("./AppToasterView").then((module) => module.AppToasterView),
  loading: () => null,
  error: ToasterUnavailable,
});

export function AppToaster() {
  const requested = useSyncExternalStore(
    subscribeToasterRequest,
    isToasterRequested,
  );

  return requested ? <AppToasterSplit /> : null;
}
