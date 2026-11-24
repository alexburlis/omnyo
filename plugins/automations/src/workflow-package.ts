import { z } from "zod";

export const WORKFLOW_PACKAGE_MAX_BYTES = 256 * 1024;

export const WORKFLOW_SHARE_ID = /^[a-f0-9]{32}$/;

export const WORKFLOW_RELAY_ORIGIN = "https://omnyo.link";

const utf8 = new TextEncoder();

const unicode = z.string().refine((value) => !/[\uD800-\uDFFF]/u.test(value));

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

const title = z.string().min(1).max(160).and(unicode);

const prose = z.string().max(8192).and(unicode);

const prompt = z.string().min(1).max(32000).and(unicode);

const digest = z.string().regex(/^[a-f0-9]{64}$/);

const timestamp = z.iso.datetime({ offset: true });

const timezone = z
  .string()
  .max(80)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });

      return !/^[+-]/.test(value);
    } catch {
      return false;
    }
  });

const input = z.discriminatedUnion("type", [
  z.strictObject({
    id,
    label: title,
    type: z.literal("text"),
    default: prose.optional(),
  }),
  z.strictObject({
    id,
    label: title,
    type: z.literal("integer"),
    default: z.int().min(1).max(50).optional(),
  }),
  z.strictObject({
    id,
    label: title,
    type: z.literal("boolean"),
    default: z.boolean().optional(),
  }),
  z.strictObject({
    id,
    label: title,
    type: z.literal("timezone"),
    default: timezone.optional(),
  }),
]);

const trigger = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual") }),
  z.strictObject({ kind: z.literal("once"), at: timestamp }),
  z.strictObject({
    kind: z.literal("schedule"),
    cron: z.string().min(1).max(100).and(unicode),
    timezone,
  }),
  z.strictObject({
    kind: z.literal("weekly"),
    timezone,
    weekday: z.int().min(0).max(6),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  }),
]);

const step = z.discriminatedUnion("kind", [
  z.strictObject({ id, kind: z.literal("model"), prompt, nextStepId: id }),
  z.strictObject({
    id,
    kind: z.literal("validate-text"),
    maxBytes: z.int().min(0).max(65536),
    nextStepId: id,
    failureStepId: id,
  }),
  z.strictObject({
    id,
    kind: z.literal("decision"),
    operand: z.enum(["equals", "contains"]),
    value: z.string().max(65536).and(unicode),
    nextStepId: id,
    otherwiseStepId: id,
  }),
  z.strictObject({ id, kind: z.literal("export") }),
]);

const graph = z.discriminatedUnion("engine", [
  z.strictObject({
    kind: z.literal("graph"),
    engine: z.literal("restricted"),
    startStepId: id,
    steps: z.array(step).min(1).max(32),
  }),
  z.strictObject({
    kind: z.literal("graph"),
    engine: z.literal("weekly-content-feed"),
    targetCount: z.int().min(1).max(7),
    maxCandidates: z.int().min(1).max(28),
    writer: z.strictObject({ prompt }),
    reviewer: z.strictObject({ prompt }),
  }),
]);

const skill = z.strictObject({
  id: z
    .string()
    .max(128)
    .regex(/^[a-z][a-z0-9-]{0,63}\.[a-z][a-z0-9-]{0,63}$/),
  title,
  body: prompt.refine(
    (value) =>
      !/^\s*(?:---(?:\s|$)|(?:hooks|allowed-tools|context|agent|mode|command)\s*:)/im.test(
        value,
      ) && !/!\x60|\$\(|\x00/.test(value),
  ),
});

export const workflowPackageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  templateId: id.optional(),
  revision: z.int().positive(),
  parentPackageDigest: digest.optional(),
  title,
  description: prose,
  senderLabel: title.optional(),
  inputs: z.array(input).max(32),
  trigger,
  flow: z.union([
    z.strictObject({ kind: z.literal("prompt"), prompt }),
    z.strictObject({
      kind: z.literal("script-requirement"),
      description: title,
    }),
    graph,
  ]),
  skills: z.array(skill).max(16),
  layout: z
    .array(
      z.strictObject({
        stepId: id,
        x: z.number().min(-100_000).max(100_000),
        y: z.number().min(-100_000).max(100_000),
      }),
    )
    .max(32)
    .optional(),
});

export type WorkflowPackageV1 = z.infer<typeof workflowPackageSchema>;

export type WorkflowCapability =
  | "model-text"
  | "write-run-artifacts"
  | "replace-script-requirement";

