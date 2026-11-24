const { mkdir, copyFile, readFile, writeFile } = require("node:fs/promises");

const { join, resolve, relative, isAbsolute } = require("node:path");

const {
  withDangerousMod,
  withXcodeProject,
  withPodfile,
  IOSConfig,
} = require("expo/config-plugins");

const files = [
  "OmnyoPreferencesRecordsV1.h",
  "OmnyoPreferencesRecordsV1.mm",
  "OmnyoPreferencesModuleV1.mm",
];

function patchPreferencesPodfileV1(contents) {
  const invocation = "  OmnyoMmkvCorePatchV1.apply(installer)";
  const required = 'require_relative "./mmkv-core-patch-v1"';

  if (contents.includes(invocation)) {
    if (!contents.includes(required))
      throw new Error("The existing MMKV patch hook has no owning script.");

    return contents;
  }

  const entry = "post_install do |installer|";

  if (contents.split(entry).length !== 2)
    throw new Error(
      "The existing CocoaPods post-install owner is missing or ambiguous.",
    );

  return required + "\n" + contents.replace(entry, entry + "\n" + invocation);
}

async function bridgePreferencesOwnerV1(mod, projectName) {
  const project = mod.modResults;

  const release = project.getBuildProperty(
    "SWIFT_OBJC_BRIDGING_HEADER",
    "Release",
    projectName,
  );

  const debug = project.getBuildProperty(
    "SWIFT_OBJC_BRIDGING_HEADER",
    "Debug",
    projectName,
  );

  if (typeof release !== "string" || release !== debug)
    throw new Error(
      "The existing app Swift bridging-header owner is missing or differs across builds.",
    );

  const reference = release
    .replace(/^"|"$/gu, "")
    .replace(/\$\((?:SRCROOT|PROJECT_DIR)\)\//gu, "")
    .replace(/\$\(PROJECT_NAME\)/gu, projectName);

  const root = mod.modRequest.platformProjectRoot;
  const header = resolve(root, reference);
  const owned = relative(root, header);

  if (!owned || owned.startsWith("..") || isAbsolute(owned))
    throw new Error(
      "The app bridging header escapes its owning native project.",
    );
  const original = await readFile(header, "utf8");
  const include = '#import "OmnyoPreferencesRecordsV1.h"';

  if (!original.includes(include))
    await writeFile(header, original + "\n" + include + "\n");
}

module.exports = function withPreferencesRecordsV1(config) {
  config = withDangerousMod(config, [
    "ios",
    async (mod) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(
        mod.modRequest.projectRoot,
      );

      const target = join(mod.modRequest.platformProjectRoot, projectName);
      await mkdir(target, { recursive: true });

      for (const name of files)
        await copyFile(
          join(__dirname, "ios-identity-handoff", name),
          join(target, name),
        );

      for (const name of ["mmkv-core-patch-v1.rb", "mmkv-core-patch-v1.json"])
        await copyFile(
          join(__dirname, "ios-identity-handoff", name),
          join(mod.modRequest.platformProjectRoot, name),
        );

      return mod;
    },
  ]);

  config = withPodfile(config, (mod) => {
    mod.modResults.contents = patchPreferencesPodfileV1(
      mod.modResults.contents,
    );

    return mod;
  });

  return withXcodeProject(config, async (mod) => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(
      mod.modRequest.projectRoot,
    );

    for (const name of files.filter((file) => file.endsWith(".mm"))) {
      const filepath = join(projectName, name);

      if (!mod.modResults.hasFile(filepath))
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath,
          groupName: projectName,
          project: mod.modResults,
        });
    }

    await bridgePreferencesOwnerV1(mod, projectName);

    return mod;
  });
};

module.exports.patchPreferencesPodfileV1 = patchPreferencesPodfileV1;

module.exports.bridgePreferencesOwnerV1 = bridgePreferencesOwnerV1;
