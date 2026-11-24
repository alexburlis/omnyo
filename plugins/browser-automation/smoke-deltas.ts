import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRuntime, runtimeEnvironment } from "./runtime.js";
import { execute } from "./process.js";
import { currentPlatform } from "./installer.js";
import { runtimeRelease } from "./runtime-pin.js";
import { z } from "zod";

const binary = resolve(
  z.string().min(1).parse(process.env.DEV_BROWSER_SMOKE_BINARY),
);

const chrome = resolve(
  z.string().min(1).parse(process.env.DEV_BROWSER_SMOKE_CHROME),
);

const parent = resolve(z.string().min(1).parse(process.argv[2]));

assert.equal((await stat(parent)).isDirectory(), true);

const signal = AbortSignal.timeout(40_000);

const platform = currentPlatform();

assert.ok(platform);

const hash = createHash("sha256");

for await (const chunk of createReadStream(binary)) hash.update(chunk);

const sha256 = hash.digest("hex");

assert.equal(sha256, runtimeRelease.artifacts[platform]);

const version = await execute(
  binary,
  ["--version"],
  runtimeEnvironment(parent),
  signal,
);

assert.equal(version.trim(), `dev-browser ${runtimeRelease.version}`);

const root = await mkdtemp(join(parent, "browser-deltas-"));

let session: Awaited<ReturnType<typeof createRuntime>> | undefined;

const pairSchema = z
  .object({ full: z.string(), incremental: z.string() })
  .strict();

const options = '{interactive:true,track:"main-interactive"}';

const fixture = (body: string) => `data:text/html,${encodeURIComponent(body)}`;

const items = Array.from(
  { length: 60 },
  (_, index) => `<button>Item ${index}</button>`,
).join("");

const initialUrl = fixture(
  `<h1>Delta fixture</h1><button id="save" aria-pressed="false" onclick="this.setAttribute('aria-pressed','true');document.querySelector('[role=status]').textContent='Saved'">Save</button><p role="status">Ready</p><button id="remove" onclick="document.querySelector('#temporary').remove()">Remove</button><button id="temporary">Temporary</button>${items}`,
);

const navigatedUrl = fixture(
  '<h1>New document</h1><section id="focused"><button onclick="this.textContent=\'Finished\'">Continue</button></section><button>Outside scope</button>',
);

const observedRef = (tree: string, name: string) => {
  const match = tree
    .split("\n")
    .find((line) => line.includes(`button "${name}"`))
    ?.match(/\[ref=(e\d+)\]/);

  assert.ok(match, `Missing current ref for ${name}`);

  return match[1]!;
};

try {
  const dataDir = join(root, "data");

  await mkdir(join(dataDir, "runtime"), { recursive: true });
  await symlink(chrome, join(dataDir, "runtime", "chrome"));
  session = await createRuntime({
    runtime: { binary, version: runtimeRelease.version, source: "release" },
    dataDir,
    tempDir: join(root, "sessions"),
    signal,
  });

  const run = async (script: string) => {
    const result = await session!.run(script, 10_000, signal);

    assert.equal(result.exitCode, 0, result.text);

    return result.text.trim();
  };

  const prefix = 'const p = await browser.getPage("main");';

  const baseline = await run(
    `${prefix} await p.goto(${JSON.stringify(initialUrl)}); const s = await p.snapshot(${options}); s.full`,
  );

  assert.match(baseline, /Item 59/);
  assert.match(baseline, /Ready/);
  assert.equal(
    await run(
      `${prefix} const s = await p.snapshot(${options}); s.incremental`,
    ),
    "(no changes)",
  );

  const changed = pairSchema.parse(
    JSON.parse(
      await run(
        `${prefix} await p.click(${JSON.stringify(`ref/${observedRef(baseline, "Save")}`)}); const s = await p.snapshot(${options}); JSON.stringify(s)`,
      ),
    ),
  );

  assert.match(changed.full, /Item 59/);
  assert.match(changed.incremental, /\+ .*button "Save".*\[pressed\]/);
  assert.match(changed.incremental, /Saved/);
  assert.doesNotMatch(changed.incremental, /Item 59/);

  const fullBytes = Buffer.byteLength(changed.full);

  const incrementalBytes = Buffer.byteLength(changed.incremental);

  assert.ok(incrementalBytes < fullBytes);

  const removedRef = observedRef(changed.full, "Temporary");

  const removed = await run(
    `${prefix} await p.click(${JSON.stringify(`ref/${observedRef(changed.full, "Remove")}`)}); const s = await p.snapshot(${options}); s.incremental`,
  );

  assert.match(removed, /- .*button "Temporary"/);

  const stale = await run(
    `${prefix} let message = "unexpected success"; try { await p.ref(${JSON.stringify(removedRef)}); } catch (error) { message = error.message; } message`,
  );

  assert.match(stale, /stale|unknown/);

  const navigated = await run(
    `${prefix} await p.goto(${JSON.stringify(navigatedUrl)}); const s = await p.snapshot(${options}); s.full`,
  );

  assert.match(navigated, /New document/);
  assert.doesNotMatch(navigated, /Item 59|Temporary/);

  const completed = await run(
    `${prefix} await p.click(${JSON.stringify(`ref/${observedRef(navigated, "Continue")}`)}); const s = await p.snapshot(${options}); s.incremental`,
  );

  assert.match(completed, /Finished/);
  assert.doesNotMatch(completed, /Item 59|Temporary/);

  const scopedOptions =
    '{interactive:true,scope:"#focused",track:"main-interactive"}';

  const scoped = await run(
    `${prefix} const s = await p.snapshot(${scopedOptions}); s.full`,
  );

  assert.match(scoped, /Finished/);
  assert.doesNotMatch(scoped, /Outside scope/);
  assert.equal(
    await run(
      `${prefix} const s = await p.snapshot(${scopedOptions}); s.incremental`,
    ),
    "(no changes)",
  );
  await session.close();
  session = undefined;
  console.log(
    JSON.stringify({
      passed: true,
      version: runtimeRelease.version,
      sha256,
      fullBytes,
      incrementalBytes,
      savedBytes: fullBytes - incrementalBytes,
      checks: [
        "initial full baseline",
        "unchanged delta",
        "action and semantic delta in one script",
        "same-state output bytes",
        "removed ref rejection",
        "navigation full baseline with fresh refs",
        "changed scope full baseline",
      ],
    }),
  );
} finally {
  await session?.close();
  await rm(root, { recursive: true, force: true });
}
