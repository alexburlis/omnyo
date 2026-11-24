import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  AUTOMATION_MAX_CONSECUTIVE_FAILURES,
  listPendingFailureNotices,
  markFailureNoticeSent,
  type AutomationFailureNoticeKind,
  type Db,
  type PendingFailureNotice,
} from "./data.js";
import { errorMessage } from "./run.js";

export const FAILURE_NOTICE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export const FAILURE_NOTICE_RETRY_DELAY_MS = 5 * 60 * 1_000;

const FAILURE_NOTICE_BATCH_SIZE = 20;

const PUSH_NOTIFICATIONS_PLUGIN_ID = "push-notifications";

const TITLE_MAX_LENGTH = 80;

const BODY_MAX_LENGTH = 500;

const noticeReceiptSchema = z
  .object({ id: z.string(), status: z.string() })
  .passthrough();

type FailureNoticeApi = Pick<PluginApi, "log"> & {
  sdk: { plugins: Pick<PluginApi["sdk"]["plugins"], "callRpc"> };
};

const NOTICE_TEXT: Record<
  AutomationFailureNoticeKind,
  { prefix: string; next: string }
> = {
  failed: {
    prefix: "Automation failed",
    next: " Open Automations to check it.",
  },
  retrying: {
    prefix: "Automation failed",
    next: ` Omnyo retries it and pauses it after ${AUTOMATION_MAX_CONSECUTIVE_FAILURES} failures in a row.`,
  },
  paused: {
    prefix: "Automation paused",
    next: " It stopped after repeated failures. Fix it, then resume it in Automations.",
  },
};

function truncate(text: string, maxLength: number): string {
  const collapsed = text.trim().replace(/\s+/gu, " ");

  return collapsed.length <= maxLength
    ? collapsed
    : `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

export function failureNoticeMessage(notice: PendingFailureNotice): {
  id: string;
  title: string;
  body: string;
} {
  const { prefix, next } = NOTICE_TEXT[notice.kind];
  const error = notice.error?.trim() || "The run failed without an error.";

  return {
    id: `automation-failure:${notice.runId}`,
    title: truncate(`${prefix}: ${notice.automationName}`, TITLE_MAX_LENGTH),
    body: `${truncate(error, BODY_MAX_LENGTH - next.length)}${next}`,
  };
}

export function createFailureNoticeSender(api: FailureNoticeApi, db: Db) {
  let retryAfter = 0;

  return async function sendPendingFailureNotices(
    now: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (now < retryAfter) return;

    const pending = listPendingFailureNotices(db, {
      finishedAfter: now - FAILURE_NOTICE_MAX_AGE_MS,
      limit: FAILURE_NOTICE_BATCH_SIZE,
    });

    for (const notice of pending) {
      signal.throwIfAborted();

      try {
        await api.sdk.plugins.callRpc({
          pluginId: PUSH_NOTIFICATIONS_PLUGIN_ID,
          method: "notifications.send",
          input: failureNoticeMessage(notice),
          outputSchema: noticeReceiptSchema,
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
      } catch (error) {
        signal.throwIfAborted();
        retryAfter = now + FAILURE_NOTICE_RETRY_DELAY_MS;
        api.log.warn(
          `Automation failure notice for run ${notice.runId} was not queued; retrying in 5 minutes: ${errorMessage(error)}`,
        );

        return;
      }

      markFailureNoticeSent(db, { runId: notice.runId, now: Date.now() });
    }
  };
}
