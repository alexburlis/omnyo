import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "..");

const pointer = JSON.parse(await readFile(join(root, "dist/runtime-current.json"), "utf8"));

const scratch = await mkdtemp(join(tmpdir(), "sentry-runtime-smoke-"));

try {
  const runtime = join(scratch, "runtime");
  execFileSync("/bin/cp", ["-ac", pointer.directory, runtime]);
  execFileSync("omnyo", ["plugin", "build", runtime], { stdio: ["ignore", "pipe", "pipe"] });
  const manifest = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
  assert.deepEqual(manifest.omnyo.skills, ["skills"]);

  for (const name of ["sentry", "solve-sentry-issues"]) {
    const path = join("skills", name, "SKILL.md");
    const packaged = await readFile(join(runtime, path), "utf8");
    assert.equal(packaged, await readFile(join(root, path), "utf8"));
    assert(packaged.includes(`name: ${name}`));
  }

  const provenance = JSON.parse(
    await readFile(join(runtime, "skills/solve-sentry-issues/source.json"), "utf8"),
  );

  const policy = await readFile(join(runtime, "skills/solve-sentry-issues/SKILL.md"), "utf8");
  assert.equal(createHash("sha256").update(policy).digest("hex"), provenance.bundledSha256);
  assert(!/\/Users\/|[A-Z]:\\Users\\|\]\(\//u.test(policy));
  await access(join(runtime, "skills/solve-sentry-issues/agents/openai.yaml"));
  const css = await readFile(join(runtime, "dist/app.css"), "utf8");
  assert(
    css.includes(".sentry-panel"),
    "A path installation rebuild must retain the authored inbox styles",
  );
  assert(
    css.includes(".sentry-rail-badge"),
    "A path installation rebuild must retain the global icon badge styles",
  );
  await writeFile(
    join(root, "docs/evidence/runtime-package-journey.json"),
    JSON.stringify(
      {
        build: pointer.build,
        pathInstallRebuild: true,
        inboxStylesRetained: true,
        badgeStylesRetained: true,
        bundledSolverSkills: ["sentry", "solve-sentry-issues"],
        solverPolicySha256: provenance.bundledSha256,
        surface:
          "Real installed Omnyo CLI rebuilt the compiled runtime exactly as a path install does",
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Runtime path-install CSS journey passed");
} finally {
  await rm(scratch, { recursive: true, force: true });
  assert.equal(
    await access(scratch).then(
      () => true,
      () => false,
    ),
    false,
  );
}
