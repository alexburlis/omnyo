import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

const id = z.string().min(1).max(128);

const target = z.strictObject({ projectId: id, importId: id });

export const openSeoSite = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
  );

const siteTarget = target.extend({ site: openSeoSite });

export const openSeoConnection = z.strictObject({
  site: openSeoSite,
  openSeoProjectId: id,
});

const connectionTarget = target.extend(openSeoConnection.shape);

const status = z.strictObject({
  kind: z.enum(["disconnected", "connected", "expired"]),
  keyConfigured: z.boolean(),
  connection: openSeoConnection.nullable(),
});

const problem = z.strictObject({
  kind: z.enum([
    "disconnected",
    "expired",
    "empty",
    "failed",
    "budget-blocked",
  ]),
});

const project = z.strictObject({
  id,
  name: z.string().max(256),
  site: openSeoSite,
});

export const openSeoKeyword = z.strictObject({
  id,
  keyword: z.string().min(1).max(500),
  intent: z.string().max(100).nullable(),
  volume: z.int().nonnegative().nullable(),
});

const retrievedAt = z.iso.datetime();

export const workflowSourceSelection = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("notes") }),
  z.strictObject({
    kind: z.literal("openseo"),
    readId: z.uuid(),
    keywordIds: z
      .array(id)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
]);

export const workflowSourceSnapshot = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("notes") }),
  z.strictObject({
    kind: z.literal("openseo"),
    site: openSeoSite,
    retrievedAt,
    keywords: z.array(openSeoKeyword).min(1).max(50),
  }),
]);

export const openSeoRpcContract = defineRpcContract({
  workflow_openseo_status: { input: target, output: status },
  workflow_openseo_disconnect: { input: target, output: status },
  workflow_openseo_connect: {
    input: connectionTarget,
    output: z.strictObject({
      kind: z.enum([
        "connected",
        "disconnected",
        "expired",
        "failed",
        "budget-blocked",
      ]),
    }),
  },
  workflow_openseo_projects: {
    input: siteTarget,
    output: z.discriminatedUnion("kind", [
      problem,
      z.strictObject({
        kind: z.literal("ready"),
        projects: z.array(project).max(100),
      }),
    ]),
  },
  workflow_openseo_keywords: {
    input: connectionTarget,
    output: z.discriminatedUnion("kind", [
      problem,
      z.strictObject({
        kind: z.literal("ready"),
        readId: z.uuid(),
        retrievedAt,
        keywords: z.array(openSeoKeyword).max(50),
      }),
    ]),
  },
});
