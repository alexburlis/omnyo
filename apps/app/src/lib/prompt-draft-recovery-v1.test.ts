import { describe, expect, it } from "vitest";
import {
  parsePromptDraftStorage,
  serializePromptDraftStorage,
} from "@omnyo/client-core/prompt-draft";
import {
  planOriginComposerRecoveryV1,
  promptDraftStorageKeyV1,
} from "./prompt-draft-recovery-v1";

const draft = (text: string) =>
  serializePromptDraftStorage({ text, mentions: [], attachments: [] });

function selected() {
  const entries = (id: string, threadId: string, text: string) =>
    JSON.stringify([
      {
        id,
        scope: { kind: "thread", projectId: "proj_stable", threadId },
        draft: draft(text),
      },
    ]);

  const local: [string, string][] = [
    [
      "bb.composer-submissions.v1.original-tab-a",
      entries("submission-a", "pending_original", "unsent first"),
    ],
    [
      "bb.composer-submissions.v1.original-tab-b",
      entries("submission-b", "pending_accepted", "unsent second"),
    ],
    ["bb.promptbox.contents-draft-3", draft("existing input")!],
    [
      "bb.promptbox.contents-proj_stable-pending_accepted-3",
      draft("typed while waiting")!,
    ],
    ["vendor.opaque.work", '  {"preserve":"exact raw bytes"}  '],
  ];

  const windows = [
    {
      windowKey: "native-window-a",
      session: [
        ["bb.composer-submission-tab.v1", "original-tab-a"],
        [
          "bb.pending-chats.v1",
          JSON.stringify([
            {
              id: "pending_original",
              projectId: "proj_stable",
              realThreadId: null,
            },
          ]),
        ],
        ["vendor.session.work", "opaque first window"],
      ] satisfies [string, string][],
    },
    {
      windowKey: "native-window-b",
      session: [
        ["bb.composer-submission-tab.v1", "original-tab-b"],
        [
          "bb.pending-chats.v1",
          JSON.stringify([
            {
              id: "pending_accepted",
              projectId: "proj_stable",
              realThreadId: "thr_stable",
            },
          ]),
        ],
        ["vendor.session.work", "opaque second window"],
      ] satisfies [string, string][],
    },
  ];

  return { local, windows };
}

describe("sealed local-window composer recovery", () => {
  it("plans every selected tab and pending destination without touching the original snapshots", () => {
    const input = selected();
    const before = JSON.stringify(input);
    const plan = planOriginComposerRecoveryV1(input);
    expect(JSON.stringify(input)).toBe(before);
    const local = new Map(plan.localAfter);
    expect(plan.recoveredSubmissions).toBe(2);
    expect(plan.movedDrafts).toBe(1);
    expect(local.get("vendor.opaque.work")).toBe(
      '  {"preserve":"exact raw bytes"}  ',
    );
    expect(
      parsePromptDraftStorage(
        local.get(promptDraftStorageKeyV1({ kind: "new-thread" })) ?? null,
      ).text,
    ).toBe("existing input\n\nunsent first");
    expect(
      parsePromptDraftStorage(
        local.get(
          promptDraftStorageKeyV1({
            kind: "thread",
            projectId: "proj_stable",
            threadId: "thr_stable",
          }),
        ) ?? null,
      ).text,
    ).toBe("unsent second\n\ntyped while waiting");
    expect(local.has("omnyo.composer-submissions.v1.original-tab-a")).toBe(
      false,
    );
    expect(local.has("omnyo.composer-submissions.v1.original-tab-b")).toBe(
      false,
    );
    expect(local.has("bb.composer-submissions.v1.original-tab-a")).toBe(false);
    expect(
      local.has(
        promptDraftStorageKeyV1({
          kind: "thread",
          projectId: "proj_stable",
          threadId: "pending_accepted",
        }),
      ),
    ).toBe(false);
    const first = new Map(plan.windows[0].session);
    const second = new Map(plan.windows[1].session);
    expect(first.get("omnyo.composer-submission-tab.v1")).toBe(
      "original-tab-a",
    );
    expect(second.get("omnyo.composer-submission-tab.v1")).toBe(
      "original-tab-b",
    );
    expect(first.get("vendor.session.work")).toBe("opaque first window");
    expect(second.get("vendor.session.work")).toBe("opaque second window");
    expect(JSON.parse(second.get("omnyo.pending-chats.v1")!)[0]).toEqual({
      id: "pending_accepted",
      projectId: "proj_stable",
      realThreadId: "thr_stable",
    });
  });

  it("refuses a collision in a later selected window before any real storage changes", () => {
    const input = selected();
    input.windows[1].session.push([
      "omnyo.composer-submission-tab.v1",
      "foreign-tab",
    ]);
    const before = JSON.stringify(input);
    expect(() => planOriginComposerRecoveryV1(input)).toThrow();
    expect(JSON.stringify(input)).toBe(before);
  });

  it("refuses an old nonempty journal whose source tab is outside the selected window set", () => {
    const input = selected();
    input.local.push([
      "bb.composer-submissions.v1.unmapped-tab",
      JSON.stringify([
        {
          id: "orphaned-unsent-request",
          scope: {
            kind: "thread",
            projectId: "proj_stable",
            threadId: "thr_other",
          },
          draft: draft("preserve this unselected source input"),
        },
      ]),
    ]);
    const before = JSON.stringify(input);
    expect(() => planOriginComposerRecoveryV1(input)).toThrow(
      "no selected source window",
    );
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["entry", "scope", "attachment", "mention", "resource"])(
    "refuses unrecognized selected journal %s work without changing either original snapshot",
    (field) => {
      const input = selected();

      const opaque = {
        unknownRequestId: "preserve-future-user-work",
        nested: ["exact opaque state"],
      };

      input.local[0][1] = JSON.stringify([
        {
          id: "submission-a",
          scope: {
            kind: "thread",
            projectId: "proj_stable",
            threadId: "pending_original",
            ...(field === "scope" ? { futureWork: opaque } : {}),
          },
          draft: JSON.stringify({
            text: "unsent first",
            attachments:
              field === "attachment"
                ? [
                    {
                      type: "localFile",
                      path: "/synthetic/owned-file",
                      name: "owned-file",
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
                        sectionId: "opaque-section-id",
                        label: "kept",
                        ...(field === "resource" ? { futureWork: opaque } : {}),
                      },
                      ...(field === "mention" ? { futureWork: opaque } : {}),
                    },
                  ]
                : [],
          }),
          ...(field === "entry" ? { futureWork: opaque } : {}),
        },
      ]);
      const before = JSON.stringify(input);
      expect(() => planOriginComposerRecoveryV1(input)).toThrow();
      expect(JSON.stringify(input)).toBe(before);
    },
  );

  it("keeps unconsumed unknown pending descriptor bytes while using the known accepted destination", () => {
    const input = selected();

    const pending = JSON.stringify([
      {
        id: "pending_accepted",
        projectId: "proj_stable",
        realThreadId: "thr_stable",
        futureWork: { requestId: "preserve-unknown-pending-work" },
      },
    ]);

    input.windows[1].session = input.windows[1].session.map(([key, value]) => [
      key,
      key === "bb.pending-chats.v1" ? pending : value,
    ]);
    const before = JSON.stringify(input);
    const plan = planOriginComposerRecoveryV1(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(new Map(plan.windows[1].session).get("omnyo.pending-chats.v1")).toBe(
      pending,
    );
    expect(plan.recoveredSubmissions).toBe(2);
  });
});
