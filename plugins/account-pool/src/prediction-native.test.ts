import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { predictNative } from "./prediction-runner.js";

const fixture = new URL("./fixtures/prediction-native.mjs", import.meta.url);

const directories: string[] = [];

async function setup(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), "omnyo-prediction-fixture-"));
  directories.push(directory);
  const trace = join(directory, "trace");
  const launcher = join(directory, "codex.mjs");
  await writeFile(
    launcher,
    [
      "#!/usr/bin/env node",
      `process.argv.splice(2, 0, ${JSON.stringify(mode)}, ${JSON.stringify(trace)});`,
      `await import(${JSON.stringify(fixture.href)});`,
    ].join("\n"),
    { mode: 0o700 },
  );

  const cliPath =
    process.platform === "win32" ? join(directory, "codex.cmd") : launcher;

  if (process.platform === "win32")
    await writeFile(
      cliPath,
      `@echo off\r\n"${process.execPath}" "${launcher}" %*\r\n`,
    );

  return {
    trace: () => readFile(trace, "utf8"),
    predict: (signal: AbortSignal = new AbortController().signal) =>
      predictNative(
        {
          conversationContext: JSON.stringify([
            { role: "user", text: "Synthetic user text" },
            { role: "assistant", text: "Synthetic assistant text" },
          ]),
          cliPath,
          model: "gpt-6.1-sol",
          force: true,
        },
        signal,
      ),
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("native Codex prediction", () => {
  it("uses the ordinary signed-in process to publish a structured suggestion", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-inherited-key");
    vi.stubEnv(
      "OMNYO_COMPOSER_PREDICTION_CAPABILITY",
      "fixture-inherited-pool",
    );
    const test = await setup("ready");

    await expect(test.predict()).resolves.toMatchObject({
      text: "Run the live check.",
      promptVersion: "omnyo-codex-1",
      archiveReadiness: { ready: false, reason: "Verification remains." },
    });
    expect((await test.trace()).trim().split("\n")).toEqual([
      "initialize",
      "initialized",
      "config/read",
      "account/read",
      "thread/start",
      "account/rateLimits/read",
      "turn/start",
    ]);
  });

  it.each([
    ["endpoint", "text-only configuration"],
    ["mcp", "text-only configuration"],
    ["instructions", "text-only configuration"],
    ["signed-out", "Sign in to the Codex prediction profile"],
    ["unavailable", "fresh included Codex allowance"],
    ["exhausted", "fresh included Codex allowance"],
    ["stale", "fresh included Codex allowance"],
    ["prepaid", "fresh included Codex allowance"],
    ["unknown-credits", "fresh included Codex allowance"],
    ["changed-account", "fresh included Codex allowance"],
  ])("blocks %s before sending the transcript", async (mode, message) => {
    const test = await setup(mode);

    await expect(test.predict()).rejects.toThrow(message);
    expect(await test.trace()).not.toContain("turn/start");
  });

  it.each([
    ["tool", "cannot execute tools"],
    ["server-request", "cannot execute tools"],
    ["invalid-output", "invalid prediction"],
    ["exit", "exited before prediction completed"],
  ])("fails visibly on %s", async (mode, message) => {
    const test = await setup(mode);

    await expect(test.predict()).rejects.toThrow(message);
  });

  it("settles cancellation after dispatch", async () => {
    const test = await setup("wait");
    const controller = new AbortController();

    const result = expect(test.predict(controller.signal)).rejects.toThrow(
      "Prediction canceled",
    );

    await vi.waitFor(async () =>
      expect(await test.trace()).toContain("turn/start"),
    );
    controller.abort();
    await result;
  });
});
