interface ComposerSendQueue {
  pending: Map<string, Promise<void>>;
  aliases: Map<string, string>;
}

const queues = new WeakMap<object, ComposerSendQueue>();

function queueFor(owner: object): ComposerSendQueue {
  let queue = queues.get(owner);

  if (queue === undefined) {
    queue = { pending: new Map(), aliases: new Map() };
    queues.set(owner, queue);
  }

  return queue;
}

function resolveThreadId(queue: ComposerSendQueue, threadId: string): string {
  let resolved = threadId;
  let next = queue.aliases.get(resolved);

  while (next !== undefined) {
    resolved = next;
    next = queue.aliases.get(resolved);
  }

  return resolved;
}

export function aliasComposerSendThread(
  owner: object,
  pendingThreadId: string,
  realThreadId: string,
): void {
  const queue = queueFor(owner);
  const from = resolveThreadId(queue, pendingThreadId);
  const to = resolveThreadId(queue, realThreadId);

  if (from === to) return;
  queue.aliases.set(from, to);
  const prior = queue.pending.get(from);
  const destination = queue.pending.get(to);
  queue.pending.delete(from);

  if (prior === undefined) return;

  const settled =
    destination === undefined
      ? prior
      : Promise.all([prior, destination]).then(() => {});

  queue.pending.set(to, settled);
  void settled.then(() => {
    if (queue.pending.get(to) === settled) queue.pending.delete(to);
  });
}

export interface ComposerSendSlot {
  run<T>(send: () => Promise<T>): Promise<T>;
  cancel(): void;
}

export function reserveComposerSend(
  owner: object,
  threadId: string,
): ComposerSendSlot {
  const queue = queueFor(owner);
  const pending = queue.pending;
  const destinationId = resolveThreadId(queue, threadId);
  const ready = pending.get(destinationId) ?? Promise.resolve();
  let complete: () => void = () => {};

  const completion = new Promise<void>((resolve) => {
    complete = resolve;
  });

  const settled = ready.then(() => completion);
  pending.set(destinationId, settled);
  void settled.then(() => {
    if (pending.get(destinationId) === settled) pending.delete(destinationId);
  });

  return {
    async run(send) {
      await ready;

      try {
        return await send();
      } finally {
        complete();
      }
    },
    cancel: () => complete(),
  };
}
