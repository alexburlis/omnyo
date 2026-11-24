import type { TimelineUserConversationRow } from "@omnyo/server-contract";
import { parseAgentMessageEnvelope } from "./agent-message-envelope.js";
import { parseAutomationDueMessage } from "./automation-due-message.js";

type UserMessageSource = Pick<
  TimelineUserConversationRow,
  "initiator" | "senderThreadId" | "systemMessageKind" | "text"
>;

export function isHumanThreadInput(message: UserMessageSource): boolean {
  return (
    message.initiator === "user" &&
    message.senderThreadId === null &&
    message.systemMessageKind !== "external-message" &&
    parseAgentMessageEnvelope(message.text) === null &&
    parseAutomationDueMessage(message.text) === null
  );
}

export function userMessageSourceLabel(
  message: UserMessageSource &
    Pick<TimelineUserConversationRow, "systemMessageSubject">,
): string {
  const sourceThreadId =
    message.senderThreadId ??
    parseAgentMessageEnvelope(message.text)?.senderThreadId;

  if (sourceThreadId) return `Thread ${sourceThreadId}`;

  if (message.initiator === "agent") return "Agent";
  const subject = message.systemMessageSubject;

  if (subject?.kind === "message-source") {
    return subject.source.kind === "script"
      ? `Script ${subject.source.label}`
      : `Plugin ${subject.source.pluginId}`;
  }

  const automation = parseAutomationDueMessage(message.text);

  if (automation !== null) return `Automation ${automation.automationId}`;

  return message.initiator === "system" ||
    message.systemMessageKind === "external-message"
    ? "System"
    : "User";
}
