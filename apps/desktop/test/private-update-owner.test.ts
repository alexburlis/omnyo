import { deferred } from "./fixtures/deferred.js";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createPrivateDesktopUpdateInstaller } from "../src/private-update-install.js";

const owned: { child: ChildProcess; root: string }[] = [];

const version = "0.46.2+private.2";

const artifact = {
  runtimeSha256: "0".repeat(64),
  version: "0.46.2",
  runtimeVersion: version,
  protocolVersion: 234,
  appId: "dev.omnyo.private",
  teamId: "Z7T4C33A35",
  sha512: Buffer.alloc(64, 1).toString("base64"),
};

const readySchema = z
  .object({ url: z.url(), pid: z.number().int().positive() })
  .strict();

function fixtureReady(child: ChildProcess) {
  return new Promise<z.infer<typeof readySchema>>((resolve, reject) => {
    let text = "";

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.removeListener("data", data);
      child.removeListener("error", failed);
      child.removeListener("exit", exited);
    };

    const failed = () => {
      cleanup();
      reject(new Error("Owned fixture readiness failed"));
    };

    const exited = () => failed();

    const data = (chunk: Buffer) => {
      text += chunk.toString("utf8");

      if (text.length > 4096) return failed();

      if (!text.includes("\n")) return;

      try {
        const ready = readySchema.parse(JSON.parse(text.split("\n")[0] ?? ""));
        cleanup();
        resolve(ready);
      } catch {
        failed();
      }
    };

    const timeout = setTimeout(failed, 5000);
    child.stdout?.on("data", data);
    child.once("error", failed);
    child.once("exit", exited);
  });
}

async function stopFixture(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const exited = () => {
      clearTimeout(timeout);
      resolve();
    };

    const timeout = setTimeout(() => {
      child.removeListener("exit", exited);
      reject(
        new Error("Owned fixture did not stop; its outputs remain retained"),
      );
    }, 5000);

    child.once("exit", exited);
    child.kill("SIGTERM");
  });
}

