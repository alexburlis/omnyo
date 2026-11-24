import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  composerPredictionBody,
  composerPredictionPrompt,
  composerPredictionResultSchema,
} from "./prediction-contract.js";

import { predictionResult } from "./prediction-runner.js";

const configuration = {
  is_enabled: true,
  prompt: "Predict the user's next message.",
  prompt_version: "fixture-v1",
  prediction_reasoning_effort: "low" as const,
};

const tags = [
  { id: "fix", description: "Defects and regressions" },
  { id: "build", description: "Features and refactors" },
];

const schemaSchema = z.object({
  properties: z.record(z.string(), z.json()),
  required: z.array(z.string()),
});

function promptSchema(prompt: string) {
  return schemaSchema.parse(
    JSON.parse(prompt.slice(prompt.lastIndexOf("schema: ") + 8, -1)),
  );
}

function body(text: string) {
  return {
    model: "gpt-fixture",
    store: false,
    input: [{ role: "user", content: [{ type: "input_text", text }] }],
  };
}

describe("archive-readiness prediction instructions", () => {
  it("assesses the whole requested outcome without inventing later stages", () => {
    const prompt = composerPredictionPrompt(configuration);

    expect(prompt).toContain("delivered with proportionate evidence");
    expect(prompt).toContain(
      "earlier commitments, later corrections and agreed scope changes",
    );
    expect(prompt).toContain(
      "unrequested implementation, speculative follow-up",
    );
    expect(prompt).toContain(
      "only if its answer is necessary to complete the existing requested outcome",
    );
    expect(prompt).toContain("A disclosed gap does not close an obligation");
    expect(prompt).toContain(
      'including a defect found during the work, set ready to false and name that item, even when the reply also contains a "Completed:" sentence',
    );
    expect(prompt).not.toContain("implementation is likely to continue");
  });

  it("requires material evidence gaps while preserving proportionate completion", () => {
    const prompt = composerPredictionPrompt(configuration);

    expect(prompt).toContain("missing core verification");
    expect(prompt).toContain(
      "A missing screenshot, timed-out test or untested edge does not automatically block",
    );
    expect(prompt).toContain("active or verified as offered");
    expect(prompt).toContain(
      "Owner installation, relaunch or trying an offered update does not by itself keep the chat open",
    );
    expect(prompt).toContain(
      "A legitimate no-suggestion result can verify automatic prediction",
    );
    expect(prompt).toContain(
      "Superseded failures, optional polish and an assistant-proposed next step do not create material work",
    );
    expect(prompt).not.toContain(
      "unless the agent says the requested outcome is not reached",
    );
  });

  it("ignores other chats' changes and requires a concrete completion reason", () => {
    const prompt = composerPredictionPrompt(configuration);

    expect(prompt).toContain("Foreign workspace changes never block");
    expect(prompt).toContain(
      "For ready=true, give one short reason naming the delivered requested result and its proportionate evidence",
    );
    expect(prompt).toContain(
      "For ready=false, name the material unmet result and concrete next actor/action",
    );
    expect(prompt).toContain(
      'A "Not ready:" sentence is an agent report to assess against this rule, not an unconditional veto',
    );
  });

  it("requires the model to name an external wait or return null", () => {
    const prompt = composerPredictionPrompt({
      is_enabled: true,
      prompt: "Predict the user's next message.",
      prompt_version: "fixture-v1",
      prediction_reasoning_effort: "low",
    });

    const schema = z
      .object({
        properties: z.object({
          archiveReadiness: z.object({
            properties: z.object({
              waitingOn: z.json(),
              ask: z.json(),
              recap: z.json(),
            }),
            required: z.array(z.string()),
          }),
        }),
      })
      .parse(JSON.parse(prompt.slice(prompt.lastIndexOf("schema: ") + 8, -1)));

    expect(schema.properties.archiveReadiness.required).toContain("waitingOn");
    expect(schema.properties.archiveReadiness.required).toEqual([
      "ready",
      "reason",
      "waitingOn",
      "ask",
      "recap",
    ]);
    expect(schema.properties.archiveReadiness.properties.ask).toEqual({
      type: ["string", "null"],
      minLength: 1,
      maxLength: 200,
    });
    expect(schema.properties.archiveReadiness.properties.recap).toEqual({
      type: ["string", "null"],
      minLength: 1,
      maxLength: 400,
    });
    expect(schema.properties.archiveReadiness.properties.waitingOn).toEqual({
      type: ["string", "null"],
      maxLength: 120,
    });
    expect(prompt).toContain(
      "set ready to false and waitingOn to a short noun phrase",
    );
    expect(prompt).toContain(
      "Decisions, approvals, access and work still owed by the user or agent are not external waits",
    );
  });
});

