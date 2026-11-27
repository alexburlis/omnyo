import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  writeFileSync,
  readFileSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  lstatSync,
  realpathSync,
  existsSync,
  readdirSync,
  chmodSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const args = process.argv.slice(2);

function installExistingHelper(sourceArgument, manifestArgument) {
  const source = resolve(sourceArgument);
  const manifestPath = resolve(manifestArgument);
  const manifestInfo = lstatSync(manifestPath);

  if (
    !manifestInfo.isFile() ||
    manifestInfo.isSymbolicLink() ||
    manifestInfo.uid !== process.getuid() ||
    manifestInfo.mode & 0o022 ||
    manifestInfo.size > 16384
  )
    throw new Error("The accepted helper manifest must be an owned ordinary protected file.");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const allowed = [
    ["OmnyoLocalVoice", 0o755],
    ["FluidAudio_FluidAudio.bundle/luxtts_en_us_g2p_aux.json", 0o444],
    ["FluidAudio_FluidAudio.bundle/luxtts_en_us_lexicon.tsv.zz", 0o444],
  ];

  if (
    manifest.schema !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== allowed.length
  )
    throw new Error("An exact accepted Dictation by Paraspeech helper manifest is required.");

  function ownedDirectory(path) {
    const info = lstatSync(path);

    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      realpathSync(path) !== path ||
      info.uid !== process.getuid() ||
      info.mode & 0o022
    )
      throw new Error(
        "Dictation by Paraspeech installation requires owned ordinary protected directories.",
      );
  }

  ownedDirectory(source);
  ownedDirectory(join(source, "FluidAudio_FluidAudio.bundle"));

  const sourcePaths = readdirSync(source).sort();
  const resourcePaths = readdirSync(join(source, "FluidAudio_FluidAudio.bundle")).sort();

  if (
    JSON.stringify(sourcePaths) !==
      JSON.stringify(["FluidAudio_FluidAudio.bundle", "OmnyoLocalVoice"]) ||
    JSON.stringify(resourcePaths) !==
      JSON.stringify(
        allowed
          .slice(1)
          .map(([path]) => basename(path))
          .sort(),
      )
  )
    throw new Error("The accepted Dictation by Paraspeech payload contains unexpected entries.");

  const inputs = allowed.map(([path, mode]) => {
    const entries = manifest.files.filter((entry) => entry.path === path);

    if (entries.length !== 1)
      throw new Error(
        "The accepted Dictation by Paraspeech manifest contains duplicate or missing paths.",
      );

    const expected = entries[0];
    const file = join(source, path);
    const info = lstatSync(file);
    const bytes = readFileSync(file);

    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o7777) !== mode ||
      expected.mode !== mode ||
      expected.bytes !== bytes.length ||
      !/^[a-f0-9]{64}$/u.test(expected.sha256) ||
      createHash("sha256").update(bytes).digest("hex") !== expected.sha256
    )
      throw new Error("The Dictation by Paraspeech payload differs from its accepted manifest.");

    return { path, mode, bytes, sha256: expected.sha256 };
  });

  const signature = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--strict", join(source, "OmnyoLocalVoice")],
    { stdio: "ignore", timeout: 5000 },
  );

  if (signature.status !== 0)
    throw new Error("The accepted Dictation by Paraspeech helper signature is invalid.");

  const helperRoot = resolve("helper");
  const destination = join(helperRoot, "bin");
  const bundle = join(destination, "FluidAudio_FluidAudio.bundle");

  ownedDirectory(helperRoot);

  for (const directory of [destination, bundle]) {
    try {
      lstatSync(directory);
      ownedDirectory(directory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const pending = inputs.filter((entry) => {
    const target = join(destination, entry.path);

    if (!existsSync(target)) {
      try {
        lstatSync(target);
      } catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
      }

      throw new Error("Dictation by Paraspeech installation refuses a symbolic-link target.");
    }

    const info = lstatSync(target);

    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o7777) !== entry.mode ||
      createHash("sha256").update(readFileSync(target)).digest("hex") !== entry.sha256
    )
      throw new Error("Dictation by Paraspeech installation refuses a conflicting target.");

    return false;
  });

  mkdirSync(destination, { recursive: true });
  mkdirSync(bundle, { recursive: true });
  ownedDirectory(destination);
  ownedDirectory(bundle);

  for (const entry of [
    ...pending.filter((entry) => entry.path !== "OmnyoLocalVoice"),
    ...pending.filter((entry) => entry.path === "OmnyoLocalVoice"),
  ]) {
    const target = join(destination, entry.path);
    const temporary = join(dirname(target), `.omnyo-local-voice-install-${randomUUID()}`);
    const descriptor = openSync(temporary, "wx", 0o600);

    let closed = false;

    try {
      writeFileSync(descriptor, entry.bytes);
      fsyncSync(descriptor);
      chmodSync(temporary, entry.mode);
      closeSync(descriptor);
      closed = true;
      ownedDirectory(dirname(target));
      linkSync(temporary, target);
    } finally {
      if (!closed) closeSync(descriptor);
      unlinkSync(temporary);
    }
  }

  console.log(
    JSON.stringify({
      installed: pending.length,
      destination,
      compilerInvoked: false,
      helperExecuted: false,
    }),
  );
}

