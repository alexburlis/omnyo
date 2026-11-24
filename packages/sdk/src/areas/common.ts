import type {
  SystemExecutionOptionsQuery,
  SystemExecutionOptionsResponse,
} from "@omnyo/server-contract";
import type { OmnyoSdkTransport } from "../transport.js";

export interface CreateSdkAreaArgs {
  transport: OmnyoSdkTransport;
}

type SignalRequestOptions = { init: { signal: AbortSignal } };

export function signalRequestArgs(
  signal: AbortSignal | undefined,
): [] | [SignalRequestOptions] {
  return signal === undefined ? [] : [{ init: { signal } }];
}

export async function readExecutionOptions(
  transport: OmnyoSdkTransport,
  input: SystemExecutionOptionsQuery & { signal?: AbortSignal },
): Promise<SystemExecutionOptionsResponse> {
  const response = await transport.readJson(
    transport.api.v1.system["execution-options"].$get(
      {
        query: {
          environmentId: input.environmentId,
          hostId: input.hostId,
          providerId: input.providerId,
        },
      },
      ...signalRequestArgs(input.signal),
    ),
  );

  return { ...response, modelNotice: response.modelNotice ?? null };
}
