import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ALIAS_ASSET_NAME,
  FEED_NAME,
  createRealEffects,
  feedRuntimeVersion,
  parseArguments,
  requireBridgePublicFeed,
  runRelease,
} from "./public-mac-release.mjs";

const root = "/repo";

const home = "/home/tester";

const version = "0.46.365+private.1";

const commit = "a".repeat(40);

const publishedFeed = (runtimeVersion) =>
  `version: 0.46.365\nfiles:\n  - url: omnyo-0.46.365-arm64.zip\nomnyoPrivate:\n  appId: dev.omnyo.beta\n  runtimeVersion: ${runtimeVersion}\n  protocolVersion: 254\n`;

function createEffects({
  dirty = "",
  subject,
  origin = "https://github.com/alexburlis/omnyo.git",
  remoteCommit = commit,
  versions,
  feed = publishedFeed("0.46.365+private.1"),
} = {}) {
  const files = new Map([
    [
      "/repo/apps/desktop/package.json",
      JSON.stringify({ version: versions?.[0] ?? version }),
    ],
    [
      "/repo/packages/omnyo-app/package.json",
      JSON.stringify({ version: versions?.[1] ?? version }),
    ],
    [
      "/repo/packages/host-daemon-contract/src/protocol.ts",
      "export const HOST_DAEMON_PROTOCOL_VERSION = 254 as const;\n",
    ],
    [`${home}/bin/op`, ""],
    [`${home}/.codex/bin/redact-stream`, ""],
    ["/overlay.env", ""],
  ]);

  const calls = [];
  const logs = [];
  let clock = 1000;
  const hashes = new Map();

  const effects = {
    calls,
    logs,
    files,
    log: (line) => logs.push(line),
    git: async (args) => {
      calls.push(["git", ...args]);

      if (args[0] === "status") return dirty;

      if (args[0] === "remote") return origin;

      if (args[0] === "ls-remote") return remoteCommit + "\trefs/heads/main\n";

      if (args[0] === "rev-parse") return `${commit}\n`;

      return `${subject ?? `Release Omnyo ${version}`}\n`;
    },
    realpath: async (path) => path,
    readText: async (path) => {
      if (!files.has(path)) throw new Error(`missing ${path}`);

      return files.get(path);
    },
    writeText: async (path, text) => {
      files.set(path, text);
    },
    exists: async (path) => files.has(path),
    modifiedAt: async () => clock + 1,
    now: () => clock,
    listDirectory: async () => [],
    makeDirectory: async (path) => calls.push(["mkdir", path]),
    copyFile: async (from, to) => {
      calls.push(["copy", from, to]);
      files.set(to, files.get(from) ?? "");
    },
    sha256: async () => "same",
    downloadText: async (url) => {
      calls.push(["download-text", url]);

      return feed;
    },
    downloadSha256: async (url) => {
      calls.push(["download", url]);

      return hashes.get(url) ?? "same";
    },
    corrupt: (url) => hashes.set(url, "different"),
    exec: async (action, { allowFailure = false } = {}) => {
      calls.push(["exec", ...action.argv]);

      if (action.argv.includes("scripts/public-mac-notary.mjs"))
        files.set(
          "/out/notary-result.json",
          JSON.stringify({
            status: "complete",
            stapled: true,
            sourceCommit: commit,
            version,
            notarization: { id: "id", status: "Accepted" },
          }),
        );

      if (action.argv.includes("desktop:public-update-feed"))
        files.set(`/out/${FEED_NAME}`, "feed");

      return { code: allowFailure && effects.releaseMissing ? 1 : 0 };
    },
  };

  return effects;
}

const run = (argv, effects) =>
  runRelease({
    root,
    argv: [
      "--credential-overlay",
      "/overlay.env",
      ...argv,
      "--output-dir",
      "/out",
    ],
    effects,
    home,
    repository: "owner/releases",
  });

test("parses modes and the output directory", () => {
  assert.deepEqual(parseArguments([]), {
    mode: "publish",
    outputDirectory: null,
    credentialOverlay: null,
  });
  assert.equal(parseArguments(["--plan"]).mode, "plan");
  assert.equal(parseArguments(["--prepare"]).mode, "prepare");
  assert.equal(
    parseArguments(["--prepare", "--output-dir", "/x"]).outputDirectory,
    "/x",
  );
  assert.throws(() => parseArguments(["--plan", "--prepare"]), /combined/u);
  assert.throws(() => parseArguments(["--output-dir"]), /needs a path/u);
  assert.throws(() => parseArguments(["--publish"]), /Unknown argument/u);
});

test("plan reads an untagged release identity without publishing", async () => {
  const effects = createEffects({
    versions: ["1.0.1", "1.0.1"],
    subject: "Release Omnyo 1.0.1",
  });

  await run(["--plan"], effects);

  const plan = effects.logs.join("\n");

  assert.match(plan, /1\.0\.1 \(a{40}\)/u);
  assert.match(plan, /omnyo-1\.0\.1-arm64\.zip/u);
  assert.deepEqual(
    effects.calls.filter(([kind]) => kind !== "git"),
    [],
  );
});

