import { defineRpcContract, type PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";

const controlCharacters = /\p{Cc}/u;

const webAddress = /^https:\/\/[^\s<>]+$/u;

const localPath = /^(?![A-Za-z][A-Za-z0-9+.-]+:)[^<>]+$/u;

function line(maximum: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !controlCharacters.test(value), "Use one line without control characters");
}

export const cardStatuses = ["working", "needs-you", "blocked", "done"] as const;

export const cardPhases = ["investigate", "build", "test", "ship", "done"] as const;

export const factTones = ["neutral", "positive", "warning", "negative", "info", "muted"] as const;

export const proofKinds = ["reproduced", "inspected", "hypothesis"] as const;

export const projectImageSchema = z
  .object({
    kind: z.literal("project-image"),
    projectId: line(200),
    path: line(2000).refine(
      (value) =>
        !value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes(":") &&
        value.split("/").every((part) => part !== ".." && part !== "." && part.length > 0),
      "Use a project-relative attachment path without traversal",
    ),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    alt: line(300),
    visualRequestId: line(200).optional(),
    role: z.enum(["before", "result"]).optional(),
  })
  .strict();

export type ProjectImage = z.infer<typeof projectImageSchema>;

export const visualDeliverableSchema = z.object({
  title: line(120),
  preview: projectImageSchema,
});

export const cardSchema = z
  .object({
    status: z
      .enum(cardStatuses)
      .describe(
        "working; needs-you only while a native composer question needs an owner answer; blocked only for a concrete external gate; done only when the whole requested outcome is delivered and verified",
      ),
    phase: z
      .enum(cardPhases)
      .describe("Current work stage; drawn as a small progress strip on the open card"),
    goal: line(120)
      .optional()
      .describe(
        "The Goal row: what the owner originally asked this chat to do, as a short plain phrase of at most 80 characters, for example: Redesign the Glance card around goal, status and next step. Set it on the first card; a later card that omits goal keeps the previous one, so send a new goal only when the owner changes the request",
      ),
    headline: line(160).describe(
      "The Now row: where this chat's main request stands and its impact, in one plain sentence of at most 90 characters a busy owner understands: what is true now and why it matters. Leave out side requests, process steps, check counts, timestamps, paths, commands and IDs",
    ),
    sidebarSummary: line(64)
      .optional()
      .describe(
        'Done only: the single outcome of this chat\'s main request, result first, ideally at most 55 characters. Never join unrelated outcomes with "·" or "and"',
      ),
    blocker: line(300)
      .optional()
      .describe(
        "blocked only: what cannot proceed, why, and who or what unblocks it, in plain words",
      ),
    facts: z
      .array(
        z
          .object({
            label: line(60),
            value: line(120),
            tone: z.enum(factTones).default("neutral"),
          })
          .strict(),
      )
      .max(8)
      .default([])
      .describe(
        "Hidden under Details: at most three supporting outcomes with short labels and values; never repeat the goal, headline, next, status or phase, and put commands and evidence in proof",
      ),
    deliverables: z
      .array(
        z
          .object({
            title: line(120).refine(
              (value) => !/[<>]/u.test(value),
              "Titles cannot contain < or >",
            ),
            href: line(2000).refine(
              (value) => webAddress.test(value) || localPath.test(value),
              "Use an HTTPS URL, an absolute path or a workspace-relative path",
            ),
            meta: line(160).optional(),
            preview: projectImageSchema.optional(),
          })
          .strict(),
      )
      .max(8)
      .default([])
      .describe("Files or links the reader can open"),
    proof: z
      .array(
        z
          .object({
            claim: line(200),
            kind: z.enum(proofKinds),
            command: line(300).optional(),
            eventSeq: z.number().int().positive().optional(),
            ref: line(300).optional(),
          })
          .strict(),
      )
      .max(10)
      .default([])
      .describe("Hidden under Details: evidence behind the claims"),
    next: line(200)
      .optional()
      .describe(
        "The Next row: who acts next and what they do, at most 80 characters, for example: The owner picks the release scope, or: The agent runs the device check. Omit it once the chat is done; the card then shows archive readiness when a readiness plugin such as Tidy is installed",
      ),
  })
  .strict()
  .superRefine((card, context) => {
    if (card.sidebarSummary !== undefined && card.status !== "done")
      context.addIssue({
        code: "custom",
        path: ["sidebarSummary"],
        message: "Only completed cards have an outcome summary for the sidebar",
      });

    if ((card.status === "blocked") !== (card.blocker !== undefined))
      context.addIssue({
        code: "custom",
        path: ["blocker"],
        message: "A blocked card names the blocker and who or what unblocks it",
      });

    card.proof.forEach((entry, index) => {
      if (entry.kind === "reproduced" && entry.command === undefined)
        context.addIssue({
          code: "custom",
          path: ["proof", index, "command"],
          message: "Reproduced proof names the command that ran in this chat",
        });
    });
  });

export type CardInput = z.input<typeof cardSchema>;

export type Card = z.output<typeof cardSchema>;

export type CardStatus = (typeof cardStatuses)[number];

export type CardPhase = (typeof cardPhases)[number];

export type FactTone = (typeof factTones)[number];

export type ProofKind = (typeof proofKinds)[number];

export const proofLinkSchema = z.object({
  index: z.number().int().nonnegative(),
  linked: z.boolean(),
  eventSeq: z.number().int().nullable(),
  command: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  cwd: z.string().nullable(),
  excerpt: z.string().nullable(),
  status: z.string().nullable(),
  excerptUnavailable: z.boolean(),
});

export type ProofLink = z.infer<typeof proofLinkSchema>;

