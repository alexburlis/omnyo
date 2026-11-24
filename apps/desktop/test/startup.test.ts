import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { expect, it } from "vitest";

const startup = transpileModule(
  readFileSync(join(__dirname, "../src/startup.ts"), "utf8"),
  {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2022,
    },
  },
).outputText;

async function boot(argv: string[], rejectContinuity = false) {
  const ordinary: string[] = [];
  const calls: string[][] = [];
  const exits: number[] = [];
  const pending: Promise<void>[] = [];

  const context = createContext({
    exports: {},
    process: {
      argv: ["fixture", ...argv],
      env: {},
      exit: (code: number) => exits.push(code),
    },
    require: (name: string) => {
      if (name === "node:fs" || name === "node:path") return {};

      if (name === "./desktop-main.cjs") {
        ordinary.push(name);

        return {};
      }

      if (name === "./desktop-profile-continuity-entry-v2.cjs") {
        return {
          runDesktopProfileContinuityEntryV2(args: string[]) {
            calls.push([...args]);

            const result = rejectContinuity
              ? Promise.reject(
                  new Error("Closed native authentication refusal"),
                )
              : Promise.resolve();

            pending.push(result);

            return result;
          },
        };
      }

      throw new Error(`Unexpected bootstrap module: ${name}`);
    },
  });

  runInContext(startup, context);
  await Promise.allSettled(pending);

  return { ordinary, calls, exits };
}

it("enters the closed continuity handler before ordinary desktop startup", async () => {
  const argv = ["--omnyo-profile-continuity-v2", "/owned-closed-job"];
  const result = await boot(argv);
  expect(result.calls).toEqual([argv]);
  expect(result.ordinary).toEqual([]);
  expect(result.exits).toEqual([]);
});

it.each([
  ["--omnyo-profile-continuity-v2"],
  ["--omnyo-profile-continuity-v2=bad"],
  ["--omnyo-profile-continuity-v3", "/owned-closed-job"],
  ["--another-flag", "--omnyo-profile-continuity-v2", "/owned-closed-job"],
])(
  "keeps reserved continuity arguments out of ordinary startup: %j",
  async (...argv) => {
    const result = await boot(argv);
    expect(result.calls).toEqual([argv]);
    expect(result.ordinary).toEqual([]);
  },
);

it("exits after a rejected continuity handler without ordinary fallback", async () => {
  const result = await boot(
    ["--omnyo-profile-continuity-v2", "/owned-closed-job"],
    true,
  );

  expect(result.exits).toEqual([2]);
  expect(result.ordinary).toEqual([]);
});

it.each([[], ["--another-user-argument"]])(
  "preserves ordinary desktop startup for non-reserved arguments: %j",
  async (...argv) => {
    const result = await boot(argv);
    expect(result.ordinary).toEqual(["./desktop-main.cjs"]);
    expect(result.calls).toEqual([]);
    expect(result.exits).toEqual([]);
  },
);

it("retains the exact trust-probe argument refusal", async () => {
  await expect(boot(["--omnyo-electron-trust-probe=bad"])).rejects.toThrow(
    "Invalid internal Electron trust probe arguments",
  );
});
