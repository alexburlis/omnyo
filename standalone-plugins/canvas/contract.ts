import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { projectRpc } from "./project-contract";
import { boardAddressSchema } from "./board-contract";
import { workspaceRpc } from "./workspace-contract";
import { nodeBindingSchema, sourceIdSchema } from "./source-contract.ts";

const singleLineControls = /\p{Cc}/u;

const webAddress = /^https:\/\/[^\s<>]+$/u;

const localPath = /^(?![A-Za-z][A-Za-z0-9+.-]+:)[^<>\n]+$/u;

function line(maximum: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !singleLineControls.test(value), "Use one line without control characters");
}

function text(maximum: number) {
  return z
    .string()
    .max(maximum)
    .refine(
      (value) =>
        [...value].every((character) => {
          const code = character.charCodeAt(0);

          return code === 9 || code === 10 || (code >= 32 && code !== 127);
        }),
      "Remove control characters",
    );
}

export const nodeKinds = [
  "note",
  "image",
  "video",
  "file",
  "decision",
  "status",
  "code",
  "html",
  "link",
] as const;

export const nodeTones = ["neutral", "positive", "warning", "negative", "info"] as const;

export const statusStates = ["running", "done", "failed", "blocked", "waiting"] as const;

export const nodeIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/u, "Use 1–40 lowercase letters, digits or hyphens");

export const sectionSchema = line(60);

const optionsSchema = z.array(line(80)).min(1).max(4);

export const nodeViewsSchema = z
  .object({
    overview: text(32000).optional(),
    evidence: text(32000).optional(),
    sources: text(32000).optional(),
  })
  .strict();

export type NodeViews = z.infer<typeof nodeViewsSchema>;

export const nodeExtrasSchema = z
  .object({
    conversation: z.object({ id: nodeIdSchema }).strict().nullable().optional(),
    width: z.number().finite().min(240).max(1600).nullable().optional(),
    views: nodeViewsSchema.nullable().optional(),
    binding: nodeBindingSchema.nullable().optional(),
    evidence: z
      .object({
        sourceIds: z.array(sourceIdSchema).max(50),
        revisions: z.record(sourceIdSchema, z.number().int().nonnegative()),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export const nodeFieldsSchema = z
  .object({
    ...nodeExtrasSchema.shape,
    title: line(120).optional(),
    body: text(8000).optional(),
    section: sectionSchema.optional(),
    tone: z.enum(nodeTones).optional(),
    pinned: z.boolean().optional(),
    wide: z.boolean().optional(),
    href: line(2000)
      .refine(
        (value) => webAddress.test(value) || localPath.test(value),
        "Use an HTTPS URL, an absolute path or a workspace-relative path",
      )
      .optional(),
    language: line(32).optional(),
    html: text(32000).optional(),
    options: optionsSchema.optional(),
    recommended: line(80).optional(),
    progress: z.number().min(0).max(1).optional(),
    state: z.enum(statusStates).optional(),
  })
  .strict();

export type NodeFields = z.output<typeof nodeFieldsSchema>;

export const nodeInputSchema = nodeFieldsSchema
  .extend({
    id: nodeIdSchema.optional(),
    kind: z.enum(nodeKinds),
    after: nodeIdSchema.optional(),
  })
  .strict()
  .superRefine((node, context) => {
    if (node.kind === "decision" && (node.title === undefined || node.options === undefined))
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "A decision node needs a title (the question) and 1–4 options",
      });

    if (node.recommended !== undefined && !node.options?.includes(node.recommended))
      context.addIssue({
        code: "custom",
        path: ["recommended"],
        message: "The recommended answer must be one of the options",
      });

    if (node.kind === "html" && node.html === undefined)
      context.addIssue({ code: "custom", path: ["html"], message: "An html node needs html" });

    if ((node.kind === "file" || node.kind === "link") && node.href === undefined)
      context.addIssue({
        code: "custom",
        path: ["href"],
        message: "File and link nodes need an href",
      });

    if (node.kind === "image" || node.kind === "video")
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "Add images and videos with canvas_image so the file is stored with the board",
      });
  });

