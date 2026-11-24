import type { AttentionCommand } from "@omnyo/server-contract";
import type {
  ThreadAttentionResult,
  ThreadAttentionSnapshot,
} from "@omnyo/domain";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface ExperimentalThreadAttentionArea {
  history(args: {
    threadId: string;
    signal?: AbortSignal;
  }): Promise<ThreadAttentionSnapshot>;
  snapshot(args?: { signal?: AbortSignal }): Promise<ThreadAttentionSnapshot>;
  command(args: {
    threadId: string;
    command: AttentionCommand;
    signal?: AbortSignal;
  }): Promise<ThreadAttentionResult>;
  adopt(args: {
    pluginId: "decisions" | "needs-you";
    signal?: AbortSignal;
  }): Promise<{ imported: boolean }>;
}

export function createThreadAttentionArea({
  transport,
}: CreateSdkAreaArgs): ExperimentalThreadAttentionArea {
  return {
    history: (args) =>
      transport.readJson(
        transport.api.v1.threads[":id"].attention.$get(
          { param: { id: args.threadId } },
          ...signalRequestArgs(args.signal),
        ),
      ),
    snapshot: (args = {}) =>
      transport.readJson(
        transport.api.v1["thread-attention"].$get(
          {},
          ...signalRequestArgs(args.signal),
        ),
      ),
    command: (args) =>
      transport.readJson(
        transport.api.v1.threads[":id"].attention.$post(
          { param: { id: args.threadId }, json: args.command },
          ...signalRequestArgs(args.signal),
        ),
      ),
    adopt: (args) =>
      transport.readJson(
        transport.api.v1["thread-attention"].adopt.$post(
          { json: { pluginId: args.pluginId } },
          ...signalRequestArgs(args.signal),
        ),
      ),
  };
}
