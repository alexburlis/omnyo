import { mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { workflowDeliverySchema, workflowPlanInputSchema, type hostContract } from "../contract";
import { execute } from "./host-execution";
import { sha } from "./contract-fields";
import { hasRunMarker } from "./publication-identity";
import { digest, optionalJson, outputJson, ownedFile } from "./host-data";
import { PluginSnapshots } from "./plugin-snapshots";

import type {
  WorkflowMergeInput,
  WorkflowPlanInput,
  WorkflowPlan,
  WorkflowDeliveryInput,
  WorkflowDelivery,
  WorkflowVerification,
} from "./workflow-host-types";

type RunCommand = typeof execute;

const pullSchema = z.object({
  number: z.number().int(),
  url: z.url(),
  headRefOid: sha,
  headRefName: z.string(),
  baseRefName: z.string(),
  body: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  mergeCommit: z.object({ oid: sha }).nullable(),
  createdAt: z.iso.datetime(),
  statusCheckRollup: z.array(z.unknown()),
});

const checksAppearMs = 3 * 60_000;

const mergeJournalSchema = z.object({ requestHash: sha, attempted: z.boolean() });

const plannerSchema = z.object({
  status: z.string(),
  sourceCommit: sha,
  actions: z.array(
    z.object({ kind: z.string(), root: z.string().optional(), id: z.string().optional() }),
  ),
  unresolved: z.array(z.string()).default([]),
});

const storedPlanSchema = z.object({
  requestHash: sha,
  input: workflowPlanInputSchema.strip(),
  kind: workflowDeliverySchema.shape.kind,
  plugins: z.array(z.object({ root: z.string(), id: z.string() })),
  blocked: z.string().nullable(),
});

const deliveryJournalSchema = z.object({
  planDigest: sha,
  attempted: z.boolean(),
  acknowledgedFailure: z.string().nullable().default(null),
  result: workflowDeliverySchema.strip().nullable(),
});

const releaseReceiptSchema = z
  .object({
    status: z.string(),
    mode: z.string().optional(),
    sourceCommit: sha.optional(),
    phases: z.record(z.string(), z.object({ status: z.string() }).passthrough()).optional(),
  })
  .passthrough();

const failedReleaseStates = ["failed", "cancelled", "prepared"];

function offerVisible(receipt: z.infer<typeof releaseReceiptSchema>) {
  return (
    receipt.status === "complete" || receipt.phases?.["coordinator-offer"]?.status === "complete"
  );
}

function releaseFailed(receipt: z.infer<typeof releaseReceiptSchema>) {
  return (
    !offerVisible(receipt) &&
    (failedReleaseStates.includes(receipt.status) || receipt.mode === "prepare")
  );
}

function releaseAmbiguous(receipt: z.infer<typeof releaseReceiptSchema>) {
  return !offerVisible(receipt) && receipt.status === "ambiguous";
}

function versionAtLeast(installed: string, offered: string) {
  const parts = (version: string) => version.split("+")[0]!.split(".").map(Number);
  const [left, right] = [parts(installed), parts(offered)];

  for (let index = 0; index < 3; index += 1)
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);

  return true;
}

type JournalValue =
  | z.infer<typeof mergeJournalSchema>
  | z.infer<typeof storedPlanSchema>
  | z.input<typeof deliveryJournalSchema>;

async function atomicJson(path: string, value: JournalValue): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + ".next";
  await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

export class WorkflowHost {
  private readonly snapshots = new PluginSnapshots({
    command: (...args) => this.command(...args),
    checked: (...args) => this.checked(...args),
  });
  constructor(
    private readonly journalRoot: string,
    private readonly signal?: AbortSignal,
    private readonly run: RunCommand = execute,
  ) {}

  private path(runId: string, file: string): string {
    if (!/^[A-Za-z0-9_-]{1,120}$/u.test(runId)) throw new Error("Invalid workflow run identity");

    return join(this.journalRoot, runId, file);
  }

