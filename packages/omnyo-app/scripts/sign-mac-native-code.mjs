import { execFile } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RUNTIME_MAC_SIGNING_TEAM_ENV = "OMNYO_RUNTIME_MAC_SIGNING_TEAM";

const MACH_O_EXECUTE = 2;

const thinMagic = new Map([
  [0xfeedface, "big"],
  [0xfeedfacf, "big"],
  [0xcefaedfe, "little"],
  [0xcffaedfe, "little"],
]);

const fatMagic = new Set([0xcafebabe, 0xcafebabf]);

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);

  return buffer.subarray(0, bytesRead);
}

function thinFileType(header) {
  if (header.length < 16) return null;
  const endian = thinMagic.get(header.readUInt32BE(0));

  if (endian === undefined) return null;

  return endian === "big" ? header.readUInt32BE(12) : header.readUInt32LE(12);
}

export function fatFirstSliceOffset(header) {
  if (header.length < 8 || !fatMagic.has(header.readUInt32BE(0))) return null;
  const wide = header.readUInt32BE(0) === 0xcafebabf;
  const count = header.readUInt32BE(4);

  if (count === 0 || count > 32 || header.length < 8 + (wide ? 32 : 20))
    return null;

  return wide ? Number(header.readBigUInt64BE(16)) : header.readUInt32BE(16);
}

export async function machOFileType(path) {
  const handle = await open(path, "r");

  try {
    const header = await readAt(handle, 0, 64);
    const sliceOffset = fatFirstSliceOffset(header);

    return sliceOffset === null
      ? thinFileType(header)
      : thinFileType(await readAt(handle, sliceOffset, 16));
  } finally {
    await handle.close();
  }
}

export async function findMachOFiles(root, relativeRoots) {
  const found = [];

  async function visit(relative) {
    const absolute = join(root, relative);

    const entries = await readdir(absolute, { withFileTypes: true }).catch(
      (error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );

    if (entries === null) return;

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative + "/" + entry.name;

      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const fileType = await machOFileType(join(root, path));

        if (fileType !== null) found.push({ path, fileType });
      }
    }
  }

  for (const relativeRoot of relativeRoots) await visit(relativeRoot);

  return found;
}

export function selectDeveloperIdIdentity(findIdentityOutput, team) {
  const matches = [
    ...findIdentityOutput.matchAll(
      /^\s*\d+\)\s+([0-9A-F]{40})\s+"Developer ID Application: [^"]*\(([A-Z0-9]{10})\)"$/gmu,
    ),
  ].filter((match) => match[2] === team);

  const hashes = [...new Set(matches.map((match) => match[1]))];

  if (hashes.length !== 1)
    throw new Error(
      `Runtime Mac signing requires exactly one Developer ID Application identity for team ${team}; found ${hashes.length}`,
    );

  return hashes[0];
}

export async function signRuntimeMacNativeCode({
  root,
  relativeRoots,
  team,
  entitlements,
}) {
  if (process.platform !== "darwin")
    throw new Error("Runtime Mac signing runs only on macOS");

  if (!/^[A-Z0-9]{10}$/u.test(team))
    throw new Error("Runtime Mac signing team is invalid");

  const { stdout } = await execFileAsync("/usr/bin/security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ]);

  const identity = selectDeveloperIdIdentity(stdout, team);
  const files = await findMachOFiles(root, relativeRoots);

  for (const file of files) {
    const absolute = join(root, file.path);

    await execFileAsync("/usr/bin/codesign", [
      "--force",
      "--timestamp",
      "--options",
      "runtime",
      ...(file.fileType === MACH_O_EXECUTE
        ? ["--entitlements", entitlements]
        : []),
      "--sign",
      identity,
      absolute,
    ]);
    await execFileAsync("/usr/bin/codesign", [
      "--verify",
      "--strict",
      absolute,
    ]);

    const { stderr } = await execFileAsync("/usr/bin/codesign", [
      "-dv",
      absolute,
    ]);

    if (!stderr.includes(`TeamIdentifier=${team}`))
      throw new Error(`Runtime Mac signing left another team on ${file.path}`);
  }

  return files.map((file) => file.path);
}
