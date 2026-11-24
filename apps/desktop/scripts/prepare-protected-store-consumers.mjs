import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import { RELEASE_VERSION_PATTERN } from "@omnyo/config/release-version";

const execute = promisify(execFile);

const consumerFiles = [
  "desktop-protected-store-reader-v1",
  "desktop-protected-store-writer-v1",
  "desktop-keychain-ui-fence-v1.node",
];

const environment = () => ({
  HOME: homedir(),
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  TMPDIR: process.env.TMPDIR,
});

const qualifiedNativeInputsV1 = {
  "src/desktop-protected-store-closed-v2.m":
    "ea5d08ce0d5457b864186d5ca7b37ccdeb472b88333d7f22ed28c9147cbd9d46",
  "src/desktop-keychain-ui-fence-v1.c":
    "6e31c97a831ad415c9251761088e7f17fedca9ea957a1e5deb3ab68acaaa39b0",
  "src/desktop-keychain-query-guard-v1.h":
    "3657212aea8a7785c56f8d10d26972f9e7a4ea0cfc166f2a92e5edb5e372895a",
  "src/desktop-keychain-query-guard-v1.m":
    "17dd36cf55fb46fbf265e3e288288c60b32691e5a0653def553d5f083afb5ee3",
};

const qualifiedCompileFunctionSha256V1 =
  "7be918c4d0f4d19a0a062ec0aa127e4dae2c12ce37ea366a554d407d332a3c7b";

const qualifiedSealOwnersSha256V2 =
  "a5c73ecd454efd0157d8c1383c881a55bf8a2cd7f430420306acb1d6aae3fcba";

const qualifiedNativeEvidenceV1 = {
  selectedSourceQualification:
    "c5b90069d4b908e683dbf60407b83c8c5226002bb79a9690110a535bc8d2279b",
  configuredTargetDefaultDeny:
    "0b9c3382e0e04f18c00639b55c0d106a8a515582b2fa0e9dc733d53b007f3413",
  syntheticUnchangedQueryContinuity:
    "1f6246dee0763e6d9cc73cb25782cf3dc672d55d69a459fd46f6e3ad4182cbe6",
  nativeAdmissionModes:
    "88ff0d914bcf860482b199e07faecc6cd166d7b1b04137cd8b1dfdf7850334a0",
};

const digestSchemaV1 = z.string().regex(/^[a-f0-9]{64}$/u);

const buildJobSchemaV1 = z
  .object({
    version: z.literal(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    runtimeVersion: z.string().regex(RELEASE_VERSION_PATTERN),
    platform: z.literal("darwin"),
    arch: z.literal("arm64"),
    appId: z.literal("dev.omnyo.private"),
    applicationName: z.literal("Omnyo Private"),
    desktopProfileAdoptionProtocol: z.literal(2),
  })
  .strict();

const compiledFileSchemaV1 = z
  .object({
    file: z.string(),
    sha256: digestSchemaV1,
    mode: z.number().int().min(0).max(0o777),
  })
  .strict();

const compiledManifestSchemaV1 = z
  .object({
    version: z.literal(1),
    platform: z.literal("darwin"),
    arch: z.literal("arm64"),
    compileFunctionSha256: digestSchemaV1,
    sources: z.array(compiledFileSchemaV1).length(4),
    consumers: z.array(compiledFileSchemaV1).length(3),
  })
  .strict();

async function ownedBuildFileV1(path, privateFile = false) {
  const entry = await lstat(path);

  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    entry.uid !== process.getuid() ||
    (entry.mode & 0o022) !== 0 ||
    (privateFile && (entry.mode & 0o077) !== 0) ||
    (await realpath(path)) !== path
  )
    throw new Error("Protected-store build file ownership differs");
  const bytes = await readFile(path);

  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mode: entry.mode & 0o777,
    bytes,
  };
}

async function compiledInputsV1(packageRoot) {
  return Promise.all(
    Object.keys(qualifiedNativeInputsV1).map(async (file) => {
      const { sha256, mode } = await ownedBuildFileV1(join(packageRoot, file));

      return { file, sha256, mode };
    }),
  );
}

