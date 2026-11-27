import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PermissionMode,
  ReasoningLevel,
  ServiceTier,
} from "@omnyo/domain";
import type { ExperimentalComposerSelection } from "@omnyo/plugin-sdk";
import type { ModelPickerSelection } from "@/components/pickers/model-picker-selection";

const COMPOSER_SELECTION_SETTLE_TIMEOUT_MS = 15_000;

let settleTimeoutOverrideMs: number | null = null;

export function setComposerSelectionSettleTimeoutForTest(
  timeoutMs: number | null,
): void {
  settleTimeoutOverrideMs = timeoutMs;
}

export function useQueuedComposerSelection(
  apply: (
    selection: ExperimentalComposerSelection,
    deadline: number,
  ) => Promise<ExperimentalComposerSelection>,
): (
  selection: ExperimentalComposerSelection,
) => Promise<ExperimentalComposerSelection> {
  const pending = useRef<Promise<unknown>>(Promise.resolve());

  return useCallback(
    (selection) => {
      const run = () =>
        apply(
          selection,
          Date.now() +
            (settleTimeoutOverrideMs ?? COMPOSER_SELECTION_SETTLE_TIMEOUT_MS),
        );

      const result = pending.current.then(run, run);
      pending.current = result;

      return result;
    },
    [apply],
  );
}

export interface CommittedComposerState {
  version: number;
  isSettled: boolean;
}

