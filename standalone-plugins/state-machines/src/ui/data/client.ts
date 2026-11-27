import { useRpc } from "@omnyo/plugin-sdk/app";
import { useMemo } from "react";

import type { SmContract, SmInput, SmMethodName, SmOutput } from "./contract.js";

export class SmError extends Error {
  readonly code: string;
  readonly issues: readonly { path: string; message: string }[];

  constructor(
    code: string,
    message: string,
    issues: readonly { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = "SmError";
    this.code = code;
    this.issues = issues;
  }
}

export const TRANSPORT_ERROR = "TRANSPORT";

export interface SmClient {
  call<Name extends SmMethodName>(method: Name, input: SmInput<Name>): Promise<SmOutput<Name>>;
}

export function toSmError(error: Error | SmError): SmError {
  if (error instanceof SmError) return error;

  return new SmError(TRANSPORT_ERROR, error.message);
}

export function errorFromCatch(caught: Error | SmError | string | null | undefined): SmError {
  if (caught instanceof SmError) return caught;

  if (caught instanceof Error) return toSmError(caught);

  return new SmError(TRANSPORT_ERROR, "The State machines service isn't responding.");
}

export function useSmClient(): SmClient {
  const rpc = useRpc<SmContract>();

  return useMemo<SmClient>(
    () => ({
      async call(method, input) {
        let envelope;

        try {
          envelope = await rpc.call(method, input);
        } catch (caught) {
          throw errorFromCatch(caught instanceof Error ? caught : null);
        }

        if (envelope.ok) return envelope.value;

        throw new SmError(envelope.error.code, envelope.error.message, envelope.error.issues ?? []);
      },
    }),
    [rpc],
  );
}

export function newRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}
