import type {
  PreviewBinding,
  PreviewListResponse,
  PreviewRegisterRequest,
  PreviewRestartRequest,
  PreviewStatus,
} from "@omnyo/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export type PreviewRegisterArgs = PreviewRegisterRequest;

export interface PreviewListArgs {
  threadId: string;
  signal?: AbortSignal;
}

export interface PreviewGetArgs {
  previewId: string;
  signal?: AbortSignal;
}

export type PreviewRestartArgs = PreviewRestartRequest & {
  previewId: string;
};

export type PreviewRegisterResult = PreviewBinding;

export type PreviewListResult = PreviewListResponse;

export type PreviewGetResult = PreviewBinding;

export type PreviewStatusResult = PreviewStatus;

export type PreviewRestartResult = PreviewStatus;

export interface PreviewRemoveResult {
  ok: true;
}

export interface PreviewsArea {
  register(args: PreviewRegisterArgs): Promise<PreviewRegisterResult>;
  list(args: PreviewListArgs): Promise<PreviewListResult>;
  get(args: PreviewGetArgs): Promise<PreviewGetResult>;
  status(args: PreviewGetArgs): Promise<PreviewStatusResult>;
  restart(args: PreviewRestartArgs): Promise<PreviewRestartResult>;
  experimental_remove(args: PreviewGetArgs): Promise<PreviewRemoveResult>;
}

export function createPreviewsArea({
  transport,
}: CreateSdkAreaArgs): PreviewsArea {
  return {
    async register(input) {
      return transport.readJson(
        transport.api.v1.previews.$post({ json: input }),
      );
    },
    async list(input) {
      return transport.readJson(
        transport.api.v1.previews.$get(
          { query: { threadId: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async get(input) {
      return transport.readJson(
        transport.api.v1.previews[":previewId"].$get(
          { param: { previewId: encodeURIComponent(input.previewId) } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async status(input) {
      return transport.readJson(
        transport.api.v1.previews[":previewId"].status.$get(
          { param: { previewId: encodeURIComponent(input.previewId) } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async restart(input) {
      return transport.readJson(
        transport.api.v1.previews[":previewId"].restart.$post({
          param: { previewId: encodeURIComponent(input.previewId) },
          json: { requestId: input.requestId },
        }),
      );
    },
    async experimental_remove(input) {
      return transport.readJson(
        transport.api.v1.previews[":previewId"].$delete(
          { param: { previewId: encodeURIComponent(input.previewId) } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
  };
}
