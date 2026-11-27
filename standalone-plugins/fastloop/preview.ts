import { z } from "zod";
import type { EvidenceView } from "./details.js";

export const previewChunkSchema = z.object({
  evidenceId: z.string(),
  evidence: z.object({
    id: z.string(),
    runId: z.string(),
    sha256: z.string(),
    redacted: z.literal(true),
  }),
  offset: z.number().int().nonnegative(),
  totalBytes: z.number().int().min(1).max(10485760),
  bytesBase64: z.string().max(349528),
  mimeType: z.string(),
  complete: z.boolean(),
});

export interface Preview {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: "image/png" | "image/jpeg" | "text/plain";
}

export async function loadPreview(
  evidence: EvidenceView,
  read: (offset: number) => Promise<z.infer<typeof previewChunkSchema>>,
  signal: AbortSignal,
): Promise<Preview> {
  if (!evidence.redacted) throw new Error("PREVIEW_WITHHELD");
  let offset = 0;
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  let mimeType: string | undefined;

  while (!signal.aborted) {
    const chunk = await read(offset);

    if (signal.aborted) throw new Error("PREVIEW_CLOSED");

    if (
      chunk.evidenceId !== evidence.id ||
      chunk.evidence.id !== evidence.id ||
      chunk.evidence.runId !== evidence.runId ||
      chunk.evidence.sha256 !== evidence.sha256 ||
      chunk.offset !== offset
    )
      throw new Error("PREVIEW_IDENTITY_CHANGED");

    if (!bytes) {
      bytes = new Uint8Array(chunk.totalBytes);
      mimeType = chunk.mimeType;
    }

    if (bytes.byteLength !== chunk.totalBytes || mimeType !== chunk.mimeType)
      throw new Error("PREVIEW_IDENTITY_CHANGED");

    const decoded = Uint8Array.from(atob(chunk.bytesBase64), (character) =>
      character.charCodeAt(0),
    );

    if (
      !decoded.byteLength ||
      decoded.byteLength > 262144 ||
      offset + decoded.byteLength > bytes.byteLength
    )
      throw new Error("PREVIEW_CHUNK_INVALID");
    bytes.set(decoded, offset);
    offset += decoded.byteLength;

    if (chunk.complete !== (offset === bytes.byteLength)) throw new Error("PREVIEW_CHUNK_INVALID");

    if (!chunk.complete) continue;

    const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    if (actual !== evidence.sha256) throw new Error("PREVIEW_HASH_MISMATCH");

    const imageBytes = bytes;

    if (
      mimeType === "image/png" &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => imageBytes[index] === byte)
    )
      return { bytes, mimeType };

    if (mimeType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
      return { bytes, mimeType };

    if (evidence.kind === "screenshot") throw new Error("PREVIEW_IMAGE_INVALID");

    if (
      !new Set([
        "application/json",
        "application/x-ndjson",
        "text/markdown",
        "text/typescript",
        "text/javascript",
        "text/plain",
      ]).has(mimeType ?? "")
    )
      throw new Error("PREVIEW_TYPE_UNSUPPORTED");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);

    return { bytes, mimeType: "text/plain" };
  }

  throw new Error("PREVIEW_CLOSED");
}
