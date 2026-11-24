import type {
  EnvironmentActionRequest,
  EditMessageRequest,
  SendMessageRequest,
} from "@omnyo/server-contract";
import type { ComposerSendSlot } from "@/lib/composer-send-queue";
import type { ExpectedPluginWait } from "@/lib/expected-plugin-wait";
import type { PromptInput } from "@omnyo/domain";

export type RequestEnvironmentActionMutationRequest = {
  id: string;
} & EnvironmentActionRequest;

export interface SendThreadMessageMutationRequest extends SendMessageRequest {
  id: string;
  sendReservation?: ComposerSendSlot;
  prepareInput?: () => Promise<PromptInput[]>;
  expectedPluginWait?: ExpectedPluginWait;
}

export interface EditMessageMutationRequest extends EditMessageRequest {
  id: string;
}
