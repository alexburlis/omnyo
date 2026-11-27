import { execFile, spawn, type ExecFileException } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from "@omnyo/plugin-sdk";
import { discoveryContract } from "./host-contract.js";

const ignored = new Set([
  "node_modules",
  "vendor",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".agents",
  ".codex",
  ".claude",
  ".bb",
  ".omnyo",
]);

const GH_HINT = "Install GitHub CLI on the machine running Omnyo and sign in with gh auth login.";

let ghPath: string | null = null;

function ghFailureMessage(error: ExecFileException, stderr: string): string {
  if (error.killed) return "GitHub CLI timed out.";

  if (/rate limit|abuse detection/i.test(stderr))
    return "GitHub rate limit reached. Try again after the limit resets.";

  if (/no oauth token|not logged in|HTTP 401|bad credentials|authentication failed/i.test(stderr))
    return "GitHub authentication failed. Sign in again with gh auth login.";

  if (
    /HTTP 403|resource not accessible|permission denied|must have .* access|not permitted|does not have permission/i.test(
      stderr,
    )
  )
    return "GitHub denied this action. Check repository permissions and token scopes.";

  if (/HTTP 404|could not resolve to an? (?:repository|issue|pullrequest)/i.test(stderr))
    return "GitHub could not find this repository or item, or your account cannot access it.";

  if (
    /dial tcp|no such host|connection refused|network is unreachable|TLS handshake|i\/o timeout/i.test(
      stderr,
    )
  )
    return "GitHub could not be reached. Check the network connection.";

  if (error.code === "ENOENT") return `GitHub CLI was not found. ${GH_HINT}`;

  return Number.isInteger(error.code)
    ? `GitHub CLI request failed (exit code ${error.code}).`
    : "GitHub CLI could not run.";
}

function execute(
  file: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        signal,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GH_HOST: "github.com" },
      },
      (error, stdout, stderr) => {
        if (signal.aborted) reject(signal.reason);
        else if (error) reject(new Error(ghFailureMessage(error, stderr)));
        else resolve(stdout);
      },
    );
  });
}

async function resolveGh(signal: AbortSignal): Promise<string | null> {
  if (ghPath) return ghPath;

  for (const candidate of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
    try {
      await execute(candidate, ["--version"], signal, 5_000);
      ghPath = candidate;

      return candidate;
    } catch {
      signal.throwIfAborted();
    }
  }

  return null;
}

// Probe local credential presence without ever buffering its stdout in JavaScript.
function credentialPresence(
  file: string,
  signal: AbortSignal,
): Promise<"present" | "missing" | "unavailable"> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ["auth", "token", "--hostname", "github.com"], {
      signal,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 65_536) stderr += chunk.toString().slice(0, 65_536 - stderr.length);
    });
    const timer = setTimeout(() => child.kill(), 5_000);
    child.once("error", () => {
      clearTimeout(timer);

      if (signal.aborted) reject(signal.reason);
      else resolve("unavailable");
    });
    child.once("close", (code) => {
      clearTimeout(timer);

      if (signal.aborted) reject(signal.reason);
      else
        resolve(
          code === 0
            ? "present"
            : /no oauth token|not logged in/i.test(stderr)
              ? "missing"
              : "unavailable",
        );
    });
  });
}

function requestSignal(context: ExperimentalHostRpcContext): AbortSignal {
  return AbortSignal.any([context.signal, context.lifecycle.signal]);
}

