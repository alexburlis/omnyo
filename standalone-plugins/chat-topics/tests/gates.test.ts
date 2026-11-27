import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { gate, paused } from "./gates.ts";

const prompt = { timeout: 1000 };

describe("paused", () => {
  let hostHandle: ReturnType<typeof setInterval> | undefined;

  beforeEach(() => {
    hostHandle = setInterval(() => {}, 60_000);
  });

  afterEach(() => {
    clearInterval(hostHandle);
  });

  it("fails when the operation finishes without reaching its gate", prompt, async () => {
    const entered = gate();

    await assert.rejects(paused(entered.promise, Promise.resolve("done")), {
      message: "The operation finished before reaching its paused step",
    });
  });

  it("passes on the operation's own failure when it fails before its gate", prompt, async () => {
    const entered = gate();

    await assert.rejects(paused(entered.promise, Promise.reject(new Error("Storage locked"))), {
      message: "Storage locked",
    });
  });

  it("returns once the operation reaches its gate and leaves it running", prompt, async () => {
    const entered = gate();
    const release = gate();
    let finished = false;

    const operation = (async () => {
      entered.release();
      await release.promise;
      finished = true;
    })();

    await paused(entered.promise, operation);
    assert.equal(finished, false);
    release.release();
    await operation;
    assert.equal(finished, true);
  });

  it("leaves a later failure for the caller to observe", prompt, async () => {
    const entered = gate();
    const release = gate();

    const operation = (async () => {
      entered.release();
      await release.promise;
      throw new Error("Aborted after pausing");
    })();

    await paused(entered.promise, operation);
    release.release();
    await assert.rejects(operation, { message: "Aborted after pausing" });
  });
});
