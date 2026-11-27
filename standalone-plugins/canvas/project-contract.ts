import { z } from "zod";

export const boardKeySchema = z.string().min(1).max(200);

export type BoardKey = z.infer<typeof boardKeySchema>;

import { boardReferenceSchema } from "./board-contract.ts";

export { boardReferenceSchema };

export type BoardReference = z.infer<typeof boardReferenceSchema>;

export const projectRealtimeChannel = "canvas.project.changed";

export const coordinateSchema = z.number().finite().min(-1000000).max(1000000);

export const projectRectSchema = z.object({
  x: coordinateSchema,
  y: coordinateSchema,
  width: z.number().positive().max(2000000),
  height: z.number().positive().max(2000000),
});

const titleSchema = z.string().trim().min(1).max(200);

const idSchema = z.string().min(1).max(200);

export const projectActorSchema = z.enum(["human", "agent", "system"]);

export const projectSectionSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  title: titleSchema,
  question: z.string().nullable(),
  x: coordinateSchema,
  y: coordinateSchema,
  order: z.number(),
  locked: z.boolean(),
  archivedAt: z.number().nullable(),
  originThreadId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.number(),
});

export const viewAnchorKindSchema = z.enum(["section", "island", "node", "chat", "free"]);

export const projectViewSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  title: titleSchema,
  order: z.number(),
  anchorKind: viewAnchorKindSchema,
  regionId: z.string().nullable(),
  anchorId: z.string().nullable(),
  rect: projectRectSchema,
  createdBy: z.string(),
  createdAt: z.number(),
});

export const projectChatSchema = z.object({
  threadId: idSchema,
  projectId: idSchema,
  regionId: z.string().nullable(),
  anchorKind: viewAnchorKindSchema,
  anchorId: z.string().nullable(),
  x: coordinateSchema,
  y: coordinateSchema,
  role: z.enum(["spawned", "origin", "joined"]),
  state: z.enum(["open", "resolved"]),
  createdAt: z.number(),
});

export const projectCanvasSchema = z.object({
  projectId: idSchema,
  revision: z.number().int().nonnegative(),
  homeViewId: z.string().nullable(),
  archivedAt: z.number().nullable(),
  sections: z.array(projectSectionSchema),
  views: z.array(projectViewSchema),
  chats: z.array(projectChatSchema),
});

export const projectMutationSchema = z.object({
  projectId: idSchema,
  actor: projectActorSchema.optional(),
  actingThreadId: idSchema.optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
});

export const projectSectionCreateSchema = projectMutationSchema.extend({
  title: titleSchema,
  question: z.string().max(500).nullable().optional(),
  x: coordinateSchema.optional(),
  y: coordinateSchema.optional(),
});

export const projectSectionUpdateSchema = projectMutationSchema.extend({
  sectionId: idSchema,
  title: titleSchema.optional(),
  question: z.string().max(500).nullable().optional(),
  x: coordinateSchema.optional(),
  y: coordinateSchema.optional(),
  locked: z.boolean().optional(),
  order: z.number().finite().optional(),
});

export const projectSectionActionSchema = projectMutationSchema.extend({ sectionId: idSchema });

export const projectAdoptSchema = projectMutationSchema.extend({
  threadId: idSchema,
  title: titleSchema,
});

export const projectViewPutSchema = projectMutationSchema.extend({
  id: idSchema.optional(),
  title: titleSchema,
  anchorKind: viewAnchorKindSchema,
  regionId: idSchema.nullable().optional(),
  anchorId: idSchema.nullable().optional(),
  rect: projectRectSchema,
});

export const projectChatPutSchema = projectMutationSchema.extend({
  threadId: idSchema,
  regionId: idSchema.nullable().optional(),
  anchorKind: viewAnchorKindSchema,
  anchorId: idSchema.nullable().optional(),
  x: coordinateSchema,
  y: coordinateSchema,
  role: z.enum(["spawned", "origin", "joined"]).optional(),
  state: z.enum(["open", "resolved"]).optional(),
});

export type ProjectCanvas = z.infer<typeof projectCanvasSchema>;

export type ProjectSection = z.infer<typeof projectSectionSchema>;

export type ProjectView = z.infer<typeof projectViewSchema>;

export type ProjectChat = z.infer<typeof projectChatSchema>;

export type ProjectMutation = z.infer<typeof projectMutationSchema>;

const projectReadSchema = z.object({ projectId: idSchema });

export const projectViewRemoveSchema = projectMutationSchema.extend({ id: idSchema });

export const projectViewReorderSchema = projectMutationSchema.extend({
  ids: z.array(idSchema).max(300),
});

export const projectChatMoveSchema = projectMutationSchema.extend({
  threadId: idSchema,
  regionId: idSchema.nullable(),
  anchorKind: viewAnchorKindSchema,
  anchorId: idSchema.nullable().optional(),
  x: coordinateSchema,
  y: coordinateSchema,
});

export const projectChatResolveSchema = projectMutationSchema.extend({
  threadId: idSchema,
  resolved: z.boolean().optional(),
});

export const projectJoinSchema = projectMutationSchema.extend({
  threadId: idSchema,
  sectionId: idSchema.optional(),
});

export const projectUndoSchema = projectMutationSchema.extend({ changeId: idSchema.optional() });

export const projectJournalEntrySchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  actor: z.string(),
  label: z.string(),
  createdAt: z.number(),
  state: z.enum(["applied", "undone"]),
});

export const projectRpc = {
  "project.get": { input: projectReadSchema, output: projectCanvasSchema },
  "project.section.create": {
    input: projectSectionCreateSchema,
    output: projectCanvasSchema,
  },
  "project.section.update": {
    input: projectSectionUpdateSchema,
    output: projectCanvasSchema,
  },
  "project.section.move": {
    input: projectSectionUpdateSchema,
    output: projectCanvasSchema,
  },
  "project.section.archive": {
    input: projectSectionActionSchema,
    output: projectCanvasSchema,
  },
  "project.section.restore": {
    input: projectSectionActionSchema,
    output: projectCanvasSchema,
  },
  "project.view.put": {
    input: projectViewPutSchema,
    output: projectCanvasSchema,
  },
  "project.view.remove": {
    input: projectViewRemoveSchema,
    output: projectCanvasSchema,
  },
  "project.view.reorder": {
    input: projectViewReorderSchema,
    output: projectCanvasSchema,
  },
  "project.view.home": {
    input: projectViewRemoveSchema,
    output: projectCanvasSchema,
  },
  "project.chat.put": {
    input: projectChatPutSchema,
    output: projectCanvasSchema,
  },
  "project.chat.move": {
    input: projectChatMoveSchema,
    output: projectCanvasSchema,
  },
  "project.chat.resolve": {
    input: projectChatResolveSchema,
    output: projectCanvasSchema,
  },
  "project.adopt": { input: projectAdoptSchema, output: projectCanvasSchema },
  "project.return": {
    input: projectSectionActionSchema,
    output: projectCanvasSchema,
  },
  "project.join": { input: projectJoinSchema, output: projectCanvasSchema },
  "project.journal": {
    input: projectReadSchema.extend({
      revisions: z.array(z.number().int().nonnegative()).min(1).max(201).optional(),
    }),
    output: z.array(projectJournalEntrySchema),
  },
  "project.undo": { input: projectUndoSchema, output: projectCanvasSchema },
  "project.redo": { input: projectUndoSchema, output: projectCanvasSchema },
};
