import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";
import { expect, it, vi } from "vitest";
import {
  declarationId,
  sharedDeclarationEmit,
} from "./shared-declaration-emit.mjs";
import { normalizeBundledDts } from "./normalize-bundled-dts.mjs";

it("emits a linked workspace dependency with matching compiler options", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "omnyo-linked-declarations-")),
  );

  try {
    const sdk = path.join(root, "sdk");
    const contract = path.join(root, "contract");
    await mkdir(path.join(sdk, "node_modules/@omnyo"), { recursive: true });
    await mkdir(contract);

    const config = JSON.stringify({
      compilerOptions: { strict: true, types: [] },
    });

    await writeFile(path.join(sdk, "tsconfig.json"), config);
    await writeFile(path.join(contract, "tsconfig.json"), config);
    await writeFile(
      path.join(contract, "package.json"),
      JSON.stringify({ name: "@omnyo/contract", types: "index.ts" }),
    );
    await symlink(
      contract,
      path.join(sdk, "node_modules/@omnyo/contract"),
      "dir",
    );
    const entry = path.join(sdk, "index.ts");
    const value = path.join(contract, "index.ts");
    await writeFile(entry, 'export { value } from "@omnyo/contract";');
    await writeFile(value, 'export const value = "linked" as const;');

    const shared = sharedDeclarationEmit([entry], (id) =>
      id === "@omnyo/contract" ? value : null,
    );

    shared.resolveId("@omnyo/contract", declarationId(entry));
    expect(shared.load(declarationId(value))).toContain(
      'export declare const value: "linked";',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("shares one compiler graph across entry points", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omnyo-declaration-reuse-"));
  const readFile = vi.spyOn(ts.sys, "readFile");
  const performanceWasEnabled = ts.performance.isEnabled();
  ts.performance.enable();
  const programsBefore = ts.performance.getCount("beforeProgram");

  try {
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, types: [] } }),
    );

    const entries = Array.from({ length: 5 }, (_, i) =>
      path.join(root, `entry-${i}.ts`),
    );

    await Promise.all(
      entries.map((entry, i) =>
        writeFile(entry, `export const value${i} = ${i} as const;`),
      ),
    );
    const shared = sharedDeclarationEmit(entries, () => null);

    for (const [i, entry] of entries.entries()) {
      expect(shared.load(declarationId(entry))).toContain(
        `export declare const value${i}: ${i};`,
      );
    }

    expect(ts.performance.getCount("beforeProgram") - programsBefore).toBe(1);

    for (const entry of entries) {
      const reads = readFile.mock.calls.filter(
        ([file]) => path.resolve(file) === entry,
      );

      expect(reads.length).toBeLessThanOrEqual(2);
    }
  } finally {
    readFile.mockRestore();

    if (!performanceWasEnabled) ts.performance.disable();
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves inferred types, ambient declarations, and distinct workspace compiler options", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omnyo-shared-declarations-"));

  try {
    const sdk = path.join(root, "sdk");
    const contract = path.join(root, "contract");
    await mkdir(path.join(sdk, "node_modules/@omnyo"), { recursive: true });
    await mkdir(contract);
    await symlink(
      contract,
      path.join(sdk, "node_modules/@omnyo/contract"),
      "dir",
    );
    await writeFile(
      path.join(contract, "package.json"),
      JSON.stringify({ name: "@omnyo/contract", types: "index.ts" }),
    );
    const entries = [path.join(sdk, "index.ts"), path.join(sdk, "other.ts")];
    await writeFile(
      entries[0],
      'export { value, nullable, ambientValue } from "@omnyo/contract";\nexport const own = [1, null];',
    );
    await writeFile(
      entries[1],
      'export { value } from "@omnyo/contract";\nexport const other = "second" as const;',
    );
    await writeFile(
      path.join(contract, "index.ts"),
      'export const value = { label: "hello", count: 1 } as const;\nexport const nullable = [1, null];\nexport const ambientValue = ambient;',
    );
    await writeFile(
      path.join(contract, "ambient.d.ts"),
      'declare const ambient: "ambient";',
    );
    await writeFile(
      path.join(sdk, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          moduleResolution: "node",
          target: "es2022",
        },
      }),
    );

    const resolveSource = (id) =>
      id === "@omnyo/contract" ? path.join(contract, "index.ts") : null;

    async function bundle(entry, plugins) {
      const build = await rollup({ input: entry, plugins });

      try {
        const { output } = await build.generate({ format: "es" });

        return normalizeBundledDts(output[0].code);
      } finally {
        await build.close();
      }
    }

    for (const strictNullChecks of [false, true]) {
      await writeFile(
        path.join(contract, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strictNullChecks,
            moduleResolution: "node",
            target: "es2022",
          },
        }),
      );
      const shared = sharedDeclarationEmit(entries, resolveSource);

      for (const entry of entries) {
        const actual = await bundle(declarationId(entry), [shared, dts()]);

        const expected = await bundle(entry, [
          { name: "workspace", resolveId: resolveSource },
          dts({ compilerOptions: { strictNullChecks } }),
        ]);

        expect(actual).toContain('readonly label: "hello"');

        if (entry === entries[0]) {
          expect(actual).toContain('declare const ambientValue: "ambient"');
          expect(actual.match(/declare const nullable: ([^;]+);/)[1]).toBe(
            expected.match(/declare const nullable: ([^;]+);/)[1],
          );
          expect(actual).toContain("declare const own: (number | null)[]");
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
