import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { hostContract, hostSignals } from "./contracts.js";
import { PayloadError, sha256 } from "./package-payload.js";
import { HostRuntime } from "./runtime.js";
import { HostLeaseManager } from "./leases.js";

const runtimes = new Map<string, HostRuntime>();

function runtime(dataDir: string): HostRuntime {
  let selected = runtimes.get(dataDir);

  if (!selected) {
    selected = new HostRuntime(dataDir);
    runtimes.set(dataDir, selected);
  }

  return selected;
}

const leaseManagers = new Map<string, HostLeaseManager>();

function leases(dataDir: string): HostLeaseManager {
  let manager = leaseManagers.get(dataDir);

  if (!manager) {
    manager = new HostLeaseManager(runtime(dataDir));
    leaseManagers.set(dataDir, manager);
  }

  return manager;
}

const setupPayload = z.strictObject({
  nodeExecutable: z.string().min(1),
  nativeBinaryPath: z.string().optional(),
  nativeLicensePaths: z.array(z.string()).max(64).optional(),
});

const doctorPayload = z.strictObject({ probeService: z.boolean().optional() });

async function canonicalMissingPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new PayloadError("WORKSPACE_CONTEXT_MISMATCH");
  const suffix: string[] = [];
  let ancestor = normalize(path);

  for (;;) {
    try {
      return join(await realpath(ancestor), ...suffix.reverse());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      suffix.push(basename(ancestor));
      const parent = dirname(ancestor);

      if (parent === ancestor) throw new PayloadError("WORKSPACE_CONTEXT_MISMATCH");
      ancestor = parent;
    }
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    async retainedRead(input, context) {
      context.signal.throwIfAborted();
      const candidate = await canonicalMissingPath(input.candidatePath);

      try {
        await stat(candidate);

        return { missing: false };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }

      if (candidate !== input.binding.canonicalRoot)
        throw new PayloadError("WORKSPACE_CONTEXT_MISMATCH");

      if (input.binding.platform !== process.platform || input.binding.arch !== process.arch)
        throw new PayloadError("PLATFORM_CONTEXT_CHANGED");

      return {
        missing: true,
        result: await leases(context.experimental_paths.dataDir).retainedRead(
          input.binding,
          input.method,
          input.payload,
        ),
      };
    },
    async inspectWorkspace(input, context) {
      context.signal.throwIfAborted();
      const candidate = await realpath(input.candidatePath);

      if (!(await stat(candidate)).isDirectory()) throw new PayloadError("WORKSPACE_REQUIRED");
      let canonicalRoot = candidate;
      let workspaceId = sha256(Buffer.from(candidate));

      if (input.gitCheckout) {
        const result = await promisify(execFile)(
          "git",
          [
            "-C",
            candidate,
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--git-common-dir",
          ],
          {
            env: { PATH: process.env.PATH, HOME: homedir(), LANG: "en_US.UTF-8" },
            timeout: 5000,
            maxBuffer: 16384,
            signal: context.signal,
            windowsHide: true,
          },
        );

        const lines = result.stdout.trim().split(/\r?\n/);

        if (lines.length !== 2 || !lines[0] || !lines[1])
          throw new PayloadError("WORKSPACE_GIT_IDENTITY_UNAVAILABLE");
        canonicalRoot = await realpath(lines[0]);
        workspaceId = sha256(Buffer.from(await realpath(lines[1])));
      }

      const policy = await readFile(join(canonicalRoot, ".fastloop", "config.json")).catch(() => {
        throw new PayloadError("POLICY_REQUIRED");
      });

      if (policy.byteLength > 131072) throw new PayloadError("POLICY_TOO_LARGE");

      return {
        canonicalRoot,
        candidateCanonicalPath: candidate,
        withinWorkspace: candidate === canonicalRoot,
        directory: true,
        workspaceId,
        policyHash: sha256(policy),
        platform: process.platform,
        arch: process.arch,
      };
    },
    async setup(input, context) {
      return z
        .json()
        .parse(
          await runtime(context.experimental_paths.dataDir).setup(
            setupPayload.parse(input.payload),
            context.signal,
          ),
        );
    },
    async doctor(input, context) {
      return z
        .json()
        .parse(
          await runtime(context.experimental_paths.dataDir).doctor(
            ("binding" in input ? input.binding : input.workspace).canonicalRoot,
            doctorPayload.parse(input.payload),
            context.signal,
          ),
        );
    },
    async status(_input, context) {
      const dataDir = context.experimental_paths.dataDir;

      return z.json().parse({
        ...(await runtime(dataDir).status()),
        scopeFaults: [...(leaseManagers.get(dataDir)?.faults ?? [])],
      });
    },
    submit: (input, context) =>
      leases(context.experimental_paths.dataDir).invoke(
        "submit",
        input.binding,
        input.payload,
        context,
      ),
    submission: (input, context) =>
      leases(context.experimental_paths.dataDir).invoke(
        "submission",
        input.binding,
        input.payload,
        context,
      ),
    result: (input, context) =>
      leases(context.experimental_paths.dataDir).invoke(
        "result",
        input.binding,
        input.payload,
        context,
      ),
    events: (input, context) =>
      leases(context.experimental_paths.dataDir).invoke(
        "events",
        input.binding,
        input.payload,
        context,
      ),
    artifact: (input, context) =>
      leases(context.experimental_paths.dataDir).invoke(
        "artifact",
        input.binding,
        input.payload,
        context,
      ),
    cancel: (input, context) =>
      leases(context.experimental_paths.dataDir).invoke(
        "cancel",
        input.binding,
        input.payload,
        context,
      ),
    releaseClient: (input, context) =>
      leases(context.experimental_paths.dataDir).release(input.binding, context),
  },
});
