import {
  readAdoptedDesktopProfileV1Sync,
  assertDesktopProfileSourceNotFencedV1,
} from "./desktop-profile-adoption-v1.js";

export {
  prepareDesktopProfileAdoptionV1,
  acceptDesktopProfileAdoptionV1,
  rollbackDesktopProfileAdoptionV1,
} from "./desktop-profile-adoption-v1.js";

import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const profileNameSchema = z.enum([
  "Omnyo Private",
  "Omnyo Private Nightly",
  "omnyo-dev",
  "Omnyo",
]);

export type DesktopProfileName = z.infer<typeof profileNameSchema>;

const legacyProfileNamesV1 = {
  "Omnyo Private": "BB Private",
  "Omnyo Private Nightly": "BB Private Nightly",
  "omnyo-dev": "bb-dev",
  Omnyo: "Omnyo",
} satisfies Record<DesktopProfileName, string>;

const currentProfileSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("fresh"),
    applicationName: profileNameSchema,
  })
  .strict();

const profileMarkerName = "product-profile-v1.json";

function optionalInfo(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

function profileExists(path: string): boolean {
  const info = optionalInfo(path);

  if (info === null) return false;

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  )
    throw new Error("Desktop profile ownership is not an exact user directory");

  return true;
}

function prepareFreshProfile(
  path: string,
  applicationName: DesktopProfileName,
): void {
  if (!profileExists(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const markerPath = join(path, profileMarkerName);
  const marker = optionalInfo(markerPath);

  if (marker !== null) {
    if (
      !marker.isFile() ||
      marker.isSymbolicLink() ||
      marker.size > 4096 ||
      (process.getuid !== undefined && marker.uid !== process.getuid())
    )
      throw new Error("Desktop profile identity record is not owned");

    const parsed = currentProfileSchema.parse(
      JSON.parse(readFileSync(markerPath, "utf8")),
    );

    if (parsed.applicationName !== applicationName)
      throw new Error(
        "Desktop profile belongs to another application identity",
      );

    return;
  }

  if (readdirSync(path).length !== 0)
    throw new Error(
      "Existing desktop profile requires verified native identity adoption; its files were preserved",
    );
  const file = openSync(markerPath, "wx", 0o600);

  try {
    writeFileSync(
      file,
      JSON.stringify({ version: 1, kind: "fresh", applicationName }) + "\n",
    );
    fsyncSync(file);
  } finally {
    closeSync(file);
  }

  if (process.platform !== "win32") {
    const directory = openSync(path, "r");

    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}

export function prepareDesktopProfilePathV1(input: {
  appDataPath: string;
  applicationName: DesktopProfileName;
  explicitUserDataPath: string | null;
}): string {
  if (
    !isAbsolute(input.appDataPath) ||
    resolve(input.appDataPath) !== input.appDataPath
  )
    throw new Error("Desktop application data path is not absolute");
  const applicationName = profileNameSchema.parse(input.applicationName);

  if (applicationName === "Omnyo") {
    if (input.explicitUserDataPath !== null)
      throw new Error("The public app uses its own dedicated profile");
    const target = join(input.appDataPath, applicationName);
    prepareFreshProfile(target, applicationName);

    return target;
  }

  const legacy = join(input.appDataPath, legacyProfileNamesV1[applicationName]);

  const target =
    input.explicitUserDataPath === null
      ? join(input.appDataPath, applicationName)
      : resolve(input.explicitUserDataPath);

  assertDesktopProfileSourceNotFencedV1(
    input.appDataPath,
    applicationName,
    target,
  );

  if (
    profileExists(target) &&
    readAdoptedDesktopProfileV1Sync(target, applicationName)
  )
    return target;

  if (target !== legacy && input.explicitUserDataPath !== null) {
    prepareFreshProfile(target, applicationName);

    return target;
  }

  const hasLegacy = profileExists(legacy);
  const hasTarget = target === legacy ? hasLegacy : profileExists(target);

  if (hasLegacy)
    throw new Error(
      hasTarget && target !== legacy
        ? "Desktop profiles collide; preserve both profiles for verified native adoption"
        : "The existing desktop profile requires verified native identity adoption before Omnyo can start",
    );

  prepareFreshProfile(target, applicationName);

  return target;
}