export async function inspectDesktopProtectedStoreBuildV1(packageRoot, value) {
  const parsed = buildJobSchemaV1.safeParse(value);

  if (!parsed.success)
    throw new Error("Protected-store selected build job differs");
  const selected = parsed.data;

  const compileFunctionSha256 = createHash("sha256")
    .update(compileDesktopProtectedStoreConsumersV1.toString())
    .digest("hex");

  const sealFunctionSha256 = createHash("sha256")
    .update(
      JSON.stringify(
        [
          inspectProtectedStoreExecutableV2,
          attestProtectedStoreSourceApplicationV2,
          constructUnsignedProtectedStoreJobV2,
          protectedStoreEnvelopeInventoryV2,
          verifyPreparedEnvelopeSelectionV2,
          prepareDesktopProtectedStoreUnsignedJobV2,
          inspectSignedProtectedStoreCodeEnvelopeV2,
          finalizeDesktopProtectedStoreUnsignedJobV2,
          verifyDesktopProtectedStoreSignedJobV2,
          sealDesktopProtectedStoreJobV2,
          inspectDesktopProtectedStorePreparedJobV2,
        ].map((owner) => owner.toString()),
      ),
    )
    .digest("hex");

  if (
    compileFunctionSha256 !== qualifiedCompileFunctionSha256V1 ||
    sealFunctionSha256 !== qualifiedSealOwnersSha256V2
  )
    throw new Error(
      "Protected-store compiler or sealed-job owner requires fresh qualification",
    );

  if (
    process.platform !== selected.platform ||
    process.arch !== selected.arch ||
    (await realpath(packageRoot)) !== packageRoot
  )
    throw new Error("Protected-store selected build owner differs");

  const metadata = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );

  if (
    metadata.name !== "@omnyo/desktop" ||
    metadata.version !== selected.runtimeVersion ||
    metadata.desktopProfileAdoptionProtocol !==
      selected.desktopProfileAdoptionProtocol
  )
    throw new Error("Protected-store selected build metadata differs");

  const current = await execute("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: packageRoot,
    timeout: 3000,
    env: environment(),
    maxBuffer: 4096,
  });

  if (current.stdout.trim() !== selected.sourceCommit)
    throw new Error("Protected-store selected source commit differs");

  const dirty = await execute(
    "/usr/bin/git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: packageRoot,
      timeout: 3000,
      env: environment(),
      maxBuffer: 4096,
    },
  );

  if (dirty.stdout.trim())
    throw new Error(
      "Protected-store selected source must be committed and clean",
    );
  const sources = await compiledInputsV1(packageRoot);

  if (
    sources.some(
      ({ file, sha256, mode }) =>
        qualifiedNativeInputsV1[file] !== sha256 || mode !== 0o644,
    )
  )
    throw new Error(
      "Protected-store native source requires fresh qualification",
    );

  const path = join(
    packageRoot,
    "dist/desktop-protected-store-compiled-v1.json",
  );

  const raw = await ownedBuildFileV1(path, true);

  if (raw.bytes.length > 16384)
    throw new Error("Protected-store compile receipt exceeds its bound");
  let compiledJson;

  try {
    compiledJson = JSON.parse(raw.bytes.toString("utf8"));
  } catch {
    throw new Error("Protected-store compile receipt is invalid");
  }

  const parsedManifest = compiledManifestSchemaV1.safeParse(compiledJson);

  if (!parsedManifest.success)
    throw new Error("Protected-store compile receipt is invalid");
  const compiled = parsedManifest.data;

  if (
    compiled.compileFunctionSha256 !== compileFunctionSha256 ||
    JSON.stringify(compiled.sources) !== JSON.stringify(sources)
  )
    throw new Error("Protected-store compiled native source differs");

  const consumers = await Promise.all(
    consumerFiles.map(async (file) => {
      const { sha256, mode } = await ownedBuildFileV1(
        join(packageRoot, "dist", file),
      );

      return { file, sha256, mode };
    }),
  );

  if (JSON.stringify(compiled.consumers) !== JSON.stringify(consumers))
    throw new Error("Protected-store unsigned consumer bytes differ");

  return {
    selected,
    compileReceiptSha256: raw.sha256,
    sources,
    consumers,
    evidence: qualifiedNativeEvidenceV1,
  };
}

