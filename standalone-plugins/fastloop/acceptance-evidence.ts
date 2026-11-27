import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { JsonPayload } from "./contracts.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);

const reference = z.strictObject({ path: z.string().refine(isAbsolute), sha256: hash });

export const acceptanceIndexSchema = z.strictObject({
  schema: z.literal(1),
  brokenResult: reference,
  repairedResult: reference,
  brokenRegistry: reference,
  repairedRegistry: reference,
  nativeEvents: reference,
  checkArtifacts: z
    .array(reference.extend({ runId: z.string(), evidenceId: z.string() }))
    .min(2)
    .max(512),
});

const evidenceSchema = z.object({
  id: z.string(),
  runId: z.string(),
  relativePath: z.string(),
  sha256: hash,
  redacted: z.literal(true),
  identity: z
    .object({ sessionId: z.string(), buildGeneration: z.number().int().nonnegative() })
    .optional(),
});

const resultSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  verdict: z.enum(["FAILED", "PASSED"]),
  requirementsHash: hash,
  checksHash: hash,
  checks: z
    .array(z.object({ checkId: z.string(), status: z.string(), evidenceIds: z.array(z.string()) }))
    .min(1),
  evidence: z.array(evidenceSchema),
});

const registrySchema = z.object({
  requirementsHash: hash,
  checksHash: hash,
  requirements: z.array(z.json()).min(1),
  checks: z.array(z.object({ id: z.string(), required: z.boolean() }).catchall(z.json())).min(1),
});

export async function readEvidenceReference(ref: z.infer<typeof reference>): Promise<JsonPayload> {
  const bytes = await readFile(ref.path);

  if (bytes.length > 16 * 1024 * 1024) throw new Error("ACCEPTANCE_EVIDENCE_TOO_LARGE");

  if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256)
    throw new Error("ACCEPTANCE_EVIDENCE_DIGEST_MISMATCH");

  return z.json().parse(JSON.parse(bytes.toString("utf8")));
}

