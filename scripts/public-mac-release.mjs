import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALIAS_ASSET_NAME,
  FEED_NAME,
  RELEASE_TAG,
  RELEASES_REPOSITORY,
} from "../packages/config/src/public-mac-release.mjs";
import {
  compareReleaseNumbers,
  parseReleaseVersion,
} from "../packages/config/src/release-version.mjs";
import { preparePublicRuntime } from "./public-runtime-checkpoint.mjs";

const PUBLIC_SOURCE_ORIGIN = `https://github.com/${RELEASES_REPOSITORY}.git`;

export const SIGNING_TEAM = "Z7T4C33A35";

const RELEASE_RECEIPT = "prepared-release.json";

const NOTARY_RESULT = "notary-result.json";

export const REDACTED_NAMES = [
  "ASC_PRIVATE_KEY_BASE64",
  "ASC_KEY_ID",
  "ASC_ISSUER_ID",
];

const USAGE = `Usage: pnpm public:mac-release [--plan | --prepare | --promote] [--credential-overlay PATH] [--output-dir PATH]

  (no mode)    build, sign, notarize, verify, create the feed and publish
  --prepare    build, notarize and save the verified archive, feed and receipt
  --promote    publish an existing prepared archive and feed
  --plan       print the steps without running any of them
  --credential-overlay PATH
               notary credential references outside the checkout
  --output-dir PATH
               directory for logs, results and the feed
               (default: ~/scratch/omnyo/public-mac-release/<version>)`;

const MINUTE = 60 * 1000;

export function parseArguments(argv) {
  const options = {
    mode: "publish",
    outputDirectory: null,
    credentialOverlay: null,
  };

  let modeFlag = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (["--plan", "--prepare", "--promote"].includes(argument)) {
      if (modeFlag !== null && modeFlag !== argument)
        throw new Error(`${modeFlag} and ${argument} cannot be combined`);
      modeFlag = argument;
      options.mode = argument.slice(2);
    } else if (
      argument === "--output-dir" ||
      argument === "--credential-overlay"
    ) {
      const value = argv[index + 1];

      if (value === undefined || value.startsWith("--"))
        throw new Error(argument + " needs a path");

      if (argument === "--output-dir") options.outputDirectory = value;
      else options.credentialOverlay = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.mode = "help";
    } else {
      throw new Error(`Unknown argument ${argument}\n${USAGE}`);
    }
  }

  return options;
}

export function usage() {
  return USAGE;
}

export function releaseCommitSubject(version) {
  return `Release Omnyo ${version}`;
}

export function isReleaseCommitSubject(subject, version) {
  return subject === releaseCommitSubject(version);
}

export async function readReleaseIdentity({ root, effects }) {
  const versions = await Promise.all(
    ["apps/desktop/package.json", "packages/omnyo-app/package.json"].map(
      async (path) => ({
        path,
        version: JSON.parse(await effects.readText(join(root, path))).version,
      }),
    ),
  );

  const [first, second] = versions;

  if (first.version !== second.version)
    throw new Error(
      `Version files disagree: ${first.path}=${first.version} ${second.path}=${second.version}`,
    );

  const parsed = parseReleaseVersion(first.version);

  if (parsed === null)
    throw new Error(
      `Version ${first.version} is not a release version (X.Y.Z or X.Y.Z+private.N)`,
    );

  const protocolSource = await effects.readText(
    join(root, "packages/host-daemon-contract/src/protocol.ts"),
  );

  const protocol = /HOST_DAEMON_PROTOCOL_VERSION = (\d+)/u.exec(protocolSource);

  if (protocol === null)
    throw new Error("Host daemon protocol version was not found");

  return {
    version: first.version,
    numericVersion: parsed.numeric,
    protocolVersion: Number(protocol[1]),
  };
}

