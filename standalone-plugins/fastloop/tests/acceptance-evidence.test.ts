import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { validateNativeRepairEvidence } from "../acceptance-evidence.js";

it("binds immutable required checks, fresh evidence, native handles and one accepted callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "fastloop-acceptance-evidence-"));

  try {
    const save = async <Fixture>(name: string, value: Fixture) => {
      const path = join(root, name);
      const data = JSON.stringify(value);
      await writeFile(path, data);

      return { path, sha256: createHash("sha256").update(data).digest("hex") };
    };

    const registry = {
      requirementsHash: "a".repeat(64),
      checksHash: "b".repeat(64),
      requirements: [{ id: "req", required: true }],
      checks: [{ id: "check", required: true, predicate: { kind: "text", equals: "Saved" } }],
    };

    const brokenRegistry = await save("broken-registry.json", registry);
    const repairedRegistry = await save("repaired-registry.json", registry);

    const brokenState = await save("broken-state.json", {
      identity: { sessionId: "session", buildGeneration: 0 },
    });

    const repairedState = await save("repaired-state.json", {
      identity: { sessionId: "session", buildGeneration: 1 },
    });

    const result = (runId: string, generation: number) => ({
      runId,
      sessionId: "session",
      verdict: generation ? "PASSED" : "FAILED",
      requirementsHash: registry.requirementsHash,
      checksHash: registry.checksHash,
      checks: [{ checkId: "check", status: generation ? "PASS" : "FAIL", evidenceIds: ["state"] }],
      evidence: [
        {
          id: "registry",
          runId,
          relativePath: "registry.json",
          sha256: brokenRegistry.sha256,
          redacted: true,
        },
        {
          id: "state",
          runId,
          relativePath: "state.json",
          sha256: generation ? repairedState.sha256 : brokenState.sha256,
          redacted: true,
          identity: { sessionId: "session", buildGeneration: generation },
        },
      ],
    });

    const brokenResult = await save("broken.json", result("broken", 0));
    const repairedResult = await save("repaired.json", result("repaired", 1));

    const events = ["broken", "repaired"].flatMap((runId, index) => [
      {
        type: "item/completed",
        data: {
          item: {
            type: "toolCall",
            tool: "fastloop_verify",
            result: JSON.stringify({ runId, sessionId: "session" }),
          },
        },
      },
      {
        type: "item/completed",
        data: {
          item: {
            type: "toolCall",
            tool: "fastloop_result",
            result: JSON.stringify({ runId, result: result(runId, index) }),
          },
        },
      },
      {
        type: "client/turn/requested",
        data: {
          requestId: `request-${index}`,
          input: [
            {
              type: "text",
              text: `[FastLoop completion] Done\nRun: ${runId}. FastLoop receipt: 12345678-1234-1234-1234-123456789abc.`,
            },
          ],
        },
      },
      { type: "turn/input/accepted", data: { clientRequestId: `request-${index}` } },
    ]);

    const nativeEvents = await save("events.json", events);

    const index = {
      schema: 1,
      brokenResult,
      repairedResult,
      brokenRegistry,
      repairedRegistry,
      nativeEvents,
      checkArtifacts: [
        { ...brokenState, runId: "broken", evidenceId: "state" },
        { ...repairedState, runId: "repaired", evidenceId: "state" },
      ],
    };

    await expect(validateNativeRepairEvidence(index)).resolves.toEqual({
      brokenRunId: "broken",
      repairedRunId: "repaired",
      sessionId: "session",
    });

    const changedRegistry = await save("changed-registry.json", {
      ...registry,
      checks: [{ ...registry.checks[0], predicate: { kind: "text", equals: "Changed" } }],
    });

    await expect(
      validateNativeRepairEvidence({ ...index, repairedRegistry: changedRegistry }),
    ).rejects.toThrow("NATIVE_REPAIR_IMMUTABLE_SCOPE_CHANGED");
    const blocked = await save("blocked.json", { ...result("broken", 0), verdict: "BLOCKED" });
    await expect(
      validateNativeRepairEvidence({ ...index, brokenResult: blocked }),
    ).rejects.toThrow();
    const stale = result("repaired", 1);
    stale.evidence[1]!.identity!.buildGeneration = 0;
    await expect(
      validateNativeRepairEvidence({ ...index, repairedResult: await save("stale.json", stale) }),
    ).rejects.toThrow("NATIVE_CHECK_ARTIFACT_IDENTITY_MISMATCH");
    await expect(
      validateNativeRepairEvidence({
        ...index,
        nativeEvents: await save("duplicated.json", [...events, events[2], events[3]]),
      }),
    ).rejects.toThrow("NATIVE_EXACTLY_ONE_COMPLETION_REQUIRED");
    await expect(
      validateNativeRepairEvidence({
        ...index,
        nativeEvents: await save(
          "missing-native.json",
          events.filter((event) => event.type !== "item/completed"),
        ),
      }),
    ).rejects.toThrow("NATIVE_HANDLE_BINDING_MISSING");
    await writeFile(brokenResult.path, (await readFile(brokenResult.path, "utf8")) + " ");
    await expect(validateNativeRepairEvidence(index)).rejects.toThrow(
      "ACCEPTANCE_EVIDENCE_DIGEST_MISMATCH",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