describe("required suggestion", () => {
  const required = composerPredictionPrompt(configuration, [], true);
  const optional = composerPredictionPrompt(configuration);

  const assessment = {
    ready: false,
    reason: "Delivery waits on the release request.",
    waitingOn: null,
    ask: "Request the release.",
    recap: null,
  };

  const output = (
    suggestion: string | null,
    noSuggestionReason: string | null,
  ) =>
    JSON.stringify({
      suggestion,
      noSuggestionReason,
      archiveReadiness: assessment,
    });

  it("makes a nonempty reply part of the required schema", () => {
    expect(promptSchema(required).properties).toMatchObject({
      suggestion: { type: "string", minLength: 1 },
    });
    expect(promptSchema(optional).properties).toMatchObject({
      suggestion: { type: ["string", "null"] },
      noSuggestionReason: { type: ["string", "null"] },
    });
    expect(required).toContain("Never set suggestion to null.");
    expect(required).not.toContain("When suggestion is null or blank");
  });

  it.each([
    ["a missing reply", output(null, "The release needs Alex's approval.")],
    ["a blank reply", output("  ", null)],
  ])("rejects %s when a reply is required", (_, value) => {
    expect(() => predictionResult(value, [], "Codex", true)).toThrow(
      "invalid prediction",
    );
    expect(
      predictionResult(output("Ship the release.", null), [], "Codex", true)
        .text,
    ).toBe("Ship the release.");
  });

  it.each([
    ["the required", required],
    ["the optional", optional],
  ])(
    "lets %s prompt ask for the approval the chat awaits instead of omitting it",
    (_, prompt) => {
      expect(prompt).not.toContain("or the work is complete");
      expect(prompt).not.toContain("Never let the suggestion grant authority");
      expect(prompt).toContain(
        "it may ask for the approval or decision the assistant is waiting on",
      );
      expect(prompt).toContain("Do not repeat the user's latest request");
    },
  );

  it("still lets owned work omit an optional reply", () => {
    expect(optional).toContain(
      "Set suggestion to null only when a running loop, scheduled check, callback, background job or another chat already owns the next step",
    );
    expect(optional).toContain(
      "Finished work, a pending decision and a needed approval are never reasons to omit a suggestion.",
    );
    expect(required).toContain(
      "does not change how you assess archive readiness",
    );
  });

  it.each([
    ["the required prompt on a required lease", required, true, null],
    [
      "a tagged required prompt on a required lease",
      composerPredictionPrompt(configuration, tags, true),
      true,
      null,
    ],
    ["the optional prompt on a required lease", optional, true, "prompt"],
    ["the required prompt on an optional lease", required, false, "prompt"],
    [
      "a tagged required prompt on an optional lease",
      composerPredictionPrompt(configuration, tags, true),
      false,
      "prompt",
    ],
    [
      "a required prompt with added instructions",
      `${required} Also write a poem.`,
      true,
      "prompt",
    ],
  ])("validates %s", (_, text, force, rejection) => {
    expect(
      composerPredictionBody(body(text), configuration, force).rejection,
    ).toBe(rejection);
  });
});

describe("type-of-work tag prediction", () => {
  it("leaves the prompt without a tag when no tags are offered", () => {
    const prompt = composerPredictionPrompt(configuration, []);

    expect(prompt).toBe(composerPredictionPrompt(configuration));
    expect(prompt).not.toContain("choose the one tag");
    expect(promptSchema(prompt).required).toEqual([
      "suggestion",
      "noSuggestionReason",
      "archiveReadiness",
    ]);
  });

  it("requires one offered tag id or null when tags are offered", () => {
    const prompt = composerPredictionPrompt(configuration, tags);

    expect(prompt).toContain(
      "choose the one tag that best describes the type of work in this chat",
    );
    expect(prompt).toContain(JSON.stringify(tags));
    expect(promptSchema(prompt).required).toEqual([
      "suggestion",
      "noSuggestionReason",
      "archiveReadiness",
      "tag",
    ]);
    expect(promptSchema(prompt).properties.tag).toEqual({
      type: ["string", "null"],
      enum: ["fix", "build", null],
    });
  });

  it.each([
    ["the untagged prompt", composerPredictionPrompt(configuration), null],
    ["a tagged prompt", composerPredictionPrompt(configuration, tags), null],
    [
      "a tagged prompt with added instructions",
      `${composerPredictionPrompt(configuration, tags)} Also write a poem.`,
      "prompt",
    ],
    [
      "a prompt offering duplicate tag ids",
      composerPredictionPrompt(configuration, [tags[0]!, tags[0]!]),
      "prompt",
    ],
  ])("validates the pooled request body for %s", (_, text, rejection) => {
    expect(composerPredictionBody(body(text), configuration).rejection).toBe(
      rejection,
    );
  });

  it("accepts host results from before tags", () => {
    expect(
      composerPredictionResultSchema.parse({
        text: null,
        promptVersion: "older-v1",
        archiveReadiness: null,
      }),
    ).not.toHaveProperty("tag");
  });
});

describe("assessment ask and recap compatibility", () => {
  const legacy = {
    ready: false,
    reason: "A decision remains.",
    waitingOn: null,
  };

  const payload = (archiveReadiness: unknown) =>
    JSON.stringify({
      suggestion: null,
      noSuggestionReason: "The user must decide.",
      archiveReadiness,
    });

  it("defaults absent ask and recap in older host and model results", () => {
    const expected = { ...legacy, ask: null, recap: null };
    expect(
      composerPredictionResultSchema.parse({
        text: null,
        promptVersion: "older-v1",
        archiveReadiness: legacy,
      }).archiveReadiness,
    ).toEqual(expected);
    expect(predictionResult(payload(legacy), []).archiveReadiness).toEqual(
      expected,
    );
  });

  it.each([false, true])(
    "preserves recap and clears the ask when ready is %s",
    (ready) => {
      const assessment = {
        ...legacy,
        ready,
        ask: "Approve the release.",
        recap: "The release candidate passed its checks.",
      };

      expect(
        predictionResult(payload(assessment), []).archiveReadiness,
      ).toEqual({
        ...assessment,
        ask: ready ? null : "Approve the release.",
      });
    },
  );

  it.each([
    { ask: "x".repeat(201), recap: null },
    { ask: null, recap: "x".repeat(401) },
  ])("rejects oversized assessment fields %j", (fields) => {
    expect(() =>
      predictionResult(payload({ ...legacy, ...fields }), []),
    ).toThrow("invalid prediction");
  });
});