export function feedRuntimeVersion(feed) {
  const lines = feed.split(/\r?\n/u);
  const start = lines.indexOf("omnyoPrivate:");

  if (start === -1) return null;

  for (const line of lines.slice(start + 1)) {
    if (!/^[ \t]/u.test(line)) break;

    const match =
      /^[ \t]+runtimeVersion:[ \t]*(['"]?)([^'"\s]+)\1[ \t]*$/u.exec(line);

    if (match !== null) return match[2];
  }

  return null;
}

export async function requireBridgePublicFeed({
  effects,
  repository,
  version,
}) {
  if (parseReleaseVersion(version)?.revision !== null) return;

  const url = `https://github.com/${repository}/releases/download/${RELEASE_TAG}/${FEED_NAME}`;
  const feed = await effects.downloadText(url);

  if (
    feed === null &&
    repository === RELEASES_REPOSITORY &&
    compareReleaseNumbers(version, "1.0.0") >= 0
  )
    return;

  const published = feed === null ? null : feedRuntimeVersion(feed);

  if (
    parseReleaseVersion(published) === null ||
    compareReleaseNumbers(published, "1.0.0") < 0
  )
    throw new Error(
      `Untagged public release ${version} refused before any effect: the published ${FEED_NAME} carries runtime ${published ?? "an unreadable version"}, and installed public apps older than 1.0.0 reject untagged updates. Publish a tagged 1.x bridge build to the public channel first and let users update to it (public_feed_not_bridge_capable).`,
    );

  if (compareReleaseNumbers(published, version) > 0)
    throw new Error(`Public feed already serves newer version ${published}`);
}

async function requirePublicMain(effects, sourceCommit) {
  const ref = "refs/heads/main";

  const remote = (
    await effects.git(["ls-remote", "--exit-code", "origin", ref])
  ).trim();

  if (remote !== sourceCommit + "\t" + ref)
    throw new Error(
      "Publish requires the exact commit currently on public main",
    );
}

export async function preflight({ root, effects, home, options }) {
  const dirty = (await effects.git(["status", "--porcelain"])).trim();

  if (dirty !== "")
    throw new Error(
      "Refusing to release from a checkout with uncommitted or untracked changes",
    );

  const origin = (await effects.git(["remote", "get-url", "origin"])).trim();

  if (origin !== PUBLIC_SOURCE_ORIGIN)
    throw new Error("A public Omnyo source checkout is required");

  const identity = await readReleaseIdentity({ root, effects });

  const sourceCommit = (await effects.git(["rev-parse", "HEAD"])).trim();
  const subject = (await effects.git(["log", "-1", "--format=%s"])).trim();

  if (!isReleaseCommitSubject(subject, identity.version))
    throw new Error(
      `HEAD is not the release commit for ${identity.version}; expected "${releaseCommitSubject(identity.version)}" but found "${subject}"`,
    );

  if (options.mode === "publish" || options.mode === "promote")
    await requirePublicMain(effects, sourceCommit);

  const tools = {
    op: join(home, "bin/op"),
    redact: join(home, ".codex/bin/redact-stream"),
  };

  if (options.mode === "promote")
    return { ...identity, sourceCommit, overlay: "", tools };

  if (options.credentialOverlay === null)
    throw new Error("--credential-overlay is required");

  const [overlay, checkout] = await Promise.all([
    effects.realpath(resolve(options.credentialOverlay)),
    effects.realpath(root),
  ]);

  const relativeOverlay = relative(checkout, overlay);

  if (
    !isAbsolute(relativeOverlay) &&
    relativeOverlay !== ".." &&
    !relativeOverlay.startsWith("../")
  )
    throw new Error(
      "The notary credential overlay must be outside the checkout",
    );

  for (const path of [tools.op, tools.redact, overlay])
    if (!(await effects.exists(path)))
      throw new Error(`Required release input is missing: ${path}`);

  return { ...identity, sourceCommit, overlay, tools };
}

function exec(argv, { cwd, env = {}, timeoutMs = 5 * MINUTE, redact = false }) {
  return { kind: "exec", argv, cwd, env, timeoutMs, redact };
}

function check(describe, run) {
  return { kind: "check", describe, run };
}

const archiveName = (identity) => `omnyo-${identity.numericVersion}-arm64.zip`;

function preparedIdentity(identity, repository) {
  return {
    schema: 1,
    sourceCommit: identity.sourceCommit,
    version: identity.version,
    protocolVersion: identity.protocolVersion,
    repository,
    tag: RELEASE_TAG,
    channel: "public-beta",
    teamId: SIGNING_TEAM,
  };
}

async function artifactBytes(effects, path) {
  const [sha256, bytes] = await Promise.all([
    effects.sha256(path),
    effects.fileSize(path),
  ]);

  if (
    !/^[a-f0-9]{64}$/u.test(sha256) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1
  )
    throw new Error(`Invalid release artifact at ${path}`);

  return { sha256, bytes };
}

function sameBytes(recorded, actual) {
  return recorded?.sha256 === actual.sha256 && recorded?.bytes === actual.bytes;
}

async function readNotaryResult(effects, path, identity) {
  const outcome = JSON.parse(await effects.readText(path));

  if (
    outcome.status !== "complete" ||
    outcome.stapled !== true ||
    outcome.notarization?.status !== "Accepted" ||
    outcome.sourceCommit !== identity.sourceCommit ||
    outcome.version !== identity.version ||
    outcome.protocolVersion !== identity.protocolVersion ||
    outcome.teamId !== SIGNING_TEAM
  )
    throw new Error("Notarization result is not complete and accepted");

  return outcome.archive;
}

async function verifyPrepared(effects, outputDirectory, identity, repository) {
  const directory = await effects.realpath(outputDirectory);

  const paths = [
    RELEASE_RECEIPT,
    archiveName(identity),
    FEED_NAME,
    NOTARY_RESULT,
  ].map((name) => join(directory, name));

  const [receipt, zip, feed, notarization] = paths;

  const resolved = await Promise.all(
    paths.map((path) => effects.realpath(path)),
  );

  if (resolved.some((path, index) => path !== paths[index]))
    throw new Error(
      "Prepared release files must be direct files in the output directory",
    );

  const prepared = JSON.parse(await effects.readText(receipt));
  const binding = preparedIdentity(identity, repository);

  if (Object.entries(binding).some(([key, value]) => prepared[key] !== value))
    throw new Error(
      "Prepared release identity does not match this publication",
    );

  const [archive, manifest, notarized] = await Promise.all([
    artifactBytes(effects, zip),
    artifactBytes(effects, feed),
    readNotaryResult(effects, notarization, identity),
  ]);

  if (
    !sameBytes(prepared.archive, archive) ||
    !sameBytes(notarized, archive) ||
    !sameBytes(prepared.feed, manifest)
  )
    throw new Error(
      "Prepared release artifact differs from its recorded bytes",
    );
}

export function buildSteps({ root, outputDirectory, identity, repository }) {
  const desktop = join(root, "apps/desktop");
  const app = join(desktop, "release/mac-arm64/Omnyo.app");
  const zipName = archiveName(identity);
  const zip = join(desktop, "release", zipName);
  const preparedZip = join(outputDirectory, zipName);
  const alias = join(outputDirectory, ALIAS_ASSET_NAME);
  const feed = join(outputDirectory, FEED_NAME);
  const extracted = join(outputDirectory, "extracted");
  const extractedApp = join(extracted, "Omnyo.app");
  const job = join(outputDirectory, "notary-job.json");
  const result = join(outputDirectory, NOTARY_RESULT);
  const releaseArguments = ["-R", repository];

  const downloadUrl = (name) =>
    `https://github.com/${repository}/releases/download/${RELEASE_TAG}/${name}`;

  const verifyDownload = (name, file) =>
    check(
      `download ${downloadUrl(name)} and compare its sha256 with ${file}`,
      async (effects) => {
        const [expected, actual] = await Promise.all([
          effects.sha256(file),
          effects.downloadSha256(downloadUrl(name)),
        ]);

        if (expected !== actual)
          throw new Error(`Published ${name} differs from the local file`);
      },
    );

  return [
    {
      id: "build-runtime",
      title: "Build and sign the bundled runtime",
      phase: "prepare",
      actions: [
        exec(["pnpm", "exec", "turbo", "run", "build", "--filter=omnyo-app"], {
          cwd: root,
          env: {
            OMNYO_RUNTIME_MAC_SIGNING_TEAM: SIGNING_TEAM,
            OMNYO_DESKTOP_RELEASE_CHANNEL: "public-beta",
          },
          timeoutMs: 30 * MINUTE,
        }),
        check(
          "snapshot the verified runtime for coordinator staging",
          (effects) =>
            effects.prepareRuntime({ root, outputDirectory, identity }),
        ),
      ],
    },
    {
      id: "build-desktop",
      title: "Build and sign the public macOS app",
      phase: "prepare",
      actions: [
        check("record the build start time", (effects, state) => {
          state.buildStartedAt = effects.now();
        }),
        exec(["pnpm", "run", "desktop:build"], {
          cwd: desktop,
          env: { OMNYO_DESKTOP_RELEASE_CHANNEL: "public-beta" },
          timeoutMs: 45 * MINUTE,
        }),
        check(
          `require ${app} and ${zip} to be produced by this build`,
          async (effects, state) => {
            for (const path of [app, zip]) {
              const modified = await effects.modifiedAt(path);

              if (modified === null || modified < state.buildStartedAt)
                throw new Error(`${path} was not produced by this build`);
            }
          },
        ),
      ],
    },
    {
      id: "notarize",
      title: "Notarize and staple",
      phase: "prepare",
      actions: [
        check(`write ${job}`, (effects) =>
          effects.writeText(
            job,
            JSON.stringify({
              sourceCommit: identity.sourceCommit,
              version: identity.version,
              protocolVersion: identity.protocolVersion,
              nativeRelease: { tools: {} },
            }) + "\n",
          ),
        ),
        exec(
          [
            identity.tools.op,
            "run",
            "--env-file",
            identity.overlay,
            "--",
            "node",
            "scripts/public-mac-notary.mjs",
            "--job",
            job,
            "--app",
            app,
            "--zip",
            zip,
            "--result",
            result,
          ],
          { cwd: root, timeoutMs: 45 * MINUTE, redact: true },
        ),
        check(`require a complete accepted stapled ${result}`, (effects) =>
          readNotaryResult(effects, result, identity),
        ),
      ],
    },
    {
      id: "verify",
      title: "Verify Gatekeeper and the staple on the app and the final zip",
      phase: "prepare",
      actions: [
        exec(["spctl", "--assess", "--type", "execute", "--verbose=2", app], {
          cwd: root,
        }),
        exec(["xcrun", "stapler", "validate", app], { cwd: root }),
        exec(["ditto", "-x", "-k", zip, extracted], {
          cwd: root,
          timeoutMs: 15 * MINUTE,
        }),
        exec(
          [
            "spctl",
            "--assess",
            "--type",
            "execute",
            "--verbose=2",
            extractedApp,
          ],
          { cwd: root },
        ),
        exec(["xcrun", "stapler", "validate", extractedApp], { cwd: root }),
      ],
    },
    {
      id: "feed",
      title: "Create the update feed",
      phase: "prepare",
      actions: [
        exec(
          [
            "corepack",
            "pnpm",
            "--dir",
            "apps/desktop",
            "desktop:public-update-feed",
            "--app",
            app,
            "--zip",
            zip,
            "--output",
            feed,
            "--channel",
            "public-beta",
          ],
          { cwd: root, timeoutMs: 10 * MINUTE },
        ),
        check(`require ${feed}`, async (effects) => {
          if (!(await effects.exists(feed)))
            throw new Error("The update feed was not written");
        }),
        check(
          "save the prepared archive and record its feed and notarization",
          async (effects) => {
            await effects.copyFile(zip, preparedZip);

            const [archive, manifest, notarized] = await Promise.all([
              artifactBytes(effects, preparedZip),
              artifactBytes(effects, feed),
              readNotaryResult(effects, result, identity),
            ]);

            if (!sameBytes(notarized, archive))
              throw new Error(
                "Prepared archive differs from the notarized bytes",
              );

            await effects.writeText(
              join(outputDirectory, RELEASE_RECEIPT),
              JSON.stringify({
                ...preparedIdentity(identity, repository),
                archive,
                feed: manifest,
              }) + "\n",
            );
          },
        ),
      ],
    },
    {
      id: "publish",
      title: `Publish to ${repository} release ${RELEASE_TAG}: versioned zip, then ${ALIAS_ASSET_NAME}, then feed`,
      phase: "publish",
      actions: [
        check(
          "verify the approved source and prepared artifacts before publication",
          async (effects) => {
            await requirePublicMain(effects, identity.sourceCommit);
            await verifyPrepared(
              effects,
              outputDirectory,
              identity,
              repository,
            );
            await requireBridgePublicFeed({
              effects,
              repository,
              version: identity.version,
            });
          },
        ),
        check(
          `create release ${RELEASE_TAG} if it does not exist`,
          async (effects) => {
            const view = await effects.exec(
              exec(
                ["gh", "release", "view", RELEASE_TAG, ...releaseArguments],
                {
                  cwd: root,
                },
              ),
              { allowFailure: true },
            );

            if (view.code === 0) return;

            await effects.exec(
              exec(
                [
                  "gh",
                  "release",
                  "create",
                  RELEASE_TAG,
                  ...releaseArguments,
                  "--target",
                  identity.sourceCommit,
                  "--title",
                  "Omnyo for macOS",
                  "--notes",
                  "Current public Omnyo build for macOS.",
                ],
                { cwd: root },
              ),
            );
          },
        ),
        check(
          `upload or reconcile the immutable archive ${zipName}`,
          async (effects) => {
            const existing = await effects.downloadSha256(
              downloadUrl(zipName),
              {
                allowMissing: true,
              },
            );

            if (existing === null) {
              await effects.exec(
                exec(
                  [
                    "gh",
                    "release",
                    "upload",
                    RELEASE_TAG,
                    preparedZip,
                    ...releaseArguments,
                  ],
                  { cwd: root, timeoutMs: 20 * MINUTE },
                ),
              );
            } else if (existing !== (await effects.sha256(preparedZip))) {
              throw new Error(
                `Published ${zipName} differs from the local file`,
              );
            }
          },
        ),
        verifyDownload(zipName, preparedZip),
        check(
          "recheck the release source and feed before updating the stable download",
          async (effects) => {
            await requirePublicMain(effects, identity.sourceCommit);
            await requireBridgePublicFeed({
              effects,
              repository,
              version: identity.version,
            });
          },
        ),
        check(`copy ${preparedZip} to ${alias}`, (effects) =>
          effects.copyFile(preparedZip, alias),
        ),
        exec(
          [
            "gh",
            "release",
            "upload",
            RELEASE_TAG,
            alias,
            "--clobber",
            ...releaseArguments,
          ],
          { cwd: root, timeoutMs: 20 * MINUTE },
        ),
        verifyDownload(ALIAS_ASSET_NAME, preparedZip),
        check(
          "recheck the release source and feed before updating the feed",
          async (effects) => {
            await requirePublicMain(effects, identity.sourceCommit);
            await requireBridgePublicFeed({
              effects,
              repository,
              version: identity.version,
            });
          },
        ),
        exec(
          [
            "gh",
            "release",
            "upload",
            RELEASE_TAG,
            feed,
            "--clobber",
            ...releaseArguments,
          ],
          { cwd: root },
        ),
        verifyDownload(FEED_NAME, feed),
      ],
    },
  ];
}

export function selectSteps(steps, mode) {
  if (mode === "prepare")
    return steps.filter((step) => step.phase === "prepare");

  if (mode === "promote")
    return steps.filter((step) => step.phase === "publish");

  return steps;
}

function quote(value) {
  return /^[\w@%+=:,./-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export function describeAction(action) {
  if (action.kind === "check") return action.describe;

  const environment = Object.entries(action.env).map(
    ([name, value]) => `${name}=${quote(value)} `,
  );

  return `${environment.join("")}${action.argv.map(quote).join(" ")}  (cwd ${action.cwd})`;
}

export function renderPlan({ steps, outputDirectory, identity, mode }) {
  const lines = [
    `Public macOS release ${identity.version} (${identity.sourceCommit})`,
    `Mode: ${mode}`,
    `Output directory: ${outputDirectory}`,
  ];

  steps.forEach((step, index) => {
    lines.push("", `${index + 1}. ${step.title}`);

    for (const action of step.actions)
      lines.push(`   - ${describeAction(action)}`);
  });

  return lines.join("\n");
}

export function defaultOutputDirectory(home, version) {
  return join(home, "scratch/omnyo/public-mac-release", version);
}

export async function runRelease({ root, argv, effects, home, repository }) {
  const options = parseArguments(argv);

  if (options.mode === "help") {
    effects.log(USAGE);

    return { steps: [] };
  }

  const identity = await preflight({ root, effects, home, options });
  const destination = repository ?? RELEASES_REPOSITORY;

  if (options.mode === "publish" || options.mode === "promote")
    await requireBridgePublicFeed({
      effects,
      repository: destination,
      version: identity.version,
    });

  const outputDirectory = resolve(
    options.outputDirectory ?? defaultOutputDirectory(home, identity.version),
  );

  const steps = selectSteps(
    buildSteps({
      root,
      outputDirectory,
      identity,
      repository: destination,
    }),
    options.mode,
  );

  if (options.mode === "plan") {
    effects.log(
      renderPlan({ steps, outputDirectory, identity, mode: options.mode }),
    );

    return { steps };
  }

  if (options.mode !== "promote") {
    if ((await effects.listDirectory(outputDirectory)).length > 0)
      throw new Error(
        `Output directory ${outputDirectory} is not empty; choose another with --output-dir`,
      );
    await effects.makeDirectory(outputDirectory);
  }

  const state = {};

  const logPrefix =
    options.mode === "promote" ? `promote-${effects.now()}-` : "";

  for (const [index, step] of steps.entries()) {
    effects.log(`[${index + 1}/${steps.length}] ${step.title}`);

    let execCount = 0;

    for (const action of step.actions) {
      if (action.kind === "check") {
        await action.run(effects, state);
        continue;
      }

      execCount += 1;

      await effects.exec(action, {
        logFile: join(
          outputDirectory,
          `${logPrefix}${String(index + 1).padStart(2, "0")}-${step.id}-${execCount}.log`,
        ),
      });
    }
  }

  effects.log(
    options.mode === "prepare"
      ? `Prepared ${identity.version}; nothing was uploaded. Results are in ${outputDirectory}`
      : `Published ${identity.version} to ${destination}`,
  );

  return { steps };
}

function runProcess(
  argv,
  { cwd, env, timeoutMs, stdio, allowFailure = false, failure },
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      stdio,
      timeout: timeoutMs,
    });

    child.once("error", () => reject(new Error(failure)));
    child.once("close", (code) => {
      if (code !== 0 && !allowFailure) reject(new Error(failure));
      else resolvePromise({ code });
    });
  });
}

