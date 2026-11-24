import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { materializeWireHeaderOperations } from "../../../scripts/omnyo-wire-map.mjs";

it("maps only exact owned current header and route contexts while retaining finite legacy and opaque custom headers", () => {
  const root = mkdtempSync(join(tmpdir(), "omnyo-wire-map-"));

  try {
    const source =
      'export const name="X-BB-Artifact-SHA256"; const route="/install/bb-app.tgz"; const custom="x-bb-test"; send({headers:{"x-bb-plugin-token":"synthetic-principal"}}); function readHubHeaderV1(){return "x-bb-account-pool-token";}';

    writeFileSync(join(root, "entry.ts"), source);

    const manifest = materializeWireHeaderOperations({
      root,
      owner: "fixture",
      bindings: { files: ["entry.ts"] },
    });

    expect(
      manifest.operations.map((op) => [op.selector.before, op.selector.after]),
    ).toEqual([
      ["X-BB-Artifact-SHA256", "x-omnyo-artifact-sha256"],
      ["/install/bb-app.tgz", "/install/omnyo-app.tgz"],
      ["x-bb-plugin-token", "x-omnyo-plugin-token"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
