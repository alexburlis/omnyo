import { useEffect, useState } from "react";
import type { TimelineConversationAttachments } from "@omnyo/server-contract";
import type { PromptTextMention } from "@omnyo/domain";
import { fileNameFromPath } from "@omnyo/thread-view";
import {
  ImageLightbox,
  getWrappedImageIndex,
} from "../../ui/image-lightbox.js";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@omnyo/shared-ui/motion";
import {
  buildProjectAttachmentContentUrl,
  isAbsoluteLocalPath,
  isProjectAttachmentPath,
} from "@/lib/file-content-urls";
import { formatByteSize } from "@/lib/format-byte-size";
import { useAttachmentOpener } from "@/components/secondary-panel/AttachmentOpenerContext";
import type {
  ThreadTimelineLocalFileLinkHandler,
  UserAttachmentImageSrcResolver,
} from "./types.js";
import { IMAGE_ANCHOR_ATTR, pairSentImageAnchors } from "./sent-image-anchors";

import {
  responsiveThumbnailSources,
  userAttachmentThumbnailSources,
} from "@/lib/user-attachment-images";

interface ConversationImageItem {
  alt: string;
  src: string;
  anchorLabel: string | null;
  thumbnail?: { src: string; srcSet: string };
}

export interface ConversationAttachmentItems {
  filePaths: string[];
  fileDetails: TimelineConversationAttachments["localFileDetails"];
  imageItems: ConversationImageItem[];
}

interface ConversationAttachmentsProps extends ConversationAttachmentItems {
  align?: "start" | "end";
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
}

interface BuildAttachmentItemsArgs {
  attachments: TimelineConversationAttachments | null;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  text: string;
  mentions: readonly PromptTextMention[];
}

interface ProjectAttachmentHrefArgs {
  path: string;
  projectId: string | undefined;
}

const INTERACTIVE_ATTACHMENT_PILL_CLASS = `cursor-pointer hover:bg-state-hover ${CONTROL_PRESS_TRANSITION} ${CONTROL_PRESS_FEEDBACK}`;

function projectAttachmentHref({
  path,
  projectId,
}: ProjectAttachmentHrefArgs): string | null {
  if (!projectId || !isProjectAttachmentPath({ path })) {
    return null;
  }

  return buildProjectAttachmentContentUrl(projectId, path);
}

export function buildAttachmentItems({
  attachments,
  projectId,
  resolveUserAttachmentImageSrc,
  text,
  mentions,
}: BuildAttachmentItemsArgs): ConversationAttachmentItems {
  if (!attachments) {
    return {
      filePaths: [],
      fileDetails: [],
      imageItems: [],
    };
  }

  const anchorLabels = pairSentImageAnchors({
    text,
    mentions,
    localImagePaths: attachments.localImagePaths,
  });

  const imageItems: ConversationImageItem[] = [
    ...attachments.imageUrls.map((url) => ({
      alt: fileNameFromPath(url),
      src: url,
      anchorLabel: null,
    })),
    ...attachments.localImagePaths.map((path, index) => {
      const src = resolveUserAttachmentImageSrc
        ? resolveUserAttachmentImageSrc(path, projectId)
        : path;

      const thumbnail = /^(blob:|data:)/i.test(src)
        ? null
        : resolveUserAttachmentImageSrc
          ? responsiveThumbnailSources(src, (thumbnailWidth) =>
              resolveUserAttachmentImageSrc(path, projectId, {
                thumbnailWidth,
              }),
            )
          : userAttachmentThumbnailSources(path, projectId);

      return {
        alt: fileNameFromPath(path),
        src,
        anchorLabel: anchorLabels[index] ?? null,
        ...(thumbnail === null ? {} : { thumbnail }),
      };
    }),
  ];

  return {
    filePaths: attachments.localFilePaths,
    fileDetails: attachments.localFileDetails,
    imageItems,
  };
}