if (args[0] === "--install-existing") {
  if (args.length !== 3)
    throw new Error("Use --install-existing PAYLOAD_DIRECTORY ACCEPTED_MANIFEST.");

  installExistingHelper(args[1], args[2]);
  process.exit(0);
}

const dependencyOnly = args[0] === "--prepare-dependencies";

const modeArgs = dependencyOnly ? args.slice(1) : args;

const externallyNetworkFenced = modeArgs[0] === "--externally-network-fenced";

const buildArgs = externallyNetworkFenced ? modeArgs.slice(1) : modeArgs;

if (buildArgs.length !== 0 && (buildArgs.length !== 2 || buildArgs[0] !== "--resume-scratch"))
  throw new Error("Use --resume-scratch PATH only for an owned interrupted build.");

const resumed = buildArgs.length === 2;

if (externallyNetworkFenced && (dependencyOnly || !resumed))
  throw new Error(
    "Externally network-fenced mode requires an owned full-helper --resume-scratch recovery.",
  );

const nativePlannerPolicy = {
  version: 1,
  buildSystem: "native",
  compilerSha256: "d54d5ca10dc4fcb4d29cab20630e176747659074f7bebe2f4c1dfc5cf45dd59e",
  status: "deprecated-planner-pinned-toolchain-requalification-required",
};

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

const tool = spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" });

if (tool.status !== 0) throw new Error("Pinned Swift compiler identity unavailable");

const compilerPath = realpathSync(tool.stdout.trim());

const compilerSha256 = digest(readFileSync(compilerPath));

if (compilerSha256 !== nativePlannerPolicy.compilerSha256)
  throw new Error(
    "Dictation by Paraspeech native planner requires the qualified pinned Swift compiler.",
  );

const temporaryRoot = realpathSync(tmpdir());

const scratch = resumed
  ? resolve(buildArgs[1])
  : mkdtempSync(join(temporaryRoot, "omnyo-local-voice-build-"));

if (
  !lstatSync(scratch).isDirectory() ||
  realpathSync(scratch) !== scratch ||
  !scratch.startsWith(temporaryRoot + sep) ||
  !/^omnyo-local-voice-build-[A-Za-z0-9]+$/u.test(basename(scratch))
)
  throw new Error("The compiler stage must be an owned ordinary directory inside TMPDIR.");

const phaseId = randomUUID();

const sourceBinding = [
  "helper/Package.swift",
  "helper/Package.resolved",
  "helper/Sources/LocalVoice/main.swift",
  "scripts/build-helper.mjs",
].map((file) => ({ file, sha256: digest(readFileSync(file)) }));

const report = {
  owner: "local-voice-helper-build",
  scratch,
  resumed,
  phaseId,
  sourceBinding,
  compilerPath,
  compilerSha256,
  buildSystemPolicy: nativePlannerPolicy,
  checkpointRecorded: false,
  checkpointEligible: false,
  sourceBoundRecoveryHold: false,
  stage: dependencyOnly ? "dependency" : "helper",
  completed: false,
  retainedFor: dependencyOnly
    ? "The same-stage OmnyoLocalVoice product consumer; close after its output handoff"
    : null,
  purpose: "SwiftPM compiler output",
  restoreInputs: "helper/Package.swift and Package.resolved",
  expectedBytes: 3_000_000_000,
  retained: "helper/bin/",
  removed: false,
};

