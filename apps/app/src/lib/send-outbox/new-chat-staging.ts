const stagedCallbacks = new WeakMap<object, () => void>();

export function registerNewChatStagedCallback(
  request: object,
  onDurablyStaged: () => void,
): void {
  stagedCallbacks.set(request, onDurablyStaged);
}

export function takeNewChatStagedCallback(
  request: object,
): (() => void) | undefined {
  const callback = stagedCallbacks.get(request);

  stagedCallbacks.delete(request);

  return callback;
}
