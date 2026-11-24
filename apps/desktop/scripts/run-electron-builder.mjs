import { signDesktopProtectedStoreConsumersV1 } from "./prepare-protected-store-consumers.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDesktopReleaseConfig,
  desktopBuildSelection,
  desktopNativeVersion,
  resolveDesktopBuildPlatform,
  resolveDesktopReleaseChannel,
} from "./desktop-release-channel.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

const desktopPackageRoot = resolve(scriptDirectory, "..");

const baseConfigPath = resolve(
  desktopPackageRoot,
  "electron-builder.config.json",
);

const generatedConfigPath = resolve(
  desktopPackageRoot,
  ".electron-builder.generated.json",
);

const electronBuilderCli = resolve(
  desktopPackageRoot,
  "node_modules",
  "electron-builder",
  "cli.js",
);

const codeSigningKeys = ["CSC_LINK", "CSC_KEY_PASSWORD"];

const notarizationKeys = [
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
];

const requiredSigningEnvironmentKeys = [
  ...codeSigningKeys,
  ...notarizationKeys,
];

const printConfigFlag = "--print-config";

function envValueIsSet(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function missingEnvironmentKeys(keys, env) {
  return keys.filter((key) => !envValueIsSet(env[key]));
}

function presentEnvironmentKeys(keys, env) {
  return keys.filter((key) => envValueIsSet(env[key]));
}

function formatEnvironmentKeyList(keys) {
  if (keys.length === 0) {
    return "none";
  }

  return keys.join(", ");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function logWarning(message) {
  if (process.env.GITHUB_ACTIONS === "true") {
    console.warn(`::warning::${message}`);

    return;
  }

  console.warn(message);
}

function logSigningPlan(signingPlan) {
  if (signingPlan.mode === "environment") {
    if (signingPlan.identityName) {
      console.log(
        `macOS code signing enabled with CSC_NAME identity "${signingPlan.identityName}".`,
      );
    } else {
      console.log(
        "macOS code signing enabled; electron-builder will derive the identity from CSC_LINK.",
      );
    }
  } else if (signingPlan.mode === "keychain") {
    console.log(
      "macOS code signing via keychain auto-discovery; artifacts stay unsigned if no identity is installed. Notarization skipped.",
    );
  } else {
    logWarning(
      "macOS signing skipped: CSC_IDENTITY_AUTO_DISCOVERY=false and no signing secrets found. Artifacts will be unsigned.",
    );
  }

  if (signingPlan.notarizationEnabled) {
    console.log("macOS notarization enabled.");
  }
}

function autoDiscoveryExplicitlyDisabled(env) {
  return (
    envValueIsSet(env.CSC_IDENTITY_AUTO_DISCOVERY) &&
    env.CSC_IDENTITY_AUTO_DISCOVERY.trim() === "false"
  );
}

function createSigningPlan(env) {
  const presentSigningKeys = presentEnvironmentKeys(
    requiredSigningEnvironmentKeys,
    env,
  );

  const missingSigningKeys = missingEnvironmentKeys(
    requiredSigningEnvironmentKeys,
    env,
  );

  const hasAnySigningKeys = presentSigningKeys.length > 0;
  const hasAllSigningKeys = missingSigningKeys.length === 0;

  if (hasAnySigningKeys && !hasAllSigningKeys) {
    throw new Error(
      `Incomplete macOS signing/notarization environment. Present: ${formatEnvironmentKeyList(
        presentSigningKeys,
      )}. Missing: ${formatEnvironmentKeyList(
        missingSigningKeys,
      )}. Set all required keys or unset all of them for a keychain-signed local build.`,
    );
  }

  if (hasAllSigningKeys) {
    return {
      mode: "environment",
      identityName: envValueIsSet(env.CSC_NAME)
        ? env.CSC_NAME.trim()
        : undefined,
      notarizationEnabled: true,
    };
  }

  return {
    mode: autoDiscoveryExplicitlyDisabled(env) ? "disabled" : "keychain",
    identityName: undefined,
    notarizationEnabled: false,
  };
}

function resolveElectronBuilderConfig(
  baseConfig,
  env,
  electronBuilderArgs,
  version,
) {
  const releaseChannel = resolveDesktopReleaseChannel(env);

  const nativeVersion = desktopNativeVersion(version);
  const signingPlan = createSigningPlan(env);

  if (releaseChannel === "public-beta" && signingPlan.notarizationEnabled)
    throw new Error(
      "Local beta preparation forbids notarization; remove provider signing environment",
    );

  const selectedPlatforms = [
    ["--mac", "macos"],
    ["--win", "windows"],
    ["--linux", "linux"],
  ].filter(([flag]) => electronBuilderArgs.includes(flag));

  if (selectedPlatforms.length > 1)
    throw new Error("Private packaging requires one exact native platform");

  const buildPlatform =
    selectedPlatforms[0]?.[1] ?? resolveDesktopBuildPlatform(process.platform);

  const releaseConfig = createDesktopReleaseConfig(
    releaseChannel,
    buildPlatform,
  );

  const config = cloneJson(baseConfig);

  const mac = {
    ...config.mac,
    icon: releaseConfig.macIconPath,
    notarize: signingPlan.notarizationEnabled,
    bundleShortVersion: nativeVersion.shortVersion,
    bundleVersion: nativeVersion.bundleVersion,
  };

  if (signingPlan.mode === "disabled") {
    mac.identity = null;
  } else if (signingPlan.identityName) {
    mac.identity = signingPlan.identityName;
  } else {
    delete mac.identity;
  }

  config.mac = mac;
  config.linux = {
    ...config.linux,
    executableName: releaseConfig.linuxExecutableName,
    icon: "assets/" + releaseConfig.iconFileName,
  };
  config.win = {
    ...config.win,
    icon: "assets/" + releaseConfig.iconFileName,
  };

  if (electronBuilderArgs.includes("--win")) {
    config.extraMetadata = {
      ...config.extraMetadata,
      name: releaseConfig.windowsInstallName,
    };

    if (releaseConfig.windowsInstallGuid !== null)
      config.nsis = { ...config.nsis, guid: releaseConfig.windowsInstallGuid };
  }

  if (buildPlatform === "macos") {
    config.extraMetadata = {
      ...config.extraMetadata,
      productName: releaseConfig.applicationName,
    };
  }

  if (releaseChannel === "public-beta") {
    const selection = desktopBuildSelection(releaseChannel);
    config.asarUnpack = config.asarUnpack.filter(
      (entry) =>
        entry !== "dist/omnyo-app-bridge.mjs" &&
        entry !== "dist/desktop-profile-adoption-v1.cjs" &&
        entry !== "dist/desktop-protected-store-*",
    );
    config.asarUnpack.push(selection.outputDirectory + "/omnyo-app-bridge.mjs");
    config.files = config.files.filter(
      (entry) => entry !== "dist/**" && entry !== "node_modules/**",
    );
    config.files.push({ from: "../..", to: ".", filter: ["LICENSE"] });
    config.files.push({
      from: selection.outputDirectory,
      to: "dist",
      filter: [
        "**/*",
        ...selection.excludedArtifacts.map((file) => "!" + file),
      ],
    });
  }

  config.appId = releaseConfig.appId;
  config.artifactName = releaseConfig.artifactName.replace(
    "${version}",
    nativeVersion.shortVersion,
  );
  config.buildNumber = nativeVersion.buildNumber;
  config.buildVersion = nativeVersion.buildVersion;
  config.productName = releaseConfig.applicationName;
  config.publish = [];

  return {
    config,
    profileName: releaseConfig.profileName,
    releaseChannel,
    signingPlan,
  };
}

function createElectronBuilderEnv(signingPlan) {
  const childEnv = {
    ...process.env,
  };

  childEnv.CSC_IDENTITY_AUTO_DISCOVERY =
    signingPlan.mode !== "disabled" && !signingPlan.identityName
      ? "true"
      : "false";

  return childEnv;
}

async function readBaseConfig() {
  const configText = await readFile(baseConfigPath, "utf8");

  return JSON.parse(configText);
}

async function writeGeneratedConfig(config) {
  await writeFile(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function removeGeneratedConfig() {
  await rm(generatedConfigPath, { force: true });
}

async function runElectronBuilder(args, signingPlan) {
  const child = spawn(
    process.execPath,
    [electronBuilderCli, "--config", generatedConfigPath, ...args],
    {
      cwd: desktopPackageRoot,
      env: createElectronBuilderEnv(signingPlan),
      stdio: "inherit",
    },
  );

  const exitCode = await new Promise((resolveExitCode) => {
    child.on("error", () => {
      resolveExitCode(1);
    });
    child.on("close", resolveExitCode);
  });

  if (typeof exitCode === "number") {
    process.exitCode = exitCode;

    return;
  }

  process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.some((arg) => arg === "--publish" || arg.startsWith("--publish="))) {
    throw new Error(
      "Private fork publication is disabled. Build locally and review upstream update PRs.",
    );
  }

  const printConfig = args.includes(printConfigFlag);

  const internalFlags = [
    "--protected-store-build-job",
    "--protected-store-build-job-sha256",
  ];

  if (
    args.some(
      (arg) =>
        arg.startsWith("--protected-store-") && !internalFlags.includes(arg),
    )
  )
    throw new Error("Unsupported protected-store build argument");

  const internalValues = internalFlags.map((flag) => {
    const index = args.indexOf(flag);

    if (index < 0) return null;

    if (
      args.lastIndexOf(flag) !== index ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      throw new Error("Protected-store build job arguments differ");

    return args[index + 1];
  });

  if (
    internalValues.some((value) => value !== null) &&
    internalValues.some((value) => value === null)
  )
    throw new Error("Protected-store build job requires its exact digest");

  const electronBuilderArgs = args.filter(
    (arg, index) =>
      arg !== printConfigFlag &&
      !internalFlags.includes(arg) &&
      !internalFlags.includes(args[index - 1]),
  );

  const baseConfig = await readBaseConfig();

  const metadata = JSON.parse(
    await readFile(resolve(desktopPackageRoot, "package.json"), "utf8"),
  );

  const { config, profileName, signingPlan, releaseChannel } =
    resolveElectronBuilderConfig(
      baseConfig,
      process.env,
      electronBuilderArgs,
      metadata.version,
    );

  if (
    releaseChannel === "public-beta" &&
    internalValues.some((value) => value !== null)
  )
    throw new Error("Public beta refuses private protected-store build jobs");

  if (
    internalValues[0] !== null &&
    (process.platform !== "darwin" ||
      metadata.desktopProfileAdoptionProtocol !== 2 ||
      ((electronBuilderArgs.includes("--linux") ||
        electronBuilderArgs.includes("--win")) &&
        !electronBuilderArgs.includes("--mac")))
  )
    throw new Error(
      "Protected-store build job requires the selected Mac surface",
    );

  if (printConfig) {
    console.log(JSON.stringify(config, null, 2));

    return;
  }

  if (
    (electronBuilderArgs.includes("--linux") ||
      electronBuilderArgs.includes("--win")) &&
    !electronBuilderArgs.includes("--mac")
  ) {
    console.log("macOS signing is not applicable for this build.");
  } else {
    logSigningPlan(signingPlan);
  }

  if (
    desktopBuildSelection(releaseChannel).privateContinuity &&
    process.platform === "darwin" &&
    metadata.desktopProfileAdoptionProtocol === 2 &&
    !(
      (electronBuilderArgs.includes("--linux") ||
        electronBuilderArgs.includes("--win")) &&
      !electronBuilderArgs.includes("--mac")
    )
  ) {
    if (signingPlan.mode === "disabled")
      throw new Error(
        "Replacement native profile consumers require the existing signing owner",
      );

    let selectedBuild;

    if (internalValues[0] !== null) {
      const [path, expectedSha256] = internalValues;

      if (resolve(path) !== path || !/^[a-f0-9]{64}$/u.test(expectedSha256))
        throw new Error("Protected-store build job path or digest differs");
      const info = await lstat(path);

      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid() ||
        (info.mode & 0o077) !== 0 ||
        info.size > 16384 ||
        (await realpath(path)) !== path
      )
        throw new Error(
          "Protected-store build job is not an exact private file",
        );
      const bytes = await readFile(path);

      if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256)
        throw new Error("Protected-store build job bytes differ");

      try {
        selectedBuild = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new Error("Protected-store build job JSON is invalid");
      }

      if (
        selectedBuild?.appId !== config.appId ||
        selectedBuild?.applicationName !== profileName
      )
        throw new Error("Protected-store selected build identity differs");
    }

    const consumerPatterns = await signDesktopProtectedStoreConsumersV1(
      desktopPackageRoot,
      selectedBuild,
    );

    config.mac.signIgnore = [
      ...(config.mac.signIgnore ?? []),
      ...consumerPatterns,
    ];
  }

  await mkdir(dirname(generatedConfigPath), { recursive: true });
  await writeGeneratedConfig(config);

  try {
    await runElectronBuilder(electronBuilderArgs, signingPlan);
  } finally {
    await removeGeneratedConfig();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }

    process.exitCode = 1;
  });
}
