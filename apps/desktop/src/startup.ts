import { lstatSync, readdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const flag = "--omnyo-electron-trust-probe";

const args = process.argv.slice(1);

if (
  process.env.OMNYO_DESKTOP_RELEASE_CHANNEL === "public-beta" &&
  args.some(
    (argument) =>
      argument.startsWith("--omnyo-profile-continuity") ||
      argument.startsWith("--omnyo-profile-adoption") ||
      argument.startsWith(flag),
  )
) {
  process.stderr.write(
    "Private profile migration modes are unavailable in the public Omnyo app\n",
  );
  process.exit(2);
}

if (
  args.some((argument) => argument.startsWith("--omnyo-profile-continuity"))
) {
  const {
    runDesktopProfileContinuityEntryV2,
  } = require("./desktop-profile-continuity-entry-v2.cjs");

  void runDesktopProfileContinuityEntryV2(args).catch(() => process.exit(2));
} else if (args.some((argument) => argument.startsWith(flag))) {
  const [mode, profile, result] = args;

  if (
    mode !== flag ||
    args.length !== 3 ||
    !profile ||
    !result ||
    !isAbsolute(profile) ||
    !isAbsolute(result)
  ) {
    throw new Error("Invalid internal Electron trust probe arguments");
  }

  const directory = lstatSync(profile);
  const outputDirectory = lstatSync(dirname(result));
  const uid = process.getuid?.();

  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    !outputDirectory.isDirectory() ||
    outputDirectory.isSymbolicLink() ||
    (uid !== undefined &&
      (directory.uid !== uid || outputDirectory.uid !== uid)) ||
    readdirSync(profile).length !== 0 ||
    lstatSync(result, { throwIfNoEntry: false }) !== undefined
  ) {
    throw new Error(
      "Electron trust probe requires an owned empty profile and fresh result",
    );
  }

  require("./private-electron-trust-probe.cjs");
} else {
  require("./desktop-main.cjs");
}
