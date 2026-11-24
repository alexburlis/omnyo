import { describe, expect, it } from "vitest";
import type { SystemAppUpdateStatus } from "@omnyo/server-contract";
import {
  formatAppUpdateRevision,
  formatAppUpdateTarget,
  runningThreadsWarning,
  omnyoUpdateNowState,
  appUpdateProgressLabel,
  updateNowDescription,
} from "./app-update-presentation";

describe("app update presentation", () => {
  it("shows an idle-only identity offer without a force action or deadline", () => {
    const status: SystemAppUpdateStatus = {
      activity: { phase: "idle" },
      available: {
        activation: "idle-only",
        channel: "private",
        commit: null,
        commitCount: null,
        subjects: [],
        version: "0.46.244+private.1",
      },
      blocked: null,
      current: { commit: null, version: "0.46.243+private.1" },
      installsWhenIdle: false,
      lastResult: null,
      newTurnsPausedForUpdate: false,
      runningThreadCount: 2,
      support: { kind: "supported", mode: "private" },
    };

    expect(omnyoUpdateNowState(status)).toBe("none");
    expect(updateNowDescription(status)).toBe(
      "The update installs after all chats and background work finish.",
    );

    const pending: SystemAppUpdateStatus = {
      ...status,
      installsWhenIdle: true,
      activity: {
        phase: "preparing",
        code: null,
        output: [],
        startedAt: "2026-11-03T12:00:00Z",
        step: "Waiting for idle",
        targetVersion: "0.46.244+private.1",
      },
    };

    expect(appUpdateProgressLabel(pending)).toBe("Waiting for idle");
    expect(omnyoUpdateNowState(pending)).toBe("updating");
  });
  it("labels source revisions with a short commit", () => {
    expect(
      formatAppUpdateRevision({ commit: "abcdef1234567", version: "1.0.0" }),
    ).toBe("abcdef1");
    expect(
      formatAppUpdateTarget({
        channel: "main",
        commit: "abcdef1234567",
        commitCount: 1,
        subjects: [],
        version: "1.0.0",
      }),
    ).toBe("abcdef1 (+1 commit)");
  });

  it("warns in the singular and plural", () => {
    expect(runningThreadsWarning(1)).toBe(
      "1 thread is running. Updating restarts Omnyo and interrupts it.",
    );
    expect(runningThreadsWarning(3)).toBe(
      "3 threads are running. Updating restarts Omnyo and interrupts them.",
    );
  });
});