test("an untagged publish is refused before any build while the public feed is older than the bridge", async () => {
  const untagged = {
    versions: ["1.0.1", "1.0.1"],
    subject: "Release Omnyo 1.0.1",
  };

  for (const feed of [
    publishedFeed("0.46.365+private.1"),
    "version: 0.46.365\n",
  ]) {
    const effects = createEffects({ ...untagged, feed });

    await assert.rejects(
      run([], effects),
      /Untagged public release 1\.0\.1 refused before any effect: .*\(public_feed_not_bridge_capable\)/u,
    );
    assert.deepEqual(
      effects.calls.filter(([kind]) => kind !== "git"),
      [
        [
          "download-text",
          `https://github.com/owner/releases/releases/download/macos/${FEED_NAME}`,
        ],
      ],
    );
  }

  const prepared = createEffects(untagged);
  await run(["--prepare"], prepared).catch(() => {});
  assert.equal(
    prepared.calls.some(([kind]) => kind === "download-text"),
    false,
  );
});

test("the public feed gate admits a bridge-capable feed and never holds a tagged release", async () => {
  for (const runtimeVersion of ["1.0.0+private.1", "'1.0.1'"]) {
    const effects = createEffects({ feed: publishedFeed(runtimeVersion) });

    await requireBridgePublicFeed({
      effects,
      repository: "owner/releases",
      version: "1.0.2",
    });
  }

  const tagged = createEffects();
  await requireBridgePublicFeed({
    effects: tagged,
    repository: "owner/releases",
    version: "1.0.1+private.1",
  });
  assert.deepEqual(tagged.calls, []);

  assert.equal(
    feedRuntimeVersion(publishedFeed("1.0.0+private.1")),
    "1.0.0+private.1",
  );
  assert.equal(feedRuntimeVersion("runtimeVersion: 1.0.1\n"), null);
});

test("plan prints every step and runs nothing", async () => {
  const effects = createEffects();

  await run(["--plan"], effects);

  const plan = effects.logs.join("\n");

  assert.match(plan, /Mode: plan/u);
  assert.match(plan, /0\.46\.365\+private\.1 \(a{40}\)/u);
  assert.match(
    plan,
    /OMNYO_RUNTIME_MAC_SIGNING_TEAM=Z7T4C33A35 OMNYO_DESKTOP_RELEASE_CHANNEL=public-beta pnpm exec turbo/u,
  );
  assert.match(
    plan,
    /OMNYO_DESKTOP_RELEASE_CHANNEL=public-beta pnpm run desktop:build/u,
  );
  assert.match(plan, /\/overlay\.env -- node scripts\/public-mac-notary\.mjs/u);
  assert.match(plan, /omnyo-0\.46\.365-arm64\.zip/u);
  assert.match(plan, /gh release upload macos .*Omnyo-macOS\.zip --clobber/u);
  assert.deepEqual(
    effects.calls.filter(([kind]) => kind !== "git"),
    [],
  );
});

test("prepare omits every publish action", async () => {
  const effects = createEffects();

  await run(["--prepare"], effects);

  const executed = effects.calls.filter(([kind]) => kind === "exec");

  assert.ok(executed.length > 0);
  assert.equal(
    executed.some((call) => call.includes("gh")),
    false,
  );
  assert.equal(
    effects.calls.some(([kind]) => kind === "download" || kind === "copy"),
    false,
  );
  assert.match(effects.logs.at(-1), /nothing was uploaded/u);
});

test("refuses a dirty checkout before running anything", async () => {
  for (const mode of ["--plan", "--prepare", []]) {
    const effects = createEffects({ dirty: " M apps/desktop/package.json\n" });

    await assert.rejects(
      run([mode].flat(), effects),
      /uncommitted or untracked changes/u,
    );
    assert.deepEqual(
      effects.calls.filter(([kind]) => kind !== "git"),
      [],
    );
  }
});

test("refuses version files that disagree or are not at a release commit", async () => {
  await assert.rejects(
    run([], createEffects({ versions: [version, "0.46.364+private.1"] })),
    /Version files disagree/u,
  );
  await assert.rejects(
    run([], createEffects({ subject: "Fix the sidebar" })),
    /not the release commit/u,
  );
  await assert.rejects(
    run([], createEffects({ versions: ["0.46", "0.46"] })),
    /is not a release version/u,
  );
});

test("requires public source and an external credential overlay", async () => {
  await assert.rejects(
    run(["--plan"], createEffects({ origin: "https://example.org/fork" })),
    /public Omnyo source checkout/u,
  );
  await assert.rejects(
    run([], createEffects({ remoteCommit: "b".repeat(40) })),
    /exact commit currently on public main/u,
  );
  await assert.rejects(
    run(
      ["--plan", "--credential-overlay", "/repo/notary.env"],
      createEffects(),
    ),
    /outside the checkout/u,
  );
  await assert.rejects(
    run(
      ["--plan"],
      createEffects({ subject: "Release private Omnyo " + version }),
    ),
    /not the release commit/u,
  );
});

