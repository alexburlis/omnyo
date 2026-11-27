import { useCallback, useRef, useState } from "react";

import { errorFromCatch, newRequestId, type SmError, useSmClient } from "../data/client.js";
import type { ControlOperation, InstanceView } from "../data/contract.js";
import { useQueryStore } from "../data/query.js";

export interface ControlState {
  pending: ControlOperation["kind"] | null;
  error: SmError | null;
  run(operation: ControlOperation): Promise<boolean>;
  clearError(): void;
}

function operationKey(operation: ControlOperation): string {
  return JSON.stringify(operation);
}

export function useControl(instance: InstanceView): ControlState {
  const client = useSmClient();
  const store = useQueryStore();
  const [pending, setPending] = useState<ControlOperation["kind"] | null>(null);
  const [error, setError] = useState<SmError | null>(null);
  const requestIds = useRef(new Map<string, string>());

  const run = useCallback(
    async (operation: ControlOperation) => {
      const key = operationKey(operation);
      const requestId = requestIds.current.get(key) ?? newRequestId();

      requestIds.current.set(key, requestId);
      setPending(operation.kind);
      setError(null);

      try {
        const view = await client.call("sm_instance_control", {
          instanceId: instance.instanceId,
          expectedControlRevision: instance.controlRevision,
          operation,
          requestId,
        });

        requestIds.current.delete(key);
        store.set(`instance:${instance.instanceId}`, view);
        store.refetchMatching("attention:");
        store.refetchMatching("machines:");

        return true;
      } catch (caught) {
        const failure = errorFromCatch(caught instanceof Error ? caught : null);

        if (failure.code === "REVISION_CONFLICT" || failure.code === "STALE_ENTRY") {
          requestIds.current.delete(key);
          void store.fetch(`instance:${instance.instanceId}`);
        }

        setError(failure);

        return false;
      } finally {
        setPending(null);
      }
    },
    [client, instance.controlRevision, instance.instanceId, store],
  );

  return { pending, error, run, clearError: () => setError(null) };
}