  private async command(program: string, args: string[], cwd: string, timeoutMs = 60_000) {
    return this.run(program, args, cwd, timeoutMs, true, this.signal);
  }

  private async checked(
    program: string,
    args: string[],
    cwd: string,
    timeoutMs = 60_000,
  ): Promise<string> {
    const result = await this.command(program, args, cwd, timeoutMs);

    if (result.exitCode !== 0 || result.termination || result.signal)
      throw new Error("Workflow operation did not complete: " + program + " " + args[0]);

    return result.output.trim();
  }

  private async repository(path: string, expected: WorkflowPlanInput["repository"], head?: string) {
    const root = await realpath(path);
    const remote = await this.checked("git", ["remote", "get-url", "origin"], root);

    if (
      ![
        "https://github.com/" + expected,
        "https://github.com/" + expected + ".git",
        "git@github.com:" + expected + ".git",
      ].includes(remote)
    )
      throw new Error("Workflow repository remote does not match its approved scope");

    if (await this.checked("git", ["status", "--porcelain", "--untracked-files=all"], root))
      throw new Error("Workflow source has uncommitted changes");

    if (head && (await this.checked("git", ["rev-parse", "HEAD"], root)) !== head)
      throw new Error("Workflow source does not match the merged commit");

    return root;
  }

  async worktreePath(input: z.infer<typeof hostContract.workflowWorktreePath.input>) {
    const root = await realpath(input.repositoryPath);

    if (!/^[A-Za-z0-9_-]{1,120}$/u.test(input.runId))
      throw new Error("Invalid workflow run identity");
    const top = await realpath(await this.checked("git", ["rev-parse", "--show-toplevel"], root));

    if (root !== top) throw new Error("Select the exact repository root");
    const parent = join(homedir(), "worktrees", basename(root));
    await mkdir(parent, { recursive: true });

    return { path: join(parent, input.runId + "--sentry-" + input.suffix) };
  }

  async merge(input: WorkflowMergeInput) {
    const path = await this.repository(input.path, input.repository, input.head);

    if (input.review.head !== input.head || !input.branch.startsWith("sentry/"))
      throw new Error("The independent review does not cover this repair");
    await ownedFile(path, input.review.evidencePath);

    const query = [
      "pr",
      "view",
      String(input.prNumber),
      "--repo",
      input.repository,
      "--json",
      "number,url,headRefOid,headRefName,baseRefName,body,state,isDraft,mergeCommit,createdAt,statusCheckRollup",
    ];

    const read = async () => outputJson(pullSchema, await this.checked("gh", query, path));
    let pull = await read();

    if (
      pull.number !== input.prNumber ||
      pull.headRefOid !== input.head ||
      pull.headRefName !== input.branch ||
      pull.baseRefName !== input.baseBranch ||
      !hasRunMarker(pull.body, input.runId)
    )
      throw new Error("The pull request does not match the owned reviewed repair");

    const result = (status: "pending" | "merged" | "blocked", reason: string | null) => ({
      status,
      head: input.head,
      mergeCommit: pull.mergeCommit?.oid ?? null,
      prUrl: pull.url,
      reason,
    });

    if (pull.state === "MERGED") {
      if (!pull.mergeCommit) throw new Error("Merged pull request has no merge commit");

      return result("merged", null);
    }

    if (pull.state !== "OPEN")
      return result("blocked", "The pull request was closed without merging");
    const journalPath = this.path(input.runId, "merge.json");
    const requestHash = digest(JSON.stringify(input));
    const journal = await optionalJson(mergeJournalSchema, journalPath);

    if (journal !== null) {
      if (journal.requestHash !== requestHash)
        throw new Error("Merge request changed after admission");

      if (journal.attempted)
        return result("blocked", "Merge outcome is not confirmed; no second merge was submitted");
    }

    const checks = await this.command(
      "gh",
      [
        "pr",
        "checks",
        String(input.prNumber),
        "--repo",
        input.repository,
        "--required",
        "--json",
        "name,bucket",
      ],
      path,
    );

    if (checks.exitCode !== 0 && checks.exitCode !== 8) {
      if (pull.statusCheckRollup.length > 0)
        return result("blocked", "Required pull request checks are failed or unavailable");

      if (Date.now() - Date.parse(pull.createdAt) < checksAppearMs)
        return result("pending", "Waiting for pull request checks to appear");
    } else {
      const rows = outputJson(
        z.array(
          z.object({
            name: z.string(),
            bucket: z.enum(["pass", "fail", "pending", "skipping", "cancel"]),
          }),
        ),
        checks.output,
      );

      if (rows.some((row) => row.bucket === "fail" || row.bucket === "cancel"))
        return result("blocked", "A required pull request check failed");

      if (rows.some((row) => row.bucket === "pending"))
        return result("pending", "Waiting for required pull request checks");
    }

    await atomicJson(journalPath, { requestHash, attempted: true });

    if (pull.isDraft)
      await this.checked(
        "gh",
        ["pr", "ready", String(input.prNumber), "--repo", input.repository],
        path,
      );

    try {
      await this.checked(
        "gh",
        [
          "pr",
          "merge",
          String(input.prNumber),
          "--repo",
          input.repository,
          "--squash",
          "--match-head-commit",
          input.head,
        ],
        path,
      );
    } catch {
      pull = await read();

      return result(
        pull.state === "MERGED" && pull.mergeCommit ? "merged" : "blocked",
        pull.state === "MERGED"
          ? null
          : "Merge was not confirmed; its original journal is retained",
      );
    }

    pull = await read();

    return result(
      pull.state === "MERGED" && pull.mergeCommit ? "merged" : "blocked",
      pull.state === "MERGED" ? null : "GitHub has not confirmed the merge",
    );
  }

