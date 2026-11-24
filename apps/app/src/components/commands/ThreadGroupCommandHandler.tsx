import {
  useAppCommandContext,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import { useThreadGroupActions } from "@/hooks/useThreadGroupActions";
import { useChatSelection } from "@/lib/chat-selection";

export function ThreadGroupCommandHandler() {
  const selection = useChatSelection();
  const { group } = useThreadGroupActions();

  useAppCommandContext("chatSelection", selection.length > 0);

  useAppCommandHandler("thread.group", () => {
    if (selection.length === 0) return false;

    void group(selection).catch(() => undefined);

    return true;
  });

  return null;
}