export async function validateNativeRepairEvidence(
  input: JsonPayload,
): Promise<{ brokenRunId: string; repairedRunId: string; sessionId: string }> {
  const index = acceptanceIndexSchema.parse(input);

  const [broken, repaired, brokenRegistry, repairedRegistry, eventsValue] = await Promise.all([
    readEvidenceReference(index.brokenResult).then((value) => resultSchema.parse(value)),
    readEvidenceReference(index.repairedResult).then((value) => resultSchema.parse(value)),
    readEvidenceReference(index.brokenRegistry).then((value) => registrySchema.parse(value)),
    readEvidenceReference(index.repairedRegistry).then((value) => registrySchema.parse(value)),
    readEvidenceReference(index.nativeEvents),
  ]);

  if (
    broken.verdict !== "FAILED" ||
    repaired.verdict !== "PASSED" ||
    broken.runId === repaired.runId ||
    broken.sessionId !== repaired.sessionId
  )
    throw new Error("NATIVE_REPAIR_OUTCOMES_REQUIRED");

  if (
    broken.requirementsHash !== repaired.requirementsHash ||
    broken.checksHash !== repaired.checksHash ||
    JSON.stringify(brokenRegistry) !== JSON.stringify(repairedRegistry)
  )
    throw new Error("NATIVE_REPAIR_IMMUTABLE_SCOPE_CHANGED");
  let oldGeneration = -1;

  for (const [result, registry, registryRef] of [
    [broken, brokenRegistry, index.brokenRegistry],
    [repaired, repairedRegistry, index.repairedRegistry],
  ] as const) {
    if (
      result.requirementsHash !== registry.requirementsHash ||
      result.checksHash !== registry.checksHash
    )
      throw new Error("NATIVE_REPAIR_REGISTRY_MISMATCH");

    if (
      !result.evidence.some(
        (item) =>
          item.runId === result.runId &&
          item.relativePath === "registry.json" &&
          item.sha256 === registryRef.sha256,
      )
    )
      throw new Error("NATIVE_REPAIR_REGISTRY_EVIDENCE_MISSING");
    const required = registry.checks.filter((item) => item.required);

    if (!required.length) throw new Error("NATIVE_REPAIR_REQUIRED_SCOPE_MISSING");
    const checks = required.map((spec) => result.checks.find((check) => check.checkId === spec.id));

    if (checks.some((check) => !check)) throw new Error("NATIVE_REPAIR_REQUIRED_CHECK_MISSING");

    if (result === broken && !checks.some((check) => check?.status === "FAIL"))
      throw new Error("NATIVE_BROKEN_CHECK_FAILURE_REQUIRED");

    if (result === repaired && checks.some((check) => check?.status !== "PASS"))
      throw new Error("NATIVE_REPAIRED_CHECK_PASS_REQUIRED");

    const refs = checks
      .flatMap((check) => check?.evidenceIds ?? [])
      .map((id) => result.evidence.find((item) => item.id === id));

    if (!refs.length || refs.some((ref) => !ref || ref.runId !== result.runId))
      throw new Error("NATIVE_CHECK_EVIDENCE_MISSING");

    let verifiedState = false;

    for (const ref of refs) {
      const actual = index.checkArtifacts.find(
        (item) => item.runId === result.runId && item.evidenceId === ref?.id,
      );

      if (!ref || !actual || actual.sha256 !== ref.sha256)
        throw new Error("NATIVE_CHECK_ARTIFACT_REFERENCE_MISSING");
      const bytes = await readFile(actual.path);

      if (
        bytes.length > 16 * 1024 * 1024 ||
        createHash("sha256").update(bytes).digest("hex") !== actual.sha256
      )
        throw new Error("NATIVE_CHECK_ARTIFACT_DIGEST_MISMATCH");

      if (ref.relativePath.endsWith(".json") && ref.identity) {
        const state = z
          .object({
            identity: z.object({
              sessionId: z.string(),
              buildGeneration: z.number().int().nonnegative(),
            }),
          })
          .safeParse(JSON.parse(bytes.toString("utf8")));

        if (
          !state.success ||
          state.data.identity.sessionId !== ref.identity.sessionId ||
          state.data.identity.buildGeneration !== ref.identity.buildGeneration
        )
          throw new Error("NATIVE_CHECK_ARTIFACT_IDENTITY_MISMATCH");
        verifiedState = true;
      }
    }

    if (!verifiedState) throw new Error("NATIVE_CHECK_STATE_ARTIFACT_REQUIRED");
    const identities = refs.flatMap((ref) => (ref?.identity ? [ref.identity] : []));

    if (
      !identities.length ||
      identities.some((identity) => identity.sessionId !== result.sessionId)
    )
      throw new Error("NATIVE_BUILD_EVIDENCE_MISSING");

    if (result === broken)
      oldGeneration = Math.max(...identities.map((identity) => identity.buildGeneration));
    else if (identities.some((identity) => identity.buildGeneration <= oldGeneration))
      throw new Error("NATIVE_REPAIR_BUILD_NOT_FRESH");
  }

  const events = z
    .array(z.object({ type: z.string(), data: z.json() }))
    .max(10000)
    .parse(eventsValue);

  for (const result of [broken, repaired]) {
    const nativeReplies = events
      .filter((event) => event.type === "item/completed")
      .flatMap((event) => {
        const item = z
          .object({
            item: z.object({
              type: z.literal("toolCall"),
              tool: z.literal("fastloop_verify"),
              result: z.string(),
            }),
          })
          .safeParse(event.data);

        if (!item.success) return [];

        try {
          return [JSON.parse(item.data.item.result)];
        } catch {
          return [];
        }
      });

    if (
      nativeReplies.filter(
        (reply) => reply?.runId === result.runId && reply?.sessionId === result.sessionId,
      ).length !== 1
    )
      throw new Error("NATIVE_HANDLE_BINDING_MISSING");

    const resultReplies = events
      .filter((event) => event.type === "item/completed")
      .flatMap((event) => {
        const item = z
          .object({
            item: z.object({
              type: z.literal("toolCall"),
              tool: z.literal("fastloop_result"),
              result: z.string(),
            }),
          })
          .safeParse(event.data);

        if (!item.success) return [];

        try {
          const reply = z
            .object({ runId: z.string(), result: resultSchema })
            .parse(JSON.parse(item.data.item.result));

          return [reply];
        } catch {
          return [];
        }
      });

    if (
      resultReplies.filter(
        (reply) =>
          reply.runId === result.runId && JSON.stringify(reply.result) === JSON.stringify(result),
      ).length !== 1
    )
      throw new Error("NATIVE_CANONICAL_RESULT_BINDING_MISSING");

    const requested = events
      .filter((event) => event.type === "client/turn/requested")
      .flatMap((event) => {
        const parsed = z
          .object({
            requestId: z.string(),
            input: z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough()),
          })
          .safeParse(event.data);

        if (!parsed.success) return [];

        return parsed.data.input.some(
          (item) =>
            item.text.startsWith("[FastLoop completion]") &&
            item.text.includes(`Run: ${result.runId}.`) &&
            /FastLoop receipt: [a-f0-9-]{36}\.$/.test(item.text),
        )
          ? [parsed.data.requestId]
          : [];
      });

    if (
      requested.length !== 1 ||
      events.filter(
        (event) =>
          event.type === "turn/input/accepted" &&
          z.object({ clientRequestId: z.literal(requested[0]) }).safeParse(event.data).success,
      ).length !== 1
    )
      throw new Error("NATIVE_EXACTLY_ONE_COMPLETION_REQUIRED");
  }

  return { brokenRunId: broken.runId, repairedRunId: repaired.runId, sessionId: broken.sessionId };
}
