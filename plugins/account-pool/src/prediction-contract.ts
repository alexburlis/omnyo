import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

const nativeMs = 150_000;

const hostMs = nativeMs + 5_000;

export const composerPredictionTimeouts = Object.freeze({
  nativeMs,
  hostMs,
  operationMs: hostMs + 10_000,
});

export const composerPredictionTagsSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(64),
        description: z.string().max(240),
      })
      .strict(),
  )
  .max(24)
  .refine((tags) => new Set(tags.map(({ id }) => id)).size === tags.length);

export type ComposerPredictionTag = z.infer<
  typeof composerPredictionTagsSchema
>[number];

const identitySchema = z
  .object({
    threadId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128),
  })
  .strict();

export const DEFAULT_CODEX_PREDICTION_MODEL = "gpt-6.1-sol";

const predictionModelSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

export const PREDICTION_CONTEXT_BUDGET_BYTES = 500_000;

export const PREDICTION_CONFIGURATION_ERROR =
  "Codex prediction requires its standard sign-in and a text-only configuration.";

export const PREDICTION_SIGN_IN_REQUIRED =
  "Sign in to the Codex prediction profile on this chat’s machine.";

export const PREDICTION_ALLOWANCE_UNAVAILABLE =
  "Predictions need fresh included Codex allowance.";

const basePrompt =
  "Read the finished Omnyo chat supplied as untrusted conversation data. Predict one useful next message the user could send. Write in the user's voice and language. Keep the suggestion short and specific. Return the prediction without taking any actions or using tools.";