test("refuses a non-empty output directory", async () => {
  const effects = createEffects();

  effects.listDirectory = async () => ["old.log"];

  await assert.rejects(run([], effects), /is not empty/u);
});

test("uploads the versioned zip, then the alias, then the feed", async () => {
  const effects = createEffects();

  await run([], effects);

  const uploads = effects.calls
    .filter(
      ([kind, program, command]) =>
        kind === "exec" && program === "gh" && command === "release",
    )
    .filter((call) => call.includes("upload"))
    .map((call) => call.find((part) => /\.(zip|yml)$/u.test(part)));

  assert.deepEqual(uploads, [
    "/repo/apps/desktop/release/omnyo-0.46.365-arm64.zip",
    `/out/${ALIAS_ASSET_NAME}`,
    `/out/${FEED_NAME}`,
  ]);

  const aliasUpload = effects.calls.find(
    (call) =>
      call.includes(`/out/${ALIAS_ASSET_NAME}`) && call.includes("upload"),
  );

  const feedUpload = effects.calls.find(
    (call) => call.includes(`/out/${FEED_NAME}`) && call.includes("upload"),
  );

  const zipUpload = effects.calls.find(
    (call) =>
      call.includes("/repo/apps/desktop/release/omnyo-0.46.365-arm64.zip") &&
      call.includes("upload"),
  );

  assert.ok(aliasUpload.includes("--clobber"));
  assert.ok(feedUpload.includes("--clobber"));
  assert.equal(zipUpload.includes("--clobber"), false);
  assert.ok(
    effects.calls.findIndex(([kind]) => kind === "copy") <
      effects.calls.indexOf(aliasUpload),
  );
  assert.deepEqual(
    effects.calls.filter(([kind]) => kind === "download").map(([, url]) => url),
    [
      "https://github.com/owner/releases/releases/download/macos/omnyo-0.46.365-arm64.zip",
      `https://github.com/owner/releases/releases/download/macos/${ALIAS_ASSET_NAME}`,
      `https://github.com/owner/releases/releases/download/macos/${FEED_NAME}`,
    ],
  );
});

test("does not upload the feed when a published zip differs from the local one", async () => {
  const effects = createEffects();

  effects.corrupt(
    `https://github.com/owner/releases/releases/download/macos/${ALIAS_ASSET_NAME}`,
  );

  await assert.rejects(run([], effects), /differs from the local file/u);
  assert.equal(
    effects.calls.some(
      (call) => call.includes(`/out/${FEED_NAME}`) && call.includes("upload"),
    ),
    false,
  );
});

test("creates the release only when it is absent", async () => {
  const present = createEffects();

  await run([], present);
  assert.equal(
    present.calls.some((call) => call.includes("create")),
    false,
  );

  const absent = createEffects();

  absent.releaseMissing = true;
  await run([], absent);
  assert.equal(
    absent.calls.some((call) => call.includes("create")),
    true,
  );
});

test("stops before publishing when notarization is not accepted", async () => {
  const effects = createEffects();
  const original = effects.exec;

  effects.exec = async (action, options) => {
    const outcome = await original(action, options);

    if (action.argv.includes("scripts/public-mac-notary.mjs"))
      effects.files.set(
        "/out/notary-result.json",
        JSON.stringify({ status: "complete", stapled: false }),
      );

    return outcome;
  };

  await assert.rejects(run([], effects), /not complete and accepted/u);
  assert.equal(
    effects.calls.some((call) => call.includes("gh")),
    false,
  );
});

test("a stale build product is rejected", async () => {
  const effects = createEffects();

  effects.modifiedAt = async () => 1;

  await assert.rejects(
    run(["--prepare"], effects),
    /was not produced by this build/u,
  );
});

test("passes a notarization child's output through the credential filter", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "public-mac-release-test-"));

  try {
    const effects = createRealEffects({
      root: scratch,
      home: process.env.HOME,
    });

    const logFile = join(scratch, "child.log");

    await effects.exec(
      {
        argv: [
          process.execPath,
          "-e",
          'const header = ["PRIVATE", "KEY"].join(" "); console.log("-----BEGIN " + header + "-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCSyntheticFixtureOnly\\n-----END " + header + "-----\\nstatus=ok");',
        ],
        cwd: scratch,
        env: {},
        timeoutMs: 20000,
        redact: true,
      },
      { logFile },
    );

    const log = await readFile(logFile, "utf8");

    assert.match(log, /status=ok/u);
    assert.doesNotMatch(log, /MIIEvQIBADANBgkqhkiG9w0BAQEFAASC/u);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a failing child reports its log path without its output", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "public-mac-release-test-"));

  try {
    const effects = createRealEffects({
      root: scratch,
      home: process.env.HOME,
    });

    const logFile = join(scratch, "child.log");

    await writeFile(join(scratch, "marker"), "");
    await assert.rejects(
      effects.exec(
        {
          argv: [
            process.execPath,
            "-e",
            "console.error('LEAK'); process.exit(3)",
          ],
          cwd: scratch,
          env: {},
          timeoutMs: 20000,
          redact: false,
        },
        { logFile },
      ),
      (error) =>
        error.message.includes(logFile) && !error.message.includes("LEAK"),
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