export function ConversationAttachments({
  align = "start",
  filePaths,
  fileDetails,
  imageItems,
  onOpenLocalFileLink,
  projectId,
}: ConversationAttachmentsProps) {
  const openAttachment = useAttachmentOpener();

  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(
    null,
  );

  const currentImageItem =
    expandedImageIndex === null
      ? null
      : (imageItems[expandedImageIndex] ?? null);

  const hasMultipleImages = imageItems.length > 1;
  const justifyClassName = align === "end" ? "justify-end" : "justify-start";

  useEffect(() => {
    if (expandedImageIndex === null || expandedImageIndex < imageItems.length) {
      return;
    }

    setExpandedImageIndex(null);
  }, [expandedImageIndex, imageItems.length]);

  if (filePaths.length === 0 && imageItems.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 space-y-2">
      {imageItems.length > 0 ? (
        <div className={cn("flex flex-wrap gap-2", justifyClassName)}>
          {imageItems.map((imageItem, index) => (
            <button
              type="button"
              key={`${imageItem.src}-${index}`}
              className={cn(
                "relative cursor-zoom-in overflow-hidden rounded-md border transition-[box-shadow,scale] [transition-duration:var(--motion-duration-fast),var(--motion-duration-base)] [transition-timing-function:var(--motion-ease-standard),var(--motion-ease-snappy)] active:[transition-duration:var(--motion-duration-fast)]",
                CONTROL_PRESS_FEEDBACK,
                "data-[image-anchor-active=true]:ring-2 data-[image-anchor-active=true]:ring-ring",
                align === "end"
                  ? "border-surface-selected-border bg-surface-raised"
                  : "border-border bg-surface-recessed",
              )}
              onClick={() => setExpandedImageIndex(index)}
              {...(imageItem.anchorLabel
                ? {
                    "aria-label": `${imageItem.anchorLabel}, ${imageItem.alt}`,
                    [IMAGE_ANCHOR_ATTR]: imageItem.anchorLabel,
                  }
                : { title: imageItem.alt })}
            >
              {imageItem.anchorLabel ? (
                <span
                  aria-hidden="true"
                  className="absolute bottom-1 left-1 rounded-sm bg-background/85 px-1 text-xs leading-4 font-medium text-foreground"
                >
                  {imageItem.anchorLabel}
                </span>
              ) : null}
              <img
                src={imageItem.thumbnail?.src ?? imageItem.src}
                srcSet={imageItem.thumbnail?.srcSet}
                alt={imageItem.alt}
                className={cn(
                  "object-cover",
                  align === "end" ? "h-20 w-36" : "h-16 w-24",
                )}
                loading="lazy"
                decoding="async"
              />
            </button>
          ))}
        </div>
      ) : null}
      {filePaths.length > 0 ? (
        <div className={cn("flex flex-wrap gap-1.5", justifyClassName)}>
          {filePaths.map((path) => {
            const className = cn(
              "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground",
              align === "end"
                ? "border-surface-selected-border bg-surface-raised"
                : "border-border bg-surface-recessed",
            );

            const detail = fileDetails.find((file) => file.path === path);

            const label = (
              <span className="truncate">
                {detail?.name ?? fileNameFromPath(path)}
                {detail?.sizeBytes == null
                  ? ""
                  : ` · ${formatByteSize(detail.sizeBytes)}`}
              </span>
            );

            const attachmentHref = projectAttachmentHref({ path, projectId });

            if (attachmentHref && openAttachment && projectId) {
              return (
                <button
                  key={path}
                  type="button"
                  className={cn(className, INTERACTIVE_ATTACHMENT_PILL_CLASS)}
                  onClick={() =>
                    openAttachment({
                      name: detail?.name ?? fileNameFromPath(path),
                      path,
                      projectId,
                    })
                  }
                >
                  {label}
                </button>
              );
            }

            if (attachmentHref) {
              return (
                <a
                  key={path}
                  href={attachmentHref}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(className, INTERACTIVE_ATTACHMENT_PILL_CLASS)}
                >
                  {label}
                </a>
              );
            }

            if (!onOpenLocalFileLink || !isAbsoluteLocalPath({ path })) {
              return (
                <span key={path} className={cn(className, "cursor-default")}>
                  {label}
                </span>
              );
            }

            return (
              <button
                key={path}
                type="button"
                className={cn(className, INTERACTIVE_ATTACHMENT_PILL_CLASS)}
                onClick={() => {
                  onOpenLocalFileLink({
                    lineRange: null,
                    openTargetId: null,
                    path,
                  });
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
      <ImageLightbox
        title="Attached image preview"
        imageSrc={currentImageItem?.src ?? null}
        imageAlt={currentImageItem?.alt ?? "Attached image"}
        hasMultipleImages={hasMultipleImages}
        onPrevious={() => {
          setExpandedImageIndex(
            expandedImageIndex === null || imageItems.length <= 1
              ? expandedImageIndex
              : getWrappedImageIndex({
                  currentIndex: expandedImageIndex,
                  direction: "previous",
                  itemCount: imageItems.length,
                }),
          );
        }}
        onNext={() => {
          setExpandedImageIndex(
            expandedImageIndex === null || imageItems.length <= 1
              ? expandedImageIndex
              : getWrappedImageIndex({
                  currentIndex: expandedImageIndex,
                  direction: "next",
                  itemCount: imageItems.length,
                }),
          );
        }}
        onClose={() => setExpandedImageIndex(null)}
      />
    </div>
  );
}
