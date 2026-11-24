import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);

const {
  patchPreferencesPodfileV1,
  bridgePreferencesOwnerV1,
} = require("../with-preferences-records-v1.js");

const digest = (value) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnyo-mmkv-patch-"));
  const ios = join(root, "ios");
  const pod = join(ios, "Pods/MMKVCore");
  await mkdir(join(pod, "Core"), { recursive: true });
  await copyFile(
    join(directory, "mmkv-core-patch-v1.rb"),
    join(ios, "mmkv-core-patch-v1.rb"),
  );
  const files = [];

  for (const name of ["MMKV.cpp", "MMKV_IO.cpp", "MMKV.h"]) {
    const before = "upstream fixture " + name + "\n";
    const after = "patched fixture " + name + "\n";
    await writeFile(join(pod, "Core", name), before);
    files.push({
      path: "Core/" + name,
      beforeSha256: digest(before),
      afterSha256: digest(after),
      edits: [{ before, after }],
    });
  }

  await writeFile(
    join(ios, "mmkv-core-patch-v1.json"),
    JSON.stringify({ version: 1, pod: "MMKVCore", podVersion: "2.4.0", files }),
  );

  const invoke = (version = "2.4.0") =>
    spawnSync(
      "/usr/bin/ruby",
      [
        "-e",
        `require ARGV.fetch(0)
require "pathname"
sandbox = Struct.new(:root) { def pod_dir(name); root.join(name); end }.new(Pathname.new(ARGV.fetch(1)).join("Pods"))
target = Struct.new(:pod_name, :root_spec).new("MMKVCore", Struct.new(:version).new(ARGV.fetch(2)))
installer = Struct.new(:pod_targets, :sandbox).new([target], sandbox)
puts JSON.generate(OmnyoMmkvCorePatchV1.apply(installer))`,
        join(ios, "mmkv-core-patch-v1.rb"),
        ios,
        version,
      ],
      { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } },
    );

  return { root, ios, pod, files, invoke };
}

test("CocoaPods migration patch is source-bound, atomic before writes and repeatable", async () => {
  const value = await fixture();

  try {
    const first = value.invoke();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).changed, 3);

    for (const file of value.files)
      assert.equal(
        digest(await readFile(join(value.pod, file.path))),
        file.afterSha256,
      );
    const repeat = value.invoke();
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(JSON.parse(repeat.stdout).changed, 0);
    await writeFile(
      join(value.pod, value.files[0].path),
      value.files[0].edits[0].before,
    );
    const resumed = value.invoke();
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).changed, 1);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("CocoaPods migration patch refuses later input drift before any source write", async () => {
  const value = await fixture();

  try {
    await writeFile(join(value.pod, value.files[2].path), "foreign source\n");
    const result = value.invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source changed/);
    assert.equal(
      await readFile(join(value.pod, value.files[0].path), "utf8"),
      value.files[0].edits[0].before,
    );
    assert.equal(
      await readFile(join(value.pod, value.files[2].path), "utf8"),
      "foreign source\n",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("CocoaPods migration patch refuses another version and a linked Pod source", async () => {
  const value = await fixture();

  try {
    assert.notEqual(value.invoke("2.5.0").status, 0);
    const saved = join(value.root, "foreign-pod");
    await mkdir(saved);
    await rm(value.pod, { recursive: true });
    await symlink(saved, value.pod);
    const result = value.invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /job-owned Pods/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("iOS configuration retains existing Pod and Swift header owners", async () => {
  const original =
    "platform :ios, '26.0'\npost_install do |installer|\n  existing_owner(installer)\nend\n";

  const patched = patchPreferencesPodfileV1(original);
  assert.ok(patched.includes("existing_owner(installer)"));
  assert.ok(
    patched.indexOf("OmnyoMmkvCorePatchV1.apply") <
      patched.indexOf("existing_owner(installer)"),
  );
  assert.equal(patchPreferencesPodfileV1(patched), patched);
  assert.throws(() => patchPreferencesPodfileV1("no hook"));
  assert.throws(() => patchPreferencesPodfileV1(original + original));
  const root = await mkdtemp(join(tmpdir(), "omnyo-mmkv-header-"));

  try {
    await mkdir(join(root, "OmnyoPrivate"));
    const header = join(root, "OmnyoPrivate/OmnyoPrivate-Bridging-Header.h");
    const before = '#import "ExistingOwner.h"\n';
    await writeFile(header, before);

    const project = {
      getBuildProperty: () =>
        '"$(SRCROOT)/OmnyoPrivate/OmnyoPrivate-Bridging-Header.h"',
    };

    await bridgePreferencesOwnerV1(
      { modResults: project, modRequest: { platformProjectRoot: root } },
      "OmnyoPrivate",
    );
    const result = await readFile(header, "utf8");
    assert.ok(result.startsWith(before));
    assert.equal(result.split("OmnyoPreferencesRecordsV1.h").length, 2);
    await bridgePreferencesOwnerV1(
      { modResults: project, modRequest: { platformProjectRoot: root } },
      "OmnyoPrivate",
    );
    assert.equal(await readFile(header, "utf8"), result);
    const foreign = { getBuildProperty: () => '"../Foreign.h"' };
    await assert.rejects(
      bridgePreferencesOwnerV1(
        { modResults: foreign, modRequest: { platformProjectRoot: root } },
        "OmnyoPrivate",
      ),
      /escapes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