  private async ensureCommit(commit: string, path: string) {
    if ((await this.command("git", ["cat-file", "-e", commit + "^{commit}"], path)).exitCode)
      await this.checked("git", ["fetch", "--no-tags", "origin", commit], path);
  }

  private async contains(ancestor: string, commit: string, path: string) {
    await this.ensureCommit(commit, path);

    return (
      (await this.command("git", ["merge-base", "--is-ancestor", ancestor, commit], path))
        .exitCode === 0
    );
  }

  private async releaseDirectory(path: string) {
    return z
      .object({ outputDirectory: z.string() })
      .parse(
        await optionalJson(
          z.object({ outputDirectory: z.string() }),
          join(path, "scripts/private-ship.json"),
        ),
      ).outputDirectory;
  }

  private async readReceipt(path: string) {
    const raw = await readFile(path, "utf8").catch(() => null);

    if (raw === null) return null;

    try {
      const parsed = releaseReceiptSchema.safeParse(JSON.parse(raw));

      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async offeredRelease(mergeCommit: string, path: string) {
    const release = z.object({ version: z.string(), commit: sha.nullable() });

    const status = outputJson(
      z.object({ current: release, available: release.nullable().optional() }),
      await this.checked("omnyo", ["updates", "app", "status", "--json"], path),
    );

    const outputDirectory = await this.releaseDirectory(path);

    for (const offer of [status.available, status.current]) {
      if (!offer) continue;
      const directory = join(outputDirectory, "private-ship", offer.version);

      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        const receiptPath = join(directory, entry.name, "receipt.json");
        const receipt = await this.readReceipt(receiptPath);

        if (
          receipt?.sourceCommit &&
          offerVisible(receipt) &&
          (!offer.commit || offer.commit === receipt.sourceCommit) &&
          (await this.contains(mergeCommit, receipt.sourceCommit, path))
        )
          return { version: offer.version, receipt: receiptPath };
      }
    }

    return null;
  }

  private async alive(pid: number, processStart: string, path: string) {
    for (const [program, ...prefix] of [["ps"], ["env", "LC_ALL=C", "ps"]] as const) {
      const result = await this.command(
        program,
        [...prefix, "-p", String(pid), "-o", "lstart="],
        path,
      );

      if (result.exitCode === 0 && result.output.trim() === processStart) return true;
    }

    return false;
  }

  private async liveTickets(path: string) {
    const outputDirectory = await this.releaseDirectory(path);
    const tickets = join(outputDirectory, "private-ship-lane", "tickets");

    const ticket = z
      .object({
        jobId: z.string(),
        version: z.string(),
        pid: z.number().int().positive(),
        processStart: z.string().min(1),
      })
      .passthrough();

    const names = (await readdir(tickets, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();

    const live: { version: string; receiptPath: string }[] = [];

    for (const name of names) {
      const raw = await readFile(join(tickets, name), "utf8").catch(() => null);
      let parsed: ReturnType<typeof ticket.safeParse> | null = null;

      try {
        parsed = raw === null ? null : ticket.safeParse(JSON.parse(raw));
      } catch {
        parsed = null;
      }

      if (!parsed?.success) continue;
      const entry = parsed.data;

      if (
        entry.jobId.startsWith(entry.version + "-") &&
        (await this.alive(entry.pid, entry.processStart, path))
      )
        live.push({
          version: entry.version,
          receiptPath: join(
            outputDirectory,
            "private-ship",
            entry.version,
            entry.jobId.slice(entry.version.length + 1),
            "receipt.json",
          ),
        });
    }

    return live;
  }

  private async queuedRelease(mergeCommit: string, path: string) {
    for (const entry of await this.liveTickets(path)) {
      const receipt = await this.readReceipt(entry.receiptPath);

      const job = z.object({ mode: z.string() }).safeParse(
        await readFile(join(dirname(entry.receiptPath), "job.json"), "utf8")
          .then((text) => JSON.parse(text))
          .catch(() => null),
      );

      if ((job.success && job.data.mode !== "ship") || receipt?.mode === "prepare") continue;

      if (!receipt) return { version: entry.version, receipt: entry.receiptPath };

      if (offerVisible(receipt) || ["ambiguous", ...failedReleaseStates].includes(receipt.status))
        continue;

      if (
        receipt.phases?.["source-push"]?.status !== "complete" ||
        (receipt.sourceCommit && (await this.contains(mergeCommit, receipt.sourceCommit, path)))
      )
        return { version: entry.version, receipt: entry.receiptPath };
    }

    return null;
  }

  async plan(input: WorkflowPlanInput): Promise<WorkflowPlan> {
    const path = await this.repository(input.path, input.repository, input.mergeCommit);
    const planPath = this.path(input.runId, "plan.json");
    const requestHash = digest(JSON.stringify(input));
    let plan = await optionalJson(storedPlanSchema, planPath);

    if (plan !== null) {
      if (plan.requestHash !== requestHash) throw new Error("Delivery plan input changed");
    } else {
      const plugins: { root: string; id: string }[] = [];
      let kind: WorkflowPlan["kind"] = "none";
      let blocked: string | null = null;

      if (!input.repository.endsWith("/omnyo-plugins")) {
        const candidate = outputJson(
          plannerSchema,
          await this.checked("pnpm", ["private:plan"], path),
        );

        if (
          candidate.status !== "ready" ||
          candidate.unresolved.length ||
          candidate.sourceCommit !== input.mergeCommit
        )
          throw new Error("The official delivery planner refused this source");
        kind = candidate.actions.some((action) => action.kind === "runtime")
          ? "runtime"
          : candidate.actions.some((action) => action.kind === "web")
            ? "web"
            : candidate.actions.some((action) => action.kind === "plugin")
              ? "plugin"
              : "none";

        for (const action of candidate.actions)
          if (action.kind === "plugin" && action.root && action.id)
            plugins.push({ root: action.root, id: action.id });

        if (input.nativeRequired.length) kind = "runtime";

        if (kind === "web" && !input.selectionPath)
          blocked = "Web delivery requires the source-bound selective test artifact";

        if (input.selectionPath) await ownedFile(path, input.selectionPath);
      } else {
        const folders = new Set(
          input.changedFiles
            .filter((file) => file.includes("/"))
            .map((file) => file.split("/")[0])
            .filter((folder) => folder && !folder.startsWith(".")),
        );

        for (const folder of folders) {
          const manifest = z
            .object({ name: z.string() })
            .parse(
              await optionalJson(
                z.object({ name: z.string() }),
                join(path, folder, "package.json"),
              ),
            );

          const id = manifest.name.replace(/^omnyo-plugin-/u, "");

          if (!/^[a-z0-9-]+$/u.test(id)) throw new Error("Invalid affected plugin identity");
          plugins.push({ root: folder, id });
        }

        kind = plugins.length ? "plugin" : "none";

        if (plugins.length) await this.snapshots.preserve(input, plugins);

        if (input.nativeRequired.length)
          blocked = "Native repair must be delivered through the core release owner";
      }

      plan = {
        requestHash,
        input,
        kind,
        plugins,
        blocked,
      };
      await atomicJson(planPath, plan);
    }

    return {
      status: plan.blocked ? "blocked" : "planned",
      kind: plan.kind,
      sourceCommit: input.mergeCommit,
      planPath,
      planDigest: digest(JSON.stringify(plan)),
      nativeRequired: input.nativeRequired,
      releaseRequired:
        plan.kind === "runtime" &&
        !plan.blocked &&
        (await this.offeredRelease(input.mergeCommit, path)) === null,
      reason: plan.blocked,
    };
  }

  private async storedPlan(input: WorkflowDeliveryInput) {
    const expectedPath = this.path(input.runId, "plan.json");

    if (resolve(input.planPath) !== resolve(expectedPath))
      throw new Error("Delivery plan belongs to another run");
    const plan = await optionalJson(storedPlanSchema, expectedPath);

    if (!plan) throw new Error("Delivery plan is missing");

    if (digest(JSON.stringify(plan)) !== input.planDigest || plan.input.runId !== input.runId)
      throw new Error("Delivery plan changed after verification");

    return plan;
  }

  private delivery(plan: z.infer<typeof storedPlanSchema>) {
    return (
      status: WorkflowDelivery["status"],
      reason: string | null,
      receiptPath: string | null = null,
      offeredVersion: string | null = null,
    ): WorkflowDelivery => ({
      status,
      kind: plan.kind,
      sourceCommit: plan.input.mergeCommit,
      receiptPath,
      offeredVersion,
      reason,
    });
  }

  async deliver(input: WorkflowDeliveryInput): Promise<WorkflowDelivery> {
    const plan = await this.storedPlan(input);
    const journalPath = this.path(input.runId, "delivery.json");
    const stored = await optionalJson(deliveryJournalSchema, journalPath);
    const response = this.delivery(plan);

    if (stored !== null && stored.planDigest !== input.planDigest)
      throw new Error("Delivery journal belongs to another plan");

    if (plan.kind === "runtime" && !plan.blocked) {
      const path = await this.repository(
        plan.input.path,
        plan.input.repository,
        plan.input.mergeCommit,
      );

      const offered = await this.offeredRelease(plan.input.mergeCommit, path);

      const requested = deliveryJournalSchema.safeParse(
        await readFile(this.path(input.runId, "release.json"), "utf8")
          .then((text) => JSON.parse(text))
          .catch(() => null),
      );

      const requestedReceipt =
        requested.success && requested.data.result?.receiptPath
          ? await this.readReceipt(requested.data.result.receiptPath)
          : null;

      const requestedPath = requested.success ? (requested.data.result?.receiptPath ?? null) : null;

      const vanished =
        requestedPath !== null &&
        requestedReceipt === null &&
        !(await this.liveTickets(path)).some((entry) => entry.receiptPath === requestedPath);

      const newlyFailed =
        ((requestedReceipt !== null && releaseFailed(requestedReceipt)) || vanished) &&
        requestedPath !== stored?.acknowledgedFailure;

      const result = offered
        ? response(
            "complete",
            `Release ${offered.version} contains the repair and is offered; installing it is the owner's choice`,
            offered.receipt,
            offered.version,
          )
        : newlyFailed
          ? response(
              "release-failed",
              `The requested release ${requestedReceipt ? `ended ${requestedReceipt.status}` : "stopped before writing its receipt"} before offering the repair; choose again`,
              requestedPath,
              requested.success ? (requested.data.result?.offeredVersion ?? null) : null,
            )
          : requestedReceipt && releaseAmbiguous(requestedReceipt)
            ? response(
                "blocked",
                "The requested release needs reconciliation before it can offer the repair; no other release was started",
                requestedPath,
              )
            : response("pending", "Waiting for a release that contains the repair");

      await atomicJson(journalPath, {
        planDigest: input.planDigest,
        attempted: true,
        acknowledgedFailure: newlyFailed ? requestedPath : (stored?.acknowledgedFailure ?? null),
        result,
      });

      return result;
    }

    if (stored !== null)
      return (
        stored.result ??
        response(
          "blocked",
          "Delivery outcome is uncertain; the recorded operation will not be replayed",
        )
      );

    if (plan.blocked) return response("blocked", plan.blocked);

    if (plan.kind === "plugin" && plan.input.repository.endsWith("/omnyo-plugins"))
      return response("blocked", "Standalone plugin delivery requires the guarded installer");

    const path = await this.repository(
      plan.input.path,
      plan.input.repository,
      plan.input.mergeCommit,
    );

    await atomicJson(journalPath, { planDigest: input.planDigest, attempted: true, result: null });
    let result: WorkflowDelivery;

    try {
      if (plan.kind === "none")
        result = response("complete", "No deployed product surface changed");
      else if (plan.kind === "web") {
        if (!plan.input.selectionPath) throw new Error("Missing selective web proof");
        const selection = await ownedFile(path, plan.input.selectionPath);

        const common = await this.checked(
          "git",
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          path,
        );

        const published = outputJson(
          z
            .object({
              receipt: z.string().optional(),
              active: z.object({ sourceCommit: sha }).optional(),
              sourceCommit: sha.optional(),
            })
            .passthrough(),
          await this.checked(
            "pnpm",
            ["private:web", "--source-directory", path, "--test-selection", selection],
            dirname(common),
          ),
        );

        if ((published.active?.sourceCommit ?? published.sourceCommit) !== plan.input.mergeCommit)
          throw new Error("Web publisher did not confirm the selected source");
        result = response("complete", null, published.receipt ?? null);
      } else {
        result = await this.deliverPlugins(plan);
      }
    } catch {
      result = response(
        "blocked",
        "Delivery was not confirmed; inspect the retained operation journal before recovery",
      );
    }

    await atomicJson(journalPath, { planDigest: input.planDigest, attempted: true, result });

    return result;
  }

  async release(input: WorkflowDeliveryInput): Promise<WorkflowDelivery> {
    const plan = await this.storedPlan(input);

    if (plan.kind !== "runtime" || plan.blocked)
      throw new Error("Only a planned runtime repair needs a release");
    const journalPath = this.path(input.runId, "release.json");
    const stored = await optionalJson(deliveryJournalSchema, journalPath);
    const response = this.delivery(plan);

    if (stored !== null && stored.planDigest !== input.planDigest)
      throw new Error("Release journal belongs to another plan");

    const path = await this.repository(
      plan.input.path,
      plan.input.repository,
      plan.input.mergeCommit,
    );

    const existing =
      (await this.offeredRelease(plan.input.mergeCommit, path)) ??
      (await this.queuedRelease(plan.input.mergeCommit, path));

    const prior = stored?.result ?? null;

    const priorReceipt =
      prior?.status === "pending" && prior.receiptPath
        ? await this.readReceipt(prior.receiptPath)
        : null;

    let result: WorkflowDelivery;

    if (existing)
      result = response(
        "pending",
        `Release ${existing.version} already contains or will contain the repair; no other release was started`,
        existing.receipt,
        existing.version,
      );
    else if (priorReceipt && releaseAmbiguous(priorReceipt))
      result = response(
        "blocked",
        "The requested release needs reconciliation before it can offer the repair; no other release was started",
        prior?.receiptPath ?? null,
        prior?.offeredVersion ?? null,
      );
    else if (stored !== null && (prior === null || prior.status === "blocked"))
      result = response(
        "release-failed",
        "The earlier release request was not confirmed and no matching release is queued or offered; choose again",
      );
    else if (prior?.status === "pending" && priorReceipt !== null && !releaseFailed(priorReceipt))
      result = prior;
    else {
      await atomicJson(journalPath, {
        planDigest: input.planDigest,
        attempted: true,
        result: null,
      });

      try {
        const queued = outputJson(
          z.object({ version: z.string(), receipt: z.string() }).passthrough(),
          await this.checked("pnpm", ["private:ship", "--release"], path, 540_000),
        );

        result = response(
          "pending",
          `Requested release ${queued.version} is queued; it ships everything on main`,
          queued.receipt,
          queued.version,
        );
      } catch {
        result = response(
          "blocked",
          "The release request was not confirmed; check the release lane before choosing again",
        );
      }
    }

    await atomicJson(journalPath, { planDigest: input.planDigest, attempted: true, result });

    return result;
  }

  private async deliverPlugins(plan: z.infer<typeof storedPlanSchema>): Promise<WorkflowDelivery> {
    const entries = z.array(z.object({ id: z.string(), rootDir: z.string(), status: z.string() }));

    const installedSchema = z.union([
      z.object({ plugins: entries }),
      entries.transform((plugins) => ({ plugins })),
    ]);

    const installed = outputJson(
      installedSchema,
      await this.checked("omnyo", ["plugin", "list", "--json"], plan.input.path),
    );

    for (const plugin of plan.plugins) {
      if (
        ["sentry", "state-machines", "account-pool"].includes(plugin.id) ||
        plugin.id.startsWith("provider-")
      )
        throw new Error("This plugin requires an independent idle update owner");
      const current = installed.plugins.find((item) => item.id === plugin.id);

      if (!current) throw new Error("The affected plugin is not installed");

      const manifest = z
        .object({ name: z.string(), scripts: z.record(z.string(), z.string()).optional() })
        .parse(
          await optionalJson(
            z.object({ name: z.string(), scripts: z.record(z.string(), z.string()).optional() }),
            join(plan.input.path, plugin.root, "package.json"),
          ),
        );

      if (!manifest.scripts?.["prepare:bundled"])
        throw new Error("No supported bundled plugin publisher");
      await this.checked(
        "pnpm",
        ["exec", "turbo", "run", "prepare:bundled", "--filter=" + manifest.name],
        plan.input.path,
      );
      await this.checked(
        "omnyo",
        [
          "plugin",
          "update",
          plugin.id,
          "--directory",
          join(plan.input.path, plugin.root, ".bundled-runtime"),
          "--yes",
        ],
        plan.input.path,
      );
    }

    const after = outputJson(
      installedSchema,
      await this.checked("omnyo", ["plugin", "list", "--json"], plan.input.path),
    );

    if (
      plan.plugins.some(
        (plugin) => after.plugins.find((item) => item.id === plugin.id)?.status !== "running",
      )
    )
      throw new Error("A delivered plugin is not running");

    return {
      status: "complete",
      kind: "plugin",
      sourceCommit: plan.input.mergeCommit,
      receiptPath: this.path(plan.input.runId, "delivery.json"),
      offeredVersion: null,
      reason: null,
    };
  }

  async pluginTargets(input: WorkflowDeliveryInput) {
    const plan = await this.storedPlan(input);

    if (plan.kind !== "plugin" || plan.input.repository.split("/")[1] !== "omnyo-plugins")
      throw new Error("This delivery is not a separately managed plugin update");

    if (plan.blocked) throw new Error(plan.blocked);
    await this.repository(plan.input.path, plan.input.repository, plan.input.mergeCommit);
    await this.snapshots.preserve(plan.input, plan.plugins);

    const targets = [];

    for (const plugin of [...plan.plugins].sort(
      (left, right) => Number(left.id === "sentry") - Number(right.id === "sentry"),
    ))
      targets.push(
        await this.snapshots.prepare(
          plan.input,
          plugin,
          this.path(plan.input.runId, "plugin-runtimes/" + plugin.id),
        ),
      );

    return { sourceCommit: plan.input.mergeCommit, planDigest: input.planDigest, targets };
  }

  async verify(input: WorkflowDeliveryInput): Promise<WorkflowVerification> {
    const plan = await this.storedPlan(input);

    if (plan.blocked)
      return { status: "blocked", sourceCommit: plan.input.mergeCommit, proof: plan.blocked };

    if (plan.kind === "none")
      return {
        status: "verified",
        sourceCommit: plan.input.mergeCommit,
        proof: "No product runtime changed",
      };

    const journal = await optionalJson(
      deliveryJournalSchema,
      this.path(input.runId, "delivery.json"),
    );

    if (!journal) throw new Error("Delivery journal is missing");

    if (journal.planDigest !== input.planDigest) throw new Error("Verification plan changed");
    const delivery = journal.result;
    let verifiedSource = plan.input.mergeCommit;

    if (!delivery || delivery.status === "blocked")
      return {
        status: "blocked",
        sourceCommit: plan.input.mergeCommit,
        proof: delivery?.reason ?? "Delivery outcome is unknown",
      };

    if (delivery.kind === "runtime") {
      const status = outputJson(
        z.object({
          current: z.object({ version: z.string(), commit: z.string().nullable() }),
        }),
        await this.checked("omnyo", ["updates", "app", "status", "--json"], plan.input.path),
      );

      if (
        !delivery.offeredVersion ||
        !versionAtLeast(status.current.version, delivery.offeredVersion)
      )
        return {
          status: "pending",
          sourceCommit: plan.input.mergeCommit,
          proof: "The runtime update is offered but is not installed",
        };

      if (!delivery.receiptPath) throw new Error("Runtime publication has no receipt");
      const receipt = await this.readReceipt(delivery.receiptPath);

      if (!receipt?.sourceCommit || !offerVisible(receipt))
        return {
          status: "pending",
          sourceCommit: plan.input.mergeCommit,
          proof: "Runtime delivery is not complete",
        };

      if (!(await this.contains(plan.input.mergeCommit, receipt.sourceCommit, plan.input.path)))
        return {
          status: "blocked",
          sourceCommit: plan.input.mergeCommit,
          proof: "The installed release does not contain the merged repair",
        };

      verifiedSource = receipt.sourceCommit;

      if (plan.input.nativeRequired.length)
        return {
          status: "verified",
          sourceCommit: verifiedSource,
          proof:
            "The coordinator source is installed; the mandatory independent verifier must still prove the selected native surfaces are installed and behave correctly",
        };
    }

    if (delivery.kind === "web") {
      const active = outputJson(
        z.object({ active: z.object({ sourceCommit: sha }).nullable() }),
        await this.checked("omnyo", ["updates", "web", "status", "--json"], plan.input.path),
      );

      if (active.active?.sourceCommit !== plan.input.mergeCommit)
        return {
          status: "blocked",
          sourceCommit: plan.input.mergeCommit,
          proof: "The selected web generation is no longer active",
        };
    }

    return {
      status: "verified",
      sourceCommit: verifiedSource,
      proof:
        "The selected delivery owner confirmed the merged source; retain the issue's behavioral proof separately",
    };
  }
}
