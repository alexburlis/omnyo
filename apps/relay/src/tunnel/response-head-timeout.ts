export const RESP_HEAD_TIMEOUT_MS = 30_000;

export const VOICE_TRANSCRIPTION_RESP_HEAD_TIMEOUT_MS = 90_000;

const VOICE_TRANSCRIPTION_PATH = "/api/v1/system/voice-transcription";

export function responseHeadTimeoutMs(
  method: string,
  path: string,
  target: string | null,
): number {
  const queryAt = path.indexOf("?");
  const pathname = queryAt === -1 ? path : path.slice(0, queryAt);

  return method === "POST" &&
    pathname === VOICE_TRANSCRIPTION_PATH &&
    (target === null || target === "")
    ? VOICE_TRANSCRIPTION_RESP_HEAD_TIMEOUT_MS
    : RESP_HEAD_TIMEOUT_MS;
}
