import type { z } from "zod";
import type {
  composerSubmissionEntriesSchema,
  pendingChatDescriptorsSchema,
} from "../../../app/src/lib/legacy-browser-storage-v1.js";
import { withOriginStorageLeaseV1 } from "../../../app/src/lib/origin-storage-transfer-v1.js";
import {
  stageOriginWindowStateV1,
  restoreOriginWindowStateV1,
} from "../../../app/src/lib/origin-window-state-v1.js";

function context(index: number) {
  if (index !== 0 && index !== 1)
    throw new Error("Synthetic window selection is invalid");

  const id = (index === 0 ? "a" : "c").repeat(64);

  const ticket = {
    version: 1 as const,
    adoptionId: "synthetic-native-window",
    id,
    selectedIds: ["a".repeat(64), "c".repeat(64)],
    nonce: (index === 0 ? "b" : "d").repeat(64),
    fromOrigin: location.origin,
    toOrigin: "http://127.0.0.1:49174",
  };

  const tabId = `synthetic-stable-tab-${index}`;

  const pendingId = `pending_synthetic_${index}`;

  const submissions = [
    {
      id: `synthetic-submission-${index}`,
      scope: {
        kind: "thread",
        projectId: "proj_synthetic",
        threadId: pendingId,
      },
      draft: JSON.stringify({
        text: "unsubmitted work",
        mentions: [],
        attachments: [],
      }),
    },
  ] satisfies z.infer<typeof composerSubmissionEntriesSchema>;

  const descriptors = [
    {
      id: pendingId,
      projectId: "proj_synthetic",
      realThreadId: "thr_synthetic",
    },
  ] satisfies z.infer<typeof pendingChatDescriptorsSchema>;

  const pending = JSON.stringify(submissions);
  const pendingDescriptors = JSON.stringify(descriptors);

  const opaque = `opaque synthetic user bytes ${index}`;

  return {
    ticket,
    tabId,
    pending,
    pendingDescriptors,
    opaque,
    windowKey: index === 0 ? "primary" : "window-explicit-selected-second",
  };
}

function initialize(index: number) {
  const { tabId, pending, pendingDescriptors, opaque } = context(index);
  localStorage.setItem(`bb.composer-submissions.v1.${tabId}`, pending);
  localStorage.setItem(`unknown-native-fixture-${index}`, opaque);
  sessionStorage.setItem("bb.composer-submission-tab.v1", tabId);
  sessionStorage.setItem("bb.pending-chats.v1", pendingDescriptors);
  sessionStorage.setItem("unknown-native-session", opaque);
}

async function stage(index: number) {
  const { ticket, windowKey, tabId } = context(index);
  await withOriginStorageLeaseV1(() =>
    stageOriginWindowStateV1({
      ticket,
      windowKey,
      currentOrigin: location.origin,
      local: localStorage,
      session: sessionStorage,
    }),
  );

  return {
    staged: true,
    secureContext: window.isSecureContext,
    webLocksAvailable: typeof navigator.locks?.request === "function",
    tabIdPreserved:
      sessionStorage.getItem("bb.composer-submission-tab.v1") === tabId,
  };
}

async function restore(index: number) {
  const { ticket, windowKey, tabId, pending, pendingDescriptors, opaque } =
    context(index);

  const freshWindowLostSession =
    sessionStorage.getItem("bb.composer-submission-tab.v1") === null;

  await restoreOriginWindowStateV1({
    ticket,
    windowKey,
    currentOrigin: location.origin,
    local: localStorage,
    session: sessionStorage,
  });

  const tabIdPreserved =
    sessionStorage.getItem("bb.composer-submission-tab.v1") === tabId;

  const pendingIdsPreserved =
    sessionStorage.getItem("bb.pending-chats.v1") === pendingDescriptors;

  const journalPreserved =
    localStorage.getItem(`bb.composer-submissions.v1.${tabId}`) === pending;

  const unknownPreserved =
    localStorage.getItem(`unknown-native-fixture-${index}`) === opaque &&
    sessionStorage.getItem("unknown-native-session") === opaque;

  return {
    freshWindowLostSession,
    tabIdPreserved,
    pendingIdsPreserved,
    journalPreserved,
    unknownPreserved,
  };
}

function inputs(index: number) {
  const { pending, pendingDescriptors, tabId } = context(index);

  return { journal: pending, pending: pendingDescriptors, tabId };
}

Object.assign(window, {
  omnyoProfileFixture: { initialize, stage, restore, inputs },
});
