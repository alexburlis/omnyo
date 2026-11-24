import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import {
  providerCliInstallEventSchema,
  type ProviderCliInstallEvent,
} from "@omnyo/host-daemon-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { streamProviderInstallation } from "./provider-installation.js";

function childEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    TEMP: directory,
    TMP: directory,
    Path: directory,
    pAtHeXt: ".CMD;.EXE;.COM;.BAT",
    ARGUMENT_EXPANSION_FIXTURE: "expanded fixture argument",
  };
}

async function readEvents(stream: ReadableStream<Uint8Array>) {
  const text = await new Response(stream).text();

  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => providerCliInstallEventSchema.parse(JSON.parse(line)));
}

function output(events: ProviderCliInstallEvent[]): string {
  return stripVTControlCharacters(
    events
      .filter((event) => event.type === "output")
      .map((event) => event.text)
      .join(""),
  );
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

describe.skipIf(process.platform !== "win32")(
  "native Windows provider installation",
  () => {
    const nativeName = `omnyo-update-native-${randomUUID()}`;
    const cmdName = `omnyo-update-cmd-${randomUUID()}`;
    let root: string;
    let directory: string;
    let nativePath: string;
    const previousCwd = process.cwd();

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "omnyo-provider-installation-"));
      process.chdir(root);
      directory = join(root, "updater tools ü");
      await mkdir(directory);
      nativePath = join(directory, `${nativeName}.exe`);
      await copyFile(process.execPath, nativePath);
      const script = join(directory, "version.cjs");
      await writeFile(
        script,
        'console.log("OMNYO_CMD " + JSON.stringify(process.argv.slice(2)));\n',
      );
      await writeFile(
        join(directory, `${cmdName}.cmd`),
        `@echo off\r\n"${process.execPath}" "%~dp0version.cjs" %*\r\n`,
      );
    });

    afterAll(async () => {
      process.chdir(previousCwd);

      if (root) {
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      }
    });

    it.each(["native", "cmd", "absolute"])(
      "launches %s with the supplied child PATH and original arguments",
      async (kind) => {
        const command =
          kind === "native"
            ? nativeName
            : kind === "cmd"
              ? cmdName
              : nativePath;

        const events = await readEvents(
          streamProviderInstallation({
            providerId: "windows-launch-fixture",
            plan: { command, args: ["--version"], displayCommand: command },
            env: childEnvironment(directory),
          }),
        );

        expect(output(events), JSON.stringify(events)).toContain(
          kind === "cmd" ? 'OMNYO_CMD ["--version"]' : process.version,
        );
        expect(events.at(-1)).toMatchObject({
          type: "completed",
          exitCode: 0,
          success: true,
        });
      },
    );

    it("preserves spaces, quotes and shell metacharacters in batch updater arguments", async () => {
      const args = [
        "space value",
        'quoted"value',
        "one&two",
        "left|right",
        "x<y>z",
        "paren(value)",
        "bang!caret^",
        "%ARGUMENT_EXPANSION_FIXTURE%",
        "日本語",
        "",
      ];

      const events = await readEvents(
        streamProviderInstallation({
          providerId: "windows-batch-arguments-fixture",
          plan: {
            command: cmdName,
            args,
            displayCommand: "owned batch argument fixture",
          },
          env: childEnvironment(directory),
        }),
      );

      expect(output(events), JSON.stringify(events)).toContain(
        `OMNYO_CMD ${JSON.stringify(args)}`,
      );
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        exitCode: 0,
        success: true,
      });
    });

    it("reports a missing command and releases the installation lock", async () => {
      const missing = `omnyo-update-missing-${randomUUID()}`;

      const events = await readEvents(
        streamProviderInstallation({
          providerId: "windows-missing-fixture",
          plan: { command: missing, args: [], displayCommand: missing },
          env: childEnvironment(directory),
        }),
      );

      expect(events.at(-1)).toMatchObject({ type: "error" });
      expect(events.at(-1)).toHaveProperty(
        "message",
        expect.stringContaining(missing),
      );

      const next = await readEvents(
        streamProviderInstallation({
          providerId: "windows-after-missing-fixture",
          plan: {
            command: nativePath,
            args: ["--version"],
            displayCommand: nativePath,
          },
          env: childEnvironment(directory),
        }),
      );

      expect(next.at(-1)).toMatchObject({
        type: "completed",
        exitCode: 0,
        success: true,
      });
    });

    it.each(["native", "cmd"])(
      "cancels its running %s updater and releases the lock",
      async (kind) => {
        const script = join(directory, "running.cjs");
        await writeFile(
          script,
          'console.log("OMNYO_READY:" + process.pid); setInterval(() => {}, 1000);\n',
        );
        const batchScript = join(directory, "running.cmd");
        await writeFile(
          batchScript,
          `@echo off\r\n"${process.execPath}" "%~dp0running.cjs"\r\n`,
        );

        const stream = streamProviderInstallation({
          providerId: "windows-cancel-fixture",
          plan: {
            command: kind === "native" ? process.execPath : batchScript,
            args: kind === "native" ? [script] : [],
            displayCommand: "owned updater fixture",
          },
          env: childEnvironment(directory),
        });

        const reader = stream.getReader();
        let pid: number | undefined;
        let text = "";

        try {
          while (pid === undefined) {
            const chunk = await reader.read();
            expect(chunk.done).toBe(false);
            text += new TextDecoder().decode(chunk.value);
            const match = /OMNYO_READY:(\d+)/.exec(text);

            if (match) pid = Number(match[1]);
          }

          await expect(reader.cancel()).resolves.toBeUndefined();
          const deadline = Date.now() + 3_000;

          while (isRunning(pid) && Date.now() < deadline) await delay(25);
          expect(isRunning(pid)).toBe(false);

          const next = await readEvents(
            streamProviderInstallation({
              providerId: "windows-after-cancel-fixture",
              plan: {
                command: nativePath,
                args: ["--version"],
                displayCommand: nativePath,
              },
              env: childEnvironment(directory),
            }),
          );

          expect(next.at(-1)).toMatchObject({
            type: "completed",
            success: true,
          });
        } finally {
          await reader.cancel().catch(() => undefined);

          if (pid !== undefined && isRunning(pid)) {
            process.kill(pid);
            const deadline = Date.now() + 3_000;

            while (isRunning(pid) && Date.now() < deadline) await delay(25);
            expect(isRunning(pid)).toBe(false);
          }
        }
      },
    );
  },
);
