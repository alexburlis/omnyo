// @vitest-environment jsdom

import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboxSnapshot } from "@omnyo/domain";
import { experimental_useInboxSnapshot } from "../../app.js";
import { installTestPluginRuntime, renderSlot } from "../app.js";

installTestPluginRuntime();

afterEach(cleanup);

function Probe() {
  const { snapshot, status, stale, refresh } = experimental_useInboxSnapshot();

  return (
    <button onClick={refresh}>
      {status}:{String(stale)}:{snapshot?.revision ?? "absent"}
    </button>
  );
}

const snapshot: InboxSnapshot = {
  revision: "snapshot-one",
  generatedAt: 0,
  inbox: [],
  waiting: [],
  running: [],
  shelf: [],
  lastMove: null,
  counts: {
    inbox: 0,
    questions: 0,
    needsYou: 0,
    running: 0,
    waiting: 0,
    onYou: [],
    nextBackAt: null,
  },
};

describe("Inbox snapshot test host", () => {
  it("defaults to an unloaded snapshot", () => {
    const slot = renderSlot({ component: Probe }, {});
    expect(slot.getByRole("button").textContent).toBe("loading:false:absent");
  });
  it("passes retained-data errors and refresh calls through the fixture", () => {
    const refresh = vi.fn();

    const slot = renderSlot(
      { component: Probe },
      {},
      { inboxSnapshot: { snapshot, status: "error", stale: true, refresh } },
    );

    fireEvent.click(slot.getByRole("button"));
    expect(slot.getByRole("button").textContent).toBe(
      "error:true:snapshot-one",
    );
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("reports a supplied snapshot as ready", () => {
    const slot = renderSlot(
      { component: Probe },
      {},
      { inboxSnapshot: { snapshot } },
    );

    expect(slot.getByRole("button").textContent).toBe(
      "ready:false:snapshot-one",
    );
  });
});
