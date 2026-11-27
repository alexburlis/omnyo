import { z } from "zod";

const label = z.string().trim().min(1).max(120);

export const sourceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/u);

export const sourceRealtimeChannel = "canvas.sources.changed";

export const sourceProviders = ["manual", "json", "mcp", "gsc", "posthog", "cloudflare"] as const;

export const cloudflareGraphqlUrl = "https://api.cloudflare.com/client/v4/graphql";

export const cloudflareVariableNames = ["zoneTag", "start", "end", "startDate", "endDate"] as const;

const cloudflareVariables = new Set<string>(cloudflareVariableNames);

export const sourceSlots = ["apiToken1", "apiToken2", "posthogToken"] as const;

export const sourceSlotSchema = z.enum(sourceSlots);

export const columnSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(120)
      .refine(
        (value) =>
          !["__proto__", "prototype", "constructor"].includes(value) && !/\p{Cc}/u.test(value),
      ),
    label,
    type: z.enum(["string", "number", "boolean"]),
    format: z.enum(["number", "percent"]).optional(),
  })
  .strict();

export const columnsSchema = z
  .array(columnSchema)
  .min(1)
  .max(24)
  .refine(
    (columns) => new Set(columns.map((column) => column.key)).size === columns.length,
    "Column keys must be unique",
  );

export const sourceJsonSchema = z.json();

export type SourceJson = z.infer<typeof sourceJsonSchema>;

export const scalarTypes = {
  number: z.number().finite(),
  string: z.string().max(8000),
  boolean: z.boolean(),
};

export const scalarSchema = z.union([
  z.string().max(8000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const rowsSchema = z.array(z.record(z.string(), scalarSchema)).max(2000);

export const provenanceSchema = z
  .object({
    windowLabel: z.string().max(180).optional(),
    timezone: z.string().max(80).optional(),
    cohort: z.string().max(300).optional(),
    unit: z.string().max(80).optional(),
  })
  .strict();

const pathSchema = z.array(z.string().min(1).max(120)).max(12);

const base = z.object({
  id: sourceIdSchema,
  title: label,
  intervalSeconds: z.union([z.literal(0), z.number().int().min(60).max(86400)]).default(0),
  paused: z.boolean().default(false),
  provenance: provenanceSchema.default({}),
});

const tableConfig = {
  rowsPath: pathSchema.default([]),
  columns: z
    .array(columnSchema.extend({ path: pathSchema.optional() }))
    .min(1)
    .max(24),
  credential: z.enum(["apiToken1", "apiToken2"]).optional(),
};

const jsonConfig = z.object({ url: z.url().max(2000), ...tableConfig }).strict();

export const mcpArgumentsLimit = 4096;

const mcpArgumentScalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

const mcpArgumentLeaf = z.union([mcpArgumentScalar, z.array(mcpArgumentScalar)]);

const mcpConfig = z
  .object({
    url: z.url().max(2000),
    tool: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/u),
    arguments: z
      .record(z.string(), z.union([mcpArgumentLeaf, z.record(z.string(), mcpArgumentLeaf)]))
      .refine(
        (value) => new TextEncoder().encode(JSON.stringify(value)).length <= mcpArgumentsLimit,
        "MCP tool arguments must serialize to at most 4,096 bytes",
      )
      .default({}),
    ...tableConfig,
  })
  .strict();

const gscConfig = z
  .object({
    siteUrl: z.string().min(1).max(250),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    rollingDays: z.number().int().min(1).max(90).optional(),
    lagDays: z.number().int().min(0).max(7).optional(),
    dimensions: z
      .array(z.enum(["date", "query", "page", "country", "device"]))
      .max(3)
      .default(["date"]),
    limit: z.number().int().min(1).max(1000).default(100),
  })
  .strict();

const posthogConfig = z
  .object({
    projectId: z.number().int().positive(),
    query: z.string().trim().min(1).max(12000),
  })
  .strict();

function graphqlCode(query: string): string {
  return query.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\\r\n])*"/gu, '""').replace(/#[^\r\n]*/gu, "");
}

export function graphqlVariableNames(query: string): string[] {
  return [
    ...new Set(
      [...graphqlCode(query).matchAll(/\$([A-Za-z_]\w*)/gu)].map((match) => match[1] ?? ""),
    ),
  ];
}