export default experimental_defineHostEntry({
  contract: discoveryContract,
  handlers: {
    async authStatus(_input, context) {
      const signal = requestSignal(context);
      const file = await resolveGh(signal);

      if (!file)
        return {
          state: "needs_configuration" as const,
          error: `GitHub CLI was not found. ${GH_HINT}`,
        };

      try {
        await execute(
          file,
          ["auth", "status", "--hostname", "github.com", "--active"],
          signal,
          10_000,
        );

        return { state: "ready" as const, error: null };
      } catch {
        signal.throwIfAborted();
      }

      const presence = await credentialPresence(file, signal);

      if (presence === "missing")
        return {
          state: "needs_configuration" as const,
          error: `GitHub CLI is not authenticated. ${GH_HINT}`,
        };

      return {
        state: "unavailable" as const,
        error: "GitHub authentication is temporarily unavailable.",
      };
    },
    async gh({ args, timeoutMs }, context) {
      const signal = requestSignal(context);
      const file = await resolveGh(signal);

      if (!file) throw new Error(`GitHub CLI was not found. ${GH_HINT}`);
      const stdout = await execute(file, args, signal, timeoutMs);
      signal.throwIfAborted();

      return { stdout };
    },
    async discover({ roots }, context) {
      const repos = new Map<string, { repo: string; path: string }>();
      const problems: string[] = [];
      const visited = new Set<string>();

      const missing = (error: Error) =>
        error instanceof Error && "code" in error && error.code === "ENOENT";

      async function checkoutKind(path: string): Promise<"none" | "checkout" | "orphaned"> {
        const gitPath = join(path, ".git");
        let metadata;

        try {
          metadata = await lstat(gitPath);
        } catch (error) {
          if (error instanceof Error && missing(error)) return "none";
          throw error;
        }

        if (metadata.isDirectory()) {
          try {
            return (await lstat(join(gitPath, "HEAD"))).isFile() ? "checkout" : "none";
          } catch (error) {
            if (error instanceof Error && missing(error)) return "none";
            throw error;
          }
        }

        if (!metadata.isFile()) return "none";
        const pointer = (await readFile(gitPath, "utf8")).match(/^gitdir:\s*(.+?)\s*$/m);

        if (pointer === null) return "orphaned";

        try {
          await lstat(resolve(path, pointer[1]));

          return "checkout";
        } catch (error) {
          if (error instanceof Error && missing(error)) return "orphaned";
          throw error;
        }
      }

      async function walk(path: string, depth: number): Promise<void> {
        context.signal.throwIfAborted();

        if (visited.has(path)) return;
        visited.add(path);

        if (visited.size > 2000) throw new Error("Repository discovery exceeded 2000 folders");

        let entries;

        try {
          const kind = await checkoutKind(path);

          if (kind === "orphaned") return;

          if (kind === "checkout") {
            const remote = await new Promise<string>((resolveRemote, reject) => {
              execFile(
                "git",
                ["-C", path, "remote", "get-url", "origin"],
                { timeout: 5000, maxBuffer: 4096, signal: context.signal, windowsHide: true },
                (error, stdout, stderr) => {
                  if (error && stderr.includes("No such remote")) resolveRemote("");
                  else if (error) reject(new Error("its Git origin could not be read"));
                  else resolveRemote(stdout.trim());
                },
              );
            });

            const parsed = remote.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);

            if (parsed !== null) {
              const repo = `${parsed[1]}/${parsed[2]}`;

              if (!repos.has(repo.toLowerCase())) repos.set(repo.toLowerCase(), { repo, path });
            }

            return;
          }

          if (depth >= 3) return;
          entries = await readdir(path, { withFileTypes: true });
        } catch (error) {
          context.signal.throwIfAborted();

          if (depth === 0) throw error;

          problems.push(
            `Could not inspect ${path}: ${error instanceof Error ? error.message : "folder could not be read"}`,
          );

          return;
        }

        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
          if (entry.isDirectory() && !entry.isSymbolicLink() && !ignored.has(entry.name)) {
            await walk(join(path, entry.name), depth + 1);
          }
        }
      }

      for (const root of roots) {
        try {
          await walk(root, 0);
        } catch (error) {
          context.signal.throwIfAborted();
          problems.push(
            `Could not inspect ${root}: ${error instanceof Error ? error.message : "repository discovery failed"}`,
          );
        }
      }

      return { repos: [...repos.values()], problems };
    },
  },
});
