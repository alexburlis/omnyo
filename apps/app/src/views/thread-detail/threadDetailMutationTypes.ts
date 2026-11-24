import type {
  EnvironmentActionResponse,
  SendMessageResponse,
} from "@omnyo/server-contract";
import type {
  RequestEnvironmentActionMutationRequest,
  SendThreadMessageMutationRequest,
} from "@/hooks/mutations/mutation-request-types";
import type { ComposerSendSlot } from "@/lib/composer-send-queue";

export interface RequestEnvironmentActionMutationLike {
  isPending: boolean;
  mutateAsync: (
    request: RequestEnvironmentActionMutationRequest,
  ) => Promise<EnvironmentActionResponse>;
}

export interface SendMessageMutationLike {
  isPending: boolean;
  reserve: (threadId: string) => ComposerSendSlot;
  mutateAsync: (
    request: SendThreadMessageMutationRequest,
  ) => Promise<SendMessageResponse>;
}