const releaseArgs = [
  "--package-path",
  "helper",
  "--build-system",
  nativePlannerPolicy.buildSystem,
  "--scratch-path",
  scratch,
  "-c",
  "release",
  "-j",
  "2",
  "-Xswiftc",
  "-no-whole-module-optimization",
  "-Xswiftc",
  "-disable-batch-mode",
  "-Xswiftc",
  "-incremental",
  ...(externallyNetworkFenced ? ["-Xswiftc", "-Xfrontend", "-Xswiftc", "-disable-sandbox"] : []),
];

if (externallyNetworkFenced) report.externallyNetworkFenced = true;

report.compilerPolicy = "release-O-per-file-no-batching-native-pinned-v1";

report.compilerArguments = releaseArgs;

report.bindingSha256 = digest(
  JSON.stringify({ sourceBinding, compilerPath, compilerSha256, releaseArgs }),
);

const phasePath = join(scratch, `.omnyo-helper-phase-${phaseId}.json`);

const requestPath = join(scratch, `.omnyo-helper-checkpoint-${phaseId}.json`);

const phase = openSync(phasePath, "wx", 0o600);

try {
  writeFileSync(
    phase,
    JSON.stringify({
      schema: 1,
      phaseId,
      bindingSha256: report.bindingSha256,
      sourceBinding,
      compilerPath,
      compilerSha256,
      releaseArgs,
    }) + "\n",
  );
  fsyncSync(phase);
} finally {
  closeSync(phase);
}

report.phasePath = phasePath;

report.checkpointRequestPath = requestPath;

mkdirSync("artifacts", { recursive: true });

writeFileSync("artifacts/build-storage.json", JSON.stringify(report, null, 2) + "\n");

try {
  const result = spawnSync(
    "swift",
    [
      "build",
      ...releaseArgs,
      ...(dependencyOnly ? ["--target", "FluidAudio"] : ["--product", "OmnyoLocalVoice"]),
    ],
    { stdio: "inherit" },
  );

  let requested = null;

  try {
    const info = lstatSync(requestPath);

    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384)
      throw new Error("Invalid checkpoint request");
    requested = JSON.parse(readFileSync(requestPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (result.status !== 0) {
    if (
      dependencyOnly &&
      requested?.schema === 1 &&
      requested.phaseId === phaseId &&
      requested.bindingSha256 === report.bindingSha256 &&
      requested.kind === "owned-frontend-interruption" &&
      Array.isArray(requested.processes) &&
      requested.processes.length > 0 &&
      requested.processes.length <= 2 &&
      requested.processes.every(
        (item) =>
          Number.isSafeInteger(item.pid) && item.pid > 1 && /^[a-f0-9]{64}$/u.test(item.argvSha256),
      ) &&
      sourceBinding.every((item) => digest(readFileSync(item.file)) === item.sha256)
    ) {
      report.checkpointRecorded = true;
      report.retainedFor =
        "Source-bound partial metadata validation by the existing native owner; no compilation success or cache eligibility claimed";
      report.checkpointRequest = requested;
      process.exitCode = 75;
    } else {
      throw new Error("Swift helper build failed");
    }
  } else {
    report.completed = true;
  }

  if (report.completed && !dependencyOnly) {
    const location = spawnSync("swift", ["build", ...releaseArgs, "--show-bin-path"], {
      encoding: "utf8",
    });

    if (location.status !== 0) throw new Error("Swift helper output path unavailable");
    const built = location.stdout.trim();
    mkdirSync("helper/bin", { recursive: true });
    const replacement = join(scratch, "OmnyoLocalVoice");
    cpSync(join(built, "OmnyoLocalVoice"), replacement);
    renameSync(replacement, resolve("helper/bin/OmnyoLocalVoice"));
  }
} finally {
  const retained =
    (dependencyOnly && report.completed) ||
    report.checkpointRecorded ||
    (resumed && !report.completed);

  report.sourceBoundRecoveryHold = resumed && !report.completed && !report.checkpointRecorded;

  if (report.sourceBoundRecoveryHold)
    report.retainedFor =
      "Exact preexisting source-bound recovery input; unrecognized failure is not eligible for resume";

  if (!retained) rmSync(scratch, { recursive: true, force: true });
  report.removed = !retained;
  writeFileSync("artifacts/build-storage.json", JSON.stringify(report, null, 2) + "\n");
}