export const cardViewSchema = z.object({
  threadId: z.string(),
  card: cardSchema,
  revision: z.number().int().positive(),
  updatedAt: z.number(),
  source: z.enum(["tool", "cli"]),
  staleSince: z.number().nullable(),
  proofs: z.array(proofLinkSchema),
});

export type CardView = z.infer<typeof cardViewSchema>;

export const cardChangeSchema = z.object({
  field: z.string(),
  label: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});

export type CardChange = z.infer<typeof cardChangeSchema>;

export const cardDiffSchema = z.object({
  conversationSeq: z.number().int().nonnegative(),
  seenRevision: z.number().int().nullable(),
  revision: z.number().int().nullable(),
  changes: z.array(cardChangeSchema),
  newReplies: z.number().int().nonnegative(),
  moreActivity: z.boolean(),
});

export type CardDiff = z.infer<typeof cardDiffSchema>;

export const cardIndexEntrySchema = z.object({
  threadId: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(cardStatuses),
  phase: z.enum(cardPhases),
  goal: z.string().nullable(),
  headline: z.string(),
  sidebarSummary: z.string().nullable(),
  blocker: z.string().nullable(),
  next: z.string().nullable(),
  facts: z.array(z.object({ label: z.string(), value: z.string(), tone: z.enum(factTones) })),
  visuals: z.array(visualDeliverableSchema).max(2).default([]),
  stale: z.boolean(),
  unseen: z.boolean(),
  updatedAt: z.number(),
});

export type CardIndexEntry = z.infer<typeof cardIndexEntrySchema>;

const threadInput = z.object({ threadId: z.string().trim().min(1).max(200) });

export const refreshDiagnosticSchema = z
  .object({
    id: z.uuid(),
    occurredAt: z.number().int().min(0).max(8_640_000_000_000_000),
    elapsedMs: z.number().int().min(0).max(86_400_000),
    status: z.number().int().min(100).max(599).nullable(),
    stage: z.enum(["transport", "http", "response", "unknown"]),
    name: z.enum(["Error", "TypeError", "AbortError", "TimeoutError", "SyntaxError", "Other"]),
    code: z
      .enum([
        "invalid_json",
        "invalid_input",
        "handler_error",
        "invalid_output",
        "non_json_result",
        "unknown_method",
        "unknown",
      ])
      .nullable(),
    online: z.boolean(),
    visibility: z.enum(["visible", "hidden", "unknown"]),
    clientBundle: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,96}\.js$/u)
      .nullable(),
    pluginBundle: z
      .string()
      .regex(/^[a-f0-9]{16}$/u)
      .nullable(),
  })
  .strict();

export type RefreshDiagnostic = z.infer<typeof refreshDiagnosticSchema>;

type PreviewBinding = Awaited<ReturnType<PluginApi["sdk"]["previews"]["get"]>>;

type PreviewStatus = Awaited<ReturnType<PluginApi["sdk"]["previews"]["status"]>>;

const devServerPreviewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  environmentId: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  url: z.string(),
  remoteUrl: z.string(),
  createdAt: z.number(),
}) satisfies z.ZodType<PreviewBinding>;

const devServerStatusSchema = z.object({
  state: z.enum(["online", "stopped", "starting", "conflict", "error", "unknown", "host-offline"]),
  checkedAt: z.number(),
  detail: z.string().nullable(),
  runId: z.string().nullable(),
}) satisfies z.ZodType<PreviewStatus>;

export const devServerRowSchema = z.object({
  preview: devServerPreviewSchema,
  status: devServerStatusSchema,
  lastObservedOnlineAt: z.number().nullable(),
});

export const devServerShelfSchema = z.object({
  active: z.array(devServerRowSchema),
  recent: devServerRowSchema.nullable(),
});

export type DevServerRow = z.infer<typeof devServerRowSchema>;

export type DevServerShelf = z.infer<typeof devServerShelfSchema>;

export const rpcContract = defineRpcContract({
  "servers.read": {
    input: threadInput,
    output: devServerShelfSchema,
  },
  "servers.remember": {
    input: threadInput.extend({ previewId: z.string().min(1).max(200) }),
    output: devServerShelfSchema,
  },
  "servers.restart": {
    input: threadInput.extend({
      previewId: z.string().min(1).max(200),
      requestId: z.string().min(8).max(128),
    }),
    output: devServerShelfSchema,
  },
  "card.read": {
    experimental_threadBootstrap: true,
    input: threadInput,
    output: z.object({ view: cardViewSchema.nullable() }),
  },
  "card.get": {
    input: threadInput,
    output: z.object({
      view: cardViewSchema.nullable(),
      conversationSeq: z.number().int().nonnegative(),
    }),
  },
  "card.diff": {
    input: threadInput,
    output: cardDiffSchema,
  },
  "card.markSeen": {
    input: threadInput.extend({
      revision: z.number().int().positive(),
      conversationSeq: z.number().int().nonnegative(),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  "cards.index": {
    input: z.object({ diagnostic: refreshDiagnosticSchema }).strict().nullable(),
    output: z.object({ cards: z.array(cardIndexEntrySchema) }),
  },
});

export type GlanceRpcContract = typeof rpcContract;

export const realtimeChannel = "glance-changed";

export const realtimePayloadSchema = z.object({
  threadId: z.string(),
  revision: z.number().int().nonnegative(),
});

export const realtimeCardSchema = realtimePayloadSchema.extend({
  entry: cardIndexEntrySchema.nullable(),
});

export type RealtimeCard = z.infer<typeof realtimeCardSchema>;

export const toolNames = { set: "glance_set", show: "glance_show" } as const;
