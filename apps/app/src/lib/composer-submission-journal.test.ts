// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyPromptDraftState,
  type PromptDraftState,
} from "@omnyo/client-core/prompt-draft";
import type { PromptDraftScope } from "@/hooks/usePromptDraftStorage";

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.resetModules();
});

describe("interrupted composer recovery", () => {
  it.each(["entry", "scope", "attachment", "mention", "resource"])(
    "preserves unsupported %s bytes before any recovery callback or later journal persist",
    async (field) => {
      const opaque = {
        requestId: "keep-future-work",
        nested: ["exact raw bytes"],
      };

      const draft = {
        text: "saved input",
        attachments:
          field === "attachment"
            ? [
                {
                  type: "localFile",
                  path: "/synthetic/file",
                  name: "file",
                  sizeBytes: 3,
                  futureWork: opaque,
                },
              ]
            : [],
        mentions:
          field === "mention" || field === "resource"
            ? [
                {
                  start: 0,
                  end: 5,
                  resource: {
                    kind: "section",
                    sectionId: "opaque-section",
                    label: "saved",
                    ...(field === "resource" ? { futureWork: opaque } : {}),
                  },
                  ...(field === "mention" ? { futureWork: opaque } : {}),
                },
              ]
            : [],
      };

      window.sessionStorage.setItem(
        "omnyo.composer-submission-tab.v1",
        "original-tab",
      );
      const key = "omnyo.composer-submissions.v1.original-tab";

      const raw = JSON.stringify([
        {
          id: "original-request",
          scope: {
            kind: "new-thread",
            ...(field === "scope" ? { futureWork: opaque } : {}),
          },
          draft: JSON.stringify(draft),
          ...(field === "entry" ? { futureWork: opaque } : {}),
        },
      ]);

      window.localStorage.setItem(key, raw);
      const journal = await import("./composer-submission-journal");
      const restore = vi.fn();
      expect(() =>
        journal.recoverInterruptedComposerSubmissions(restore),
      ).toThrow();
      expect(restore).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(key)).toBe(raw);
      expect(() =>
        journal.beginComposerSubmission({
          scope: { kind: "new-thread" },
          draft: { ...emptyPromptDraftState(), text: "later work" },
        }),
      ).toThrow();
      expect(window.localStorage.getItem(key)).toBe(raw);
    },
  );

  it("restores valid old attachment and mention records through the existing legacy resource owner without sending again", async () => {
    window.sessionStorage.setItem(
      "bb.composer-submission-tab.v1",
      "old-valid-tab",
    );

    const attachment = {
      type: "localFile",
      path: "/synthetic/old-owned-file",
      name: "old-owned-file",
      sizeBytes: 3,
    };

    const rawDraft = JSON.stringify({
      text: "old valid input",
      attachments: [attachment],
      mentions: [
        {
          start: 0,
          end: 3,
          resource: {
            kind: "folder",
            folderId: "unchanged-opaque-id",
            label: "old",
          },
        },
      ],
    });

    window.localStorage.setItem(
      "bb.composer-submissions.v1.old-valid-tab",
      JSON.stringify([
        { id: "old-request", scope: { kind: "new-thread" }, draft: rawDraft },
      ]),
    );
    const journal = await import("./composer-submission-journal");
    const restore = vi.fn();
    expect(journal.recoverInterruptedComposerSubmissions(restore)).toEqual({
      recovered: 1,
      failed: 0,
    });
    expect(restore).toHaveBeenCalledExactlyOnceWith(
      { kind: "new-thread" },
      {
        text: "old valid input",
        attachments: [attachment],
        mentions: [
          {
            start: 0,
            end: 3,
            resource: {
              kind: "section",
              sectionId: "unchanged-opaque-id",
              label: "old",
            },
          },
        ],
      },
    );
    expect(journal.recoverInterruptedComposerSubmissions(restore)).toEqual({
      recovered: 0,
      failed: 0,
    });
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("restores each unconfirmed snapshot to its original scope without replaying a send", async () => {
    const journal = await import("./composer-submission-journal");

    const original: PromptDraftState = {
      ...emptyPromptDraftState(),
      text: "first message",
      attachments: [
        {
          path: "/tmp/owned-file.txt",
          name: "owned-file.txt",
          type: "localFile",
        },
      ],
    };

    const scope: PromptDraftScope = {
      kind: "thread",
      projectId: "proj_first",
      threadId: "thr_first",
    };

    journal.beginComposerSubmission({ scope, draft: original });
    journal.beginComposerSubmission({
      scope: { kind: "new-thread" },
      draft: { ...emptyPromptDraftState(), text: "second message" },
    });

    const confirmed = journal.beginComposerSubmission({
      scope,
      draft: { ...emptyPromptDraftState(), text: "already confirmed" },
    });

    confirmed.complete();

    vi.resetModules();
    const reloaded = await import("./composer-submission-journal");

    const restored: Array<{
      scope: PromptDraftScope;
      draft: PromptDraftState;
    }> = [];

    expect(
      reloaded.recoverInterruptedComposerSubmissions((destination, draft) => {
        restored.push({ scope: destination, draft });
      }),
    ).toEqual({ recovered: 2, failed: 0 });
    expect(restored).toEqual([
      { scope, draft: original },
      {
        scope: { kind: "new-thread" },
        draft: { ...emptyPromptDraftState(), text: "second message" },
      },
    ]);
    expect(
      reloaded.recoverInterruptedComposerSubmissions(() => {
        throw new Error("Already recovered");
      }),
    ).toEqual({ recovered: 0, failed: 0 });
  });

  it("retains interrupted input if the destination cannot restore it", async () => {
    const journal = await import("./composer-submission-journal");
    const draft = { ...emptyPromptDraftState(), text: "keep this input" };
    journal.beginComposerSubmission({ scope: { kind: "new-thread" }, draft });
    expect(
      journal.recoverInterruptedComposerSubmissions(() => {
        throw new Error("Storage unavailable");
      }),
    ).toEqual({ recovered: 0, failed: 1 });

    vi.resetModules();
    const restored = vi.fn();
    const reloaded = await import("./composer-submission-journal");
    expect(reloaded.recoverInterruptedComposerSubmissions(restored)).toEqual({
      recovered: 1,
      failed: 0,
    });
    expect(restored).toHaveBeenCalledWith({ kind: "new-thread" }, draft);
  });

  it("leaves another browser tab's active submissions alone", async () => {
    const journal = await import("./composer-submission-journal");
    journal.beginComposerSubmission({
      scope: { kind: "new-thread" },
      draft: { ...emptyPromptDraftState(), text: "other tab is sending" },
    });
    window.sessionStorage.clear();
    vi.resetModules();

    const anotherTab = await import("./composer-submission-journal");
    expect(
      anotherTab.recoverInterruptedComposerSubmissions(() => {
        throw new Error("Foreign input must stay with its owner");
      }),
    ).toEqual({ recovered: 0, failed: 0 });
    expect(window.localStorage.length).toBe(1);
  });
});
