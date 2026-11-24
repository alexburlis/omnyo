import { describe, expect, it } from "vitest";
import { SERVER_UPDATE_WAIT_COPY } from "../src/queued-message.js";
import { threadQuestionInputSchema } from "../src/thread-attention.js";
import { strongestThreadWorkSummary } from "../src/thread-indicator.js";
import {
  projectThreadWork,
  queuedMessageWork,
  threadWorkSummarySchema,
  type ThreadWorkEvidence,
} from "../src/thread-work.js";

function evidence(
  overrides: Partial<ThreadWorkEvidence> = {},
): ThreadWorkEvidence {
  return {
    revision: "current",
    basis: "current",
    activity: [],
    requiredInput: [],
    optionalInput: [],
    failures: [],
    waits: [],
    coverageComplete: true,
    unknownReason: null,
    assessment: null,
    postponement: null,
    closed: false,
    ...overrides,
  };
}

const activity = {
  id: "release",
  kind: "plugin",
  label: "Release job running.",
  phase: "running",
  actor: { kind: "agent", id: "job", label: "Release job" },
} satisfies ThreadWorkEvidence["activity"][number];

const assessment = {
  basis: "current",
  contractVersion: 1,
  availability: "available",
  reason: "The requested work is complete.",
  sourceSeq: 4,
  text: null,
  noSuggestionReason: "No reply is needed.",
  waitingOn: null,
  ask: null,
  recap: null,
  archiveReady: true,
} satisfies NonNullable<ThreadWorkEvidence["assessment"]>;

