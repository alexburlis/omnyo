import { z } from "zod";
import { OmnyoHttpError, sdk } from "../sdk";
import type {
  OutboxDeliveryFailure,
  SendOutboxTransport,
} from "./send-outbox-drain";

const errorBodySchema = z.object({
  message: z.string().optional(),
  retryable: z.boolean().optional(),
});

function isMissingRoute(error: OmnyoHttpError): boolean {
  return (
    error.status === 404 && (error.code === null || error.code === "not_found")
  );
}

export function classifyOutboxFailure(error: unknown): OutboxDeliveryFailure {
  if (!(error instanceof OmnyoHttpError)) {
    return { kind: "retry" };
  }

  const body = errorBodySchema.safeParse(error.body);

  if (
    error.status >= 500 ||
    error.status === 401 ||
    error.status === 408 ||
    error.status === 429 ||
    isMissingRoute(error) ||
    (body.success && body.data.retryable === true)
  ) {
    return { kind: "retry" };
  }

  return {
    kind: "terminal",
    code: error.code ?? `http_${error.status}`,
    message:
      (body.success ? body.data.message : undefined) ??
      "The server did not accept this message.",
  };
}

export const sdkSendOutboxTransport: SendOutboxTransport = {
  async readStoreId() {
    try {
      return (await sdk.threads.submissions.contract()).storeId;
    } catch (error) {
      if (error instanceof OmnyoHttpError && isMissingRoute(error)) {
        return null;
      }

      throw error;
    }
  },
  submit(request) {
    return sdk.threads.submissions.submit(request);
  },
  async upload(args) {
    const uploaded = await sdk.projects.attachments.upload({
      clientFile: args.blob,
      filename: args.name,
      ...(args.mimeType === undefined ? {} : { mimeType: args.mimeType }),
      projectId: args.projectId,
    });

    return uploaded.path;
  },
};