function assertJsonLimits(source: string): void {
  const containers: (Set<string> | null)[] = [];

  for (const match of source.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/gs)) {
    const token = match[0];

    if (token === "{" || token === "[") {
      if (containers.length === 16)
        throw new Error("Workflow package nesting exceeds 16 levels.");
      containers.push(token === "{" ? new Set() : null);
      continue;
    }

    if (token === "}" || token === "]") {
      containers.pop();
      continue;
    }

    const members = containers.at(-1);

    if (!members) continue;
    let end = match.index + token.length;

    while (/[ \t\r\n]/.test(source.charAt(end))) end += 1;

    if (source.charAt(end) !== ":") continue;
    const key: string = JSON.parse(token);

    if (members.has(key))
      throw new Error("Workflow package has a duplicate JSON key.");
    members.add(key);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";

  const members = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  return (
    "{" +
    members
      .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
      .join(",") +
    "}"
  );
}

export async function workflowDigest(
  value: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", value);

  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function unique(keys: readonly string[]): boolean {
  return new Set(keys).size === keys.length;
}

function checkReferences(pkg: WorkflowPackageV1): void {
  if (
    !unique(pkg.inputs.map(({ id }) => id)) ||
    !unique(pkg.skills.map(({ id }) => id))
  ) {
    throw new Error("Workflow input and skill identifiers must be unique.");
  }

  const { flow, layout = [] } = pkg;

  if (
    flow.kind === "graph" &&
    flow.engine === "weekly-content-feed" &&
    flow.maxCandidates < flow.targetCount
  ) {
    throw new Error("The weekly candidate limit must cover the target count.");
  }

  if (flow.kind !== "graph" || flow.engine !== "restricted") {
    if (layout.length)
      throw new Error("Workflow layout refers to nonexistent graph steps.");

    return;
  }

  const steps = new Map(flow.steps.map((node) => [node.id, node]));

  if (
    steps.size !== flow.steps.length ||
    !unique(layout.map(({ stepId }) => stepId)) ||
    layout.some(({ stepId }) => !steps.has(stepId))
  ) {
    throw new Error(
      "Workflow graph has duplicate or invalid step identifiers.",
    );
  }

  const reached = new Set<string>();
  const seen = new Set<string>();
  const visiting = new Set<string>();

  function visit(next: string, hasText: boolean) {
    const node = steps.get(next);

    if (!node || visiting.has(next))
      throw new Error(
        "Every workflow branch must reach an export step through a finite path.",
      );

    if (
      !hasText &&
      (node.kind === "validate-text" || node.kind === "decision")
    ) {
      throw new Error(
        "A workflow must produce model text before validating or branching on it.",
      );
    }

    const key = next + ":" + hasText;

    if (seen.has(key)) return;
    visiting.add(next);
    reached.add(next);

    if (node.kind !== "export")
      visit(node.nextStepId, hasText || node.kind === "model");

    if (node.kind === "validate-text") visit(node.failureStepId, hasText);

    if (node.kind === "decision") visit(node.otherwiseStepId, hasText);
    visiting.delete(next);
    seen.add(key);
  }

  visit(flow.startStepId, false);

  if (reached.size !== steps.size)
    throw new Error("Workflow graph contains unreachable steps.");
}

export async function inspectWorkflowPackage(bytes: Uint8Array) {
  if (bytes.byteLength === 0 || bytes.byteLength > WORKFLOW_PACKAGE_MAX_BYTES) {
    throw new Error(
      "Workflow packages must contain at most 256 KiB of UTF-8 JSON.",
    );
  }

  const source = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);

  assertJsonLimits(source);
  const decoded: unknown = JSON.parse(source);
  const checked = workflowPackageSchema.safeParse(decoded);

  if (!checked.success) {
    throw new Error(
      "Unsupported or invalid workflow package at " +
        (checked.error.issues[0]?.path.join(".") || "document") +
        ".",
    );
  }

  const pkg = checked.data;
  checkReferences(pkg);
  const canonicalBytes = utf8.encode(canonical(pkg));

  if (canonicalBytes.byteLength > WORKFLOW_PACKAGE_MAX_BYTES) {
    throw new Error("Normalized workflow package exceeds 256 KiB.");
  }

  const { schemaVersion, inputs, trigger, flow, skills } = pkg;

  const executionBytes = utf8.encode(
    canonical({
      schemaVersion,
      inputs: inputs.map(({ label: _, ...definition }) => definition),
      trigger,
      flow,
      skills: skills.map(({ id, body }) => ({ id, body })),
    }),
  );

  const [packageDigest, executionDigest] = await Promise.all([
    workflowDigest(canonicalBytes),
    workflowDigest(executionBytes),
  ]);

  const capabilities: WorkflowCapability[] =
    flow.kind === "script-requirement"
      ? ["replace-script-requirement"]
      : ["model-text", "write-run-artifacts"];

  return {
    package: pkg,
    canonicalBytes,
    packageDigest,
    executionDigest,
    capabilities,
  };
}
