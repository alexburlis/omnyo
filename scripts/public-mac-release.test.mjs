import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  createRealEffects,
  feedRuntimeVersion,
  parseArguments,
  requireBridgePublicFeed,
  runRelease,
} from "./public-mac-release.mjs";
import {
  ALIAS_ASSET_NAME,
  FEED_NAME,
} from "../packages/config/src/public-mac-release.mjs";

const root = "/repo";

const home = "/home/tester";

const version = "0.46.365+private.1";

const commit = "a".repeat(40);

const archive = "stapled zip bytes";

const zip = "omnyo-0.46.365-arm64.zip";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
    [`/repo/apps/desktop/release/${zip}`, archive],
  ]);

  const calls = [];
  const logs = [];
  let clock = 1000;
  const hashes = new Map();
  const uploads = new Map();

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
    prepareRuntime: async ({ outputDirectory }) =>
      files.set(`${outputDirectory}/runtime-prepared.json`, "{}"),
    fileSize: async (path) => Buffer.byteLength(files.get(path)),
    sha256: async (path) => digest(files.get(path)),
    downloadText: async (url) => {
      calls.push(["download-text", url]);

      return feed;
    },
    downloadSha256: async (url, { allowMissing = false } = {}) => {
      calls.push([allowMissing ? "probe" : "download", url]);

      if (hashes.has(url)) return hashes.get(url);

      if (uploads.has(url)) return uploads.get(url);

      if (allowMissing) return null;
      throw new Error(`missing published asset ${url}`);
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
            protocolVersion: 254,
            teamId: "Z7T4C33A35",
            notarization: { id: "id", status: "Accepted" },
            archive: {
              sha256: digest(archive),
              bytes: Buffer.byteLength(archive),
            },
          }),
        );

      if (action.argv.includes("desktop:public-update-feed"))
        files.set(`/out/${FEED_NAME}`, "feed");

      if (action.argv[0] === "gh" && action.argv[2] === "upload") {
        const file = action.argv[4];
        const repository = action.argv[action.argv.indexOf("-R") + 1];
        uploads.set(
          `https://github.com/${repository}/releases/download/macos/${basename(file)}`,
          digest(files.get(file)),
        );
      }

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
  assert.equal(parseArguments(["--promote"]).mode, "promote");
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

test("defaults to the public source repository for macOS releases", async () => {
  const effects = createEffects();

  await runRelease({
    root,
    argv: ["--plan", "--credential-overlay", "/overlay.env"],
    effects,
    home,
  });

  assert.match(
    effects.logs.join("\n"),
    /Publish to alexburlis\/omnyo release macos/u,
  );
});

test("an absent feed allows the first 1.x release at the new public destination", async () => {
  const effects = createEffects({ feed: null });

  await requireBridgePublicFeed({
    effects,
    repository: "alexburlis/omnyo",
    version: "1.0.185",
  });
  await assert.rejects(
    requireBridgePublicFeed({
      effects,
      repository: "owner/releases",
      version: "1.0.185",
    }),
    /public_feed_not_bridge_capable/u,
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

test("refuses to replace a newer public update feed", async () => {
  const effects = createEffects({ feed: publishedFeed("1.0.184") });

  await assert.rejects(
    requireBridgePublicFeed({
      effects,
      repository: "owner/releases",
      version: "1.0.183",
    }),
    /already serves newer version 1\.0\.184/u,
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
    effects.calls.some(([kind]) => kind === "download" || kind === "probe"),
    false,
  );
  assert.equal(effects.files.get(`/out/${zip}`), archive);
  const receipt = JSON.parse(effects.files.get("/out/prepared-release.json"));
  assert.equal(receipt.sourceCommit, commit);
  assert.equal(receipt.archive.sha256, digest(archive));
  assert.ok(effects.files.has("/out/runtime-prepared.json"));
  assert.match(effects.logs.at(-1), /nothing was uploaded/u);
});

test("promotes a prepared build without loading signing credentials or rebuilding", async () => {
  const effects = createEffects();

  await run(["--prepare"], effects);
  effects.calls.length = 0;

  await runRelease({
    root,
    argv: ["--promote", "--output-dir", "/out"],
    effects,
    home,
    repository: "owner/releases",
  });

  const executed = effects.calls.filter(([kind]) => kind === "exec");
  assert.ok(executed.some((call) => call.includes("upload")));
  assert.ok(executed.every(([, program]) => program === "gh"));
});

test("refuses a tampered prepared archive before making any publication call", async () => {
  const effects = createEffects();
  await run(["--prepare"], effects);
  effects.calls.length = 0;
  const scratch = await mkdtemp(join(tmpdir(), "public-mac-prepared-"));

  try {
    for (const [file, content] of effects.files) {
      if (file.startsWith("/out/"))
        await writeFile(join(scratch, basename(file)), content);
    }

    await writeFile(join(scratch, zip), "changed zip bytes");

    const real = createRealEffects({ root: scratch, home });
    const readFixture = effects.readText;
    effects.realpath = real.realpath;
    effects.sha256 = real.sha256;
    effects.fileSize = real.fileSize;
    effects.readText = (path) =>
      path.startsWith(root + "/") ? readFixture(path) : real.readText(path);

    await assert.rejects(
      runRelease({
        root,
        argv: ["--promote", "--output-dir", scratch],
        effects,
        home,
        repository: "owner/releases",
      }),
      /differs from its recorded bytes/u,
    );
    assert.equal(
      effects.calls.some(([kind]) => kind === "exec"),
      false,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("promotion reconciles matching immutable uploads and refuses different bytes", async () => {
  const effects = createEffects();
  await run(["--prepare"], effects);
  await run(["--promote"], effects);
  effects.calls.length = 0;
  await run(["--promote"], effects);

  const uploadedZip = () =>
    effects.calls.some(
      ([kind, program, , action, , path]) =>
        kind === "exec" &&
        program === "gh" &&
        action === "upload" &&
        path === `/out/${zip}`,
    );

  assert.equal(uploadedZip(), false);

  effects.calls.length = 0;
  effects.corrupt(
    `https://github.com/owner/releases/releases/download/macos/${zip}`,
  );
  await assert.rejects(
    run(["--promote"], effects),
    /differs from the local file/u,
  );
  assert.equal(
    effects.calls.some((call) => call.includes("upload")),
    false,
  );
});

test("promotion stops if public main no longer points to the prepared commit", async () => {
  const effects = createEffects({ remoteCommit: "b".repeat(40) });
  await run(["--prepare"], effects);
  effects.calls.length = 0;
  await assert.rejects(
    run(["--promote"], effects),
    /exact commit currently on public main/u,
  );
  assert.equal(
    effects.calls.some(([kind]) => kind === "exec"),
    false,
  );
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
    `/out/${zip}`,
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
    (call) => call.includes(`/out/${zip}`) && call.includes("upload"),
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
  assert.ok(
    absent.calls.some(
      (call) =>
        call.includes("create") &&
        call[call.indexOf("--target") + 1] === commit,
    ),
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

test("a failing credential redactor rejects a successful child", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "public-mac-release-redactor-"));

  try {
    const bin = join(scratch, ".codex/bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "redact-stream"), "#!/bin/sh\nexit 7\n", {
      mode: 0o700,
    });
    await assert.rejects(
      createRealEffects({ root: scratch, home: scratch }).exec(
        {
          argv: [process.execPath, "-e", "process.exit(0)"],
          cwd: scratch,
          env: {},
          timeoutMs: 20000,
          redact: true,
        },
        { logFile: join(scratch, "child.log") },
      ),
      /redactor failed/u,
    );
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
