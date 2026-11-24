import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createHostWatcher } from "../packages/host-watcher/src/index.js";
import {
  EMPTY_PROVIDER_NATIVE_ROOTS,
  EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS,
} from "../packages/domain/src/index.js";
import { CommandMetadataCatalog } from "../apps/host-daemon/src/command-metadata.js";

const [mode, root, output] = process.argv.slice(2);

if (!root || !output || !["prepare", "measure"].includes(mode ?? ""))
  throw new Error(
    "Usage: node --conditions=source --import tsx scripts/benchmark-command-metadata.ts prepare|measure ROOT RECEIPT",
  );

const expected = Array.from({ length: 525 }, (_, index) => ({
  name: `skill-${String(index).padStart(3, "0")}`,
  description: `Description ${index}`,
  sourceRootPath: path.join(
    root,
    ".omnyo",
    "skills",
    `skill-${String(index).padStart(3, "0")}`,
  ),
}));

if (mode === "prepare") {
  for (let start = 0; start < expected.length; start += 8)
    await Promise.all(
      expected.slice(start, start + 8).map(async (skill) => {
        await fs.mkdir(skill.sourceRootPath, { recursive: true });
        await fs.writeFile(
          path.join(skill.sourceRootPath, "SKILL.md"),
          `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${"body ".repeat(1600)}`,
        );
        await fs.writeFile(
          path.join(skill.sourceRootPath, "reference.txt"),
          "reference ".repeat(3200),
        );
      }),
    );
  console.log(
    JSON.stringify({ root, count: expected.length, expectedBytes: 21_000_000 }),
  );
} else {
  let watcherCount = 0;
  const watcher = createHostWatcher();
  const watch = watcher.watchPathRoot;

  if (!watch) throw new Error("Native watcher unavailable");
  watcher.watchPathRoot = (args) => {
    watcherCount++;

    return watch.call(watcher, args);
  };

  const catalog = new CommandMetadataCatalog(watcher, () => undefined);

  const command = {
    type: "host.list_command_metadata" as const,
    providerId: "test",
    cwd: root,
    nativeRoots: {
      skills: EMPTY_PROVIDER_NATIVE_ROOTS,
      commands: EMPTY_PROVIDER_NATIVE_ROOTS,
      resolved: EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS,
    },
    sharedSkillRoots: EMPTY_PROVIDER_NATIVE_ROOTS,
    projectSkillRead: {
      limit: 1000,
      maxFileBytes: 1024 * 1024,
      excludeNames: [],
    },
  };

  try {
    const beforeHeap = process.memoryUsage().heapUsed;
    const started = performance.now();
    const cold = await catalog.list(command);
    const coldMs = performance.now() - started;
    assert.deepEqual(cold.projectSkills, expected);
    const times: number[] = [];

    for (let index = 0; index < 25; index++) {
      const started = performance.now();
      const result = await catalog.list(command);
      times.push(performance.now() - started);
      assert.deepEqual(result.projectSkills, expected);
    }

    const sources = [
      "apps/host-daemon/src/command-metadata.ts",
      "apps/host-daemon/src/command-discovery.ts",
      "packages/host-watcher/src/catalog-cache.ts",
      "packages/process-utils/src/markdown-header.ts",
    ];

    const sourceHashes = Object.fromEntries(
      await Promise.all(
        sources.map(async (file) => [
          file,
          createHash("sha256")
            .update(await fs.readFile(file))
            .digest("hex"),
        ]),
      ),
    );

    const sorted = [...times].sort((a, b) => a - b);

    const receipt = {
      capturedAt: new Date().toISOString(),
      method:
        "Actual daemon metadata owner; 525 real project skills, 8 KiB bodies and 32 KiB ancillary references; files prepared before measurement; process-cold cache with uncontrolled OS file cache; native watcher readiness and metadata signature reconciliation included; 25 warm requests. This excludes HTTP transport and server-owned merging.",
      coldMs,
      warmP50Ms: sorted[12],
      warmP95Ms: sorted[23],
      metadataBytes: Buffer.byteLength(JSON.stringify(cold)),
      heapDeltaBytes: process.memoryUsage().heapUsed - beforeHeap,
      watcherCount,
      sampleCount: 25,
      samples: times,
      sourceHashes,
    };

    await fs.writeFile(output, JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify(receipt));
  } finally {
    await catalog.dispose();
  }
}
