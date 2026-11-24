import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import {
  partitionTestFiles,
  sharedWorkerProjects,
} from "../../../vitest.shared.ts";

it("isolates clock and process mutations in tests and imported helpers", () => {
  const root = mkdtempSync(join(tmpdir(), "omnyo-vitest-isolation-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "test"));

  const fixtures = {
    "plain.test.ts": 'import { it } from "vitest"; it("plain", () => {});',
    "timers.test.ts": "vi.useFakeTimers();",
    "date.test.ts": "vi.setSystemTime(new Date());",
    "helper.test.ts": 'import "./clock-helper.js";',
    "clock-helper.ts": "vi.useFakeTimers({ toFake: ['Date'] });",
    "env-replacement.test.ts": "process.env = {};",
    "env-assign.test.ts": "Object.assign(process.env, { TEST: '1' });",
    "env-bracket.test.ts": "process.env['TEST'] = '1';",
    "process-property.test.ts":
      "Object.defineProperty(process.stdin, 'isTTY', { value: true });",
    "global-bracket.test.ts": "globalThis['fetch'] = fakeFetch;",
    "prototype-bracket.test.ts": "Date.prototype['toISOString'] = fakeDate;",
  };

  for (const [name, source] of Object.entries(fixtures)) {
    writeFileSync(join(root, "test", name), source);
  }

  expect(partitionTestFiles(root, ["test"])).toEqual({
    shared: [{ environment: null, files: ["test/plain.test.ts"] }],
    isolated: [
      "test/date.test.ts",
      "test/env-assign.test.ts",
      "test/env-bracket.test.ts",
      "test/env-replacement.test.ts",
      "test/global-bracket.test.ts",
      "test/helper.test.ts",
      "test/process-property.test.ts",
      "test/prototype-bracket.test.ts",
      "test/timers.test.ts",
    ],
  });
});

it("classifies exact selected files without creating projects for unselected siblings", () => {
  const root = mkdtempSync(join(tmpdir(), "omnyo-vitest-selection-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "test"));

  const fixtures = {
    "plain.test.ts": 'import { it } from "vitest"; it("plain", () => {});',
    "dom.test.tsx": "// @vitest-environment jsdom\n",
    "helper.test.ts": 'import "./clock-helper.js";',
    "clock-helper.ts": "vi.useFakeTimers();",
    "unselected.test.ts": "// @vitest-environment unselected-environment\n",
  };

  for (const [name, source] of Object.entries(fixtures)) {
    writeFileSync(join(root, "test", name), source);
  }

  const selected = [
    "test/plain.test.ts",
    "test/dom.test.tsx",
    "test/helper.test.ts",
  ];

  expect(partitionTestFiles(root, selected)).toEqual({
    shared: [{ environment: null, files: ["test/plain.test.ts"] }],
    isolated: ["test/dom.test.tsx", "test/helper.test.ts"],
  });

  const projects = sharedWorkerProjects({
    pkgDir: root,
    name: "selection-fixture",
    include: selected,
  });

  expect(projects.map((project) => project.test.name)).toEqual([
    "selection-fixture",
    "selection-fixture:isolated",
  ]);
  expect(projects[0].test.isolate).toBe(false);
  expect(projects[1].test.isolate).not.toBe(false);
});