export async function compileDesktopProtectedStoreConsumersV1(
  packageRoot,
  distDir,
) {
  if (process.platform !== "darwin") return;
  await mkdir(distDir, { recursive: true });
  const sources = await compiledInputsV1(packageRoot);
  await execute(
    "/usr/bin/clang",
    [
      "-fobjc-arc",
      "-Wno-deprecated-declarations",
      "-framework",
      "Foundation",
      "-framework",
      "Security",
      "-framework",
      "LocalAuthentication",
      join(packageRoot, "src/desktop-protected-store-closed-v2.m"),
      "-o",
      join(distDir, consumerFiles[0]),
    ],
    { timeout: 15000, env: environment() },
  );
  await copyFile(
    join(distDir, consumerFiles[0]),
    join(distDir, consumerFiles[1]),
  );
  await execute(
    "/usr/bin/clang",
    [
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      "-Wno-deprecated-declarations",
      "-I",
      resolve(dirname(process.execPath), "../include/node"),
      "-framework",
      "Security",
      join(packageRoot, "src/desktop-keychain-ui-fence-v1.c"),
      "-o",
      join(distDir, consumerFiles[2]),
    ],
    { timeout: 15000, env: environment() },
  );

  if (
    JSON.stringify(sources) !==
    JSON.stringify(await compiledInputsV1(packageRoot))
  )
    throw new Error("Protected-store native source changed during compilation");

  const consumers = await Promise.all(
    consumerFiles.map(async (file) => {
      const { sha256, mode } = await ownedBuildFileV1(join(distDir, file));

      return { file, sha256, mode };
    }),
  );

  await writeFile(
    join(distDir, "desktop-protected-store-compiled-v1.json"),
    JSON.stringify(
      {
        version: 1,
        platform: process.platform,
        arch: process.arch,
        compileFunctionSha256: createHash("sha256")
          .update(compileDesktopProtectedStoreConsumersV1.toString())
          .digest("hex"),
        sources,
        consumers,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}

export async function signDesktopProtectedStoreConsumersV1(
  packageRoot,
  selectedBuild,
) {
  if (selectedBuild === undefined)
    throw new Error(
      "Protected-store consumers require configured Electron namespace and unchanged-query production-fence proof before publication",
    );

  const qualification = await inspectDesktopProtectedStoreBuildV1(
    packageRoot,
    selectedBuild,
  );

  const distDir = join(packageRoot, "dist");
  const identity = "227D854658C245C7521066FF87102B73FDB18A29";

  const identifiers = [
    "dev.bb.private",
    "dev.omnyo.private",
    "dev.omnyo.private.keychain-ui-fence-v1",
  ];

  const consumers = await Promise.all(
    consumerFiles.map(async (file, index) => {
      const path = join(distDir, file);
      await execute(
        "/usr/bin/codesign",
        [
          "--force",
          "--timestamp",
          "--sign",
          identity,
          "--options",
          "runtime",
          "--identifier",
          identifiers[index],
          path,
        ],
        { timeout: 10000, env: environment() },
      );
      await execute("/usr/bin/codesign", ["--verify", "--strict", path], {
        timeout: 3000,
        env: environment(),
      });

      const result = await execute(
        "/usr/bin/codesign",
        ["-d", "-r-", "--verbose=4", path],
        { timeout: 3000, env: environment() },
      );

      const lines = `${result.stdout}\n${result.stderr}`.split("\n");

      const codeDirectoryHash = lines
        .find((line) => line.startsWith("CDHash="))
        ?.slice("CDHash=".length);

      const designatedRequirement = lines
        .find((line) => line.startsWith("designated => "))
        ?.slice("designated => ".length);

      if (
        !lines.includes(`Identifier=${identifiers[index]}`) ||
        !lines.includes("TeamIdentifier=Z7T4C33A35") ||
        !/^[a-f0-9]{40}$/u.test(codeDirectoryHash ?? "") ||
        !designatedRequirement
      )
        throw new Error(
          "Protected-store native consumer signing identity differs",
        );

      return {
        file,
        identifier: identifiers[index],
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
        codeDirectoryHash,
        designatedRequirement,
      };
    }),
  );

  await writeFile(
    join(distDir, "desktop-protected-store-consumers-v1.json"),
    JSON.stringify(
      {
        version: 1,
        desktopProfileAdoptionProtocol: 2,
        consumers,
        qualification,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );

  return consumerFiles.map((file) => `/dist/${file.replaceAll(".", "\\.")}$`);
}

async function inspectProtectedStoreExecutableV2(path, identifier) {
  await execute("/usr/bin/codesign", ["--verify", "--strict", path], {
    timeout: 3000,
    env: environment(),
  });

  const info = await execute(
    "/usr/bin/codesign",
    ["-d", "-r-", "--verbose=4", path],
    { timeout: 3000, env: environment() },
  );

  const lines = `${info.stdout}\n${info.stderr}`.split("\n");

  const codeDirectoryHash = lines
    .find((line) => line.startsWith("CDHash="))
    ?.slice(7);

  const designatedRequirement = lines
    .find((line) => line.startsWith("designated => "))
    ?.slice(14);

  if (
    !lines.includes(`Identifier=${identifier}`) ||
    !lines.includes("TeamIdentifier=Z7T4C33A35") ||
    !/^[a-f0-9]{40}$/u.test(codeDirectoryHash ?? "") ||
    !designatedRequirement
  )
    throw new Error("Protected-store sealed consumer identity differs");

  return {
    path,
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
    codeDirectoryHash,
    designatedRequirement,
  };
}

async function attestProtectedStoreSourceApplicationV2(input) {
  const {
    envelopePath,
    oldStorageName,
    newStorageName,
    profileBindingSha256,
    admissionPath,
    sourceApplication,
  } = input;

  if (
    process.platform !== "darwin" ||
    !/^[a-f0-9]{64}$/u.test(profileBindingSha256) ||
    !resolve(admissionPath).startsWith("/") ||
    resolve(admissionPath) !== admissionPath ||
    resolve(envelopePath) !== envelopePath
  )
    throw new Error(
      "Protected-store job requires an exact attested Mac selection",
    );

  const fixtureMatch =
    /^Omnyo Closed Transfer ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}) Legacy$/u.exec(
      oldStorageName,
    );

  const fixtureRoot = dirname(envelopePath);

  const fixture =
    fixtureMatch !== null &&
    newStorageName === `Omnyo Closed Transfer ${fixtureMatch[1]} Current` &&
    /^test-[a-f0-9-]+--(?:native-protected-store|sealed-profile-v2)$/u.test(
      fixtureRoot.split("/").at(-1) ?? "",
    );

  const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort());

  let selectedSource;

  if (sourceApplication === null && fixture) selectedSource = null;
  else {
    const value = sourceApplication;
    const oldName = fixture ? "BB Private" : oldStorageName;

    const allowedApps = fixture
      ? [join(fixtureRoot, "Source.app")]
      : oldName === "BB Private"
        ? ["/Applications/BB Private VPS.app", "/Applications/BB Private.app"]
        : oldName === "BB Private Nightly"
          ? ["/Applications/BB Private Nightly.app"]
          : [];

    if (
      !exactKeys(value, [
        "appPath",
        "profilePath",
        "executable",
        "originalMode",
        "device",
        "inode",
      ]) ||
      !exactKeys(value.executable, [
        "path",
        "sha256",
        "codeDirectoryHash",
        "designatedRequirement",
      ]) ||
      !allowedApps.includes(value.appPath) ||
      typeof value.profilePath !== "string" ||
      resolve(value.profilePath) !== value.profilePath ||
      value.profilePath !==
        (fixture
          ? join(fixtureRoot, "profiles/BB Private")
          : join(dirname(value.profilePath), oldName)) ||
      value.executable.path !==
        join(value.appPath, "Contents/MacOS", oldName) ||
      !/^[a-f0-9]{64}$/u.test(value.executable.sha256) ||
      !/^[a-f0-9]{40}$/u.test(value.executable.codeDirectoryHash) ||
      typeof value.executable.designatedRequirement !== "string" ||
      !value.executable.designatedRequirement.length ||
      value.executable.designatedRequirement.length > 8192 ||
      !Number.isInteger(value.originalMode) ||
      value.originalMode < 0 ||
      value.originalMode > 0o777 ||
      (value.originalMode & 0o111) === 0 ||
      (value.originalMode & 0o022) !== 0 ||
      typeof value.device !== "string" ||
      !/^(0|[1-9][0-9]{0,19})$/u.test(value.device) ||
      typeof value.inode !== "string" ||
      !/^(0|[1-9][0-9]{0,19})$/u.test(value.inode) ||
      (!fixture && newStorageName !== oldName.replace(/^BB /u, "Omnyo "))
    )
      throw new Error("Protected-store source application attestation differs");

    const [
      app,
      profile,
      executable,
      appReal,
      profileReal,
      executableReal,
      actualCode,
    ] = await Promise.all([
      lstat(value.appPath, { bigint: true }),
      lstat(value.profilePath, { bigint: true }),
      lstat(value.executable.path, { bigint: true }),
      realpath(value.appPath),
      realpath(value.profilePath),
      realpath(value.executable.path),
      inspectProtectedStoreExecutableV2(
        value.executable.path,
        "dev.bb.private",
      ),
    ]);

    if (
      !app.isDirectory() ||
      !profile.isDirectory() ||
      !executable.isFile() ||
      executable.nlink !== 1n ||
      [app, profile, executable].some(
        (info) =>
          info.uid !== BigInt(process.getuid()) || (info.mode & 0o022n) !== 0n,
      ) ||
      appReal !== value.appPath ||
      profileReal !== value.profilePath ||
      executableReal !== value.executable.path ||
      executable.dev.toString() !== value.device ||
      executable.ino.toString() !== value.inode ||
      ![value.originalMode, value.originalMode & ~0o111].includes(
        Number(executable.mode & 0o777n),
      ) ||
      Object.keys(actualCode).some(
        (key) => actualCode[key] !== value.executable[key],
      )
    )
      throw new Error("Protected-store source application metadata changed");
    selectedSource = {
      appPath: value.appPath,
      profilePath: value.profilePath,
      executable: actualCode,
      originalMode: value.originalMode,
      device: value.device,
      inode: value.inode,
    };
  }

  return selectedSource;
}

async function constructUnsignedProtectedStoreJobV2(input) {
  const {
    envelopePath,
    readerPath,
    writerPath,
    oldStorageName,
    newStorageName,
    profileBindingSha256,
    admissionPath,
  } = input;

  const selectedSource = await attestProtectedStoreSourceApplicationV2(input);
  const resources = join(envelopePath, "Contents/Resources");
  await mkdir(envelopePath, { mode: 0o700 });
  await mkdir(join(envelopePath, "Contents/MacOS"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(resources, { mode: 0o700 });
  const reader = join(resources, "old-reader");
  const writer = join(resources, "new-writer");
  await Promise.all([
    execute("/bin/cp", ["-pc", readerPath, reader], {
      timeout: 3000,
      env: environment(),
    }),
    execute("/bin/cp", ["-pc", writerPath, writer], {
      timeout: 3000,
      env: environment(),
    }),
  ]);

  const [readerBinding, writerBinding] = await Promise.all([
    inspectProtectedStoreExecutableV2(reader, "dev.bb.private"),
    inspectProtectedStoreExecutableV2(writer, "dev.omnyo.private"),
  ]);

  const withoutPath = ({ path, ...value }) => value;

  const fields = {
    version: 2,
    keychainBackend: "default-SecItem-macOS",
    oldStorageName,
    newStorageName,
    profileBindingSha256,
    admissionPath,
    sourceApplication: selectedSource,
    reader: withoutPath(readerBinding),
    writer: withoutPath(writerBinding),
  };

  const bindingSha256 = createHash("sha256")
    .update(JSON.stringify(fields))
    .digest("hex");

  const selection =
    JSON.stringify({ ...fields, bindingSha256 }, null, 2) + "\n";

  await writeFile(join(resources, "selection.json"), selection, {
    mode: 0o600,
    flag: "wx",
  });
  await execute(
    "/bin/cp",
    ["-pc", writerPath, join(envelopePath, "Contents/MacOS/job")],
    { timeout: 3000, env: environment() },
  );
  await writeFile(
    join(envelopePath, "Contents/Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.omnyo.private.protected-store-job-v2</string><key>CFBundleExecutable</key><string>job</string><key>CFBundleName</key><string>Omnyo Protected Store Job</string><key>CFBundleVersion</key><string>2</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
    { mode: 0o600, flag: "wx" },
  );

  return {
    version: 2,
    reader: readerBinding,
    writer: writerBinding,
    oldStorageName,
    newStorageName,
    profileBindingSha256,
    admissionPath,
    sourceApplication: selectedSource,
    job: {
      path: envelopePath,
      selectionSha256: createHash("sha256").update(selection).digest("hex"),
    },
  };
}

const protectedStoreEnvelopeFilesV2 = [
  "Contents/Info.plist",
  "Contents/MacOS/job",
  "Contents/Resources/new-writer",
  "Contents/Resources/old-reader",
  "Contents/Resources/selection.json",
];

async function protectedStoreEnvelopeInventoryV2(root, signed) {
  const allowed = new Set([
    ...protectedStoreEnvelopeFilesV2,
    ...(signed ? ["Contents/_CodeSignature/CodeResources"] : []),
  ]);

  const directories = new Set([
    "",
    "Contents",
    "Contents/MacOS",
    "Contents/Resources",
    ...(signed ? ["Contents/_CodeSignature"] : []),
  ]);

  const files = [];

  async function visit(relative) {
    const path = join(root, relative);
    const info = await lstat(path);

    if (
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o022) !== 0 ||
      (await realpath(path)) !== path
    )
      throw new Error("Protected-store code envelope owner differs");

    if (info.isDirectory()) {
      if (!directories.has(relative))
        throw new Error(
          "Protected-store code envelope contains an unknown directory",
        );

      for (const name of (await readdir(path)).sort())
        await visit(relative ? relative + "/" + name : name);
    } else {
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        !allowed.has(relative) ||
        info.size > 2 * 1024 * 1024
      )
        throw new Error(
          "Protected-store code envelope contains an unknown or oversized file",
        );
      files.push({
        file: relative,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
        mode: info.mode & 0o777,
        bytes: info.size,
      });
    }
  }

  await visit("");
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  if (
    files.length !== allowed.size ||
    files.reduce((sum, file) => sum + file.bytes, 0) > 8 * 1024 * 1024
  )
    throw new Error("Protected-store code envelope is incomplete or oversized");

  return files;
}

function verifyPreparedEnvelopeSelectionV2(raw, receipt) {
  if (
    createHash("sha256").update(raw).digest("hex") !== receipt.selectionSha256
  )
    throw new Error("Protected-store code envelope selection changed");
  const selection = JSON.parse(raw.toString("utf8"));
  const { bindingSha256, ...fields } = selection;

  if (
    selection.version !== 2 ||
    selection.keychainBackend !== "default-SecItem-macOS" ||
    bindingSha256 !== receipt.selectionBindingSha256 ||
    createHash("sha256").update(JSON.stringify(fields)).digest("hex") !==
      bindingSha256
  )
    throw new Error("Protected-store code envelope binding changed");

  return selection;
}

export async function prepareDesktopProtectedStoreUnsignedJobV2(input) {
  const binding = await constructUnsignedProtectedStoreJobV2(input);

  const files = await protectedStoreEnvelopeInventoryV2(
    input.envelopePath,
    false,
  );

  const raw = await readFile(
    join(input.envelopePath, "Contents/Resources/selection.json"),
  );

  const selection = JSON.parse(raw.toString("utf8"));

  return {
    version: 2,
    phase: "target-attested-unsigned",
    binding,
    selectionSha256: binding.job.selectionSha256,
    selectionBindingSha256: selection.bindingSha256,
    files,
  };
}

async function inspectSignedProtectedStoreCodeEnvelopeV2(
  envelopePath,
  prepared,
) {
  const files = await protectedStoreEnvelopeInventoryV2(envelopePath, true);
  verifyPreparedEnvelopeSelectionV2(
    await readFile(join(envelopePath, "Contents/Resources/selection.json")),
    prepared,
  );

  for (const prior of prepared.files)
    if (
      prior.file !== "Contents/MacOS/job" &&
      files.find((file) => file.file === prior.file)?.sha256 !== prior.sha256
    )
      throw new Error("Protected-store signature changed an attested resource");
  await execute("/usr/bin/codesign", ["--verify", "--strict", envelopePath], {
    timeout: 3000,
    env: environment(),
  });

  const identity = await execute(
    "/usr/bin/codesign",
    ["-d", "--verbose=4", envelopePath],
    { timeout: 3000, env: environment() },
  );

  const lines = (identity.stdout + "\n" + identity.stderr).split("\n");

  if (
    !lines.includes("Identifier=dev.omnyo.private.protected-store-job-v2") ||
    !lines.includes("TeamIdentifier=Z7T4C33A35")
  )
    throw new Error("Protected-store returned job signing identity differs");

  return {
    version: 2,
    phase: "centrally-signed",
    binding: prepared.binding,
    selectionSha256: prepared.selectionSha256,
    selectionBindingSha256: prepared.selectionBindingSha256,
    files,
  };
}

export async function finalizeDesktopProtectedStoreUnsignedJobV2(input) {
  const { envelopePath, prepared, timestamp = true } = input;

  if (
    prepared.version !== 2 ||
    prepared.phase !== "target-attested-unsigned" ||
    typeof timestamp !== "boolean"
  )
    throw new Error("Protected-store signing input differs");
  let signaturePresent = false;

  try {
    await lstat(join(envelopePath, "Contents/_CodeSignature"));
    signaturePresent = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (signaturePresent)
    return inspectSignedProtectedStoreCodeEnvelopeV2(envelopePath, prepared);
  const actual = await protectedStoreEnvelopeInventoryV2(envelopePath, false);

  if (JSON.stringify(actual) !== JSON.stringify(prepared.files))
    throw new Error("Protected-store unsigned bytes changed before signing");

  const selection = verifyPreparedEnvelopeSelectionV2(
    await readFile(join(envelopePath, "Contents/Resources/selection.json")),
    prepared,
  );

  const native = await Promise.all([
    inspectProtectedStoreExecutableV2(
      join(envelopePath, "Contents/Resources/old-reader"),
      "dev.bb.private",
    ),
    inspectProtectedStoreExecutableV2(
      join(envelopePath, "Contents/Resources/new-writer"),
      "dev.omnyo.private",
    ),
  ]);

  for (const [index, expected] of [
    prepared.binding.reader,
    prepared.binding.writer,
  ].entries()) {
    const actual = native[index];

    if (
      actual.sha256 !== expected.sha256 ||
      actual.codeDirectoryHash !== expected.codeDirectoryHash ||
      actual.designatedRequirement !== expected.designatedRequirement
    )
      throw new Error(
        "Protected-store signer received a different native consumer",
      );
  }

  if (
    selection.reader.sha256 !== prepared.binding.reader.sha256 ||
    selection.writer.sha256 !== prepared.binding.writer.sha256 ||
    actual.find((file) => file.file === "Contents/Resources/old-reader")
      ?.sha256 !== selection.reader.sha256 ||
    actual.find((file) => file.file === "Contents/Resources/new-writer")
      ?.sha256 !== selection.writer.sha256 ||
    actual.find((file) => file.file === "Contents/MacOS/job")?.sha256 !==
      selection.writer.sha256
  )
    throw new Error("Protected-store unsigned native consumer differs");
  await execute(
    "/usr/bin/codesign",
    [
      "--force",
      timestamp ? "--timestamp" : "--timestamp=none",
      "--sign",
      "227D854658C245C7521066FF87102B73FDB18A29",
      "--options",
      "runtime",
      envelopePath,
    ],
    { timeout: 10000, env: environment() },
  );
  await execute("/usr/bin/codesign", ["--verify", "--strict", envelopePath], {
    timeout: 3000,
    env: environment(),
  });

  const files = await protectedStoreEnvelopeInventoryV2(envelopePath, true);

  for (const prior of prepared.files)
    if (
      prior.file !== "Contents/MacOS/job" &&
      files.find((file) => file.file === prior.file)?.sha256 !== prior.sha256
    )
      throw new Error("Protected-store signer changed an unsigned resource");

  return {
    version: 2,
    phase: "centrally-signed",
    binding: prepared.binding,
    selectionSha256: prepared.selectionSha256,
    selectionBindingSha256: prepared.selectionBindingSha256,
    files,
  };
}

export async function verifyDesktopProtectedStoreSignedJobV2(input) {
  const { envelopePath, prepared, signed } = input;

  if (
    signed.version !== 2 ||
    signed.phase !== "centrally-signed" ||
    prepared.phase !== "target-attested-unsigned" ||
    signed.selectionSha256 !== prepared.selectionSha256 ||
    signed.selectionBindingSha256 !== prepared.selectionBindingSha256 ||
    JSON.stringify(signed.binding) !== JSON.stringify(prepared.binding)
  )
    throw new Error(
      "Protected-store returned signature belongs to another job",
    );

  const actual = await inspectSignedProtectedStoreCodeEnvelopeV2(
    envelopePath,
    prepared,
  );

  if (JSON.stringify(actual) !== JSON.stringify(signed))
    throw new Error("Protected-store returned signed bytes changed");

  const source = await attestProtectedStoreSourceApplicationV2({
    ...prepared.binding,
    envelopePath: prepared.binding.job.path,
  });

  if (
    JSON.stringify(source) !==
    JSON.stringify(prepared.binding.sourceApplication)
  )
    throw new Error(
      "Protected-store source changed while its envelope was signed",
    );

  return prepared.binding;
}

export async function sealDesktopProtectedStoreJobV2(input) {
  const prepared = await prepareDesktopProtectedStoreUnsignedJobV2(input);

  const signed = await finalizeDesktopProtectedStoreUnsignedJobV2({
    envelopePath: input.envelopePath,
    prepared,
    timestamp: input.timestamp ?? true,
  });

  return verifyDesktopProtectedStoreSignedJobV2({
    envelopePath: input.envelopePath,
    prepared,
    signed,
  });
}

export async function inspectDesktopProtectedStorePreparedJobV2(input) {
  const { envelopePath, expected, jobPath = envelopePath } = input;

  const source = await attestProtectedStoreSourceApplicationV2({
    ...expected,
    envelopePath,
  });

  const [reader, writer] = await Promise.all([
    inspectProtectedStoreExecutableV2(
      join(envelopePath, "Contents/Resources/old-reader"),
      "dev.bb.private",
    ),
    inspectProtectedStoreExecutableV2(
      join(envelopePath, "Contents/Resources/new-writer"),
      "dev.omnyo.private",
    ),
  ]);

  const withoutPath = ({ path, ...value }) => value;

  const fields = {
    version: 2,
    keychainBackend: "default-SecItem-macOS",
    oldStorageName: expected.oldStorageName,
    newStorageName: expected.newStorageName,
    profileBindingSha256: expected.profileBindingSha256,
    admissionPath: expected.admissionPath,
    sourceApplication: source,
    reader: withoutPath(reader),
    writer: withoutPath(writer),
  };

  if (
    JSON.stringify(withoutPath(reader)) !==
      JSON.stringify(withoutPath(expected.reader)) ||
    JSON.stringify(withoutPath(writer)) !==
      JSON.stringify(withoutPath(expected.writer))
  )
    throw new Error("Protected-store resume native consumers changed");

  const selectionBindingSha256 = createHash("sha256")
    .update(JSON.stringify(fields))
    .digest("hex");

  const bytes = await readFile(
    join(envelopePath, "Contents/Resources/selection.json"),
  );

  if (
    JSON.stringify(JSON.parse(bytes.toString("utf8"))) !==
    JSON.stringify({ ...fields, bindingSha256: selectionBindingSha256 })
  )
    throw new Error(
      "Protected-store resume selection belongs to another input",
    );

  const binding = {
    version: 2,
    reader: { ...reader, path: join(jobPath, "Contents/Resources/old-reader") },
    writer: { ...writer, path: join(jobPath, "Contents/Resources/new-writer") },
    oldStorageName: fields.oldStorageName,
    newStorageName: fields.newStorageName,
    profileBindingSha256: fields.profileBindingSha256,
    admissionPath: fields.admissionPath,
    sourceApplication: source,
    job: {
      path: jobPath,
      selectionSha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };

  let signed = false;

  try {
    await lstat(join(envelopePath, "Contents/_CodeSignature"));
    signed = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const files = await protectedStoreEnvelopeInventoryV2(envelopePath, signed);

  const writerFile = files.find(
    (file) => file.file === "Contents/Resources/new-writer",
  );

  const prepared = {
    version: 2,
    phase: "target-attested-unsigned",
    binding,
    selectionSha256: binding.job.selectionSha256,
    selectionBindingSha256,
    files: files
      .filter((file) => !file.file.startsWith("Contents/_CodeSignature/"))
      .map((file) =>
        file.file === "Contents/MacOS/job"
          ? { ...writerFile, file: file.file }
          : file,
      ),
  };

  if (!signed) {
    if (JSON.stringify(files) !== JSON.stringify(prepared.files))
      throw new Error("Protected-store unsigned resume bytes changed");

    return { phase: "target-attested-unsigned", prepared };
  }

  const receipt = { ...prepared, phase: "centrally-signed", files };
  await verifyDesktopProtectedStoreSignedJobV2({
    envelopePath,
    prepared,
    signed: receipt,
  });

  return { phase: "centrally-signed", prepared, signed: receipt };
}