function runGit(root, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });

    const chunks = [];

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolvePromise(Buffer.concat(chunks).toString("utf8"))
        : reject(new Error(`git ${args.join(" ")} failed`)),
    );
  });
}

async function hashFile(path) {
  const hash = createHash("sha256");

  for await (const bytes of createReadStream(path)) hash.update(bytes);

  return hash.digest("hex");
}

export function createRealEffects({ root, home }) {
  const redactor = join(home, ".codex/bin/redact-stream");

  return {
    log: (line) => process.stdout.write(`${line}\n`),
    git: (args) => runGit(root, args),
    realpath,
    readText: (path) => readFile(path, "utf8"),
    writeText: (path, text) =>
      writeFile(path, text, { flag: "wx", mode: 0o600 }),
    exists: (path) =>
      stat(path).then(
        () => true,
        () => false,
      ),
    modifiedAt: (path) =>
      stat(path).then(
        (info) => info.mtimeMs,
        () => null,
      ),
    now: () => Date.now(),
    listDirectory: (path) => readdir(path).catch(() => []),
    makeDirectory: (path) => mkdir(path, { recursive: true, mode: 0o700 }),
    copyFile: (from, to) => copyFile(from, to, constants.COPYFILE_FICLONE),
    prepareRuntime: preparePublicRuntime,
    fileSize: async (path) => (await stat(path)).size,
    sha256: hashFile,
    downloadText: async (url) => {
      const response = await fetch(url, { redirect: "follow" });

      if (response.status === 404) return null;

      if (!response.ok)
        throw new Error(`Download of ${url} failed with ${response.status}`);

      return response.text();
    },
    downloadSha256: async (url, { allowMissing = false } = {}) => {
      const response = await fetch(url, { redirect: "follow" });

      if (allowMissing && response.status === 404) return null;

      if (!response.ok || response.body === null)
        throw new Error(`Download of ${url} failed with ${response.status}`);

      const hash = createHash("sha256");

      for await (const bytes of response.body) hash.update(bytes);

      return hash.digest("hex");
    },
    exec: async (action, { logFile, allowFailure = false } = {}) => {
      const failure = `${action.argv[0]} ${action.argv[1] ?? ""} failed${logFile === undefined ? "" : `; see ${logFile}`}`;

      const sink =
        logFile === undefined ? "ignore" : await open(logFile, "wx", 0o600);

      try {
        if (!action.redact)
          return await runProcess(action.argv, {
            cwd: action.cwd,
            env: action.env,
            timeoutMs: action.timeoutMs,
            stdio: [
              "ignore",
              sink === "ignore" ? sink : sink.fd,
              sink === "ignore" ? sink : sink.fd,
            ],
            allowFailure,
            failure,
          });

        const filter = spawn(redactor, REDACTED_NAMES, {
          stdio: ["pipe", sink.fd, sink.fd],
        });

        const filtered = new Promise((resolvePromise) => {
          filter.once("error", () => resolvePromise(null));
          filter.once("close", resolvePromise);
        });

        let outcome;

        try {
          outcome = await runProcess(action.argv, {
            cwd: action.cwd,
            env: action.env,
            timeoutMs: action.timeoutMs,
            stdio: ["ignore", filter.stdin, filter.stdin],
            allowFailure,
            failure,
          });
        } finally {
          filter.stdin.end();

          if ((await filtered) !== 0)
            throw new Error(
              `Credential-output redactor failed; see ${logFile}`,
            );
        }

        return outcome;
      } finally {
        if (sink !== "ignore") await sink.close();
      }
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const home = homedir();

  try {
    await runRelease({
      root,
      argv: process.argv.slice(2),
      effects: createRealEffects({ root, home }),
      home,
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
