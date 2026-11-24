import type { PluginThreadActionTarget } from "@omnyo/plugin-sdk";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { useThreadActionEntries } from "@/lib/thread-actions/thread-action-registry";
import { usePaneContext } from "./PaneContext";

const SHELVE_KEYS = ["omnyo--core/shelve"];

export function ThreadShelveCommandHandler({
  thread,
}: {
  thread: PluginThreadActionTarget;
}) {
  const { isFocused } = usePaneContext();
  const [shelve] = useThreadActionEntries(thread, { keys: SHELVE_KEYS });

  useAppCommandHandler("thread.shelve", () => {
    if (!isFocused || shelve === undefined) return false;

    void shelve.action.run();

    return true;
  });

  return null;
}
