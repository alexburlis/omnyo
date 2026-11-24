import { extractErrorMessage } from "@omnyo/core-ui";
import { OmnyoHttpError } from "@omnyo/sdk/browser";
import { HttpError } from "./api";

const HTTP_STATUS_PREFIX_PATTERN = /^HTTP \d{3}:\s*/u;

export function asHttpError(error: unknown): HttpError | OmnyoHttpError | null {
  return error instanceof HttpError || error instanceof OmnyoHttpError
    ? error
    : null;
}

export function getHttpErrorMessage(
  error: HttpError | OmnyoHttpError,
): string | null {
  const bodyMessage = extractErrorMessage(error.body);

  if (bodyMessage) {
    return bodyMessage;
  }

  const normalizedMessage = extractErrorMessage(error.message);

  if (normalizedMessage === null) {
    return null;
  }

  const strippedMessage = normalizedMessage.replace(
    HTTP_STATUS_PREFIX_PATTERN,
    "",
  );

  return strippedMessage.length > 0 ? strippedMessage : null;
}

export function isQueuedMessageNotFoundError(error: unknown): boolean {
  return (
    error instanceof OmnyoHttpError &&
    error.status === 404 &&
    error.code === "invalid_request" &&
    extractErrorMessage(error.body) === "Queued message not found"
  );
}
