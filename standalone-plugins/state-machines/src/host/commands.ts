import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, realpath, readdir, stat, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { atomicWrite, readReceipt, readSpec, readLog } from "./journal.js";
import { commandSpecSchema, type CommandReceipt, type CommandSpec } from "../contracts/host.js";

export class CommandHost {
  private readonly active = new Map<string, ChildProcess>();
  private readonly finishing = new Map<string, Promise<void>>();
  private readonly accounted = new Map<string, number>();
  private retainedBytes: number | null = null;
  private admission = Promise.resolve();
  private readonly storageLimitBytes: number;

  constructor(
    private readonly dataDir: string,
    private readonly runtimePath: string,
    private readonly onIdle: () => void = () => {},
    options: { storageLimitBytes?: number } = {},
  ) {
    this.storageLimitBytes = options.storageLimitBytes ?? 262_144_000;

    if (!Number.isSafeInteger(this.storageLimitBytes) || this.storageLimitBytes < 1)
      throw new Error("Invalid command storage limit");
  }

  get activeCount() {
    return this.active.size;
  }

  private directory(attemptId: string) {
    return join(this.dataDir, "invocations", attemptId);
  }

  private async admit<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.admission;
    let release = () => {};

    this.admission = new Promise<void>((resolveAdmission) => {
      release = resolveAdmission;
    });
    await previous;

