import { useCallback, useSyncExternalStore } from "react";
import { nanoid } from "nanoid";
import type { PromptDraftAttachment } from "@omnyo/client-core";
import { appToast } from "@/components/ui/app-toast";
import {
  EMPTY_ATTACHMENT_MESSAGE,
  isEmptyAttachmentRejection,
  reportEmptyAttachment,
} from "@/lib/attachment-diagnostics";

export interface PendingAttachmentUpload {
  id: string;
  file: File;
  signal?: AbortSignal;
  cancel?: () => void;
  status?: "uploading" | "failed";
  error?: string | null;
  retry?: () => void;
}

export interface CapturedAttachmentUploads {
  files: readonly File[];
  wait(): Promise<{
    attachments: PromptDraftAttachment[];
    error: string | null;
  }>;
  restore(): void;
}

interface UploadOutcome {
  attachment: PromptDraftAttachment | null;
  failed: boolean;
  reason: string | null;
}

interface UploadJob {
  id: string;
  file: File;
  controller: AbortController;
  status: "uploading" | "failed" | "complete" | "cancelled";
  reason: string | null;
  claimed: boolean;
  added: boolean;
  attempt: Promise<UploadOutcome>;
  outcome: UploadOutcome | null;
  upload(file: File, signal: AbortSignal): Promise<PromptDraftAttachment>;
  onUploaded(attachment: PromptDraftAttachment): void;
  rejectionReason(error: unknown): string | null;
  store: UploadStore;
}

interface UploadStore {
  jobs: UploadJob[];
  snapshot: readonly PendingAttachmentUpload[];
  listeners: Set<() => void>;
}

interface StartUploadsOptions {
  upload(file: File, signal: AbortSignal): Promise<PromptDraftAttachment>;
  onUploaded(attachment: PromptDraftAttachment): void;
  rejectionReason(error: unknown): string | null;
}

const EMPTY_UPLOADS: readonly PendingAttachmentUpload[] = [];

const uploadedAttachmentSources = new WeakMap<PromptDraftAttachment, File>();

export function recordUploadedAttachmentSource(
  attachment: PromptDraftAttachment,
  file: File,
): void {
  uploadedAttachmentSources.set(attachment, file);
}

export function uploadedAttachmentSource(
  attachment: PromptDraftAttachment,
): File | null {
  return uploadedAttachmentSources.get(attachment) ?? null;
}

const stores = new Map<string, UploadStore>();

const aliases = new Map<string, string>();

const uploadQueue: (() => void)[] = [];

let activeUploads = 0;

export function attachmentUploadTargetKey(
  projectId: string,
  draftKey: string,
): string {
  return `${projectId}\0${draftKey}`;
}

export function movePendingAttachmentUploads(
  fromTargetKey: string,
  toTargetKey: string,
): void {
  if (fromTargetKey === toTargetKey) return;
  const source = storeFor(fromTargetKey);
  const destination = storeFor(toTargetKey);

  if (source === destination) return;

  if (source) {
    for (const job of source.jobs) {
      job.store = destination;

      if (!destination.jobs.includes(job)) destination.jobs.push(job);
    }

    for (const listener of source.listeners)
      destination.listeners.add(listener);
    source.listeners.clear();
    source.jobs = [];
    source.snapshot = EMPTY_UPLOADS;
  }

  aliases.set(fromTargetKey, toTargetKey);
  publish(destination);
}

function scheduleUpload<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      activeUploads += 1;
      void task()
        .then(resolve, reject)
        .finally(() => {
          activeUploads -= 1;
          uploadQueue.shift()?.();
        });
    };

    if (activeUploads < 3) run();
    else uploadQueue.push(run);
  });
}

function storeFor(key: string): UploadStore {
  let nextKey = aliases.get(key);

  while (nextKey !== undefined) {
    key = nextKey;
    nextKey = aliases.get(key);
  }

  let store = stores.get(key);

  if (!store) {
    store = { jobs: [], snapshot: EMPTY_UPLOADS, listeners: new Set() };
    stores.set(key, store);
  }

  return store;
}

function publish(store: UploadStore): void {
  store.snapshot = store.jobs.flatMap((job) => {
    if (job.claimed || job.status === "complete" || job.status === "cancelled")
      return [];

    return [
      {
        id: job.id,
        file: job.file,
        signal: job.controller.signal,
        status: job.status,
        error: job.reason,
        cancel: () => {
          job.status = "cancelled";
          job.controller.abort();
          job.store.jobs = job.store.jobs.filter(
            (existing) => existing !== job,
          );
          publish(job.store);
        },
        ...(job.status === "failed" ? { retry: () => startJob(job) } : {}),
      },
    ];
  });

  for (const listener of store.listeners) listener();
}

