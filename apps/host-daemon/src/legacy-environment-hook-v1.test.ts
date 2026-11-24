import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  runSetupScript,
  runTeardownScript,
} from "./environment-lifecycle-script.js";

it.each(["setup", "teardown"] as const)(
  "retains exact legacy %s hook bytes and mode while running the existing operation",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "omnyo-hook-v1-"));
    const name = `.bb-env-${kind}.sh`;
    const script = join(root, name);

    const bytes = Buffer.from(
      "printf once >> marker\nprintf legacy-complete\n",
    );

    try {
      await writeFile(script, bytes);
      await chmod(script, 0o640);
      const before = (await stat(script)).mode;
      const output: string[] = [];
      const run = kind === "setup" ? runSetupScript : runTeardownScript;

      expect(
        await run({
          workspacePath: root,
          timeoutMs: 1000,
          onProgress: (entry) => output.push(entry.text),
        }),
      ).toEqual({ ran: true });
      expect(await readFile(join(root, "marker"), "utf8")).toBe("once");
      expect(await readFile(script)).toEqual(bytes);
      expect((await stat(script)).mode).toBe(before);
      expect(output).toContain(`Running ${name}`);
      await expect(
        stat(join(root, `.omnyo-env-${kind}.sh`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["setup", "teardown"] as const)(
  "runs the canonical %s hook without creating legacy input",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "omnyo-hook-current-"));

    try {
      const name = `.omnyo-env-${kind}.sh`;
      await writeFile(join(root, name), "printf current > marker\n");
      const run = kind === "setup" ? runSetupScript : runTeardownScript;

      expect(await run({ workspacePath: root, timeoutMs: 1000 })).toEqual({
        ran: true,
      });
      expect(await readFile(join(root, "marker"), "utf8")).toBe("current");
      await expect(
        stat(join(root, `.bb-env-${kind}.sh`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["setup", "teardown"] as const)(
  "refuses dual %s hook files before either shell executes",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "omnyo-hook-dual-"));
    const bytes = Buffer.from("printf unsafe > marker\n");

    try {
      await Promise.all(
        ["bb", "omnyo"].map((brand) =>
          writeFile(join(root, `.${brand}-env-${kind}.sh`), bytes),
        ),
      );
      const output: string[] = [];

      const args = {
        workspacePath: root,
        timeoutMs: 1000,
        onProgress: (entry: { text: string }) => output.push(entry.text),
      };

      if (kind === "setup")
        await expect(runSetupScript(args)).rejects.toThrow(
          "Both lifecycle hook files exist",
        );
      else {
        await runTeardownScript(args);
        expect(
          output.some((text) =>
            text.includes("Both lifecycle hook files exist"),
          ),
        ).toBe(true);
      }

      await expect(stat(join(root, "marker"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      for (const brand of ["bb", "omnyo"])
        expect(await readFile(join(root, `.${brand}-env-${kind}.sh`))).toEqual(
          bytes,
        );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
