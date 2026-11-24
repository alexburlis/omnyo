import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  findMachOFiles,
  machOFileType,
  selectDeveloperIdIdentity,
} from "../scripts/sign-mac-native-code.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "omnyo-mac-native-"));

  roots.push(root);

  return root;
}

function thinHeader(fileType: number) {
  const header = Buffer.alloc(32);

  header.writeUInt32BE(0xcffaedfe, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(fileType, 12);

  return header;
}

function fatHeader(sliceOffset: number, fileType: number) {
  const file = Buffer.alloc(sliceOffset + 32);

  file.writeUInt32BE(0xcafebabe, 0);
  file.writeUInt32BE(2, 4);
  file.writeUInt32BE(0x0100000c, 8);
  file.writeUInt32BE(sliceOffset, 16);
  thinHeader(fileType).copy(file, sliceOffset);

  return file;
}

it("reads thin and universal Mach-O file types and ignores other files", async () => {
  const root = await fixtureRoot();

  const files: Record<string, Buffer | string> = {
    executable: thinHeader(2),
    "library.dylib": thinHeader(6),
    "universal-helper": fatHeader(16384, 2),
    "module.node": Buffer.from("\x7fELF\x02\x01\x01", "binary"),
    "script.js": "console.log(1);\n",
  };

  for (const [name, bytes] of Object.entries(files))
    await writeFile(join(root, name), bytes);

  expect(await machOFileType(join(root, "executable"))).toBe(2);
  expect(await machOFileType(join(root, "library.dylib"))).toBe(6);
  expect(await machOFileType(join(root, "universal-helper"))).toBe(2);
  expect(await machOFileType(join(root, "module.node"))).toBeNull();
  expect(await machOFileType(join(root, "script.js"))).toBeNull();
});

it("finds Mach-O files only beneath the selected runtime roots", async () => {
  const root = await fixtureRoot();

  await mkdir(join(root, "server/dist/plugin/native"), { recursive: true });
  await mkdir(join(root, "node_modules/npm/bin"), { recursive: true });
  await writeFile(
    join(root, "server/dist/plugin/native/helper"),
    thinHeader(2),
  );
  await writeFile(join(root, "server/dist/plugin/index.js"), "export {};\n");
  await writeFile(join(root, "node_modules/npm/bin/tool"), thinHeader(2));

  expect(await findMachOFiles(root, ["dist", "server/dist"])).toEqual([
    { path: "server/dist/plugin/native/helper", fileType: 2 },
  ]);
});

it("selects exactly one Developer ID Application identity for the team", () => {
  const output = [
    '  1) 1111111111111111111111111111111111111111 "Apple Development: Someone (AAAAAAAAAA)"',
    '  2) 2222222222222222222222222222222222222222 "Developer ID Application: Example GmbH (Z7T4C33A35)"',
    '  3) 3333333333333333333333333333333333333333 "Developer ID Application: Other (BBBBBBBBBB)"',
    "     3 valid identities found",
  ].join("\n");

  expect(selectDeveloperIdIdentity(output, "Z7T4C33A35")).toBe(
    "2222222222222222222222222222222222222222",
  );
  expect(() => selectDeveloperIdIdentity(output, "CCCCCCCCCC")).toThrow(
    "found 0",
  );
});
