import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inboxLoad } from "../lib/inbox-store.ts";
import { snapshot, entry } from "./inbox-fixtures.ts";

describe("shared Inbox snapshot", () => {
  it("renders the shared snapshot itself, including core's predicted one", () => {
    const value = { ...snapshot({ inbox: [entry("a")] }), revision: "r1~p3" };

    assert.deepEqual(inboxLoad({ snapshot: value, status: "ready", stale: false }), {
      status: "ready",
      snapshot: value,
      failed: false,
    });
  });

  it("keeps the last snapshot visible with a stale flag", () => {
    const value = snapshot({ inbox: [entry("a")] });

    assert.deepEqual(inboxLoad({ snapshot: value, status: "ready", stale: true }), {
      status: "ready",
      snapshot: value,
      failed: true,
    });
  });

  it("reports loading and error before any snapshot arrives", () => {
    assert.deepEqual(inboxLoad({ snapshot: null, status: "loading", stale: false }), {
      status: "loading",
    });
    assert.deepEqual(inboxLoad({ snapshot: null, status: "error", stale: false }), {
      status: "error",
    });
  });
});