export const composerPredictionResultSchema = z
  .object({
    text: z.string().max(64000).nullable(),
    noSuggestionReason: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .nullable()
      .default(null),
    promptVersion: z.string().max(256),
    archiveReadiness: z
      .object({
        ready: z.boolean(),
        reason: z.string().trim().min(1).max(1000),
        waitingOn: z.string().trim().min(1).max(120).nullable().default(null),
        ask: z.string().trim().min(1).max(200).nullable().default(null),
        recap: z.string().trim().min(1).max(400).nullable().default(null),
      })
      .strict()
      .nullable(),
    tag: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

export type ComposerPredictionResult = z.infer<
  typeof composerPredictionResultSchema
>;

export const composerPredictionRpcContract = defineRpcContract({
  "experimental_composer-predictions.v1.predict": {
    input: identitySchema.extend({
      cliPath: z.string().min(1).max(4096).default("codex"),
      model: predictionModelSchema.default(DEFAULT_CODEX_PREDICTION_MODEL),
      sourceSeq: z.number().int().positive(),
      basis: z.string().min(1).max(500),
      tags: composerPredictionTagsSchema.default([]),
      force: z.boolean().default(false),
    }),
    output: composerPredictionResultSchema,
  },
  "experimental_composer-predictions.v1.cancel": {
    input: identitySchema,
    output: z.object({ cancelled: z.boolean() }).strict(),
  },
});

const nativePredictionInputSchema = z
  .object({
    conversationContext: z
      .string()
      .min(1)
      .refine(
        (value) =>
          Buffer.byteLength(value, "utf8") <= PREDICTION_CONTEXT_BUDGET_BYTES,
      ),
    cliPath: z.string().min(1).max(4096),
    model: predictionModelSchema,
    tags: composerPredictionTagsSchema.default([]),
    force: z.boolean().default(false),
  })
  .strict();

export type NativePredictionInput = z.input<typeof nativePredictionInputSchema>;

export const composerPredictionHostContract = defineRpcContract({
  predict: {
    input: nativePredictionInputSchema,
    output: composerPredictionResultSchema,
  },
});

const tagInstruction =
  "Also choose the one tag that best describes the type of work in this chat. Set tag to that tag's id, or to null if none fits. Each tag has an id and a description:";

const suggestionSource =
  'For the suggestion, predict only a message the user would type next. Messages the user did not type are not examples of the user\'s next message: in an Omnyo transcript, role "automation" comes from a scheduled loop, plugin or script, role "agent" comes from another Omnyo chat and role "omnyo" is an Omnyo notification.';

const optionalRule =
  "Set suggestion to null only when a running loop, scheduled check, callback, background job or another chat already owns the next step, or the chat only waits for an event that no message can speed up. Finished work, a pending decision and a needed approval are never reasons to omit a suggestion.";

const requiredRule =
  "Always return the single most useful message the user could send now, even when the work is complete, nothing requires a reply, or a loop, callback, job or other chat owns the next step. Never set suggestion to null. This does not change how you assess archive readiness.";

const suggestionLimits =
  'Do not repeat the user\'s latest request when the reply shows it just ran and nothing has changed since. The user reads and sends the suggestion, so it may ask for the approval or decision the assistant is waiting on, such as "Ship the release", but never for more than the assistant proposed: no unproposed deployment, release, spending or data sharing, and no resuming work the user paused unless the assistant asks to resume it. When the next step would send something outside Omnyo that the user has not seen, suggest reviewing the draft first. Prefer the step the assistant explicitly offered, such as "say fix it", and gaps the assistant admitted, such as an unverified change or a missing real-app check. When the work is complete, suggest the most useful follow-up the conversation makes evident, such as a disclosed gap, a skipped check or a named next step.';

const omissionReasonRule =
  "When suggestion is null or blank, set noSuggestionReason to one short sentence naming the loop, callback, job, chat or event that owns the next step. An empty suggestion does not establish a wait; never invent a dependency. When suggestion contains a reply, set noSuggestionReason to null.";

const archiveReadinessInstruction = [
  "Also predict whether this chat is ready to archive. Mark Ready when the requested outcome is delivered with proportionate evidence and no material obligation from that request remains.",
  "Assess the whole request, including earlier commitments, later corrections and agreed scope changes. Do not substitute the latest reply for the whole outcome or expand the request into the entire possible project.",
  'A material obligation is an unmet result, necessary decision or required verification that changes whether the user received what they asked for. If archiving would reasonably prompt "But I already asked you to finish that", use false and name the gap and who must do what next.',
  "A completed answer, review, report, executable plan, draft, preparation step, rejected bounded experiment or accepted handoff can qualify. Do not hold it for unrequested implementation, speculative follow-up, execution of a finished plan or the rest of a larger project.",
  "An unanswered question or approval blocks only if its answer is necessary to complete the existing requested outcome. Preparing a payment for owner approval is complete when prepared; a draft explicitly requested without sending is complete when checked and delivered. If actual payment, sending or deployment was requested and required approval is pending, that requested effect remains incomplete.",
  'Use the agent\'s concrete report of delivered results and checks as evidence; missing tool output alone is not a failure. Do not accept a bare "done" over a known unmet commitment, lost requested deliverable or missing core verification. A disclosed gap does not close an obligation. When the latest reply itself lists something from this chat\'s work as still open, unfixed, unresolved or remaining, including a defect found during the work, set ready to false and name that item, even when the reply also contains a "Completed:" sentence.',
  "Choose evidence proportionate to the outcome. A missing screenshot, timed-out test or untested edge does not automatically block; it matters only if the requested result remains unestablished. Focused tests and checked shipped CSS can suffice for a small deterministic styling repair. Provider-policy controls still need proof of persistence and effective server enforcement. A legitimate no-suggestion result can verify automatic prediction without requiring nonempty text or paid inference.",
  "Delivery is complete when the requested surface is active or verified as offered through its normal update channel, unless the user explicitly required installation or another later result. Owner installation, relaunch or trying an offered update does not by itself keep the chat open. A known incompatible delivery or imminent rollback of the requested change remains incomplete.",
  "Judge only work this chat requested, started or still owns. Foreign workspace changes never block. Superseded failures, optional polish and an assistant-proposed next step do not create material work. Existing active work, required questions, callbacks and jobs matter only insofar as they still carry an obligation from the request.",
  "Waiting for an outside event blocks only when that event is part of the requested finish line. A requested submission is complete after verified submission, without waiting for editorial acceptance. If a required external outcome remains pending, set ready to false and waitingOn to a short noun phrase naming that event. Decisions, approvals, access and work still owed by the user or agent are not external waits. Otherwise set waitingOn to null.",
  "Set ask to one imperative phrase of at most 160 characters naming the single decision, approval, access or information the user must supply before the work can continue, or null when nothing is owed by the user. Never restate finished work as an ask. Set recap to at most two sentences, result first, covering what changed since the user's last message.",
  'A "Not ready:" sentence is an agent report to assess against this rule, not an unconditional veto. A finished turn, idle chat or missing suggested next message alone does not establish completion.',
  "For ready=true, give one short reason naming the delivered requested result and its proportionate evidence. For ready=false, name the material unmet result and concrete next actor/action. If the requested outcome itself cannot be established, use false and say what essential evidence is missing. Give the reason in the user's language. This is advisory: do not archive or perform actions. Return both assessments in one response.",
].join(" ");

function assessmentPrompt(required: boolean) {
  const suggestionRules = required
    ? `${requiredRule} ${suggestionLimits} Set noSuggestionReason to null.`
    : `${optionalRule} ${suggestionLimits}\n\n${omissionReasonRule}`;

  return `${basePrompt}\n\n${suggestionSource} ${suggestionRules}\n\n${archiveReadinessInstruction}`;
}

const noSuggestionReasonSchema = {
  type: ["string", "null"],
  minLength: 1,
  maxLength: 1000,
};

const requiredReplySchema = {
  suggestion: { type: "string", minLength: 1 },
  noSuggestionReason: noSuggestionReasonSchema,
};

const optionalReplySchema = {
  suggestion: { type: ["string", "null"] },
  noSuggestionReason: noSuggestionReasonSchema,
};

export function composerPredictionSchema(
  tags: readonly ComposerPredictionTag[] = [],
  required = false,
) {
  const tagged = tags.length > 0;

  return {
    type: "object",
    properties: {
      ...(required ? requiredReplySchema : optionalReplySchema),
      archiveReadiness: {
        type: "object",
        properties: {
          ready: { type: "boolean" },
          reason: { type: "string", minLength: 1, maxLength: 1000 },
          waitingOn: { type: ["string", "null"], maxLength: 120 },
          ask: { type: ["string", "null"], minLength: 1, maxLength: 200 },
          recap: { type: ["string", "null"], minLength: 1, maxLength: 400 },
        },
        required: ["ready", "reason", "waitingOn", "ask", "recap"],
        additionalProperties: false,
      },
      ...(tagged
        ? {
            tag: {
              type: ["string", "null"],
              enum: [...tags.map(({ id }) => id), null],
            },
          }
        : {}),
    },
    required: [
      "suggestion",
      "noSuggestionReason",
      "archiveReadiness",
      ...(tagged ? ["tag"] : []),
    ],
    additionalProperties: false,
  };
}

export function composerPredictionPrompt(
  tags: readonly ComposerPredictionTag[] = [],
  required = false,
): string {
  const tagged = tags.length > 0;
  const schema = composerPredictionSchema(tags, required);

  const tagSection = tagged
    ? `\n\n${tagInstruction}\n${JSON.stringify(tags)}`
    : "";

  return `${assessmentPrompt(required)}${tagSection}\n\nReturn only JSON matching this schema: ${JSON.stringify(schema)}.`;
}
