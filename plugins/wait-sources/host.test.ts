import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import hostEntry, { runCommand } from "./host.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnyo-wait-sources-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("wait sources host entry", () => {
  it("reports whether a path exists, and what it is", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);
    const file = join(directory, "done.txt");

    await expect(
      harness.experimental_call("stat", { path: file }),
    ).resolves.toEqual({
      exists: false,
      kind: null,
      size: null,
      modifiedAt: null,
    });

    await writeFile(file, "ok");

    await expect(
      harness.experimental_call("stat", { path: file }),
    ).resolves.toMatchObject({
      exists: true,
      kind: "file",
      size: 2,
    });
    await expect(
      harness.experimental_call("stat", { path: directory }),
    ).resolves.toMatchObject({ exists: true, kind: "directory" });
    await harness.experimental_dispose();
  });

  it("runs a check command through the shell and returns its exit and output", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);

    await expect(
      harness.experimental_call("runCheck", {
        command: "echo ready && exit 0",
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: "ready\n", timedOut: false });
    await expect(
      harness.experimental_call("runCheck", { command: "exit 3" }),
    ).resolves.toEqual({ exitCode: 3, stdout: "", timedOut: false });
    await harness.experimental_dispose();
  });

  it("stops a command that runs past its limit", async () => {
    const started = Date.now();

    await expect(
      runCommand("sleep 5", new AbortController().signal, 200),
    ).resolves.toEqual({ exitCode: null, stdout: "", timedOut: true });
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
