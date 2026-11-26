import type { SendMessageResponse } from "@omnyo/server-contract";
import type { SendThreadMessageMutationRequest } from "@/hooks/mutations/mutation-request-types";
import type { ComposerSendSlot } from "@/lib/composer-send-queue";

export interface SendMessageMutationLike {
  isPending: boolean;
  reserve: (threadId: string) => ComposerSendSlot;
  mutateAsync: (
    request: SendThreadMessageMutationRequest,
  ) => Promise<SendMessageResponse>;
}
