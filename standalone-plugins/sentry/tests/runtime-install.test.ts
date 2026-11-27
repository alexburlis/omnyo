import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

const installer = resolve("scripts/install-runtime.mjs");

async function attempt(options: {
  recovery: boolean;
  state?: string;
  queuedMessages?: number;
  backgroundAgents?: number;
  activeRun?: boolean;
  startedQueue?: boolean;
  inventoryFull?: boolean;
  policyAfterInstall?: { day?: string; started?: number; remaining?: number; dailyLimit?: number };
  previous?: { source: string; rootDir: string } | "checkout";
  stranded?: { chatExists?: boolean; taskStatus?: string; stepState?: string };
}) {
  const scratch = await mkdtemp(join(tmpdir(), "sentry-install-guard-"));

  try {
    await mkdir(join(scratch, "scripts"));
    await mkdir(join(scratch, "docs/evidence"), { recursive: true });
    await mkdir(join(scratch, "runtime"));
    await mkdir(join(scratch, "bin"));
    await copyFile(installer, join(scratch, "scripts/install-runtime.mjs"));
    await writeFile(join(scratch, "runtime/server.js"), "verified candidate\n");
    await writeFile(
      join(scratch, "snapshot.json"),
      JSON.stringify({ directory: join(scratch, "runtime"), build: "new" }),
    );

    const run = {
      id: "run_retained",
      state: "local-ready",
      threadId: "thr_retained",
      result: { outcome: "fix-ready", commit: "a".repeat(40) },
      verification: { head: "a".repeat(40), checks: [{ exitCode: 0 }] },
    };

    const status = {
      routes: [{ id: "route_existing", enabled: true }],
      projectPolicies: [
        {
          projectId: "proj_existing",
          autoSolve: false,
          dailyLimit: 10,
          day: "2026-11-17",
          started: 2,
          remaining: 8,
        },
      ],
      batches: [{ id: "batch_existing", state: "waiting", runIds: ["run_queued"] }],
      runs: [
        run,
        {
          id: "run_queued",
          state: options.activeRun ? "investigating" : "queued",
          threadId: options.startedQueue ? "thr_uncertain" : null,
          spawnRequestedAt: options.startedQueue ? "2026-10-19T00:00:00Z" : null,
        },
      ],
    };

    if (options.stranded)
      status.runs.push({
        id: "run_stranded",
        state: "investigating",
        threadId: "thr_deleted",
        spawnRequestedAt: null,
      });

    const workflow = {
      tasks: [
        {
          runId: "run_stranded",
          status: options.stranded?.taskStatus ?? "blocked",
          steps: [{ state: "complete" }, { state: options.stranded?.stepState ?? "cancelled" }],
        },
      ],
    };

    if (options.inventoryFull)
      status.runs.push(
        ...Array.from({ length: 98 }, (_, index) => ({
          ...run,
          id: `run_old_${index}`,
          threadId: `thr_old_${index}`,
        })),
      );

    const thread = {
      id: "thr_retained",
      status: options.state ?? "idle",
      queuedMessageCount: options.queuedMessages ?? 0,
      activeBackgroundAgentCount: options.backgroundAgents ?? 0,
      originPluginId: "sentry",
    };

    const checkout = await realpath(scratch);

    const previous =
      options.previous === "checkout"
        ? { source: "path:" + checkout, rootDir: checkout }
        : (options.previous ?? {
            source: "path:/Users/me/.omnyo/plugins/local-builds/sentry/0123456789abcdef0123",
            rootDir: "/Users/me/.omnyo/plugins/local-builds/sentry/0123456789abcdef0123",
          });

    await writeFile(
      join(scratch, "scenario.json"),
      JSON.stringify({
        status,
        thread,
        threadMissing: options.stranded ? !options.stranded.chatExists : false,
        workflow,
        previous,
        policyAfterInstall: options.policyAfterInstall,
      }),
    );
    await writeFile(
      join(scratch, "bin/omnyo"),
      `#!/usr/bin/env node
const fs=require("node:fs");const crypto=require("node:crypto");const a=process.argv.slice(2);const f=JSON.parse(fs.readFileSync(process.env.SCENARIO_PATH,"utf8"));fs.appendFileSync(process.env.CALLS_PATH,JSON.stringify(a)+"\\n");let r;
if(a[0]==="status")r={dataDir:"/Users/me/.omnyo"};
else if(a[0]==="machine")r=[{id:"host_mac",status:"connected"}];
else if(a[0]==="thread"){if(f.threadMissing){process.stdout.write(JSON.stringify({ok:false,error:{code:"thread_not_found",message:"HTTP 404: Thread not found"}}));process.exit(1);}r={thread:f.thread};}
else if(a[0]==="file"){const bytes=fs.readFileSync(0);r={outcome:"written",sha256:crypto.createHash("sha256").update(bytes).digest("hex")};}
else if(a[0]==="plugin"&&a[1]==="list"){if(fs.existsSync(process.env.INSTALLED_PATH)){const d=fs.readFileSync(process.env.INSTALLED_PATH,"utf8");r=[{id:"sentry",source:"path:"+d,rootDir:d,status:"running"}];}else r=[{id:"sentry",status:"running",...f.previous}];}
else if(a[0]==="plugin"&&a[1]==="run"&&a[3]==="workflow")r=f.workflow;
else if(a[0]==="plugin"&&a[1]==="run"){r=f.status;if(fs.existsSync(process.env.INSTALLED_PATH)&&f.policyAfterInstall)r.projectPolicies=r.projectPolicies.map(p=>({...p,...f.policyAfterInstall}));}
else if(a[0]==="plugin"&&a[1]==="install"){const d=a[2].slice(5);fs.writeFileSync(process.env.INSTALLED_PATH,d);r={ok:true,plugin:{source:a[2]}};}
else throw Error("Unexpected fake omnyo operation");process.stdout.write(JSON.stringify(r));
`,
      { mode: 0o755 },
    );

    const args = [
      join(scratch, "scripts/install-runtime.mjs"),
      "--machine",
      "host_mac",
      "--preserve-state",
      "--snapshot-file",
      join(scratch, "snapshot.json"),
    ];

    if (options.recovery) args.push("--recover-stalled-run", "run_retained");

    if (options.stranded) args.push("--recover-stranded-run", "run_stranded");

    let error = "";

    try {
      await execute(process.execPath, args, {
        env: {
          PATH: join(scratch, "bin") + ":" + process.env.PATH,
          SCENARIO_PATH: join(scratch, "scenario.json"),
          CALLS_PATH: join(scratch, "calls.jsonl"),
          INSTALLED_PATH: join(scratch, "installed.txt"),
        },
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "failed";
    }

    const calls = (await readFile(join(scratch, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    return { error, calls };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

describe("runtime activation with retained Sentry work", () => {
  it("preserves configuration when daily usage rolls over during installation", async () => {
    const result = await attempt({
      recovery: true,
      policyAfterInstall: { day: "2026-11-18", started: 0, remaining: 10 },
    });

    expect(result.error).toBe("");
  });

  it("detects a change to the configured daily limit", async () => {
    const result = await attempt({ recovery: true, policyAfterInstall: { dailyLimit: 20 } });

    expect(result.error).toContain("Existing watched routes or auto-solve policies changed");
  });

  it("admits only explicitly selected verified idle completion while preserving queued owners and watched policy", async () => {
    const result = await attempt({ recovery: true });
    expect(result.error).toBe("");
    expect(result.calls.some((call) => call[0] === "plugin" && call[1] === "install")).toBe(true);
    expect(result.calls.some((call) => call[0] === "thread" && call[1] === "stop")).toBe(false);

    const activated = result.calls.findIndex(
      (call) => call[0] === "plugin" && call[1] === "install",
    );

    expect(
      result.calls.slice(activated).some((call) => call[0] === "plugin" && call[1] === "run"),
    ).toBe(true);
  });

  it("replaces a live checkout install with the transferred package", async () => {
    const result = await attempt({ recovery: true, previous: "checkout" });

    expect(result.error).toBe("");
    expect(result.calls.some((call) => call[0] === "plugin" && call[1] === "install")).toBe(true);
  });

  it("refuses a Sentry install owned by another source", async () => {
    const result = await attempt({
      recovery: true,
      previous: { source: "git:https://example.com/sentry.git", rootDir: "/tmp/other" },
    });

    expect(result.error).toContain("Another owner already installed plugin id sentry");
    expect(result.calls.some((call) => call[0] === "file" || call[1] === "install")).toBe(false);
  });

  it("refuses a bounded full inventory before transferring artifacts", async () => {
    const result = await attempt({ recovery: true, inventoryFull: true });
    expect(result.error).not.toBe("");
    expect(result.calls.some((call) => call[0] === "file" || call[1] === "install")).toBe(false);
  });

  it("installs over a blocked workflow run whose chat was deleted while keeping queued owners", async () => {
    const result = await attempt({ recovery: false, stranded: {} });

    expect(result.error).toBe("");
    expect(result.calls.some((call) => call[0] === "plugin" && call[1] === "install")).toBe(true);
    expect(result.calls.some((call) => call[0] === "thread" && call[1] === "stop")).toBe(false);
  });

  it.each([{ chatExists: true }, { taskStatus: "active" }, { stepState: "running" }])(
    "refuses stranded run recovery unless its chat is gone and its workflow settled: %j",
    async (stranded) => {
      const result = await attempt({ recovery: false, stranded });

      expect(result.error).toContain("Stranded run recovery needs");
      expect(result.calls.some((call) => call[0] === "file" || call[1] === "install")).toBe(false);
    },
  );

  it("refuses stranded run recovery beside other active execution", async () => {
    const result = await attempt({ recovery: false, activeRun: true, stranded: {} });

    expect(result.error).toContain("Stranded run recovery needs");
    expect(result.calls.some((call) => call[0] === "file" || call[1] === "install")).toBe(false);
  });

  it("keeps the normal preserve-state path closed for unsettled work", async () => {
    const result = await attempt({ recovery: false });
    expect(result.error).toContain("Settle existing Sentry work");
    expect(result.calls.some((call) => call[0] === "file" || call[1] === "install")).toBe(false);
  });

  it.each([
    { state: "active" },
    { state: "stopping" },
    { state: "error" },
    { queuedMessages: 1 },
    { backgroundAgents: 1 },
    { activeRun: true },
    { startedQueue: true },
  ])("refuses live or uncertain execution before any artifact transfer: %j", async (options) => {
    const result = await attempt({ recovery: true, ...options });
    expect(result.error).not.toBe("");
    expect(result.calls.some((call) => call[0] === "file" || call[1] === "install")).toBe(false);
  });
});