    try {
      return await operation();
    } finally {
      release();
    }
  }

  private reservation(spec: CommandSpec) {
    return Buffer.byteLength(JSON.stringify(spec)) + spec.outputBytes + 32_768;
  }

  private async bytes(directory: string): Promise<number> {
    let total = 0;

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile())
        throw new Error("INVOCATION_UNCERTAIN: command journal contains unexpected storage");

      try {
        total += (await stat(join(directory, entry.name))).size;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }

    return total;
  }

  private async initializeStorage(): Promise<void> {
    if (this.retainedBytes !== null) return;
    const measured = new Map<string, number>();
    let total = 0;

    for (const entry of await readdir(join(this.dataDir, "invocations"), { withFileTypes: true })) {
      if (!entry.isDirectory())
        throw new Error("INVOCATION_UNCERTAIN: command journal contains unexpected storage");
      const directory = this.directory(entry.name);
      let accounted: number;

      try {
        const actual = await this.bytes(directory);
        const spec = await readSpec(directory);
        const receipt = await readReceipt(directory);

        if (spec.attemptId !== entry.name || (receipt && receipt.specHash !== spec.specHash))
          throw new Error("Command journal identity differs");
        accounted = receipt?.quiescent ? actual : Math.max(actual, this.reservation(spec));
      } catch {
        throw new Error("INVOCATION_UNCERTAIN: existing command storage cannot be reconciled");
      }

      measured.set(entry.name, accounted);
      total += accounted;
    }

    for (const [id, accounted] of measured) this.accounted.set(id, accounted);
    this.retainedBytes = total;
  }

  private async duplicate(spec: CommandSpec): Promise<CommandReceipt | null> {
    const directory = this.directory(spec.attemptId);

    try {
      await stat(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }

    let existing: CommandSpec;

    try {
      existing = await readSpec(directory);
    } catch {
      throw new Error("INVOCATION_UNCERTAIN: prior submit has no valid specification");
    }

    if (existing.specHash !== spec.specHash)
      throw new Error("REVISION_CONFLICT: invocation spec differs");
    const receipt = await this.inspect(spec.attemptId, spec.specHash);

    if (!receipt) throw new Error("INVOCATION_UNCERTAIN: prior submit has no receipt");

    return receipt;
  }

  async submit(input: CommandSpec): Promise<CommandReceipt> {
    if (process.platform === "win32")
      throw new Error("CAPABILITY_UNAVAILABLE: Windows command containment is not enabled");
    const spec = commandSpecSchema.parse(input);

    return this.admit(async () => this.launch(spec));
  }

  private async launch(spec: CommandSpec): Promise<CommandReceipt> {
    const duplicate = await this.duplicate(spec);

    if (duplicate) return duplicate;

    if (spec.deadlineAt <= Date.now() || spec.deadlineAt > Date.now() + 7200000)
      throw new Error("Invalid command deadline");
    const root = await realpath(spec.rootPath);
    const cwd = await realpath(resolve(root, spec.cwd || "."));
    const rel = relative(root, cwd);

    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("SCOPE_MISMATCH: command cwd escapes environment");
    spec.rootPath = root;
    spec.cwd = cwd;
    await mkdir(join(this.dataDir, "invocations"), { recursive: true, mode: 0o700 });
    await this.initializeStorage();
    const reserved = this.reservation(spec);

    if (this.retainedBytes! + reserved > this.storageLimitBytes)
      throw new Error(
        "BACKPRESSURE: retained command storage reached its limit; awaiting safe acknowledged cleanup",
      );
    const directory = this.directory(spec.attemptId);

    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const receipt = await this.duplicate(spec);

      if (!receipt) throw new Error("INVOCATION_UNCERTAIN: prior submit disappeared");

      return receipt;
    }

    this.accounted.set(spec.attemptId, reserved);
    this.retainedBytes = this.retainedBytes! + reserved;

    await atomicWrite(join(directory, "spec.json"), JSON.stringify(spec));

    const initial: CommandReceipt = {
      attemptId: spec.attemptId,
      specHash: spec.specHash,
      status: "launching",
      pid: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      reason: null,
      quiescent: false,
      bytes: 0,
    };

    await atomicWrite(join(directory, "receipt.json"), JSON.stringify(initial));

    const child = spawn(
      process.execPath,
      [this.runtimePath, "--state-machine-command", directory],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          TMPDIR: process.env.TMPDIR,
        },
      },
    );

    this.active.set(spec.attemptId, child);
    this.finishing.set(
      spec.attemptId,
      new Promise<void>((complete) => {
        let settled = false;

        const finish = () => {
          if (settled) return;
          settled = true;
          void this.finished(spec.attemptId, directory, child).finally(complete);
        };

        child.once("exit", finish);
        child.once("error", finish);
      }),
    );

    return initial;
  }

  private async finished(id: string, directory: string, child: ChildProcess) {
    if (this.active.get(id) !== child) return;
    let quiescent = false;

    const until = Date.now() + 1000;

    while (child.pid && Date.now() < until) {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
          quiescent = true;
          break;
        }
      }

      await delay(10);
    }

    await this.admit(async () => {
      const receipt = await readReceipt(directory);

      if (receipt)
        await atomicWrite(
          join(directory, "receipt.json"),
          JSON.stringify({
            ...receipt,
            status:
              quiescent && !["launching", "running"].includes(receipt.status)
                ? receipt.status
                : "uncertain",
            quiescent,
            reason: quiescent ? receipt.reason : "Process group quiescence is not verified",
          }),
        );

      if (quiescent && this.retainedBytes !== null) {
        const actual = await this.bytes(directory);
        this.retainedBytes += actual - (this.accounted.get(id) ?? 0);
        this.accounted.set(id, actual);
      }

      this.active.delete(id);
      this.finishing.delete(id);

      if (!this.active.size) this.onIdle();
    });
  }

  async inspect(id: string, hash: string): Promise<CommandReceipt | null> {
    const receipt = await readReceipt(this.directory(id));

    if (!receipt) return null;

    if (receipt.attemptId !== id || receipt.specHash !== hash)
      throw new Error("REVISION_CONFLICT: invocation spec differs");

    if (!receipt.quiescent && !this.active.has(id) && receipt.status !== "uncertain")
      return { ...receipt, status: "uncertain", reason: "Supervisor ownership unavailable" };

    return receipt;
  }

  async cancel(id: string, hash: string) {
    const receipt = await this.inspect(id, hash);
    const child = this.active.get(id);

    if (child?.connected) child.send("cancel");

    return receipt;
  }

  log(id: string, cursor: number, limit: number) {
    return readLog(this.directory(id), cursor, limit);
  }

  async acknowledge(id: string, hash: string) {
    return this.admit(async () => {
      const directory = this.directory(id);
      const receipt = await this.inspect(id, hash);

      if (!receipt) {
        try {
          await stat(directory);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return { acknowledged: true };
          throw error;
        }

        throw new Error("INVOCATION_UNCERTAIN: prior submit has no receipt");
      }

      if (!receipt.quiescent || this.active.has(id) || this.finishing.has(id))
        throw new Error("STOP_PENDING: invocation storage is still owned by active work");
      const spec = await readSpec(directory);

      if (spec.attemptId !== id || spec.specHash !== hash)
        throw new Error("REVISION_CONFLICT: invocation spec differs");
      await rm(directory, { recursive: true });

      if (this.retainedBytes !== null) this.retainedBytes -= this.accounted.get(id) ?? 0;
      this.accounted.delete(id);

      return { acknowledged: true };
    });
  }

  async dispose() {
    for (const child of this.active.values()) if (child.connected) child.send("cancel");
    await Promise.allSettled(this.finishing.values());
  }
}
