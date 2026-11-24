import { useEffect, useState, type ReactNode } from "react";
import type { PendingAttachmentUpload } from "./usePendingAttachmentUploads";
import { useAttachmentOpener } from "@/components/secondary-panel/AttachmentOpenerContext";
import { isProjectAttachmentPath } from "@/lib/file-content-urls";
import {
  getWrappedImageIndex,
  ImageLightbox,
} from "@/components/ui/image-lightbox.js";
import { Icon } from "@omnyo/shared-ui/icon";
import type { PromptDraftAttachment } from "@omnyo/client-core";
import {
  toUserAttachmentImageSrc,
  userAttachmentThumbnailSources,
} from "@/lib/user-attachment-images";
import {
  getLocalAttachmentPreviewSrc,
  releaseLocalAttachmentPreview,
} from "@/lib/attachment-local-previews";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  promptAttachmentKey,
  usePromptImageAnchors,
} from "./attachment-anchor-focus";
import { IMAGE_ANCHOR_DRAG_TYPE } from "./editor/prompt-image-anchor";

export function resolveAttachmentPreviewSrc(
  path: string,
  attachmentProjectId: string | undefined,
): string {
  return (
    getLocalAttachmentPreviewSrc(path) ??
    toUserAttachmentImageSrc(path, attachmentProjectId)
  );
}

const FILE_ATTACHMENT_PILL_CLASS =
  "inline-flex h-8 max-w-64 items-center gap-2 rounded-lg border border-border bg-surface-raised py-1 pl-1 pr-1.5 text-xs text-foreground shadow-xs";

function fileExtensionLabel(name: string): string | null {
  const dot = name.lastIndexOf(".");

  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1);

  return extension.length <= 5 ? extension.toUpperCase() : null;
}

function FileChipIcon({ state }: { state: "ready" | "uploading" | "failed" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md",
        state === "failed"
          ? "bg-surface-destructive text-destructive-text"
          : "bg-state-hover text-muted-foreground",
      )}
    >
      <Icon
        name={
          state === "failed"
            ? "AlertCircle"
            : state === "uploading"
              ? "Loading"
              : "FileText"
        }
        className={cn("size-3.5", state === "uploading" && "animate-spin")}
      />
    </span>
  );
}

function FileChipLabel({
  name,
  children,
  status,
}: {
  name: string;
  children: ReactNode;
  status?: ReactNode;
}) {
  const extension = fileExtensionLabel(name);

  return (
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="min-w-0 truncate font-medium">{children}</span>
      {(status ?? extension) ? (
        <span className="truncate text-2xs text-subtle-foreground">
          {status ?? extension}
        </span>
      ) : null}
    </span>
  );
}

const FILE_CHIP_ACTION_CLASS =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function isImageAttachment(attachment: PromptDraftAttachment): boolean {
  return (
    attachment.type === "localImage" ||
    attachment.mimeType?.toLowerCase().startsWith("image/") === true
  );
}

interface AttachmentPreviewProps {
  attachments: PromptDraftAttachment[];
  pendingUploads?: readonly PendingAttachmentUpload[];
  compact?: boolean;
  attachmentProjectId?: string;
  expandedImageIndex: number | null;
  onExpandedImageIndexChange: (index: number | null) => void;
  onRemoveAttachment?: (attachment: PromptDraftAttachment) => void;
}

function isImageUpload(upload: PendingAttachmentUpload): boolean {
  return upload.file.type.startsWith("image/");
}

