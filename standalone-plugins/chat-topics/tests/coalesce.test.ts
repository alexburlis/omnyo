import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { coalesce } from "../lib/coalesce.ts";

describe("coalesced refresh", () => {
  it("runs once within the delay of the first request while requests keep arriving", () => {
    mock.timers.enable({ apis: ["setTimeout"] });

    try {
      let runs = 0;

      const refresh = coalesce(() => {
        runs += 1;
      }, 3000);

      for (let second = 0; second < 6; second += 1) {
        refresh.schedule();
        mock.timers.tick(1000);
      }

      assert.equal(runs, 2);
    } finally {
      mock.timers.reset();
    }
  });

  it("lets an immediate request replace a pending delayed one", () => {
    mock.timers.enable({ apis: ["setTimeout"] });

    try {
      let runs = 0;

      const refresh = coalesce(() => {
        runs += 1;
      }, 3000);

      refresh.schedule();
      refresh.schedule(0);
      mock.timers.tick(0);
      assert.equal(runs, 1);
      mock.timers.tick(3000);
      assert.equal(runs, 1);
      refresh.schedule();
      refresh.cancel();
      mock.timers.tick(3000);
      assert.equal(runs, 1);
    } finally {
      mock.timers.reset();
    }
  });
});
