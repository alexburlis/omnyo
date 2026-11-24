import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished } from "vitest";
import { enableProcessLauncherWorker, execPortableFile } from "../src/index.js";

const options = {
  cwd: process.cwd(),
  env: process.env,
  maxBuffer: 1024,
  timeout: 5_000,
};

let disable: (() => Promise<void>) | null = null;

beforeEach(() => {
  disable = enableProcessLauncherWorker();
});

afterEach(async () => {
  await disable?.();
  disable = null;
});

it("runs commands through the worker with input and streamed stderr", async () => {
  const chunks: string[] = [];

  const output = await execPortableFile(
    process.execPath,
    [
      "-e",
      `
    const fs = require("node:fs");
    process.stdout.write(fs.readFileSync(0, "utf8"));
    const message = Buffer.from("é日本語");
    process.stderr.write(message.subarray(0, 1));
    setTimeout(() => process.stderr.write(message.subarray(1)), 50);
  `,
    ],
    {
      ...options,
      input: "hello 日本語",
      onStderr: (chunk) => chunks.push(chunk),
    },
  );

  expect(output).toEqual({ stdout: "hello 日本語", stderr: "é日本語" });
  expect(chunks.join("")).toBe("é日本語");
});

it("reports exit codes, buffer overflow and timeouts with the same error fields", async () => {
  await expect(
    execPortableFile(
      process.execPath,
      ["-e", 'process.stderr.write("bad"); process.exit(3)'],
      options,
    ),
  ).rejects.toMatchObject({ code: 3, killed: false, stderr: "bad" });

  await expect(
    execPortableFile(
      process.execPath,
      [
        "-e",
        'process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000)',
      ],
      options,
    ),
  ).rejects.toMatchObject({
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    message: "stdout maxBuffer length exceeded",
    killed: true,
    signal: "SIGTERM",
  });

  await expect(
    execPortableFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      ...options,
      timeout: 200,
    }),
  ).rejects.toMatchObject({
    message: "Command timed out after 200ms",
    killed: true,
    signal: "SIGTERM",
  });
});

it.skipIf(process.platform === "win32")(
  "resolves bare commands on the child PATH and reports a missing one as ENOENT",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "omnyo-launcher-path-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "omnyo-probe"), "#!/bin/sh\necho found\n", {
      mode: 0o755,
    });

    const env = {
      ...process.env,
      PATH: [join(root, "missing"), bin].join(delimiter),
    };

    await expect(
      execPortableFile("omnyo-probe", [], { ...options, env }),
    ).resolves.toEqual({ stdout: "found\n", stderr: "" });
    await expect(
      execPortableFile("omnyo-probe-absent", [], { ...options, env }),
    ).rejects.toMatchObject({
      code: "ENOENT",
      syscall: "spawn omnyo-probe-absent",
    });
  },
);

it("cancels a running command and surfaces the caller's abort reason", async () => {
  const controller = new AbortController();
  let output = "";

  await expect(
    execPortableFile(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM", () => process.exit(0)); process.stderr.write("ready\\n"); setInterval(() => {}, 1000)',
      ],
      {
        ...options,
        signal: controller.signal,
        onStderr: (chunk) => {
          output += chunk;

          if (output.endsWith("\n")) controller.abort("cancelled by caller");
        },
      },
    ),
  ).rejects.toMatchObject({
    name: "AbortError",
    code: "ABORT_ERR",
    cause: "cancelled by caller",
    killed: true,
    signal: "SIGTERM",
  });
});

it("installer deadline preserves confirmed process-tree termination", async () => {
  await expect(
    execPortableFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      ...options,
      timeout: 100,
    }),
  ).rejects.toMatchObject({
    killed: true,
    treeTermination: "confirmed",
    processGroupId: expect.any(Number),
    processPlatform: process.platform,
  });
});
