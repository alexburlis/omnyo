import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it, vi, onTestFinished } from "vitest";
import {
  execPortableFile,
  sanitizeInheritedChildProcessEnv,
} from "../src/index.js";

const options = {
  cwd: process.cwd(),
  env: process.env,
  maxBuffer: 1024,
  timeout: 5_000,
};

it.each(["stdout", "stderr"])(
  "bounds buffered %s and stops the child",
  async (stream) => {
    await expect(
      execPortableFile(
        process.execPath,
        [
          "-e",
          `
    process.${stream}.write("é".repeat(1024));
    setInterval(() => {}, 1000);
  `,
        ],
        options,
      ),
    ).rejects.toMatchObject({
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      message: `${stream} maxBuffer length exceeded`,
      [stream]: "é".repeat(512),
    });
  },
);

it("does not reintroduce sanitized parent runtime settings", async () => {
  vi.stubEnv("OMNYO_PROCESS_PARENT_SECRET", "parent-only");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const output = await execPortableFile(
    process.execPath,
    [
      "-e",
      'process.stdout.write(JSON.stringify([process.env.OMNYO_PROCESS_PARENT_SECRET ?? null, process.env.PROVIDER_TOKEN]) + "\\n");',
    ],
    {
      ...options,
      env: sanitizeInheritedChildProcessEnv({
        env: { ...process.env, PROVIDER_TOKEN: "preserved-token" },
      }),
    },
  );

  expect(output).toEqual({
    stdout: '[null,"preserved-token"]\n',
    stderr: "",
  });
});

it("streams split UTF-8 stderr and closes stdin after writing the input", async () => {
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

it("cancels a command with its descendants and retains prior output", async () => {
  const controller = new AbortController();
  let output = "";
  let pids: number[] = [];

  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);

      return true;
    } catch {
      return false;
    }
  };

  try {
    await expect(
      execPortableFile(
        process.execPath,
        [
          "-e",
          `
    const { spawn } = require("node:child_process");
    process.on("SIGTERM", () => process.exit(0));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    child.once("spawn", () => process.stderr.write(JSON.stringify([process.pid, child.pid]) + "\\n"));
    setInterval(() => {}, 1000);
  `,
        ],
        {
          ...options,
          signal: controller.signal,
          onStderr: (chunk) => {
            output += chunk;

            if (output.endsWith("\n")) {
              pids = JSON.parse(output);
              controller.abort("cancelled by caller");
            }
          },
        },
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
      code: "ABORT_ERR",
      cause: "cancelled by caller",
      killed: true,
      signal: "SIGTERM",
      stderr: expect.stringContaining("["),
    });
    expect(pids).toHaveLength(2);
    await expect.poll(() => pids.some(isAlive), { timeout: 1000 }).toBe(false);
  } finally {
    for (const pid of pids) {
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
    }
  }
});

it.skipIf(process.platform === "win32")(
  "runs the first bare command on the child PATH and reports a missing one as ENOENT",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "omnyo-exec-path-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));

    const dirs = ["missing", "first", "second"].map((name) => join(root, name));

    for (const [index, dir] of dirs.slice(1).entries()) {
      await mkdir(dir);
      await writeFile(join(dir, "omnyo-probe"), `#!/bin/sh\necho ${index}\n`, {
        mode: 0o755,
      });
    }

    const env = { ...process.env, PATH: dirs.join(delimiter) };

    await expect(
      execPortableFile("omnyo-probe", [], { ...options, env }),
    ).resolves.toEqual({ stdout: "0\n", stderr: "" });
    await expect(
      execPortableFile("omnyo-probe-absent", [], { ...options, env }),
    ).rejects.toMatchObject({
      code: "ENOENT",
      syscall: "spawn omnyo-probe-absent",
    });
  },
);

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