export type NodeInput = z.input<typeof nodeInputSchema>;

export const addInputSchema = z.object({ nodes: z.array(nodeInputSchema).min(1).max(20) }).strict();

export const updateInputSchema = nodeFieldsSchema
  .extend({ id: nodeIdSchema })
  .strict()
  .refine((input) => Object.keys(input).length > 1, "Name at least one field to change");

export type UpdateInput = z.output<typeof updateInputSchema>;

export const linkInputSchema = z
  .object({
    from: nodeIdSchema,
    to: nodeIdSchema,
    label: line(60).optional(),
    remove: z.boolean().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export const archiveInputSchema = z.object({ ids: z.array(nodeIdSchema).min(1).max(50) }).strict();

export const verifyInputSchema = z
  .object({ id: z.string().min(1).max(40).optional(), island: nodeIdSchema.optional() })
  .strict()
  .refine(
    (input) => (input.id === undefined) !== (input.island === undefined),
    "Name either a module id or an island",
  );

export const imageInputSchema = z
  .object({
    path: line(2000),
    id: nodeIdSchema.optional(),
    title: line(120).optional(),
    body: text(2000).optional(),
    section: sectionSchema.optional(),
    wide: z.boolean().optional(),
    after: nodeIdSchema.optional(),
  })
  .strict();

export const canvasNodeSchema = z.object({
  ...nodeExtrasSchema.shape,
  id: nodeIdSchema,
  kind: z.enum(nodeKinds),
  order: z.number(),
  section: z.string(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  tone: z.enum(nodeTones),
  pinned: z.boolean(),
  wide: z.boolean(),
  href: z.string().nullable(),
  language: z.string().nullable(),
  html: z.string().nullable(),
  options: z.array(z.string()),
  recommended: z.string().nullable(),
  progress: z.number().nullable(),
  state: z.enum(statusStates).nullable(),
  assetId: z.string().nullable(),
  position: z.object({ x: z.number(), y: z.number() }).nullable(),
  createdRevision: z.number().int(),
  updatedRevision: z.number().int(),
  updatedAt: z.number(),
});

export type CanvasNode = z.infer<typeof canvasNodeSchema>;

export const mutationActorSchema = z.enum(["human", "agent", "system"]);

export type MutationActor = z.infer<typeof mutationActorSchema>;

export const fieldVersionsSchema = z.record(z.string(), z.number().int().nonnegative());

export const mutationResultSchema = z.object({
  revision: z.number().int().nonnegative(),
  changeId: z.string().nullable(),
});

export type MutationResult = z.infer<typeof mutationResultSchema>;

export const nodeInspectionSchema = z.object({
  node: canvasNodeSchema,
  boardRevision: z.number().int().nonnegative(),
  fieldVersions: fieldVersionsSchema,
});

export type NodeInspection = z.infer<typeof nodeInspectionSchema>;

export const editInputSchema = z
  .object({
    id: nodeIdSchema,
    fields: nodeFieldsSchema,
    expectedVersions: fieldVersionsSchema,
    label: line(160).optional(),
  })
  .strict();

export type EditInput = z.infer<typeof editInputSchema>;

export const historyFieldSchema = z.object({
  target: z.string(),
  field: z.string(),
  before: z.json(),
  after: z.json(),
});

export const historyEntrySchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  actor: mutationActorSchema,
  label: z.string(),
  createdAt: z.number(),
  state: z.enum(["applied", "undone"]),
  fields: z.array(historyFieldSchema),
  lastAction: z.enum(["edit", "undo", "redo"]),
  lastActor: mutationActorSchema,
  lastActivityAt: z.number(),
});

export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const historySchema = z.object({
  entries: z.array(historyEntrySchema),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
});

export type CanvasHistory = z.infer<typeof historySchema>;

export const historySummaryEntrySchema = historyEntrySchema.omit({ fields: true }).extend({
  fieldCount: z.number().int().nonnegative(),
  targets: z.array(z.string()),
});

export type HistorySummaryEntry = z.infer<typeof historySummaryEntrySchema>;

export const historySummarySchema = z.object({
  entries: z.array(historySummaryEntrySchema).max(200),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  total: z.number().int().nonnegative(),
});

export type HistorySummary = z.infer<typeof historySummarySchema>;

export const canvasEdgeSchema = z.object({
  from: nodeIdSchema,
  to: nodeIdSchema,
  label: z.string().nullable(),
});

export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;

const flowWeightSchema = z.number().finite().min(0.25).max(8).optional();

const flowSpanSchema = z.number().int().min(1).max(6).optional();

export const flowEmphasisSchema = z.enum(["lead", "normal", "quiet"]);

export const flowKinds = ["row", "column", "wrap", "bento"] as const;

export const islandAccents = ["neutral", "blue", "teal", "violet", "rose", "amber"] as const;

export type IslandAccent = (typeof islandAccents)[number];

export const islandSurfaces = ["soft", "none"] as const;

export const islandSchema = z
  .object({
    title: line(60),
    question: line(160).optional(),
    accent: z.enum(islandAccents).optional(),
    surface: z.enum(islandSurfaces).optional(),
    offset: z
      .object({
        x: z.number().finite().min(-20000).max(20000),
        y: z.number().finite().min(-20000).max(20000),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Island = z.infer<typeof islandSchema>;

export const bentoColumns = 3;

export const flowLeafSchema = z
  .object({
    node: nodeIdSchema,
    weight: flowWeightSchema,
    span: flowSpanSchema,
    emphasis: flowEmphasisSchema.optional(),
  })
  .strict();

export type FlowLeaf = z.infer<typeof flowLeafSchema>;

export interface FlowGroup {
  id?: string;
  flow: (typeof flowKinds)[number];
  children: FlowItem[];
  gap?: number;
  weight?: number;
  span?: number;
  minWidth?: number;
  columns?: number;
  island?: Island;
}

export type FlowItem = FlowLeaf | FlowGroup;

export interface IslandGroup extends FlowGroup {
  id: string;
  island: Island;
}

export function isIsland(item: FlowItem): item is IslandGroup {
  return "flow" in item && item.island !== undefined && item.id !== undefined;
}

function flowSchema(depth: number): z.ZodType<FlowItem> {
  if (depth === 8) return flowLeafSchema;

  return z.union([
    flowLeafSchema,
    z
      .object({
        id: nodeIdSchema.optional(),
        flow: z.enum(flowKinds),
        children: z
          .array(flowSchema(depth + 1))
          .min(1)
          .max(200),
        gap: z.number().finite().min(0).max(120).optional(),
        weight: flowWeightSchema,
        span: flowSpanSchema,
        minWidth: z.number().finite().min(160).max(1200).optional(),
        columns: z.number().int().min(1).max(6).optional(),
        island: islandSchema.optional(),
      })
      .strict(),
  ]);
}

export function flowIssues(root: FlowItem, rootMayBeIsland = false): string[] {
  const issues: string[] = [];
  const groupIds = new Set<string>();
  let count = 0;
  let islands = 0;

  function visit(item: FlowItem, parent: FlowGroup | null, insideIsland: boolean) {
    count += 1;

    if (count > 400) return;

    if (parent?.flow === "bento") {
      if (item.weight !== undefined)
        issues.push("Use span, not weight, for children of a bento group");

      if (item.span !== undefined && item.span > (parent.columns ?? bentoColumns))
        issues.push(`A span of ${item.span} exceeds its bento group's columns`);
    } else if (item.span !== undefined)
      issues.push("span applies only to children of a bento group");

    if ("node" in item) return;

    if (item.id !== undefined) {
      if (groupIds.has(item.id)) issues.push("Flow group ids must be unique");
      groupIds.add(item.id);
    }

    if (item.columns !== undefined && item.flow !== "bento")
      issues.push("columns applies only to bento groups");

    if (item.island !== undefined) {
      islands += 1;

      if (item.id === undefined) issues.push("An island needs a stable id");

      if (insideIsland) issues.push("Islands cannot contain other islands");

      if (parent === null && !rootMayBeIsland)
        issues.push("The root arranges islands; wrap islands in a root group");
    }

    for (const child of item.children)
      visit(child, item, insideIsland || item.island !== undefined);
  }

  visit(root, null, false);

  if (count > 400) issues.push("Use at most 400 flow items");

  if (islands > 24) issues.push("Use at most 24 islands");

  return [...new Set(issues)];
}

const boundedFlowSchema = flowSchema(1)
  .refine((item) => "flow" in item, "The flow root must be a group")
  .superRefine((root, context) => {
    for (const message of flowIssues(root)) context.addIssue({ code: "custom", message });
  });

export const islandGroupSchema = flowSchema(1).superRefine((item, context) => {
  if (!isIsland(item)) {
    context.addIssue({ code: "custom", message: "Supply one group with an id and island" });

    return;
  }

  for (const message of flowIssues(item, true)) context.addIssue({ code: "custom", message });
});

export function flowLeaves(root: FlowItem): FlowLeaf[] {
  return "node" in root ? [root] : root.children.flatMap(flowLeaves);
}

export const compositionSchema = z
  .object({
    width: z.number().finite().min(480).max(4000),
    root: boundedFlowSchema,
  })
  .strict()
  .superRefine((composition, context) => {
    const leaves = flowLeaves(composition.root);

    if (leaves.length > 200 || new Set(leaves.map((leaf) => leaf.node)).size !== leaves.length)
      context.addIssue({ code: "custom", message: "Reference at most 200 nodes, each only once" });
  });

export type Composition = z.infer<typeof compositionSchema>;

export const composeInputSchema = z
  .object({
    composition: compositionSchema.nullable().optional(),
    island: islandGroupSchema.optional(),
    after: nodeIdSchema.optional(),
    resetPositions: z.boolean().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ComposeInput = z.infer<typeof composeInputSchema>;

export const composeResultSchema = mutationResultSchema.extend({
  notes: z.array(z.string()),
});

export const boardSchema = z.object({
  threadId: z.string(),
  revision: z.number().int().nonnegative(),
  seenRevision: z.number().int().nonnegative(),
  sections: z.array(z.string()),
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
  composition: compositionSchema.nullable().optional(),
});

export type Board = z.infer<typeof boardSchema>;

const threadInput = boardAddressSchema;

export const starters = ["user", "agent"] as const;

export type Starter = (typeof starters)[number];

export const modeSchema = z.object({
  canvas: z.boolean(),
  unseen: z.boolean(),
  startedBy: z.enum(starters).nullable(),
  movedTo: z.string().nullable().default(null),
});

export type CanvasMode = z.infer<typeof modeSchema>;

export const rpcContract = defineRpcContract({
  ...workspaceRpc,
  ...projectRpc,
  "project.chat.changes": {
    input: z.object({ projectId: z.string(), threadId: z.string() }),
    output: z.array(z.object({ sectionId: z.string(), nodeId: z.string(), changeId: z.string() })),
  },
  "project.unseen": {
    input: z.object({ projectId: z.string().min(1) }),
    output: z.object({ sectionIds: z.array(z.string()) }),
  },
  "project.actions": {
    input: z.object({ threadIds: z.array(z.string().min(1)).max(200) }),
    output: z.array(
      z.object({
        threadId: z.string(),
        projectId: z.string(),
        boardTitle: z.string().nullable(),
        link: z.object({ sectionId: z.string().nullable(), chat: z.boolean() }).nullable(),
      }),
    ),
  },
  "project.view.resolve": {
    input: z.object({ viewId: z.string().min(1), projectId: z.string().min(1).optional() }),
    output: z.object({ projectId: z.string(), viewId: z.string() }).nullable(),
  },
  "project.link": {
    input: z.object({ threadId: z.string().min(1) }),
    output: z
      .object({ projectId: z.string(), sectionId: z.string(), title: z.string() })
      .nullable(),
  },
  "project.boards": {
    input: z.object({ projectId: z.string().min(1) }),
    output: z.array(
      z.object({
        threadId: z.string(),
        title: z.string(),
        nodeCount: z.number(),
        updatedAt: z.number(),
      }),
    ),
  },
  "project.boardProject": {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ projectId: z.string() }),
  },
  "project.info": {
    input: z.object({ projectId: z.string().min(1) }),
    output: z.object({ name: z.string() }),
  },
  "mode.get": { input: threadInput, output: modeSchema },
  "mode.off": { input: threadInput, output: modeSchema },
  "workspace.get": {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ environmentId: z.string().nullable(), hostId: z.string().nullable() }),
  },
  "board.get": {
    input: threadInput,
    output: z.object({ board: boardSchema.nullable() }),
  },
  "board.compose": {
    input: threadInput.safeExtend(composeInputSchema.shape),
    output: composeResultSchema,
  },
  "board.markSeen": {
    input: threadInput.safeExtend({ revision: z.number().int().nonnegative() }),
    output: z.object({ seenRevision: z.number().int().nonnegative() }),
  },
  "node.add": {
    input: threadInput.safeExtend(addInputSchema.shape),
    output: mutationResultSchema.extend({ added: z.array(nodeIdSchema) }),
  },
  "node.duplicate": {
    input: threadInput.safeExtend({ id: nodeIdSchema }),
    output: mutationResultSchema.extend({ id: nodeIdSchema }),
  },
  "node.inspect": {
    input: threadInput.safeExtend({ id: nodeIdSchema }),
    output: nodeInspectionSchema,
  },
  "node.edit": {
    input: threadInput.safeExtend(editInputSchema.shape),
    output: mutationResultSchema,
  },
  "board.link": {
    input: threadInput.safeExtend(linkInputSchema.shape),
    output: mutationResultSchema,
  },
  "board.history": { input: threadInput, output: historySchema },
  "board.historySummary": {
    input: threadInput.safeExtend({
      limit: z.number().int().min(1).max(200).default(20),
      offset: z.number().int().min(0).max(200).default(0),
    }),
    output: historySummarySchema,
  },
  "board.historyDetail": {
    input: threadInput.safeExtend({ changeId: z.string().min(1) }),
    output: historyEntrySchema,
  },
  "board.undo": {
    input: threadInput.safeExtend({ changeId: z.string().optional() }),
    output: mutationResultSchema,
  },
  "board.redo": {
    input: threadInput.safeExtend({ changeId: z.string().optional() }),
    output: mutationResultSchema,
  },
  "node.move": {
    input: threadInput.safeExtend({
      id: nodeIdSchema,
      position: z.object({ x: z.number().finite(), y: z.number().finite() }).nullable(),
    }),
    output: mutationResultSchema,
  },
  "node.pin": {
    input: threadInput.safeExtend({ id: nodeIdSchema, pinned: z.boolean() }),
    output: mutationResultSchema,
  },
  "node.archive": {
    input: threadInput.safeExtend({ id: nodeIdSchema }),
    output: mutationResultSchema,
  },
});

export type CanvasRpcContract = typeof rpcContract;

export const realtimeChannel = "canvas.changed";

export const realtimePayloadSchema = z.object({
  threadId: z.string(),
  revision: z.number().int(),
});

export const mentionProvider = { provider: "mode", id: "canvas", label: "Canvas" } as const;

export const nodeMentionProvider = "node";

export function nodeMentionItem(threadId: string, nodeId: string): string {
  return `${threadId}.${nodeId}`;
}

export function parseNodeMentionItem(itemId: string) {
  const separator = itemId.lastIndexOf(".");

  return { threadId: itemId.slice(0, separator), nodeId: itemId.slice(separator + 1) };
}

export const toolNames = {
  add: "canvas_add",
  update: "canvas_update",
  link: "canvas_link",
  archive: "canvas_archive",
  show: "canvas_show",
  image: "canvas_image",
  compose: "canvas_compose",
  inspect: "canvas_inspect",
  edit: "canvas_edit",
  verify: "canvas_verify",
  history: "canvas_history",
  undo: "canvas_undo",
  redo: "canvas_redo",
  sources: "canvas_sources",
  source: "canvas_source",
  refresh: "canvas_refresh",
  data: "canvas_data",
  dataset: "canvas_dataset",
  credential: "canvas_source_credential",
} as const;
