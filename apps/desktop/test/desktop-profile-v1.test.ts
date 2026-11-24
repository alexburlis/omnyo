import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareDesktopProfilePathV1 } from "../src/desktop-profile-v1.js";

const roots: string[] = [];

afterEach(async () => {
  for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "omnyo-desktop-profile-"),
  );

  roots.push(root);

  return root;
}

test("selects the explicit current profile before Electron can initialize it", async () => {
  const root = await fixture();

  for (const applicationName of [
    "Omnyo Private",
    "Omnyo Private Nightly",
    "omnyo-dev",
  ] as const) {
    expect(
      prepareDesktopProfilePathV1({
        appDataPath: root,
        applicationName,
        explicitUserDataPath: null,
      }),
    ).toBe(join(root, applicationName));
    expect(
      JSON.parse(
        await readFile(
          join(root, applicationName, "product-profile-v1.json"),
          "utf8",
        ),
      ),
    ).toEqual({ version: 1, kind: "fresh", applicationName });
    expect(
      prepareDesktopProfilePathV1({
        appDataPath: root,
        applicationName,
        explicitUserDataPath: null,
      }),
    ).toBe(join(root, applicationName));
  }
});

test("refuses a blank replacement while preserving the complete legacy profile and unknown browser partitions", async () => {
  const root = await fixture();
  const legacy = join(root, "BB Private");
  await mkdir(join(legacy, "Partitions/bb-browser-automation-opaque"), {
    recursive: true,
  });
  await writeFile(
    join(legacy, "Partitions/bb-browser-automation-opaque/user-work"),
    "opaque session bytes",
    { mode: 0o600 },
  );
  expect(() =>
    prepareDesktopProfilePathV1({
      appDataPath: root,
      applicationName: "Omnyo Private",
      explicitUserDataPath: null,
    }),
  ).toThrow("verified native identity adoption");
  await expect(stat(join(root, "Omnyo Private"))).rejects.toThrow();
  expect(
    await readFile(
      join(legacy, "Partitions/bb-browser-automation-opaque/user-work"),
      "utf8",
    ),
  ).toBe("opaque session bytes");
  await mkdir(join(root, "Omnyo Private"));
  await writeFile(join(root, "Omnyo Private/new-work"), "independent work");
  expect(() =>
    prepareDesktopProfilePathV1({
      appDataPath: root,
      applicationName: "Omnyo Private",
      explicitUserDataPath: null,
    }),
  ).toThrow("profiles collide");
  expect(await readFile(join(root, "Omnyo Private/new-work"), "utf8")).toBe(
    "independent work",
  );
});

test("preserves an explicit opaque profile path and refuses an explicit legacy default", async () => {
  const root = await fixture();
  const legacy = join(root, "BB Private");
  const explicit = join(root, "my-bb-user-profile");
  await mkdir(legacy);
  await mkdir(explicit);
  expect(
    prepareDesktopProfilePathV1({
      appDataPath: root,
      applicationName: "Omnyo Private",
      explicitUserDataPath: explicit,
    }),
  ).toBe(explicit);
  await writeFile(join(explicit, "current-work"), "unchanged work");
  expect(
    prepareDesktopProfilePathV1({
      appDataPath: root,
      applicationName: "Omnyo Private",
      explicitUserDataPath: explicit,
    }),
  ).toBe(explicit);
  const unknown = join(root, "unmarked-bb-user-profile");
  await mkdir(unknown);
  await writeFile(join(unknown, "user-work"), "unknown protected work");
  expect(() =>
    prepareDesktopProfilePathV1({
      appDataPath: root,
      applicationName: "Omnyo Private",
      explicitUserDataPath: unknown,
    }),
  ).toThrow("verified native identity adoption");
  expect(await readFile(join(unknown, "user-work"), "utf8")).toBe(
    "unknown protected work",
  );
  expect(() =>
    prepareDesktopProfilePathV1({
      appDataPath: root,
      applicationName: "Omnyo Private",
      explicitUserDataPath: legacy,
    }),
  ).toThrow("verified native identity adoption");
});

test("refuses a redirected profile instead of treating unknown ownership as absence", async () => {
  const root = await fixture();
  await mkdir(join(root, "foreign"));
  await symlink(join(root, "foreign"), join(root, "BB Private"));
  expect(() =>
    prepareDesktopProfilePathV1({
      appDataPath: root,
      applicationName: "Omnyo Private",
      explicitUserDataPath: null,
    }),
  ).toThrow("ownership");
  await expect(stat(join(root, "Omnyo Private"))).rejects.toThrow();
});

test("the public app uses only its marked fresh profile and rejects private profile reuse", async () => {
  const root = await fixture();
  const privatePath = join(root, "Omnyo Private");
  await mkdir(privatePath);
  await writeFile(join(privatePath, "foreign-state"), "preserve");

  const input = {
    appDataPath: root,
    applicationName: "Omnyo" as const,
    explicitUserDataPath: null,
  };

  const beta = prepareDesktopProfilePathV1(input);
  expect(beta).toBe(join(root, "Omnyo"));
  expect(prepareDesktopProfilePathV1(input)).toBe(beta);
  expect(() =>
    prepareDesktopProfilePathV1({
      ...input,
      explicitUserDataPath: privatePath,
    }),
  ).toThrow("dedicated profile");
  expect(await readFile(join(privatePath, "foreign-state"), "utf8")).toBe(
    "preserve",
  );
});
