import { isActiveTerminalSessionStatus } from "@omnyo/domain";
import type { TerminalSession } from "@omnyo/server-contract";

export function isVisibleTerminalSession(session: TerminalSession): boolean {
  return (
    isActiveTerminalSessionStatus(session.status) ||
    session.status === "disconnected"
  );
}
