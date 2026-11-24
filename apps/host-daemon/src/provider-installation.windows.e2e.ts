import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import {
  providerCliInstallEventSchema,
  type ProviderCliInstallEvent,
} from "@omnyo/host-daemon-contract";
import { streamProviderInstallation } from "./provider-installation.js";

interface NativeProofReport {
  status: "running" | "passed" | "failed";
  fixtureOnly: boolean;
  platform: NodeJS.Platform;
  pid: number;
  nodeVersion: string;
  startedAt: string;
  bundleSha256: string;
  checks: string[];
  outcomes: {
    name: string;
    output: string;
    finalEvent: ProviderCliInstallEvent | null;
  }[];
  failure: string | null;
  cleanupFailures: string[];
  resources: { phase: string; kinds: Record<string, number> }[];
  scratchDirectory: string | null;
  scratchRemoved: boolean;
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
      .flatMap((event) => (event.type === "output" ? [event.text] : []))
      .join(""),
  );
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;

  while (isRunning(pid) && Date.now() < deadline) await delay(25);
  assert.equal(
    isRunning(pid),
    false,
    `Owned updater fixture did not exit: ${pid}`,
  );
}

async function main() {
  const [outputArgument] = process.argv.slice(2);
  assert.ok(
    outputArgument,
    "Usage: provider-installation.windows.e2e <new-output-json>",
  );
  const bundlePath = process.argv[1];
  assert.ok(bundlePath, "Missing native proof bundle path");
  const outputPath = resolve(outputArgument);
  await mkdir(dirname(outputPath), { recursive: true });
  const checks: string[] = [];

  const outcomes: {
    name: string;
    output: string;
    finalEvent: ProviderCliInstallEvent | null;
  }[] = [];

  const report: NativeProofReport = {
    status: "running",
    fixtureOnly: true,
    platform: process.platform,
    pid: process.pid,
    nodeVersion: process.version,
    startedAt: new Date().toISOString(),
    bundleSha256: createHash("sha256")
      .update(await readFile(bundlePath))
      .digest("hex"),
    checks,
    outcomes,
    failure: null,
    cleanupFailures: [],
    resources: [],
    scratchDirectory: null,
    scratchRemoved: false,
  };

  const previousCwd = process.cwd();
  let root: string | undefined;
  let updaterPid: number | undefined;
  let updaterReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const recordFailure = (error: unknown, cleanup = false) => {
    const message = error instanceof Error ? error.message : String(error);
    report.status = "failed";
    report.failure ??= message;

    if (cleanup) report.cleanupFailures.push(message);
    process.exitCode = 1;
  };

  const recordResources = (phase: string) => {
    const kinds: Record<string, number> = {};

    for (const kind of process.getActiveResourcesInfo()) {
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }

    report.resources.push({ phase, kinds });
  };

  recordResources("before-fixtures");

  try {
    assert.equal(
      process.platform,
      "win32",
      "This proof requires actual Windows execution",
    );
    root = await mkdtemp(join(tmpdir(), "omnyo-native-provider-proof-"));
    report.scratchDirectory = root;
    process.chdir(root);
    const directory = join(root, "updater tools ü");
    await mkdir(directory);
    const nativeName = `omnyo-update-native-${randomUUID()}`;
    const cmdName = `omnyo-update-cmd-${randomUUID()}`;
    const nativePath = join(directory, `${nativeName}.exe`);
    await copyFile(process.execPath, nativePath);
    await writeFile(
      join(directory, "version.cjs"),
      'console.log("OMNYO_CMD " + JSON.stringify(process.argv.slice(2)));\n',
    );
    await writeFile(
      join(directory, `${cmdName}.cmd`),
      `@echo off\r\n"${process.execPath}" "%~dp0version.cjs" %*\r\n`,
    );

    const env = {
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec,
      TEMP: directory,
      TMP: directory,
      Path: directory,
      pAtHeXt: ".CMD;.EXE;.COM;.BAT",
      ARGUMENT_EXPANSION_FIXTURE: "expanded fixture argument",
    };

    async function run(name: string, command: string, args: string[]) {
      const events = await readEvents(
        streamProviderInstallation({
          providerId: `windows-${name}-fixture`,
          plan: {
            command,
            args,
            displayCommand: "owned native updater fixture",
          },
          env,
        }),
      );

      outcomes.push({
        name,
        output: output(events),
        finalEvent: events.at(-1) ?? null,
      });
      recordResources(`after-${name}`);

      return events;
    }

    for (const kind of ["native", "cmd", "absolute"]) {
      const command =
        kind === "native" ? nativeName : kind === "cmd" ? cmdName : nativePath;

      const events = await run(kind, command, ["--version"]);
      assert.ok(
        output(events).includes(
          kind === "cmd" ? 'OMNYO_CMD ["--version"]' : process.version,
        ),
        `Unexpected ${kind} fixture output`,
      );
      assert.deepEqual(events.at(-1), {
        type: "completed",
        provider: `windows-${kind}-fixture`,
        exitCode: 0,
        signal: null,
        success: true,
      });
      checks.push(`${kind}: child PATH and original arguments`);
    }

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

    const batch = await run("batch-arguments", cmdName, args);
    assert.ok(
      output(batch).includes(`OMNYO_CMD ${JSON.stringify(args)}`),
      "Batch arguments were changed by the command interpreter",
    );
    const batchFinal = batch.at(-1);
    assert.ok(batchFinal?.type === "completed" && batchFinal.success);
    checks.push(
      "batch: spaces, quotes, metacharacters, Unicode and empty arguments",
    );
    const missingName = `omnyo-update-missing-${randomUUID()}`;
    const missing = await run("missing", missingName, []);
    const missingFinal = missing.at(-1);
    assert.ok(
      missingFinal?.type === "error" &&
        missingFinal.message.includes(missingName),
    );
    const afterMissing = await run("after-missing", nativePath, ["--version"]);
    const afterMissingFinal = afterMissing.at(-1);
    assert.ok(
      afterMissingFinal?.type === "completed" && afterMissingFinal.success,
    );
    checks.push(
      "missing command: visible error and released installation lock",
    );
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

    for (const kind of ["native", "cmd"]) {
      updaterPid = undefined;
      updaterReader = streamProviderInstallation({
        providerId: `windows-cancel-${kind}-fixture`,
        plan: {
          command: kind === "native" ? process.execPath : batchScript,
          args: kind === "native" ? [script] : [],
          displayCommand: "owned updater fixture",
        },
        env,
      }).getReader();
      let text = "";

      const timeout = setTimeout(() => {
        void updaterReader?.cancel().catch((error: unknown) => {
          recordFailure(error);
        });
      }, 10_000);

      try {
        while (updaterPid === undefined) {
          const chunk: ReadableStreamReadResult<Uint8Array> =
            await updaterReader.read();

          assert.equal(chunk.done, false, "Updater stopped before readiness");
          text += new TextDecoder().decode(chunk.value);
          const match = /OMNYO_READY:(\d+)/u.exec(text);

          if (match) updaterPid = Number(match[1]);
        }
      } finally {
        clearTimeout(timeout);
      }

      await updaterReader.cancel();
      await waitForExit(updaterPid);

      const afterCancel = await run(`after-cancel-${kind}`, nativePath, [
        "--version",
      ]);

      const afterCancelFinal = afterCancel.at(-1);
      assert.ok(
        afterCancelFinal?.type === "completed" && afterCancelFinal.success,
      );
      checks.push(
        `${kind} cancellation: owned updater exited and installation lock released`,
      );
      recordResources(`after-${kind}-cancellation`);
    }

    if (report.failure === null) report.status = "passed";
  } catch (error) {
    recordFailure(error);
  } finally {
    recordResources("before-cleanup");
    let updaterStopped = true;

    try {
      await updaterReader?.cancel();
    } catch (error) {
      updaterStopped = false;
      recordFailure(error, true);
    }

    try {
      if (updaterPid !== undefined && isRunning(updaterPid)) {
        process.kill(updaterPid);
        await waitForExit(updaterPid);
      }
    } catch (error) {
      updaterStopped = false;
      recordFailure(error, true);
    }

    try {
      process.chdir(previousCwd);

      if (root !== undefined && updaterStopped) {
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
        report.scratchRemoved = true;
      }
    } catch (error) {
      recordFailure(error, true);
    }

    recordResources("after-cleanup");

    await writeFile(outputPath, JSON.stringify(report, null, 2), {
      flag: "wx",
    });
  }
}

await main();
