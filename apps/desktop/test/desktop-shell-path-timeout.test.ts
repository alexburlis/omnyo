import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ensurePackagedUserShellPath } from "../src/desktop-shell-path.js";

it.skipIf(process.platform !== "darwin")(
  "bounds the PATH probe when interactive shell startup outlasts its timeout",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnyo-shell-timeout-"));
    const previous = process.env.ZDOTDIR;

    try {
      writeFileSync(
        join(directory, ".zshrc"),
        "integer finish=$((SECONDS + 6))\nwhile (( SECONDS < finish )); do :; done\n",
      );
      process.env.ZDOTDIR = directory;
      const env = { PATH: "/usr/bin:/bin" };
      const started = performance.now();

      const result = await ensurePackagedUserShellPath({
        env,
        isPackaged: true,
        platform: "darwin",
        logger: { warn() {} },
      });

      expect(performance.now() - started).toBeLessThan(3500);
      expect(result).toEqual({ kind: "unchanged", reason: "shell-error" });
      expect(env.PATH).toBe("/usr/bin:/bin");
    } finally {
      if (previous === undefined) delete process.env.ZDOTDIR;
      else process.env.ZDOTDIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  },
  10_000,
);

it.skipIf(process.platform !== "darwin")(
  "keeps the event loop responsive while a real login shell is still starting",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnyo-shell-responsive-"));
    const previous = process.env.ZDOTDIR;
    let timerRan = false;

    const timer = setTimeout(() => {
      timerRan = true;
    }, 25);

    try {
      writeFileSync(join(directory, ".zprofile"), "/bin/sleep 0.6\n");
      writeFileSync(join(directory, ".zshrc"), "");
      process.env.ZDOTDIR = directory;
      const env = { PATH: "/usr/bin:/bin" };

      const result = await ensurePackagedUserShellPath({
        env,
        isPackaged: true,
        platform: "darwin",
        logger: { warn() {} },
      });

      expect(timerRan).toBe(true);
      expect(result.kind).toBe("updated");
      expect(env.PATH.length).toBeGreaterThan(0);
    } finally {
      clearTimeout(timer);

      if (previous === undefined) delete process.env.ZDOTDIR;
      else process.env.ZDOTDIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  },
  5000,
);