function ImageUploadPreview({
  file,
  cancel,
  retry,
  error,
}: {
  file: File;
  cancel?: () => void;
  retry?: () => void;
  error?: string | null;
}) {
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div
      role="status"
      aria-label={`${retry ? "Failed to upload" : "Uploading"} ${file.name}`}
      aria-description={error ?? undefined}
      className="relative shrink-0"
    >
      <span className="relative block h-16 w-24 overflow-hidden rounded-md border border-border bg-surface-recessed">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt=""
            className="size-full object-cover opacity-50"
          />
        ) : null}
        <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-background/90 py-1 text-xs text-foreground">
          <Icon
            name={retry ? "AlertCircle" : "Loading"}
            className={
              retry ? "size-3 text-destructive" : "size-3 animate-spin"
            }
          />
          {retry ? "Failed" : "Uploading"}
          {retry ? (
            <button
              type="button"
              aria-label={`Retry upload of ${file.name}`}
              onClick={retry}
              className="inline-flex size-4 items-center justify-center rounded transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Icon name="RotateCcw" className="size-3" />
            </button>
          ) : null}
        </span>
      </span>
      {cancel ? (
        <button
          type="button"
          aria-label={`${retry ? "Remove" : "Cancel upload of"} ${file.name}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={cancel}
          className="group/attachment-remove-image absolute right-1 top-1 z-10 inline-flex size-4 items-center justify-center rounded-full text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:-right-1 max-md:pointer-coarse:-top-1 max-md:pointer-coarse:size-7"
        >
          <span className="inline-flex size-4 items-center justify-center rounded-full bg-black/55 transition-colors group-hover/attachment-remove-image:bg-black/70">
            <Icon name="X" className="size-3" />
          </span>
        </button>
      ) : null}
    </div>
  );
}

function FileAttachmentName({
  name,
  path,
  projectId,
}: {
  name: string;
  path: string;
  projectId: string | undefined;
}) {
  const openAttachment = useAttachmentOpener();

  if (!openAttachment || !projectId || !isProjectAttachmentPath({ path })) {
    return <span className="truncate">{name}</span>;
  }

  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => openAttachment({ name, path, projectId })}
      className="truncate hover:underline focus-visible:outline-none focus-visible:underline"
    >
      {name}
    </button>
  );
}

function FileUploadPreview({
  file,
  cancel,
  retry,
  error,
}: {
  file: File;
  cancel?: () => void;
  retry?: () => void;
  error?: string | null;
}) {
  return (
    <span
      role="status"
      aria-label={`${retry ? "Failed to upload" : "Uploading"} ${file.name}`}
      aria-description={error ?? undefined}
      className={FILE_ATTACHMENT_PILL_CLASS}
    >
      <FileChipIcon state={retry ? "failed" : "uploading"} />
      <FileChipLabel
        name={file.name}
        status={
          retry ? (
            <span className="text-destructive-text">Upload failed</span>
          ) : (
            "Uploading…"
          )
        }
      >
        {file.name}
      </FileChipLabel>
      {retry ? (
        <button
          type="button"
          aria-label={`Retry upload of ${file.name}`}
          onClick={retry}
          className={FILE_CHIP_ACTION_CLASS}
        >
          <Icon name="RotateCcw" className="size-3" />
        </button>
      ) : null}
      {cancel ? (
        <button
          type="button"
          aria-label={`${retry ? "Remove" : "Cancel upload of"} ${file.name}`}
          onClick={cancel}
          className={FILE_CHIP_ACTION_CLASS}
        >
          <Icon name="X" className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

export function AttachmentPreview({
  attachments,
  pendingUploads = [],
  compact = false,
  attachmentProjectId,
  expandedImageIndex,
  onExpandedImageIndexChange,
  onRemoveAttachment,
}: AttachmentPreviewProps) {
  const anchors = usePromptImageAnchors();
  const imageAttachments = attachments.filter(isImageAttachment);

  const nonImageAttachments = attachments.filter(
    (attachment) => !isImageAttachment(attachment),
  );

  const imageUploads = pendingUploads.filter(isImageUpload);
  const fileUploads = pendingUploads.filter((upload) => !isImageUpload(upload));

  const attachmentImageItems = imageAttachments.map((attachment) => {
    const projectId = attachment.sourceProjectId ?? attachmentProjectId;
    const src = resolveAttachmentPreviewSrc(attachment.path, projectId);

    const thumbnail = /^(blob:|data:)/i.test(src)
      ? null
      : userAttachmentThumbnailSources(attachment.path, projectId);

    return { alt: attachment.name, src, thumbnail };
  });

  const hasMultipleAttachmentImages = imageAttachments.length > 1;

  const currentAttachmentImage =
    expandedImageIndex !== null
      ? (attachmentImageItems[expandedImageIndex] ?? null)
      : null;

  useEffect(() => {
    if (expandedImageIndex === null) return;

    if (expandedImageIndex < imageAttachments.length) return;
    onExpandedImageIndexChange(null);
  }, [expandedImageIndex, imageAttachments.length, onExpandedImageIndexChange]);

  const attachmentCount = attachments.length;

  const failedCount = pendingUploads.filter(
    (upload) => upload.status === "failed",
  ).length;

  const uploadingCount = pendingUploads.length - failedCount;

  if (attachmentCount + pendingUploads.length === 0) {
    return null;
  }

  return (
    <>
      {compact ? (
        <span
          data-promptbox-attachments=""
          role={uploadingCount > 0 ? "status" : "img"}
          aria-label={[
            attachmentCount > 0
              ? `${attachmentCount} ${attachmentCount === 1 ? "attachment" : "attachments"}`
              : null,
            uploadingCount > 0 ? `${uploadingCount} uploading` : null,
            failedCount > 0 ? `${failedCount} failed` : null,
          ]
            .filter(Boolean)
            .join(", ")}
          className="ml-3 inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md bg-surface-recessed px-1.5 text-xs text-muted-foreground"
        >
          <Icon name="Paperclip" className="size-3.5" />
          <span aria-hidden="true">
            {attachmentCount + pendingUploads.length}
          </span>
          {uploadingCount > 0 ? (
            <Icon name="Loading" className="size-3.5 animate-spin" />
          ) : null}
        </span>
      ) : (
        <div className="mx-3 mb-1 mt-1">
          {imageAttachments.length > 0 || imageUploads.length > 0 ? (
            <div className="mb-1.5 flex flex-wrap gap-2">
              {imageAttachments.map((attachment, index) => {
                const key = promptAttachmentKey(attachment);
                const isActive = anchors?.activeKey === key;

                return (
                  <div key={`${attachment.path}-${index}`} className="relative">
                    <button
                      type="button"
                      className={cn(
                        "block cursor-zoom-in overflow-hidden rounded-md border border-border bg-surface-recessed transition-shadow",
                        isActive && "ring-2 ring-ring",
                      )}
                      onClick={() => onExpandedImageIndexChange(index)}
                      {...(attachment.alias
                        ? {
                            "aria-label": `${attachment.alias}, ${attachment.name}`,
                          }
                        : { title: attachment.name })}
                      draggable={
                        anchors !== null && attachment.alias !== undefined
                      }
                      onDragStart={(event) => {
                        event.dataTransfer.setData(IMAGE_ANCHOR_DRAG_TYPE, key);
                        event.dataTransfer.effectAllowed = "copy";
                      }}
                      onPointerEnter={() => anchors?.setActiveKey(key)}
                      onPointerLeave={() => anchors?.setActiveKey(null)}
                      onFocus={() => anchors?.setActiveKey(key)}
                      onBlur={() => anchors?.setActiveKey(null)}
                    >
                      <img
                        src={
                          attachmentImageItems[index]?.thumbnail?.src ??
                          attachmentImageItems[index]?.src
                        }
                        srcSet={attachmentImageItems[index]?.thumbnail?.srcSet}
                        alt={attachment.alias ? "" : attachment.name}
                        className="h-16 w-24 object-cover"
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                      />
                      {attachment.alias ? (
                        <span
                          aria-hidden="true"
                          className="absolute bottom-1 left-1 rounded-sm bg-background/85 px-1 text-xs font-medium leading-4 text-foreground"
                        >
                          {attachment.alias}
                        </span>
                      ) : null}
                    </button>
                    {onRemoveAttachment ? (
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          event.currentTarget.blur();
                          releaseLocalAttachmentPreview(attachment.path);
                          onRemoveAttachment(attachment);
                        }}
                        className="group/attachment-remove-image absolute right-1 top-1 z-10 inline-flex size-4 items-center justify-center rounded-full text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:-right-1 max-md:pointer-coarse:-top-1 max-md:pointer-coarse:size-7"
                        aria-label={`Remove ${attachment.alias ?? attachment.name}`}
                      >
                        <span className="inline-flex size-4 items-center justify-center rounded-full bg-black/55 transition-colors group-hover/attachment-remove-image:bg-black/70">
                          <Icon name="X" className="size-3" />
                        </span>
                      </button>
                    ) : null}
                  </div>
                );
              })}
              {imageUploads.map((upload) => (
                <ImageUploadPreview
                  key={upload.id}
                  file={upload.file}
                  cancel={upload.cancel}
                  retry={upload.retry}
                  error={upload.error}
                />
              ))}
            </div>
          ) : null}

          {nonImageAttachments.length > 0 || fileUploads.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {nonImageAttachments.map((attachment) => (
                <span
                  key={attachment.path}
                  className={FILE_ATTACHMENT_PILL_CLASS}
                >
                  <FileChipIcon state="ready" />
                  <FileChipLabel name={attachment.name}>
                    <FileAttachmentName
                      name={attachment.name}
                      path={attachment.path}
                      projectId={
                        attachment.sourceProjectId ?? attachmentProjectId
                      }
                    />
                  </FileChipLabel>
                  {onRemoveAttachment ? (
                    <span className="relative size-4 shrink-0">
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          event.currentTarget.blur();
                          onRemoveAttachment(attachment);
                        }}
                        className="group/attachment-remove-file absolute left-1/2 top-1/2 inline-flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:size-7"
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <span className="inline-flex size-4 items-center justify-center rounded transition-colors group-hover/attachment-remove-file:bg-state-hover group-hover/attachment-remove-file:text-foreground">
                          <Icon name="X" className="size-3" />
                        </span>
                      </button>
                    </span>
                  ) : null}
                </span>
              ))}
              {fileUploads.map((upload) => (
                <FileUploadPreview
                  key={upload.id}
                  file={upload.file}
                  cancel={upload.cancel}
                  retry={upload.retry}
                  error={upload.error}
                />
              ))}
            </div>
          ) : null}
        </div>
      )}

      <ImageLightbox
        imageSrc={currentAttachmentImage?.src ?? null}
        imageAlt={currentAttachmentImage?.alt ?? "Attached image"}
        title="Attached image preview"
        hasMultipleImages={hasMultipleAttachmentImages}
        onPrevious={() => {
          onExpandedImageIndexChange(
            expandedImageIndex === null || attachmentImageItems.length <= 1
              ? expandedImageIndex
              : getWrappedImageIndex({
                  currentIndex: expandedImageIndex,
                  direction: "previous",
                  itemCount: attachmentImageItems.length,
                }),
          );
        }}
        onNext={() => {
          onExpandedImageIndexChange(
            expandedImageIndex === null || attachmentImageItems.length <= 1
              ? expandedImageIndex
              : getWrappedImageIndex({
                  currentIndex: expandedImageIndex,
                  direction: "next",
                  itemCount: attachmentImageItems.length,
                }),
          );
        }}
        onClose={() => onExpandedImageIndexChange(null)}
      />
    </>
  );
}