describe("shared chat work projection", () => {
  it("states a server-update wait in the shared update wording", () => {
    expect(
      queuedMessageWork(
        { id: "update", sendAt: null, waitingOn: { kind: "server-update" } },
        {
          threadId: "thread",
          threadStatus: "idle",
          waitingForHost: false,
          hasRequiredInput: false,
          pluginAvailable: () => true,
          now: 1,
        },
      ),
    ).toMatchObject({
      kind: "wait",
      wait: {
        reason: SERVER_UPDATE_WAIT_COPY.status,
        actor: { kind: "external", label: SERVER_UPDATE_WAIT_COPY.actor },
      },
    });
    expect(SERVER_UPDATE_WAIT_COPY.status).toBe("Finishing the Omnyo update");
  });
  it("attributes an overtaken retry to the user instead of an automatic producer", () => {
    expect(
      queuedMessageWork(
        { id: "retry", sendAt: null, waitingOn: { kind: "superseded" } },
        {
          threadId: "thread",
          threadStatus: "idle",
          waitingForHost: false,
          hasRequiredInput: false,
          pluginAvailable: () => true,
          now: 1,
        },
      ),
    ).toMatchObject({ kind: "wait", wait: { actor: { kind: "user" } } });
  });
  it("does not roll a family up to Ready while another member's work is unknown", () => {
    const ready = projectThreadWork(evidence({ assessment }));
    const working = projectThreadWork(evidence({ activity: [activity] }));
    expect(strongestThreadWorkSummary([null, ready])).toBeNull();
    expect(strongestThreadWorkSummary([ready, undefined])).toBeNull();
    expect(strongestThreadWorkSummary([null, working, ready])).toBe(working);
  });
  it("preserves a valid maximum-length native question in the shared work snapshot", () => {
    const question = threadQuestionInputSchema.parse({
      prompt: "Q".repeat(2000),
      mode: "required",
    });

    const work = projectThreadWork(
      evidence({
        requiredInput: [
          { id: "long-question", kind: "question", label: question.prompt },
        ],
      }),
    );

    const parsed = threadWorkSummarySchema.parse(work);
    expect(parsed.requiredInput[0]?.label).toBe(question.prompt);
    expect(parsed.primary.reason.text).toBe(question.prompt);
  });
  it("retains advancing work and its actor while required input takes primary attention", () => {
    const result = projectThreadWork(
      evidence({
        activity: [activity],
        requiredInput: [
          { id: "q", kind: "question", label: "Choose the release scope." },
        ],
      }),
    );

    expect(result.primary.label).toBe("needs-you");
    expect(result.activity).toEqual([activity]);
    expect(result.nextActors.map((actor) => actor.kind)).toEqual([
      "user",
      "agent",
    ]);
    expect(result.archive.recommended).toBe(false);
  });

  it("keeps optional input independent of activity and readiness", () => {
    const optionalInput = [
      { id: "q", kind: "question" as const, label: "Any preferences?" },
    ];

    expect(
      projectThreadWork(evidence({ activity: [activity], optionalInput }))
        .primary.label,
    ).toBe("working");

    const completed = projectThreadWork(
      evidence({ assessment, optionalInput }),
    );

    expect(completed.primary.label).toBe("ready-to-archive");
    expect(completed.optionalInput).toEqual(optionalInput);
  });

  it("retains a failure while independent work advances", () => {
    const failure = {
      code: "dependency-failed",
      text: "A required job failed.",
      sourceId: "failed-job",
    };

    const result = projectThreadWork(
      evidence({ activity: [activity], failures: [failure] }),
    );

    expect(result.primary.label).toBe("working");
    expect(result.failures).toEqual([failure]);
    expect(result.archive.eligible).toBe(false);
    expect(
      projectThreadWork(evidence({ failures: [failure] })).primary.label,
    ).toBe("failed");
  });

  it.each([
    "missing",
    "disabled",
    "failed",
    "skipped",
    "checking",
    "stale",
  ] as const)(
    "explains %s assessment availability without assuming completion",
    (availability) => {
      const result = projectThreadWork(
        evidence({
          assessment:
            availability === "missing"
              ? null
              : {
                  ...assessment,
                  availability:
                    availability === "stale" ? "available" : availability,
                  basis: availability === "stale" ? "old" : "current",
                },
        }),
      );

      expect(result.assessment.availability).toBe(availability);
      expect(result.primary.label).toBe("open");
      expect(result.archive.recommended).toBe(false);
      expect(result.primary.reason.text.length).toBeGreaterThan(0);
    },
  );

  it("does not reuse a positive or negative assessment against a changed obligation basis", () => {
    for (const archiveReady of [true, false]) {
      const result = projectThreadWork(
        evidence({
          basis: "new-job",
          activity: [activity],
          assessment: { ...assessment, archiveReady },
        }),
      );

      expect(result.primary.label).toBe("working");
      expect(result.assessment.availability).toBe("stale");
      expect(result.archive.recommended).toBe(false);
    }
  });

  it("denies archive readiness when relevant ownership cannot be verified", () => {
    const result = projectThreadWork(
      evidence({
        assessment,
        coverageComplete: false,
        unknownReason: "The release owner is unavailable.",
      }),
    );

    expect(result.primary.label).toBe("open");
    expect(result.archive).toMatchObject({
      eligible: false,
      recommended: false,
      reason: "The release owner is unavailable.",
    });
    expect(result.nextActors).toEqual([
      { kind: "unknown", id: null, label: "Next owner unconfirmed" },
    ]);
  });

  it("distinguishes an explicitly recorded wait from postponement", () => {
    const actor = { kind: "external" as const, id: null, label: "App review" };

    const waiting = projectThreadWork(
      evidence({
        waits: [
          { id: "review", reason: "Waiting for App Store review.", actor },
        ],
      }),
    );

    expect(waiting.primary.label).toBe("waiting");
    expect(waiting.nextActors).toEqual([actor]);

    const postponed = projectThreadWork(
      evidence({
        assessment,
        postponement: {
          reason: "Resume after launch.",
          until: null,
          resumeActor: actor,
        },
      }),
    );

    expect(postponed.primary.label).toBe("open");
    expect(postponed.primary.reason.code).toBe("postponed");
    expect(postponed.archive.recommended).toBe(false);
  });

  it("labels a fresh assessment waiting on an outside event External, never Ready", () => {
    const result = projectThreadWork(
      evidence({
        assessment: { ...assessment, waitingOn: "App Store review" },
      }),
    );

    expect(result.primary).toEqual({
      label: "external",
      reason: {
        code: "predicted-external-wait",
        text: "Waiting on App Store review",
      },
    });
    expect(result.nextActors).toEqual([
      { kind: "external", id: null, label: "App Store review" },
    ]);
    expect(result.archive).toMatchObject({
      eligible: true,
      recommended: false,
      reason: "Waiting on App Store review",
    });
  });

  it("puts an owner ask in Needs you instead of a predicted outside wait", () => {
    const result = projectThreadWork(
      evidence({
        assessment: {
          ...assessment,
          archiveReady: false,
          waitingOn: "Push permission for the fix commit",
          ask: "Run the push and reload command yourself.",
        },
      }),
    );

    expect(result.primary).toEqual({
      label: "needs-you",
      reason: {
        code: "assessed-ask",
        text: "Run the push and reload command yourself.",
      },
    });
    expect(result.nextActors).toEqual([
      { kind: "user", id: null, label: "You" },
    ]);
    expect(result.archive).toMatchObject({
      eligible: true,
      recommended: false,
      reason: "Run the push and reload command yourself.",
    });
  });

  it("never recommends archive while an owner ask is open", () => {
    const result = projectThreadWork(
      evidence({
        assessment: { ...assessment, ask: "Approve the release." },
      }),
    );

    expect(result.primary.label).toBe("needs-you");
    expect(result.archive.recommended).toBe(false);
  });

  it("lets recorded evidence outrank an owner ask", () => {
    const asking = {
      ...assessment,
      waitingOn: "a release",
      ask: "Approve the release.",
    };

    const actor = { kind: "agent" as const, id: null, label: "Checker" };

    const cases = [
      [evidence({ assessment: asking, activity: [activity] }), "working"],
      [
        evidence({
          assessment: asking,
          failures: [{ code: "job-failed", text: "Failed.", sourceId: null }],
        }),
        "failed",
      ],
      [
        evidence({
          assessment: asking,
          waits: [{ id: "w", reason: "Waiting on CI.", actor }],
        }),
        "waiting",
      ],
    ] as const;

    for (const [input, label] of cases)
      expect(projectThreadWork(input).primary.label).toBe(label);
  });

  it("ignores the ask of a stale or unavailable assessment", () => {
    for (const changed of [
      { basis: "old" },
      { availability: "failed" as const },
    ]) {
      const result = projectThreadWork(
        evidence({
          assessment: { ...assessment, ...changed, ask: "Approve it." },
        }),
      );

      expect(result.primary.label).toBe("open");
    }
  });

  it("lets recorded evidence outrank a predicted outside wait", () => {
    const external = { ...assessment, waitingOn: "DNS propagation" };
    const actor = { kind: "agent" as const, id: null, label: "Checker" };

    const cases = [
      [
        evidence({
          assessment: external,
          requiredInput: [{ id: "q", kind: "question", label: "Pick one." }],
        }),
        "needs-you",
      ],
      [evidence({ assessment: external, activity: [activity] }), "working"],
      [
        evidence({
          assessment: external,
          failures: [{ code: "job-failed", text: "Failed.", sourceId: null }],
        }),
        "failed",
      ],
      [
        evidence({
          assessment: external,
          waits: [{ id: "w", reason: "Waiting on CI.", actor }],
        }),
        "waiting",
      ],
      [
        evidence({
          assessment: external,
          postponement: {
            reason: "Resume Monday.",
            until: null,
            resumeActor: actor,
          },
        }),
        "open",
      ],
    ] as const;

    for (const [input, label] of cases)
      expect(projectThreadWork(input).primary.label).toBe(label);
  });

  it("ignores the outside event of a stale or unavailable assessment", () => {
    for (const changed of [
      { basis: "old" },
      { availability: "failed" as const },
    ]) {
      const result = projectThreadWork(
        evidence({
          assessment: {
            ...assessment,
            ...changed,
            waitingOn: "App Store review",
          },
        }),
      );

      expect(result.primary.label).toBe("open");
      expect(result.archive.recommended).toBe(false);
    }
  });

  it("ranks External below Open and above Ready to archive in a family", () => {
    const ready = projectThreadWork(evidence({ assessment }));

    const external = projectThreadWork(
      evidence({ assessment: { ...assessment, waitingOn: "a reply" } }),
    );

    const open = projectThreadWork(
      evidence({ assessment: { ...assessment, archiveReady: false } }),
    );

    expect(strongestThreadWorkSummary([ready, external])).toBe(external);
    expect(strongestThreadWorkSummary([external, open])).toBe(open);
  });

  it("keeps the primary reason bounded while preserving all activity details", () => {
    const result = projectThreadWork(
      evidence({
        activity: Array.from({ length: 100 }, (_, index) => ({
          ...activity,
          id: String(index),
          label: "a".repeat(1000),
        })),
      }),
    );

    expect(threadWorkSummarySchema.safeParse(result).success).toBe(true);
    expect(result.activity).toHaveLength(100);
  });
});