const cloudflareConfig = z
  .object({
    zoneTag: z.string().regex(/^[0-9a-f]{32}$/u, "Use the zone's 32-character hexadecimal ID"),
    query: z
      .string()
      .trim()
      .min(1)
      .max(12000)
      .refine((query) => {
        const code = graphqlCode(query);

        return (
          /^\s*(?:query\b|\{)/u.test(code) && !/\b(?:mutation|subscription|fragment)\b/u.test(code)
        );
      }, "Cloudflare sources accept one read-only GraphQL query")
      .refine(
        (query) => graphqlVariableNames(query).every((name) => cloudflareVariables.has(name)),
        "Cloudflare queries may use only $zoneTag, $start, $end, $startDate and $endDate",
      ),
    rollingHours: z.number().int().min(1).max(744),
    alignTo: z.enum(["minute", "hour"]).default("hour"),
    rowsPath: pathSchema.default([]),
    columns: tableConfig.columns,
    credential: z.enum(["apiToken1", "apiToken2"]),
  })
  .strict();

export const sourceInputSchema = z.discriminatedUnion("provider", [
  base
    .extend({
      provider: z.literal("manual"),
      intervalSeconds: z.literal(0).default(0),
      config: z.object({}).strict().default({}),
    })
    .strict(),
  base.extend({ provider: z.literal("json"), config: jsonConfig }).strict(),
  base.extend({ provider: z.literal("mcp"), config: mcpConfig }).strict(),
  base.extend({ provider: z.literal("gsc"), config: gscConfig }).strict(),
  base.extend({ provider: z.literal("posthog"), config: posthogConfig }).strict(),
  base.extend({ provider: z.literal("cloudflare"), config: cloudflareConfig }).strict(),
]);

export type SourceInput = z.output<typeof sourceInputSchema>;

export const datasetSchema = z
  .object({
    sourceId: sourceIdSchema,
    columns: columnsSchema,
    rows: rowsSchema,
    revision: z.number().int().nonnegative(),
    capturedAt: z.number().int().nonnegative(),
    provenance: provenanceSchema,
  })
  .strict();

export type Dataset = z.infer<typeof datasetSchema>;

export const datasetPushInputSchema = z
  .object({
    sourceId: sourceIdSchema,
    columns: columnsSchema,
    rows: rowsSchema,
    capturedAt: z.number().int().nonnegative().optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict();

export type DatasetPushInput = z.infer<typeof datasetPushInputSchema>;

export const sourceRecordSchema = z
  .object({
    definition: sourceInputSchema,
    status: z.enum(["idle", "refreshing", "ready", "error"]),
    error: z.string().max(400).nullable(),
    lastAttemptAt: z.number().nullable(),
    lastSuccessAt: z.number().nullable(),
    nextRefreshAt: z.number().nullable(),
    failures: z.number().int().nonnegative(),
  })
  .strict();

export type SourceRecord = z.infer<typeof sourceRecordSchema>;

export const sourceStateSchema = z
  .object({ source: sourceRecordSchema, dataset: datasetSchema.nullable() })
  .strict();

export type SourceState = z.infer<typeof sourceStateSchema>;

export const sourceListOutputSchema = z.object({ sources: z.array(sourceStateSchema) }).strict();

export const nodeBindingSchema = z
  .object({
    sourceId: sourceIdSchema,
    view: z.enum(["metric", "bar", "line", "table", "html"]),
    x: z.string().max(80).optional(),
    y: z.string().max(80).optional(),
    format: z.enum(["number", "percent", "currency"]).optional(),
    sources: z.array(sourceIdSchema).max(8).optional(),
  })
  .strict();

export type NodeBinding = z.infer<typeof nodeBindingSchema>;

export const sourceCredentialInputSchema = z
  .object({
    slot: sourceSlotSchema,
    reference: z
      .string()
      .regex(/^op:\/\/[^/\r\n]+\/[^\r\n]+\/[^/\r\n]+$/u)
      .max(500),
    origin: z.url().max(2000).optional(),
  })
  .strict();

export type SourceCredentialInput = z.infer<typeof sourceCredentialInputSchema>;