function startJob(job: UploadJob): void {
  const controller = new AbortController();
  job.controller = controller;
  job.status = "uploading";
  job.reason = null;
  job.outcome = null;
  job.attempt = scheduleUpload(async () => {
    let outcome: UploadOutcome;

    try {
      if (controller.signal.aborted) {
        outcome = {
          attachment: null,
          failed: true,
          reason: "Upload cancelled",
        };
      } else if (job.file.size === 0) {
        void reportEmptyAttachment(job.file, "empty_before_upload");
        outcome = {
          attachment: null,
          failed: true,
          reason: EMPTY_ATTACHMENT_MESSAGE,
        };
      } else {
        const attachment = await job.upload(job.file, controller.signal);

        if (controller.signal.aborted) {
          outcome = {
            attachment: null,
            failed: true,
            reason: "Upload cancelled",
          };
        } else {
          job.status = "complete";

          if (!job.claimed) {
            job.onUploaded(attachment);
            job.added = true;
          }

          recordUploadedAttachmentSource(attachment, job.file);
          outcome = { attachment, failed: false, reason: null };
        }
      }
    } catch (error) {
      const empty =
        !controller.signal.aborted && isEmptyAttachmentRejection(error);

      if (empty) void reportEmptyAttachment(job.file, "empty_on_server");
      outcome = {
        attachment: null,
        failed: true,
        reason: controller.signal.aborted
          ? "Upload cancelled"
          : empty
            ? EMPTY_ATTACHMENT_MESSAGE
            : job.rejectionReason(error),
      };
    }

    if (job.controller !== controller) return outcome;
    job.outcome = outcome;

    if (controller.signal.aborted) job.status = "cancelled";
    else if (outcome.failed) {
      job.status = "failed";
      job.reason = outcome.reason;

      if (!job.claimed)
        appToast.error("Attachment upload failed", {
          description: `${job.file.name}: ${outcome.reason ?? "Upload failed"}`,
        });
    }

    if (job.status === "complete" || job.status === "cancelled") {
      job.store.jobs = job.store.jobs.filter((existing) => existing !== job);
    }

    publish(job.store);

    return outcome;
  });
  publish(job.store);
}

export function attachmentUploadFailure(
  failures: readonly { file: File; reason: string | null }[],
): string | null {
  if (failures.length === 0) return null;
  const names = failures.map(({ file }) => file.name).join(", ");
  const reason = failures.find((failure) => failure.reason !== null)?.reason;

  return reason == null
    ? `Failed to attach: ${names}`
    : `Failed to attach ${names}: ${reason}`;
}

export function usePendingAttachmentUploads(targetKey: string | null) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (targetKey === null) return () => {};

      const store = storeFor(targetKey);
      store.listeners.add(listener);

      return () => {
        storeFor(targetKey).listeners.delete(listener);
      };
    },
    [targetKey],
  );

  const getSnapshot = useCallback(
    () => (targetKey === null ? EMPTY_UPLOADS : storeFor(targetKey).snapshot),
    [targetKey],
  );

  const pendingUploads = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_UPLOADS,
  );

  const startUploads = useCallback(
    (files: File[], options: StartUploadsOptions) => {
      if (targetKey === null) return Promise.resolve([]);
      const store = storeFor(targetKey);

      const jobs = files.map((file): UploadJob => ({
        id: nanoid(),
        file,
        controller: new AbortController(),
        status: "uploading",
        reason: null,
        claimed: false,
        added: false,
        attempt: Promise.resolve({
          attachment: null,
          failed: false,
          reason: null,
        }),
        outcome: null,
        store,
        ...options,
      }));

      store.jobs.push(...jobs);

      for (const job of jobs) startJob(job);

      return Promise.all(jobs.map((job) => job.attempt)).then((outcomes) =>
        outcomes.flatMap(({ attachment }) => (attachment ? [attachment] : [])),
      );
    },
    [targetKey],
  );

  const capturePendingUploads =
    useCallback((): CapturedAttachmentUploads | null => {
      if (targetKey === null) return null;
      const store = storeFor(targetKey);

      const jobs = store.jobs.filter(
        (job) =>
          !job.claimed &&
          (job.status === "uploading" || job.status === "failed"),
      );

      if (jobs.length === 0) return null;

      for (const job of jobs) job.claimed = true;
      const attempts = jobs.map((job) => job.attempt);
      publish(store);
      let restored = false;

      return {
        files: jobs.map((job) => job.file),
        async wait() {
          const outcomes = await Promise.all(attempts);

          return {
            attachments: outcomes.flatMap(({ attachment }) =>
              attachment ? [attachment] : [],
            ),
            error: attachmentUploadFailure(
              outcomes.flatMap((outcome, index) => {
                const job = jobs[index];

                return outcome.failed && job
                  ? [{ file: job.file, reason: outcome.reason }]
                  : [];
              }),
            ),
          };
        },
        restore() {
          if (restored) return;
          restored = true;

          for (const job of jobs) {
            job.claimed = false;

            if (job.outcome?.attachment && !job.added) {
              job.onUploaded(job.outcome.attachment);
              job.added = true;
            } else if (job.status !== "complete") {
              if (job.status === "cancelled") {
                job.status = "failed";
                job.reason = "Upload cancelled";
              }

              if (!job.store.jobs.includes(job)) job.store.jobs.push(job);
            }

            publish(job.store);
          }
        },
      };
    }, [targetKey]);

  return { pendingUploads, startUploads, capturePendingUploads };
}