async function journey(options: { refusal?: string; mismatch?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "omnyo-private-update-owner-"));
  const script = join(root, "launcher.cjs");
  const logPath = join(root, "requests.jsonl");
  const controlPath = join(root, "control.json");
  await writeFile(controlPath, JSON.stringify(options));

  const serverSource = `
const http=require('node:http');const fs=require('node:fs');const dataDir=${JSON.stringify(root)};const releasedPath=dataDir+'/provider-released.json';const holdPath=dataDir+'/provider-held.json';let hold=fs.existsSync(holdPath)?JSON.parse(fs.readFileSync(holdPath,'utf8')):null;
const runtime={runtimeId:'fixture-runtime',processId:process.pid,parentProcessId:process.ppid,launchId:'fixture-launch',dataDir,serverHostId:'fixture-host',appVersion:'0.46.1+private.1',protocolVersion:234};
const activity={runningThreads:0,pendingInteractions:0,hostRpcs:0,provisioning:0,queuedDispatches:0,pluginLoads:0,pluginInvocations:0,hungServices:0};
const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const parsed=body?JSON.parse(body):null;
fs.appendFileSync(${JSON.stringify(logPath)},JSON.stringify({path:req.url,body:parsed})+'\\n');
const control=JSON.parse(fs.readFileSync(${JSON.stringify(controlPath)},'utf8'));if(hold&&control.holdPhase)hold.phase=control.holdPhase;const observed={...runtime,...(control.replacement?{runtimeId:'replacement-runtime',appVersion:control.replacement}:{})};
if(control.mismatch==='parent')observed.parentProcessId+=1;if(control.mismatch==='pid')observed.processId=1;if(control.mismatch==='dataDir')observed.dataDir+='/different';if(control.mismatch==='protocol')observed.protocolVersion=999;
if(req.url.endsWith('/acquire')){if(control.refusal==='lost'){req.socket.destroy();return;}if(control.refusal==='busy'){res.writeHead(409);res.end('{}');return;}hold={version:1,id:parsed.id,ownerId:parsed.ownerId,kind:'desktop-update',phase:'held',serverHostId:'fixture-host',createdAt:1,artifact:null};fs.writeFileSync(holdPath,JSON.stringify(hold));res.end(JSON.stringify({acquired:true,runtime:observed,hold}));}
else if(req.url.endsWith('/release')){const receipt=fs.existsSync(releasedPath)?JSON.parse(fs.readFileSync(releasedPath,'utf8')):null;if(!hold){if(receipt&&receipt.id===parsed.id&&receipt.ownerId===parsed.ownerId){res.end(JSON.stringify({released:true,id:parsed.id}));return;}res.writeHead(409);res.end('{}');return;}if(parsed.id!==hold.id||parsed.ownerId!==hold.ownerId){res.writeHead(409);res.end('{}');return;}fs.writeFileSync(releasedPath,JSON.stringify({id:parsed.id,ownerId:parsed.ownerId}));hold=null;fs.rmSync(holdPath);if(control.dropRelease){control.dropRelease=false;fs.writeFileSync(${JSON.stringify(controlPath)},JSON.stringify(control));req.socket.destroy();return;}res.end(JSON.stringify({released:true,id:parsed.id}));}
else res.end(JSON.stringify({contractVersion:1,runtime:observed,hold,activity}));});
server.listen(JSON.parse(fs.readFileSync(${JSON.stringify(controlPath)},'utf8')).port||0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port,pid:process.pid})));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`;

  await writeFile(
    script,
    `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(serverSource)}],{stdio:['ignore','pipe','ignore']});c.stdout.pipe(process.stdout);process.on('SIGTERM',()=>c.kill('SIGTERM'));c.on('exit',()=>process.exit(0));`,
  );

  let child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });

  owned.push({ child, root });

  let ready = await fixtureReady(child);

  const calls: string[] = [];
  let kind: "owned" | "attached" | "unknown" | "remote-only" = "owned";
  let replacement = "0.46.1+private.1";
  let rejectStage = false;
  let verification = Promise.resolve();
  let verificationCalls = 0;
  let installedArtifact = artifact;
  let installedInspections = 0;
  let stageWait = Promise.resolve();
  const journalPath = join(root, "handoff.json");

  const makeBoundary = () =>
    createPrivateDesktopUpdateInstaller({
      verifyInstalledArtifact() {
        verificationCalls += 1;

        return verification;
      },
      journalPath,
      currentVersion: () => replacement,
      protocolVersion: 234,
      runtime: () =>
        kind === "owned"
          ? { kind: "owned", child, dataDir: root, serverUrl: ready.url }
          : { kind },
      inspectArtifact: async () => artifact,
      inspectInstalledArtifact: async () => {
        installedInspections += 1;

        return installedArtifact;
      },
      async stageNativeUpdate() {
        calls.push("native");
        await stageWait;

        if (rejectStage) throw new Error("Synthetic uncertain native handoff");
      },
      async finishQuit() {
        calls.push("shutdown");
      },
      quitAndInstall() {
        calls.push("install");
      },
    });

  return {
    boundary: makeBoundary(),
    recreateBoundary: makeBoundary,
    async control(value: { refusal?: string | null; dropRelease?: boolean }) {
      const old = JSON.parse(await readFile(controlPath, "utf8"));
      await writeFile(controlPath, JSON.stringify({ ...old, ...value }));
    },
    async holdPhase(phase: string) {
      const control = JSON.parse(await readFile(controlPath, "utf8"));
      await writeFile(
        controlPath,
        JSON.stringify({ ...control, holdPhase: phase }),
      );
    },
    calls,
    child,
    journalPath,
    setVerification(value: Promise<void>) {
      verification = value;
    },
    verificationCalls() {
      return verificationCalls;
    },
    setInstalledArtifact(value: typeof artifact) {
      installedArtifact = value;
    },
    installedInspections() {
      return installedInspections;
    },
    setStageWait(value: Promise<void>) {
      stageWait = value;
    },
    setKind(value: typeof kind) {
      kind = value;
    },
    setStageFailure() {
      rejectStage = true;
    },
    async replace(value: string, mismatch?: string) {
      replacement = value;
      const port = Number(new URL(ready.url).port);
      await writeFile(
        controlPath,
        JSON.stringify({ replacement: value, mismatch, port }),
      );

      await stopFixture(child);
      child = spawn(process.execPath, [script], {
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      });
      owned.push({ child, root });
      ready = await fixtureReady(child);
    },
    async requests() {
      return (await readFile(logPath, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

afterEach(async () => {
  const items = owned.splice(0);

  for (const item of items) {
    await stopFixture(item.child);
  }

  for (const root of new Set(items.map((item) => item.root))) {
    await rm(root, { recursive: true, force: true });
    expect(
      await stat(root).then(
        () => false,
        (error) => error.code === "ENOENT",
      ),
    ).toBe(true);
  }
});

describe("private desktop install owner and restart boundary", () => {
  it("waits for full bootstrap verification before creating a journal or acquiring a hold", async () => {
    const j = await journey();
    const verification = deferred();
    j.setVerification(verification.promise);
    const install = j.boundary.install();

    try {
      expect(j.verificationCalls()).toBe(1);
      expect(j.boundary.canQuitOrdinarily()).toBe(false);
      expect(await j.requests()).toEqual([]);
      expect(j.calls).toEqual([]);
      await expect(stat(j.journalPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      verification.resolve();
      await install;
    }

    expect(j.calls).toEqual(["native", "shutdown", "install"]);
  });

  it("rejects bootstrap verification before any journal, hold or native mutation", async () => {
    const j = await journey();
    const verification = deferred();
    j.setVerification(verification.promise);
    const install = j.boundary.install();

    const rejected = expect(install).rejects.toThrow(
      "fixture bootstrap rejected",
    );

    verification.reject(new Error("fixture bootstrap rejected"));
    await rejected;
    expect(await j.requests()).toEqual([]);
    expect(j.calls).toEqual([]);
    expect(j.boundary.canQuitOrdinarily()).toBe(true);
    await expect(stat(j.journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["prepared", "held", "handoff"])(
    "retains the %s journal and exact hold while replacement verification is pending or rejected",
    async (phase) => {
      const j = await journey();
      await j.boundary.install();

      const journal = {
        ...JSON.parse(await readFile(j.journalPath, "utf8")),
        phase,
      };

      await writeFile(j.journalPath, JSON.stringify(journal));
      const initialRequests = await j.requests();
      const verification = deferred();
      j.setVerification(verification.promise);
      const owner = j.recreateBoundary();
      expect(owner.canQuitOrdinarily()).toBe(phase !== "handoff");
      const recovering = owner.recover();

      const rejected = expect(recovering).rejects.toThrow(
        "fixture replacement rejected",
      );

      expect(j.verificationCalls()).toBe(2);
      expect(await j.requests()).toEqual(initialRequests);
      verification.reject(new Error("fixture replacement rejected"));
      await rejected;
      expect(await j.requests()).toEqual(initialRequests);
      expect(JSON.parse(await readFile(j.journalPath, "utf8"))).toEqual(
        journal,
      );
    },
  );

  it("compares the replacement against the journal independently of updater feed configuration", async () => {
    const j = await journey();
    await j.boundary.install();
    await j.replace(version);
    j.setInstalledArtifact({ ...artifact, runtimeSha256: "f".repeat(64) });
    const owner = j.recreateBoundary();
    await expect(owner.recover()).rejects.toThrow(
      "replacement identity does not match",
    );
    expect(j.installedInspections()).toBe(1);
    expect(
      (await j.requests()).some((request) => request.path.endsWith("/release")),
    ).toBe(false);
    expect(owner.canQuitOrdinarily()).toBe(false);
  });

  it("serializes startup recovery behind an install already waiting for native acceptance", async () => {
    const j = await journey();
    const stage = deferred();
    j.setStageWait(stage.promise);
    const install = j.boundary.install();

    try {
      await expect.poll(() => j.calls).toEqual(["native"]);
      const recovery = j.boundary.recover();

      const rejected = expect(recovery).rejects.toThrow(
        "replacement identity does not match",
      );

      await Promise.resolve();
      expect(j.installedInspections()).toBe(0);
      stage.resolve();
      await install;
      await rejected;
      expect(j.calls).toEqual(["native", "shutdown", "install"]);
      expect(
        (await j.requests()).some((request) =>
          request.path.endsWith("/release"),
        ),
      ).toBe(false);
    } finally {
      stage.resolve();
      await install;
    }
  });

  it("updates a remote-only desktop with no coordinator request or local stop", async () => {
    const j = await journey();
    j.setKind("remote-only");
    await j.boundary.install();
    expect(await j.requests()).toEqual([]);
    expect(j.calls).toEqual(["native", "shutdown", "install"]);
  });
  it.each(["attached", "unknown"] as const)(
    "refuses %s ownership before control or native effects",
    async (kind) => {
      const j = await journey();
      j.setKind(kind);
      await expect(j.boundary.install()).rejects.toThrow();
      expect(await j.requests()).toEqual([]);
      expect(j.calls).toEqual([]);
      expect(j.child.exitCode).toBeNull();
    },
  );
  it.each(["parent", "pid", "dataDir"])(
    "refuses actual owned %s mismatch while preserving the live launcher",
    async (mismatch) => {
      const j = await journey({ mismatch });
      await expect(j.boundary.install()).rejects.toThrow();
      expect(
        (await j.requests()).some((r) => r.path.endsWith("/acquire")),
      ).toBe(false);
      expect(j.calls).toEqual([]);
      expect(j.child.exitCode).toBeNull();
    },
  );
  it.each(["busy", "lost"])(
    "preserves the live child and exact journal on %s acquisition",
    async (refusal) => {
      const j = await journey({ refusal });
      await expect(j.boundary.install()).rejects.toThrow();
      expect(j.calls).toEqual([]);
      expect(j.child.exitCode).toBeNull();
      const saved = JSON.parse(await readFile(j.journalPath, "utf8"));
      expect(saved.ownerId).toBeTruthy();
      expect(saved.id).toBeTruthy();
      expect(
        (await j.requests()).some((r) => r.path.endsWith("/release")),
      ).toBe(false);
    },
  );
  it("retries a definite busy refusal after actual work clears in the same desktop process", async () => {
    const j = await journey({ refusal: "busy" });
    await expect(j.boundary.install()).rejects.toThrow();
    expect(j.calls).toEqual([]);
    await j.control({ refusal: null });
    await j.boundary.install();
    expect(j.calls).toEqual(["native", "shutdown", "install"]);
  });
  it("reconciles an exact-owner release receipt after the committed acknowledgement is lost", async () => {
    const j = await journey();
    await j.boundary.install();
    await j.replace(version);
    await j.control({ dropRelease: true });
    await expect(j.boundary.recover()).rejects.toThrow();
    await j.recreateBoundary().recover();
    expect(JSON.parse(await readFile(j.journalPath, "utf8")).phase).toBe(
      "released",
    );

    const releases = (await j.requests()).filter((r) =>
      r.path.endsWith("/release"),
    );

    expect(releases).toHaveLength(2);
    expect(releases[1].body).toEqual(releases[0].body);
    expect(j.calls).toEqual(["native", "shutdown", "install"]);
  });
  it.each(["acquiring", "releasing"])(
    "reconciles matching %s owner state using the authoritative release route",
    async (phase) => {
      const j = await journey();
      await j.boundary.install();
      await j.replace(version);
      await j.holdPhase(phase);
      await j.recreateBoundary().recover();
      expect(JSON.parse(await readFile(j.journalPath, "utf8")).phase).toBe(
        "released",
      );
    },
  );
  it("refuses a foreign journal ID after another owner has a committed release receipt", async () => {
    const j = await journey();
    await j.boundary.install();
    await j.replace(version);
    await j.control({ dropRelease: true });
    await expect(j.boundary.recover()).rejects.toThrow();
    const journal = JSON.parse(await readFile(j.journalPath, "utf8"));
    await writeFile(
      j.journalPath,
      JSON.stringify({
        ...journal,
        id: "b127216c-eb53-440f-9f2b-c9b1f25a50c5",
      }),
    );
    await expect(j.recreateBoundary().recover()).rejects.toThrow();
    expect(JSON.parse(await readFile(j.journalPath, "utf8")).phase).not.toBe(
      "released",
    );
  });
  it("preserves an ambiguous acquisition and stable owner when a same-session retry is still unacknowledged", async () => {
    const j = await journey({ refusal: "lost" });
    await expect(j.boundary.install()).rejects.toThrow();
    const initial = JSON.parse(await readFile(j.journalPath, "utf8"));
    await expect(j.boundary.install()).rejects.toThrow();
    expect(JSON.parse(await readFile(j.journalPath, "utf8"))).toEqual(initial);
    expect(j.calls).toEqual([]);
  });
  it("allows ordinary quit before staging without install or maintenance requests", async () => {
    const j = await journey();
    expect(j.boundary.canQuitOrdinarily()).toBe(true);
    expect(j.calls).toEqual([]);
    expect(await j.requests()).toEqual([]);
  });
  it("retains a durable owner hold on uncertain native staging and refuses ordinary quit", async () => {
    const j = await journey();
    j.setStageFailure();
    await expect(j.boundary.install()).rejects.toThrow();
    expect(j.calls).toEqual(["native"]);
    expect(j.boundary.canQuitOrdinarily()).toBe(false);
    expect(JSON.parse(await readFile(j.journalPath, "utf8")).phase).toBe(
      "native-started",
    );
    expect((await j.requests()).some((r) => r.path.endsWith("/release"))).toBe(
      false,
    );
  });
  it("refuses old/mismatched replacement boot and releases only the exact journal owner after matching boot", async () => {
    const j = await journey();
    await j.boundary.install();
    expect(j.calls).toEqual(["native", "shutdown", "install"]);
    await expect(j.boundary.recover()).rejects.toThrow();
    await j.replace(version, "protocol");
    await expect(j.boundary.recover()).rejects.toThrow();
    expect((await j.requests()).some((r) => r.path.endsWith("/release"))).toBe(
      false,
    );
    await j.replace(version);
    await j.boundary.recover();
    const requests = await j.requests();
    const acquired = requests.find((r) => r.path.endsWith("/acquire"));
    const released = requests.find((r) => r.path.endsWith("/release"));
    expect(released.body.id).toBe(acquired.body.id);
    expect(released.body.ownerId).toBe(acquired.body.ownerId);
    expect(released.body.expectedServerHostId).toBe("fixture-host");
  });
});
