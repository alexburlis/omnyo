import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isSplitDiagnosticAssetPath,
  readSplitAssetAttemptId,
  SPLIT_ASSET_ATTEMPT_HEADER,
} from "./error-reporting-privacy.js";

const SPLIT_ASSET_ATTEMPTS_PER_WINDOW = 120;

const SPLIT_ASSET_ATTEMPT_WINDOW_MS = 60_000;

export function createSplitAssetAttemptAdmission(now: () => number) {
  let window = { start: 0, admitted: 0 };

  return () => {
    const start = Math.floor(now() / SPLIT_ASSET_ATTEMPT_WINDOW_MS);

    if (start !== window.start) window = { start, admitted: 0 };

    if (window.admitted >= SPLIT_ASSET_ATTEMPTS_PER_WINDOW) return false;

    window.admitted += 1;

    return true;
  };
}

export function prepareSplitAssetAttempt(
  request: Pick<IncomingMessage, "headers" | "method" | "url">,
  response: Pick<ServerResponse, "headersSent" | "writableFinished"> & {
    once(event: "close", listener: () => void): unknown;
  },
  log: (fields: {
    assetAttemptId: string;
    elapsedMs: number;
    headersSent: boolean;
    responseFinished: boolean;
  }) => void,
) {
  const assetAttemptId = readSplitAssetAttemptId(
    request.headers[SPLIT_ASSET_ATTEMPT_HEADER],
  );

  if (
    assetAttemptId === undefined ||
    request.method !== "GET" ||
    request.url === undefined ||
    !isSplitDiagnosticAssetPath(request.url)
  )
    return;
  const started = performance.now();

  return {
    id: assetAttemptId,
    observe() {
      response.once("close", () => {
        log({
          assetAttemptId,
          elapsedMs: Math.round(performance.now() - started),
          headersSent: response.headersSent,
          responseFinished: response.writableFinished,
        });
      });
    },
  };
}
