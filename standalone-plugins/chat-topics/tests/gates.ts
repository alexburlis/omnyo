import assert from "node:assert/strict";

export function gate() {
  let release = () => {};

  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

export async function paused(entered: Promise<void>, operation: Promise<unknown>) {
  await Promise.race([
    entered,
    operation.then(() => assert.fail("The operation finished before reaching its paused step")),
  ]);
}
