import {
  QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH,
  queuedMessageWaitReasonSchema,
  type QueuedMessageWaitingOn,
} from "@omnyo/domain";
import type { ComposerSubmitOptions } from "@omnyo/plugin-sdk";
import type { SendMessageRequest } from "@omnyo/server-contract";

export type ExpectedPluginWait = Extract<
  QueuedMessageWaitingOn,
  { kind: "plugin" }
>;

export function expectedPluginWait(
  options: ComposerSubmitOptions | null,
  pluginSubmission: SendMessageRequest["pluginSubmission"],
): ExpectedPluginWait | undefined {
  const hint = options?.experimental_expectHeld;

  if (hint === undefined) return undefined;

  if (pluginSubmission === undefined)
    throw new TypeError(
      "experimental_expectHeld needs experimental_data so the plugin's dispatch hook can recognize the submission.",
    );

  const reason = queuedMessageWaitReasonSchema.safeParse(hint.reason);

  if (!reason.success)
    throw new TypeError(
      `experimental_expectHeld.reason must be 1 to ${QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH} characters.`,
    );

  return {
    kind: "plugin",
    pluginId: pluginSubmission.pluginId,
    reason: reason.data,
  };
}