interface Waiter<T> {
  predicate: (state: T) => boolean;
  resolve: (state: T) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CommittedStateObserver<T> {
  publish(state: T): void;
  current(): T | null;
  waitUntil(predicate: (state: T) => boolean, deadline: number): Promise<T>;
}

export function createCommittedStateObserver<T>(): CommittedStateObserver<T> {
  let current: T | null = null;
  const waiters = new Set<Waiter<T>>();

  const settle = (waiter: Waiter<T>, state: T) => {
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    waiter.resolve(state);
  };

  return {
    publish(state) {
      current = state;

      for (const waiter of [...waiters]) {
        if (waiter.predicate(state)) settle(waiter, state);
      }
    },
    current: () => current,
    waitUntil(predicate, deadline) {
      return new Promise<T>((resolve, reject) => {
        if (current !== null && predicate(current)) {
          resolve(current);

          return;
        }

        const waiter: Waiter<T> = {
          predicate,
          resolve,
          timer: setTimeout(
            () => {
              waiters.delete(waiter);

              if (current === null) {
                reject(new Error("This composer is not ready yet."));

                return;
              }

              resolve(current);
            },
            Math.max(0, deadline - Date.now()),
          ),
        };

        waiters.add(waiter);
      });
    },
  };
}

export interface CommittedComposerStateController<
  T extends CommittedComposerState,
> {
  observer: CommittedStateObserver<T>;
  version: number;
  commit(): number;
}

export function useCommittedComposerState<T extends CommittedComposerState>(
  buildState: (version: number) => T,
): CommittedComposerStateController<T> {
  const [version, setVersion] = useState(0);
  const versionRef = useRef(0);
  const [observer] = useState(() => createCommittedStateObserver<T>());

  const [controller] = useState<CommittedComposerStateController<T>>(() => ({
    observer,
    version: 0,
    commit: () => {
      versionRef.current += 1;
      setVersion(versionRef.current);

      return versionRef.current;
    },
  }));

  controller.version = version;
  const state = buildState(version);
  useEffect(() => {
    observer.publish(state);
  });

  return controller;
}

export function waitForSettledComposerState<T extends CommittedComposerState>(
  controller: CommittedComposerStateController<T>,
  deadline: number,
  requireSettled: boolean,
): Promise<T> {
  const version = controller.commit();

  return controller.observer.waitUntil(
    (state) => state.version >= version && (!requireSettled || state.isSettled),
    deadline,
  );
}

export function waitUntilComposerStateSettled<T extends CommittedComposerState>(
  controller: CommittedComposerStateController<T>,
  deadline: number,
): Promise<T> {
  return controller.observer.waitUntil((state) => state.isSettled, deadline);
}

export interface ExecutionSelectionState {
  selectedProviderId: string;
  selectedThreadModel: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier | undefined;
  supportsServiceTier: boolean;
  permissionMode: PermissionMode;
}

export interface CommittedExecutionSelectionState
  extends CommittedComposerState, ExecutionSelectionState {
  providerIds: readonly string[];
  changeProvider(providerId: string): void;
  changeModel(model: string): void;
  changeReasoning(level: ReasoningLevel): void;
  changeServiceTier(tier: ServiceTier | undefined): void;
  changeExecution(selection: ModelPickerSelection): void;
  changePermissionMode(mode: PermissionMode): void;
}

export async function applyComposerExecutionSelection<
  State extends CommittedExecutionSelectionState,
>(
  controller: CommittedComposerStateController<State>,
  state: State,
  deadline: number,
  selection: ExperimentalComposerSelection,
  policy: {
    locks?: { provider?: boolean; execution?: boolean };
    changeModel?(state: State, model: string): void;
  } = {},
): Promise<State> {
  const locks = policy.locks;

  const settle = async (requireSettled: boolean) => {
    state = await waitForSettledComposerState(
      controller,
      deadline,
      requireSettled,
    );
  };

  const ensureSettled = async () => {
    if (state.isSettled) return;
    state = await waitUntilComposerStateSettled(controller, deadline);
  };

  if (selection.providerId !== undefined) await ensureSettled();

  const tuple = readExecutionTuple(selection, state.providerIds);

  if (
    tuple !== null &&
    !locks?.execution &&
    (!locks?.provider || tuple.providerId === state.selectedProviderId)
  ) {
    state.changeExecution(tuple);
    await settle(true);
  } else {
    if (
      selection.providerId !== undefined &&
      !locks?.provider &&
      selection.providerId !== state.selectedProviderId &&
      state.providerIds.includes(selection.providerId)
    ) {
      state.changeProvider(selection.providerId);
      await settle(true);
    }

    const providerMatches =
      selection.providerId === undefined ||
      selection.providerId === state.selectedProviderId;

    if (providerMatches && !locks?.execution && selection.model !== undefined) {
      await ensureSettled();

      if (policy.changeModel === undefined) {
        state.changeModel(selection.model);
      } else {
        policy.changeModel(state, selection.model);
      }

      await settle(false);
    }

    if (
      providerMatches &&
      !locks?.execution &&
      selection.reasoningLevel !== undefined
    ) {
      await ensureSettled();
      state.changeReasoning(selection.reasoningLevel);
      await settle(false);
    }

    if (
      !locks?.execution &&
      selection.serviceTier !== undefined &&
      state.supportsServiceTier
    ) {
      state.changeServiceTier(selection.serviceTier);
      await settle(false);
    }
  }

  if (!locks?.execution && selection.permissionMode !== undefined) {
    state.changePermissionMode(selection.permissionMode);
    await settle(false);
  }

  await settle(true);

  return state;
}

export function readExecutionSelection(
  state: ExecutionSelectionState,
): ExperimentalComposerSelection {
  return {
    ...(state.selectedProviderId
      ? { providerId: state.selectedProviderId }
      : {}),
    ...(state.selectedThreadModel ? { model: state.selectedThreadModel } : {}),
    reasoningLevel: state.reasoningLevel,
    ...(state.supportsServiceTier && state.serviceTier !== undefined
      ? { serviceTier: state.serviceTier }
      : {}),
    permissionMode: state.permissionMode,
  };
}

export function readExecutionTuple(
  selection: ExperimentalComposerSelection,
  providerIds: readonly string[],
): ModelPickerSelection | null {
  const { providerId, model, reasoningLevel, serviceTier } = selection;

  if (
    providerId === undefined ||
    model === undefined ||
    reasoningLevel === undefined ||
    !providerIds.includes(providerId)
  ) {
    return null;
  }

  return {
    providerId,
    model,
    reasoningLevel,
    ...(serviceTier === undefined ? {} : { serviceTier }),
  };
}
