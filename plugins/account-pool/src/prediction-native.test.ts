import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NativeSession } from "./prediction-native.js";
import { predictNative } from "./prediction-runner.js";
import {
  composerPredictionResultSchema,
  NATIVE_PREDICTION_UNAVAILABLE,
} from "./prediction-contract.js";

const fixture = fileURLToPath(
  new URL("./fixtures/prediction-native.mjs", import.meta.url),
);

const sessions: NativeSession[] = [];

beforeAll(() => chmod(fixture, 0o755));

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

describe("native Codex process boundary", () => {
  it.skipIf(process.platform !== "win32")(
    "starts and closes a Windows cmd shim without leaving its process running",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "omnyo prediction shim "));
      const shim = join(directory, "codex.cmd");
      await writeFile(
        shim,
        `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`,
      );

      try {
        const session = await NativeSession.open(
          shim,
          directory,
          new AbortController().signal,
          { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
        );

        sessions.push(session);
        await expect(
          session.request(
            "route-fixture",
            {},
            z.object({ capabilityPreserved: z.boolean() }),
          ),
        ).resolves.toEqual({ capabilityPreserved: true });
        await session.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("binds the canonical prediction capability selector to the same opaque child value", async () => {
    vi.stubEnv(
      "OMNYO_COMPOSER_PREDICTION_CAPABILITY",
      "stale-current-capability",
    );

    try {
      const session = await NativeSession.open(
        fixture,
        process.cwd(),
        new AbortController().signal,
        { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
      );

      sessions.push(session);

      const route = await session.request(
        "route-fixture",
        {},
        z.object({
          selectedEnvironmentName: z.string().nullable(),
          capabilityPreserved: z.boolean(),
          canonicalPresent: z.boolean(),
          configuredModelProvider: z.string().nullable(),
          legacyProviderConfigured: z.boolean(),
          clientInfoName: z.string().nullable(),
        }),
      );

      expect(route).toEqual({
        selectedEnvironmentName: "OMNYO_COMPOSER_PREDICTION_CAPABILITY",
        capabilityPreserved: true,
        canonicalPresent: true,
        configuredModelProvider: "omnyo-account-pool",
        legacyProviderConfigured: false,
        clientInfoName: "omnyo_composer_predictions",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects host results missing the archive assessment", () => {
    expect(
      composerPredictionResultSchema.safeParse({
        text: "Check the result.",
        promptVersion: "older-v1",
      }).success,
    ).toBe(false);
  });

  it("reads host results from before external waits as not waiting", () => {
    expect(
      composerPredictionResultSchema.parse({
        text: "Check the result.",
        promptVersion: "older-v1",
        archiveReadiness: { ready: false, reason: "Checks remain." },
      }).archiveReadiness,
    ).toEqual({
      ready: false,
      reason: "Checks remain.",
      waitingOn: null,
      ask: null,
      recap: null,
    });
  });

  it("predicts Claude context without reading or forking a native Claude identifier", async () => {
    expect(
      await predictNative(
        {
          nativeThreadId: "claude-not-a-codex-id",
          conversationContext:
            '[{"role":"user","text":"Ship the repair."},{"role":"assistant","text":"Live verification remains."}]',
          cwd: process.cwd(),
          cliPath: fixture,
          model: "gpt-6.1-sol",
          route: { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
          configuration: {
            is_enabled: true,
            prompt: "Provider fixture prompt",
            prompt_version: "fixture-v1",
            prediction_reasoning_effort: "low",
          },
          tags: [],
        },
        new AbortController().signal,
      ),
    ).toMatchObject({
      text: "Check the result.",
      archiveReadiness: { ready: false },
    });
  });

  it("constrains the native prediction to the validated output schema", async () => {
    vi.stubEnv("PREDICTION_FIXTURE_REQUIRE_SCHEMA", "1");

    try {
      await expect(
        predictNative(
          {
            nativeThreadId: "claude-not-a-codex-id",
            conversationContext: '[{"role":"user","text":"Ship the repair."}]',
            cwd: process.cwd(),
            cliPath: fixture,
            model: "gpt-6.1-sol",
            route: { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
            configuration: {
              is_enabled: true,
              prompt: "Provider fixture prompt",
              prompt_version: "fixture-v1",
              prediction_reasoning_effort: "low",
            },
            tags: [],
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ text: "Check the result." });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("requires a reply through the native output schema when asked to", async () => {
    vi.stubEnv("PREDICTION_FIXTURE_REQUIRE_SCHEMA", "reply");

    const predict = () =>
      predictNative(
        {
          nativeThreadId: "claude-not-a-codex-id",
          conversationContext: '[{"role":"user","text":"Ship the repair."}]',
          cwd: process.cwd(),
          cliPath: fixture,
          model: "gpt-6.1-sol",
          route: { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
          configuration: {
            is_enabled: true,
            prompt: "Provider fixture prompt",
            prompt_version: "fixture-v1",
            prediction_reasoning_effort: "low",
          },
          tags: [],
          force: true,
        },
        new AbortController().signal,
      );

    try {
      await expect(predict()).resolves.toMatchObject({
        text: "Check the result.",
      });
      vi.stubEnv(
        "PREDICTION_FIXTURE_RESULT",
        JSON.stringify({
          suggestion: null,
          noSuggestionReason: "The release needs approval.",
          archiveReadiness: {
            ready: false,
            reason: "Work remains.",
            waitingOn: null,
          },
        }),
      );
      await expect(predict()).rejects.toThrow(
        "Codex returned an invalid prediction.",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    [null, "A release job owns the next step.", true],
    ["  ", "  No follow-up is supported by this conversation.  ", true],
    [null, null, false],
    [null, " ", false],
    [null, undefined, false],
    ["Check the result.", "A release job owns the next step.", false],
    ["Check the result.", null, true],
  ])(
    "validates the omission explanation for %j and %j",
    async (suggestion, noSuggestionReason, valid) => {
      vi.stubEnv(
        "PREDICTION_FIXTURE_RESULT",
        JSON.stringify({
          suggestion,
          ...(noSuggestionReason === undefined ? {} : { noSuggestionReason }),
          archiveReadiness: {
            ready: false,
            reason: "Work remains.",
            waitingOn: null,
          },
        }),
      );

      try {
        const prediction = predictNative(
          {
            nativeThreadId: "claude-not-a-codex-id",
            conversationContext: '[{"role":"user","text":"Ship the repair."}]',
            cwd: process.cwd(),
            cliPath: fixture,
            model: "gpt-6.1-sol",
            route: { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
            configuration: {
              is_enabled: true,
              prompt: "Provider fixture prompt",
              prompt_version: "fixture-v1",
              prediction_reasoning_effort: "low",
            },
            tags: [],
          },
          new AbortController().signal,
        );

        if (valid) {
          await expect(prediction).resolves.toMatchObject({
            text: suggestion?.trim() || null,
            noSuggestionReason: noSuggestionReason?.trim() || null,
          });
        } else {
          await expect(prediction).rejects.toThrow(
            "Codex returned an invalid prediction.",
          );
        }
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("preserves missing omission explanations as unrecorded for older hosts", () => {
    expect(
      composerPredictionResultSchema.parse({
        text: null,
        promptVersion: "older-v1",
        archiveReadiness: null,
      }),
    ).toMatchObject({ text: null, noSuggestionReason: null });
  });

  it("starts Codex with plugins off so isolated prediction homes are never synced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prediction-native-argv-"));
    const argvFile = join(directory, "argv.json");
    vi.stubEnv("PREDICTION_FIXTURE_ARGV_FILE", argvFile);

    try {
      await predictNative(
        {
          nativeThreadId: "claude-not-a-codex-id",
          conversationContext:
            '[{"role":"user","text":"Ship the repair."},{"role":"assistant","text":"Live verification remains."}]',
          cwd: process.cwd(),
          cliPath: fixture,
          model: "gpt-6.1-sol",
          route: { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
          configuration: {
            is_enabled: true,
            prompt: "Provider fixture prompt",
            prompt_version: "fixture-v1",
            prediction_reasoning_effort: "low",
          },
          tags: [],
        },
        new AbortController().signal,
      );

      const argv = z
        .array(z.string())
        .parse(JSON.parse(await readFile(argvFile, "utf8")));

      expect(
        argv.some(
          (value, index) =>
            value === "-c" && argv[index + 1] === "features.plugins=false",
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["native_fixture_source", "native_fixture_original_pool_result_v1"])(
    "preserves the source model when the isolated native default differs (%s)",
    async (nativeThreadId) => {
      const originalHash = createHash("sha256")
        .update(await readFile(fixture))
        .digest("hex");

      const result = await predictNative(
        {
          nativeThreadId,
          cwd: process.cwd(),
          cliPath: fixture,
          model: "gpt-6.1-sol",
          route: { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
          configuration: {
            is_enabled: true,
            prompt: "Provider fixture prompt",
            prompt_version: "fixture-v1",
            prediction_reasoning_effort: "low",
            unsupported_models: ["gpt-daybreak-blue-latest"],
          },
          tags: [],
        },
        new AbortController().signal,
      );

      expect(result).toEqual({
        text: "Check the result.",
        noSuggestionReason: null,
        promptVersion: "fixture-v1",
        archiveReadiness: {
          ready: false,
          reason: "The requested check is still pending.",
          waitingOn: null,
          ask: null,
          recap: null,
        },
        tag: null,
      });
      expect(
        createHash("sha256")
          .update(await readFile(fixture))
          .digest("hex"),
      ).toBe(originalHash);
    },
  );

  it.each([
    [
      { ready: false, reason: "Submitted.", waitingOn: " App Store review " },
      { ready: false, reason: "Submitted.", waitingOn: "App Store review" },
    ],
    [
      { ready: true, reason: "Shipped.", waitingOn: "App Store review" },
      { ready: true, reason: "Shipped.", waitingOn: null },
    ],
    [
      { ready: false, reason: "Submitted.", waitingOn: "  " },
      { ready: false, reason: "Submitted.", waitingOn: null },
    ],
  ])(
    "normalizes the model's external wait %j",
    async (archiveReadiness, expected) => {
      vi.stubEnv(
        "PREDICTION_FIXTURE_ARCHIVE",
        JSON.stringify(archiveReadiness),
      );

      try {
        const result = await predictNative(
          {
            nativeThreadId: "claude-not-a-codex-id",
            conversationContext:
              '[{"role":"user","text":"Ship the repair."},{"role":"assistant","text":"Live verification remains."}]',
            cwd: process.cwd(),
            cliPath: fixture,
            model: "gpt-6.1-sol",
            route: { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
            configuration: {
              is_enabled: true,
              prompt: "Provider fixture prompt",
              prompt_version: "fixture-v1",
              prediction_reasoning_effort: "low",
            },
            tags: [],
          },
          new AbortController().signal,
        );

        expect(result.archiveReadiness).toEqual({
          ...expected,
          ask: null,
          recap: null,
        });
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([
    ["build", [{ id: "build", description: "Features" }], "build"],
    ["retired", [{ id: "build", description: "Features" }], null],
    [null, [{ id: "build", description: "Features" }], null],
    ["build", [], null],
  ])(
    "keeps the model's tag %j only when it names an offered tag",
    async (tag, tags, expected) => {
      vi.stubEnv("PREDICTION_FIXTURE_TAG", JSON.stringify(tag));

      try {
        const result = await predictNative(
          {
            nativeThreadId: "claude-not-a-codex-id",
            conversationContext:
              '[{"role":"user","text":"Ship the repair."},{"role":"assistant","text":"Live verification remains."}]',
            cwd: process.cwd(),
            cliPath: fixture,
            model: "gpt-6.1-sol",
            route: { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
            configuration: {
              is_enabled: true,
              prompt: "Provider fixture prompt",
              prompt_version: "fixture-v1",
              prediction_reasoning_effort: "low",
            },
            tags,
          },
          new AbortController().signal,
        );

        expect(result.tag).toBe(expected);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("keeps a missing ancestor rollout as a visible lineage failure", async () => {
    await expect(
      predictNative(
        {
          nativeThreadId: "native_fixture_deleted_ancestor",
          cwd: process.cwd(),
          cliPath: fixture,
          model: "gpt-6.1-sol",
          route: { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
          configuration: {
            is_enabled: true,
            prompt: "Provider fixture prompt",
            prompt_version: "fixture-v1",
            prediction_reasoning_effort: "low",
          },
          tags: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [
      "native_fixture_unknown_pool_result",
      "Composer predictions require the Account Pooler Codex route.",
    ],
    [
      "native_fixture_changed_model",
      "Native Codex changed the prediction source model.",
    ],
    [
      "native_fixture_payload_rejected",
      "Account Pooler rejected the Codex prediction payload.",
    ],
    [
      "native_fixture_payload_tools",
      "Account Pooler rejected the Codex prediction payload (tools).",
    ],
    ["native_fixture_unsupported_model", NATIVE_PREDICTION_UNAVAILABLE],
    ["native_fixture_missing_rollout", NATIVE_PREDICTION_UNAVAILABLE],
    ["native_fixture_deleted_rollout", NATIVE_PREDICTION_UNAVAILABLE],
    ["native_fixture_missing_lineage", "Native Codex request failed (-32600)"],
    ["native_fixture_invalid_resume", "Native Codex request failed (-32600)"],
    [
      "native_fixture_lineage_cycle",
      "Native Codex returned cyclic prediction lineage.",
    ],
    [
      "native_fixture_private_failure",
      "Codex did not complete the prediction (status=failed, code=other).",
    ],
    [
      "native_fixture_http_failure",
      "Codex did not complete the prediction (status=failed, code=responseStreamDisconnected, httpStatus=401).",
    ],
    [
      "native_fixture_unknown_failure",
      "Codex did not complete the prediction (status=failed, code=unknown).",
    ],
    [
      "native_fixture_invalid_http_failure",
      "Codex did not complete the prediction (status=failed, code=unknown).",
    ],
    [
      "native_fixture_private_status",
      "Codex did not complete the prediction (status=unknown, code=other).",
    ],
  ])("reports a safe failure for %s", async (nativeThreadId, message) => {
    await expect(
      predictNative(
        {
          nativeThreadId,
          cwd: process.cwd(),
          cliPath: fixture,
          model: "gpt-6.1-sol",
          route: { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
          configuration: {
            is_enabled: true,
            prompt: "Provider fixture prompt",
            prompt_version: "fixture-v1",
            prediction_reasoning_effort: "low",
            unsupported_models: ["gpt-5.4"],
          },
          tags: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toEqual(new Error(message));
  });

  it("preserves the complete native lineage in the isolated prediction home", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prediction-lineage-"));
    vi.stubEnv("PREDICTION_FIXTURE_LINEAGE_DIR", directory);

    try {
      for (const id of [
        "native_fixture_lineage_source",
        "native_fixture_lineage_parent",
        "native_fixture_lineage_root",
      ])
        await writeFile(join(directory, `${id}.jsonl`), id);

      await expect(
        predictNative(
          {
            nativeThreadId: "native_fixture_lineage_source",
            cwd: process.cwd(),
            cliPath: fixture,
            model: "gpt-6.1-sol",
            route: { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
            configuration: {
              is_enabled: true,
              prompt: "Provider fixture prompt",
              prompt_version: "fixture-v1",
              prediction_reasoning_effort: "low",
            },
            tags: [],
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ text: "Check the result." });

      for (const id of [
        "native_fixture_lineage_source",
        "native_fixture_lineage_parent",
        "native_fixture_lineage_root",
      ])
        expect(await readFile(join(directory, `${id}.jsonl`), "utf8")).toBe(id);
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows native EOF cleanup to close its owned helper before exit", async () => {
    const session = await NativeSession.open(
      fixture,
      process.cwd(),
      new AbortController().signal,
      { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
    );

    sessions.push(session);

    const { pid } = await session.request(
      "owned-helper",
      {},
      z.object({ pid: z.number() }),
    );

    let closed = false;

    try {
      await session.close();
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
      closed = true;
    } finally {
      if (!closed) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            )
          )
            throw error;
        }
      }
    }
  });
  it("correlates interleaved native replies without crossing results", async () => {
    const session = await NativeSession.open(
      fixture,
      process.cwd(),
      new AbortController().signal,
      { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
    );

    sessions.push(session);
    const schema = z.object({ value: z.string() });
    const slow = session.request("echo", { value: "first", delay: 20 }, schema);
    const fast = session.request("echo", { value: "second", delay: 0 }, schema);
    expect(await fast).toEqual({ value: "second" });
    expect(await slow).toEqual({ value: "first" });
  });

  it("rejects unimplemented native RPC without manufacturing a result", async () => {
    const session = await NativeSession.open(
      fixture,
      process.cwd(),
      new AbortController().signal,
      { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
    );

    sessions.push(session);
    await expect(
      session.request("fail", {}, z.object({ text: z.string() })),
    ).rejects.toThrow("Native Codex request failed (-32601)");
  });

  it("rejects malformed native output and closes its worker", async () => {
    const session = await NativeSession.open(
      fixture,
      process.cwd(),
      new AbortController().signal,
      { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
    );

    sessions.push(session);

    const { pid } = await session.request(
      "pid",
      {},
      z.object({ pid: z.number() }),
    );

    await expect(session.request("malformed", {}, z.null())).rejects.toThrow(
      "Native Codex returned an invalid message",
    );
    await session.close();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("aborts a pending request and leaves no owned process", async () => {
    const controller = new AbortController();

    const session = await NativeSession.open(
      fixture,
      process.cwd(),
      controller.signal,
      { baseUrl: "http://127.0.0.1:1", capability: "fixture" },
    );

    sessions.push(session);

    const { pid } = await session.request(
      "pid",
      {},
      z.object({ pid: z.number() }),
    );

    const pending = session.request("hang", {}, z.null());
    controller.abort();
    await expect(pending).rejects.toThrow("Prediction canceled");
    await session.close();
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
