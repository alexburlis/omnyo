import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { materializeEmbeddedSourceOperations } from "../../../scripts/omnyo-embedded-source-map.mjs";

function transform(source) {
  const root = mkdtempSync(join(tmpdir(), "omnyo-embedded-"));

  try {
    writeFileSync(join(root, "entry.ts"), source);

    const map = materializeEmbeddedSourceOperations({
      root,
      owner: "fixture",
      bindings: { files: ["entry.ts"] },
      packageIdentities: [
        { before: "@get-bb/plugin-sdk", after: "@omnyo/plugin-sdk" },
      ],
    });

    let result = readFileSync(join(root, "entry.ts"), "utf8");

    for (const { selector: s } of map.operations.sort(
      (a, b) => b.selector.start - a.selector.start,
    )) {
      expect(result.slice(s.start, s.start + s.before.length)).toBe(s.before);
      result =
        result.slice(0, s.start) +
        s.after +
        result.slice(s.start + s.before.length);
    }

    return { result, map };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("renames parsed embedded SDK imports and their local references while preserving opaque string payloads", () => {
  const code =
    'import type { BbPluginApi } from "@get-bb/plugin-sdk"; const prose="@get-bb/plugin-sdk"; export default function plugin(api: BbPluginApi) { return api; }';

  const source = `const SERVER_SOURCE = ${JSON.stringify(code)}; const prose="@get-bb/plugin-sdk";`;
  const { result } = transform(source);
  expect(result).toContain(
    'import type { PluginApi } from \\"@omnyo/plugin-sdk\\";',
  );
  expect(result).toContain("api: PluginApi");
  expect(result).toContain('const prose="@get-bb/plugin-sdk";');
});

it("does not rewrite deliberate retired-import negative fixtures", () => {
  const source =
    'it("rejects a retired SDK import",()=>{const serverSource="import \\\"@get-bb/plugin-sdk\\\";";});';

  expect(transform(source).map.operations).toEqual([]);
});

it("refuses a semantic target collision inside owned embedded code", () => {
  const code =
    'import type { BbPluginApi } from "@get-bb/plugin-sdk"; type PluginApi = string; export default function plugin(api: BbPluginApi) { return api; }';

  expect(() =>
    transform(`const SERVER_SOURCE=${JSON.stringify(code)};`),
  ).toThrow(/collision/);
});
