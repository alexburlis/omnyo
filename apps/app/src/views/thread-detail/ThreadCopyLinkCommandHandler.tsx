import type { PluginThreadActionTarget } from "@omnyo/plugin-sdk";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { useThreadActionEntries } from "@/lib/thread-actions/thread-action-registry";
import { usePaneContext } from "./PaneContext";

const COPY_LINK_KEYS = ["omnyo--core/copyLink"];

export function ThreadCopyLinkCommandHandler({
  thread,
}: {
  thread: PluginThreadActionTarget;
}) {
  const { isFocused } = usePaneContext();
  const [copyLink] = useThreadActionEntries(thread, { keys: COPY_LINK_KEYS });

  useAppCommandHandler("thread.copyLink", () => {
    if (!isFocused || copyLink === undefined) return false;

    void copyLink.action.run();

    return true;
  });

  return null;
}
