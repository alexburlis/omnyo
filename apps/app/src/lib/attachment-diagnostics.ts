import {
  attachmentDiagnosticSchema,
  type AttachmentDiagnostic,
} from "@omnyo/server-contract";
import { apiClient, toRelativeUrl } from "./api-server";
import { appSurfaceRequestInit } from "./app-surface";
import { getOmnyoDesktopInfo } from "./omnyo-desktop";
import { OmnyoHttpError } from "./sdk";
import { voiceClientIdentity } from "./voice-diagnostics";

export const EMPTY_ATTACHMENT_MESSAGE =
  "The pasted file was empty. Copy it again and paste.";

interface PasteObservation {
  at: number;
  size: number;
  clipboardTypes: string[];
  fileCount: number;
  nativeResolver: boolean;
  replayed: boolean;
  nativePath: boolean | null;
}

const observations = new WeakMap<File, PasteObservation>();

export function observePastedFiles(
  files: readonly File[],
  context: {
    clipboardTypes: readonly string[];
    nativeResolver: boolean;
    replayed: boolean;
  },
): void {
  const at = Date.now();

  for (const file of files)
    observations.set(file, {
      at: observations.get(file)?.at ?? at,
      size: observations.get(file)?.size ?? file.size,
      clipboardTypes: context.clipboardTypes
        .filter((type) => /^[A-Za-z0-9.+/_-]{1,64}$/u.test(type))
        .slice(0, 16),
      fileCount: files.length,
      nativeResolver: context.nativeResolver,
      replayed: context.replayed,
      nativePath: null,
    });
}

export function carryAttachmentObservation(from: File, to: File): void {
  const observation = observations.get(from);

  if (observation) observations.set(to, observation);
}

export function noteAttachmentNativePath(file: File, hasPath: boolean): void {
  const observation = observations.get(file);

  if (observation) observation.nativePath = hasPath;
}

export function isEmptyAttachmentRejection(error: unknown): boolean {
  return error instanceof OmnyoHttpError && error.code === "attachment_empty";
}

function userAgentFamily(): AttachmentDiagnostic["userAgentFamily"] {
  if (getOmnyoDesktopInfo() !== null) return "desktop";
  const agent = navigator.userAgent;

  if (/iPhone|iPad|iPod/u.test(agent)) return "ios";

  if (/Android/u.test(agent)) return "android";

  if (/Firefox\//u.test(agent)) return "firefox";

  if (/Chrome\//u.test(agent)) return "chrome";

  if (/Safari\//u.test(agent)) return "safari";

  return "other";
}

function readErrorKind(error: unknown): AttachmentDiagnostic["readError"] {
  if (!(error instanceof DOMException)) return "other";

  switch (error.name) {
    case "NotReadableError":
      return "not_readable";
    case "NotFoundError":
      return "not_found";
    case "AbortError":
      return "aborted";
    default:
      return "other";
  }
}

function elapsedSince(time: number): number | null {
  const elapsed = Date.now() - time;

  return elapsed >= 0 && elapsed <= 86_400_000 ? Math.floor(elapsed) : null;
}

async function readBytes(
  file: File,
): Promise<Pick<AttachmentDiagnostic, "readableBytes" | "readError">> {
  try {
    return {
      readableBytes: (await file.arrayBuffer()).byteLength,
      readError: null,
    };
  } catch (error) {
    return { readableBytes: null, readError: readErrorKind(error) };
  }
}

export async function reportEmptyAttachment(
  file: File,
  cause: AttachmentDiagnostic["cause"],
): Promise<void> {
  const observation = observations.get(file);
  const mimeType = file.type.toLowerCase();
  const extension = /\.([a-z0-9]{1,16})$/iu.exec(file.name)?.[1];

  const parsed = attachmentDiagnosticSchema.safeParse({
    occurredAt: Date.now(),
    clientBundle: voiceClientIdentity().clientBundle,
    userAgentFamily: userAgentFamily(),
    cause,
    source: observation ? "paste" : "other",
    mimeType: /^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64}$/u.test(mimeType)
      ? mimeType
      : null,
    extension: extension?.toLowerCase() ?? null,
    sizeAtUpload: file.size,
    sizeAtPaste: observation?.size ?? null,
    ...(cause === "empty_on_server"
      ? await readBytes(file)
      : { readableBytes: null, readError: null }),
    msSincePaste: observation ? elapsedSince(observation.at) : null,
    msSinceLastModified: elapsedSince(file.lastModified),
    clipboardTypes: observation?.clipboardTypes ?? null,
    pastedFileCount: observation?.fileCount ?? null,
    nativeResolver: observation?.nativeResolver ?? null,
    nativePath: observation?.nativePath ?? null,
    replayed: observation?.replayed ?? null,
  } satisfies AttachmentDiagnostic);

  if (!parsed.success) {
    console.warn("Attachment diagnostic was invalid", parsed.error.issues);

    return;
  }

  try {
    const response = await fetch(
      toRelativeUrl(apiClient.system["attachment-diagnostic"].$url()),
      appSurfaceRequestInit({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
        keepalive: true,
        signal: AbortSignal.timeout(5000),
      }),
    );

    if (!response.ok)
      console.warn("Attachment diagnostic was not recorded", response.status);
  } catch (error) {
    console.warn("Attachment diagnostic was not recorded", error);
  }
}
