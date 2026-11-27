import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveFirstPartyBridgeEntry,
  resolveFirstPartyBridgeModulePath,
} from "@omnyo/provider-bridge-protocol/testing";
import { missingBridgeModule } from "./index.js";

describe("old-leg pre-check", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function fakeCheckout(files: readonly string[]): string {
    const root = mkdtempSync(join(tmpdir(), "parity-old-leg-"));
    created.push(root);

    for (const file of files) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "");
    }

    return root;
  }

  it("admits an old checkout that only has the legacy bridge path the launch would resolve", () => {
    const root = fakeCheckout(["plugins/provider-acp/src/bridge/bridge.ts"]);
    expect(
      missingBridgeModule(root, "acp-cursor", { allowLegacyAcp: true }),
    ).toBeNull();
  });

  it("reports the current path when neither it nor a legacy path exists", () => {
    const root = fakeCheckout([]);
    expect(missingBridgeModule(root, "acp-cursor")).toBe(
      "plugins/provider-acp-next/src/host.ts",
    );
  });

  it("requires Next by default even when Classic remains in the checkout", () => {
    const root = fakeCheckout(["plugins/provider-acp/src/host.ts"]);
    expect(missingBridgeModule(root, "acp-cursor")).toBe(
      "plugins/provider-acp-next/src/host.ts",
    );
    expect(resolveFirstPartyBridgeEntry(root, "acp-cursor").pluginId).toBe(
      "omnyo--provider-acp-next",
    );
  });

  it("selects Next for current replay and Classic only for an explicit old leg", () => {
    const root = fakeCheckout([
      "plugins/provider-acp/src/host.ts",
      "plugins/provider-acp-next/src/host.ts",
    ]);

    const current = resolveFirstPartyBridgeEntry(root, "acp-cursor");

    const old = resolveFirstPartyBridgeEntry(root, "acp-cursor", {
      allowLegacyAcp: true,
    });

    expect(current.pluginId).toBe("omnyo--provider-acp-next");
    expect(resolveFirstPartyBridgeModulePath(root, current)).toBe(
      "plugins/provider-acp-next/src/host.ts",
    );
    expect(old.pluginId).toBe("provider-acp");
    expect(resolveFirstPartyBridgeModulePath(root, old)).toBe(
      "plugins/provider-acp/src/host.ts",
    );
  });

  it("uses Next for an old checkout after Classic has been retired", () => {
    const root = fakeCheckout(["plugins/provider-acp-next/src/host.ts"]);
    expect(
      missingBridgeModule(root, "acp-cursor", { allowLegacyAcp: true }),
    ).toBeNull();
    expect(
      resolveFirstPartyBridgeEntry(root, "acp-cursor", { allowLegacyAcp: true })
        .pluginId,
    ).toBe("omnyo--provider-acp-next");
  });

  it("keeps skipping pi on a checkout whose bridge ran inside the daemon bundle", () => {
    const root = fakeCheckout([
      "packages/agent-runtime/src/pi/bridge/bridge.ts",
    ]);

    expect(missingBridgeModule(root, "pi")).toBe(
      "plugins/provider-pi/src/host.ts",
    );
  });
});
