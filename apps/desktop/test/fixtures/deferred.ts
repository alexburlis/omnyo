interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

export function deferred(): Deferred {
  let resolve: (() => void) | null = null;
  let reject: ((error: Error) => void) | null = null;

  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => resolvePromise();
    reject = rejectPromise;
  });

  if (resolve === null || reject === null)
    throw new Error("Promise executor did not run");

  return { promise, resolve, reject };
}
