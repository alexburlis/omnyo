import { AsyncLocalStorage } from "node:async_hooks";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
} from "@omnyo/plugin-sdk";
import {
  hostContract,
  hostSignals,
  type OwnerMetadata,
} from "./host-contract.js";
import { createWorktreeService } from "./host-service.js";
import { withHostSignal } from "./git.js";

type OwnerRequest = {
  metadata: OwnerMetadata;
  context: ExperimentalHostRpcContext<typeof hostSignals>;
  signal: AbortSignal;
  pending: Promise<void>[];
  group?: ReadGroup;
};

type ReadGroup = {
  controller: AbortController;
  requests: Set<OwnerRequest>;
};

const requests = new AsyncLocalStorage<OwnerRequest>();

let readGroup: ReadGroup | undefined;

const service = createWorktreeService(
  async () => {
    const request = requests.getStore();

    if (!request) throw new Error("Worktree operation has no owner metadata");

    return request.metadata;
  },
  (name, payload) => {
    let request = requests.getStore();

    if (!request) throw new Error("Worktree event has no owner request");

    if (request.signal.aborted)
      request = request.group?.requests.values().next().value ?? request;
    request.signal.throwIfAborted();
    const event = request.context.experimental_emitSignal(name, payload);
    void event.catch(() => undefined);
    request.pending.push(event);
  },
);

async function invoke<T>(
  metadata: OwnerMetadata,
  context: ExperimentalHostRpcContext<typeof hostSignals>,
  run: () => T | Promise<T>,
  sharedRead = true,
): Promise<T> {
  const signal = AbortSignal.any([context.signal, context.lifecycle.signal]);
  signal.throwIfAborted();

  const group = sharedRead
    ? (readGroup ??= { controller: new AbortController(), requests: new Set() })
    : undefined;

  const request: OwnerRequest = {
    metadata,
    context,
    signal,
    pending: [],
    group,
  };

  group?.requests.add(request);

  const leave = () => {
    group?.requests.delete(request);

    if (group?.requests.size === 0 && readGroup === group)
      readGroup = undefined;
  };

  const abort = () => {
    leave();

    if (group?.requests.size === 0) {
      group.controller.abort(signal.reason);
      service.invalidateReads();
    }
  };

  signal.addEventListener("abort", abort, { once: true });

  return requests.run(request, () =>
    withHostSignal(group?.controller.signal ?? signal, async () => {
      try {
        const result = await run();
        signal.throwIfAborted();

        return result;
      } finally {
        signal.removeEventListener("abort", abort);
        leave();
        await Promise.all(request.pending);
      }
    }),
  );
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    cleanSaved: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.cleanSaved(request), false),
    inventory: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.inventory(request)),
    catalog: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.catalog(request)),
    sidebar: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.sidebar(request)),
    inspect: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.inspect(request)),
    storage: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.storage(request)),
    cleanupSummary: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.cleanupSummary(request)),
    projects: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.projects(request)),
    scan: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.scan(request)),
    files: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.files(request)),
    diff: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.diff(request)),
    prepare: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.prepare(request)),
    prepareBranch: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.prepareBranch(request)),
    deleteBranch: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.deleteBranch(request), false),
    prepareAll: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.prepareAll(request)),
    cleanupAll: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.cleanupAll(request), false),
    purge: ({ request, metadata }, context) =>
      invoke(metadata, context, () => service.purge(request), false),
  },
  dispose: () => {
    readGroup?.controller.abort();
    readGroup = undefined;
    service.invalidateReads();
  },
});
