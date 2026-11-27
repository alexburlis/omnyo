import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runningSubagents } from "../lib/subagents.ts";

const IDLE = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 };

describe("running subagent count", () => {
  it("reads the count a newer host sends", () => {
    for (const count of [0, 1, 3, 12]) {
      const activity = { ...IDLE, experimental_subagents: count };

      assert.equal(runningSubagents({ activity }), count);
    }
  });

  it("counts none on an older host that omits the field", () => {
    assert.equal(runningSubagents({ activity: IDLE }), 0);
  });

  it("counts none for a value that is not a count", () => {
    for (const value of ["3", null, -1, 1.5, Number.NaN]) {
      const activity = { ...IDLE, experimental_subagents: value };

      // @ts-expect-error Exercise malformed host payloads.
      assert.equal(runningSubagents({ activity }), 0, String(value));
    }
  });
});
