import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const args = process.argv.slice(2);

const source = args.find((arg) => arg !== "--check");

if (!source) throw new Error("Provide the shared solve-sentry-issues skill directory");

const root = resolve(import.meta.dirname, "..");

const destination = join(root, "skills/solve-sentry-issues");

const original = await readFile(join(resolve(source), "SKILL.md"), "utf8");

const format = (content, name) =>
  execFileSync("pnpm", ["exec", "oxfmt", "--stdin-filepath", join(destination, name)], {
    cwd: root,
    input: content,
    encoding: "utf8",
    timeout: 60000,
  });

const metadata = format(
  await readFile(join(resolve(source), "agents/openai.yaml"), "utf8"),
  "agents/openai.yaml",
);

const references =
  /Read \[the diagnostic standard\]\([^\n]+\) and\n\[the access guide\]\([^\n]+\) for the affected\nboundaries\./u;

if (!original.includes("name: solve-sentry-issues") || !references.test(original))
  throw new Error("Shared solver skill format changed; review its portable adaptation");

const portable = format(
  original
    .replace(
      references,
      "Follow the repository's diagnostic and access standards for the affected boundaries. " +
        "Use existing authenticated Sentry tools and accounts. Never expose credentials or raw user payloads. " +
        "If access is missing, report the precise limitation without treating it as an empty queue.",
    )
    .replaceAll("Paraspeech 2.0", "an app's 2.0 development version"),
  "SKILL.md",
);

if (/\/Users\/|[A-Z]:\\Users\\|\]\(\//u.test(portable + metadata))
  throw new Error("Bundled solver skill must not depend on private absolute paths");

const digest = (value) => createHash("sha256").update(value).digest("hex");

const files = new Map([
  ["SKILL.md", portable],
  ["agents/openai.yaml", metadata],
  [
    "source.json",
    JSON.stringify(
      {
        name: "solve-sentry-issues",
        sourceSha256: digest(original),
        bundledSha256: digest(portable),
        adaptation: "Repository access guidance and a generic development-version example",
      },
      null,
      2,
    ) + "\n",
  ],
]);

for (const [name, content] of files) {
  const path = join(destination, name);

  if (args.includes("--check")) {
    if ((await readFile(path, "utf8")) !== content)
      throw new Error("Bundled solver skill differs from the shared source: " + name);
  } else {
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
}

console.log(
  args.includes("--check") ? "Bundled solver skill matches" : "Bundled solver skill synced",
);
