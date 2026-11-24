import {
  buildProjectAttachmentContentUrl,
  buildThreadHostFileContentUrl,
  isAbsoluteLocalPath,
  isProjectAttachmentPath,
} from "./file-content-urls";

export type UserAttachmentThumbnailWidth = "160" | "320" | "640";

export interface UserAttachmentImageSrcOptions {
  thumbnailWidth?: UserAttachmentThumbnailWidth;
}

export interface UserAttachmentThumbnailSources {
  src: string;
  srcSet: string;
}

export function toUserAttachmentImageSrc(
  pathOrUrl: string,
  projectId?: string,
  threadId?: string,
  { thumbnailWidth }: UserAttachmentImageSrcOptions = {},
): string {
  if (/^(https?:|data:|blob:)/i.test(pathOrUrl)) {
    return pathOrUrl;
  }

  if (threadId && isAbsoluteLocalPath({ path: pathOrUrl })) {
    return buildThreadHostFileContentUrl(threadId, pathOrUrl, thumbnailWidth);
  }

  if (projectId) {
    return buildProjectAttachmentContentUrl(
      projectId,
      pathOrUrl,
      isProjectAttachmentPath({ path: pathOrUrl }) ? thumbnailWidth : undefined,
    );
  }

  if (/^file:/i.test(pathOrUrl)) {
    return pathOrUrl;
  }

  const normalized = pathOrUrl.replaceAll("\\", "/");

  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }

  if (normalized.startsWith("/")) {
    return `file://${encodeURI(normalized)}`;
  }

  return pathOrUrl;
}

export function responsiveThumbnailSources(
  original: string,
  thumbnail: (width: UserAttachmentThumbnailWidth) => string,
): UserAttachmentThumbnailSources | null {
  const small = thumbnail("160");

  if (small === original) return null;

  return {
    src: small,
    srcSet: `${small} 1x, ${thumbnail("320")} 2x, ${thumbnail("640")} 4x`,
  };
}

export function userAttachmentThumbnailSources(
  path: string,
  projectId: string | undefined,
  threadId?: string,
): UserAttachmentThumbnailSources | null {
  return responsiveThumbnailSources(
    toUserAttachmentImageSrc(path, projectId, threadId),
    (thumbnailWidth) =>
      toUserAttachmentImageSrc(path, projectId, threadId, { thumbnailWidth }),
  );
}
