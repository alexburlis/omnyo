import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchOnYou, onYouCandidates, significantWords } from "../lib/on-you.ts";
import { snapshot, waiting } from "./inbox-fixtures.ts";

const overlap = {
  threadId: "thread-list",
  title: "Thread list layout",
  event: "overlap recurs",
  waitId: "wait-overlap",
};

describe("On you composer chip", () => {
  it("matches a new draft on a significant shared word, never on common words", () => {
    assert.deepEqual(matchOnYou("The sidebar overlap is back", [overlap], new Set()), overlap);
    assert.deepEqual(matchOnYou("Fix the thread layout padding", [overlap], new Set()), overlap);
    assert.equal(matchOnYou("Please make this work with that", [overlap], new Set()), null);
    assert.equal(matchOnYou("", [overlap], new Set()), null);
    assert.deepEqual([...significantWords("Is it the CI run? Run again")], []);
  });

  it("stays dismissed for that wait", () => {
    assert.equal(matchOnYou("overlap again", [overlap], new Set(["wait-overlap"])), null);
  });

  it("offers only report-it waits from the Inbox snapshot", () => {
    const shown = snapshot({
      waiting: [
        {
          ...waiting("thread-list", {
            group: "on-you",
            reason: "overlap recurs",
            waitId: "wait-overlap",
          }),
          title: "Thread list layout",
        },
        waiting("deploy", {
          group: "comes-back",
          reason: "deploy finishes",
          waitId: "wait-deploy",
        }),
      ],
    });

    assert.deepEqual(onYouCandidates(shown), [overlap]);
  });
});
