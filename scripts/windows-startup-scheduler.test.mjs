import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

const installer = fileURLToPath(
  new URL(
    "../apps/server/src/assets/install-machine-windows.mjs",
    import.meta.url,
  ),
);

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function powershell(script) {
  return exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        `$ErrorActionPreference='Stop'; ${script}; exit 0`,
        "utf16le",
      ).toString("base64"),
    ],
    { windowsHide: true },
  );
}

test(
  "Windows retries a failed foreground service, honors an explicit stop, and reuses its task on start",
  { skip: process.platform !== "win32", timeout: 210_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "omnyo-scheduler-contract-"));
    const taskName = `Omnyo-Startup-Contract-${randomUUID()}`;
    process.stdout.write(
      `Owned scheduler fixture: ${root}; task: ${taskName}\n`,
    );
    const hostId = "host_scheduler_fixture";
    const prefix = join(root, "npm");
    const dist = join(prefix, "node_modules", "omnyo-app", "dist");
    const counter = join(root, "starts.jsonl");
    const installedInstaller = join(root, "install-machine-windows.mjs");
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

    const argumentsLine = [
      installedInstaller,
      "--run",
      "--host-id",
      hostId,
      "--data-dir",
      root,
    ]
      .map((part) => `"${part}"`)
      .join(" ");

    const lifecycle = (action) =>
      exec(
        process.execPath,
        [installedInstaller, action, "--host-id", hostId, "--data-dir", root],
        { windowsHide: true },
      );

    const starts = async () =>
      (await readFile(counter, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

    try {
      await mkdir(dist, { recursive: true });
      await writeFile(installedInstaller, await readFile(installer));
      await writeFile(
        join(root, "machine-service.json"),
        JSON.stringify({
          hostId,
          serverUrl: "https://omnyo.example.invalid",
          npmPrefix: prefix,
          hostDaemonPort: port,
        }),
      );
      await writeFile(
        join(dist, "omnyo-app.js"),
        `const fs=require('node:fs'); const counter=${JSON.stringify(counter)}; const previous=fs.existsSync(counter)?fs.readFileSync(counter,'utf8').trim().split('\\n').filter(Boolean).length:0; fs.appendFileSync(counter,JSON.stringify({pid:process.pid,start:previous+1})+'\\n'); require('node:http').createServer((_q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({hostId:${JSON.stringify(hostId)},serverUrl:'https://omnyo.example.invalid',connected:true}));}).listen(${port},'127.0.0.1'); if(previous===0)setTimeout(()=>process.exit(23),1000);`,
      );
      await powershell(
        `$action=New-ScheduledTaskAction -Execute ${quote(process.execPath)} -Argument ${quote(argumentsLine)} -WorkingDirectory ${quote(root)}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $principal=New-ScheduledTaskPrincipal -UserId $sid -LogonType S4U -RunLevel Limited; $settings=New-ScheduledTaskSettingsSet -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew; $trigger=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddSeconds(5)) -RepetitionInterval (New-TimeSpan -Minutes 1); Register-ScheduledTask -TaskName ${quote(taskName)} -Action $action -Principal $principal -Settings $settings -Trigger $trigger | Out-Null`,
      );
      process.stdout.write(
        "Waiting at most 90 seconds for the native one-minute failure retry.\n",
      );
      const deadline = Date.now() + 90_000;

      while ((await starts()).length < 2 && Date.now() < deadline)
        await delay(1000);
      const recovered = await starts();
      assert.equal(
        recovered.length,
        2,
        "Task Scheduler did not restart the failed launcher",
      );
      assert.notEqual(recovered[0].pid, recovered[1].pid);
      await lifecycle("--stop");

      const { stdout: stopped } = await powershell(
        `(Get-ScheduledTask -TaskName ${quote(taskName)}).State.ToString()`,
      );

      assert.equal(stopped.trim(), "Disabled");
      process.stdout.write(
        "Intentional stop disabled the task; observing one full recovery interval.\n",
      );
      await delay(65_000);
      assert.equal(
        (await starts()).length,
        2,
        "An explicitly stopped worker was restarted",
      );
      await lifecycle("--start");
      assert.equal((await starts()).length, 3);

      const { stdout: running } = await powershell(
        `(Get-ScheduledTask -TaskName ${quote(taskName)}).State.ToString()`,
      );

      assert.equal(running.trim(), "Running");
      await lifecycle("--uninstall");

      const { stdout: remaining } = await powershell(
        `@(Get-ScheduledTask -TaskName ${quote(taskName)} -ErrorAction SilentlyContinue).Count`,
      );

      assert.equal(remaining.trim(), "0");
      process.stdout.write(
        "Verified failure recovery, intentional stop, task-owned start and uninstall.\n",
      );
    } finally {
      await powershell(
        `$task=Get-ScheduledTask -TaskName ${quote(taskName)} -ErrorAction SilentlyContinue; if($task){Stop-ScheduledTask -TaskName ${quote(taskName)}; Unregister-ScheduledTask -TaskName ${quote(taskName)} -Confirm:$false}`,
      );

      const { stdout: survivors } = await powershell(
        `@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${quote(root)}) }).Count`,
      );

      assert.equal(
        survivors.trim(),
        "0",
        `Fixture processes remain under ${root}`,
      );
      await rm(root, { recursive: true, force: true });
      process.stdout.write(`Fixture removed: ${root}\n`);
    }
  },
);
