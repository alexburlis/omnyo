import { webcrypto } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { bindOriginDatabaseInventoryV1 } from "./origin-database-inventory-v1";

afterEach(() => vi.unstubAllGlobals());

test("binds both exact derived-cache generations and the selected staging owner without depending on enumeration order", async () => {
  vi.stubGlobal("crypto", webcrypto);

  const metadata = [
    { name: "bb-thread-open-snapshots", version: 1 },
    { name: "omnyo-thread-open-snapshots", version: 1 },
    { name: "omnyo-origin-adoption-v1", version: 1 },
    { name: "omnyo-boot-snapshot", version: 1 },
    { name: "omnyo-send-outbox", version: 1 },
  ];

  const original = structuredClone(metadata);
  const first = await bindOriginDatabaseInventoryV1(metadata);
  expect(await bindOriginDatabaseInventoryV1([...metadata].reverse())).toEqual(
    first,
  );
  expect(metadata).toEqual(original);
  expect(first.databases.map((entry) => entry.owner).sort()).toEqual([
    "boot-snapshot-v1",
    "legacy-thread-cache-v1",
    "send-outbox-v1",
    "thread-cache-v1",
    "window-staging-v1",
  ]);
  expect(JSON.stringify(first)).not.toContain("bb-thread-open");
});

test("refuses unknown saved data, changed versions and ambiguous inventories before any migration admission", async () => {
  vi.stubGlobal("crypto", webcrypto);
  await expect(
    bindOriginDatabaseInventoryV1([
      { name: "opaque-user-plugin-work", version: 1 },
    ]),
  ).rejects.toThrow("requires its owner");
  await expect(
    bindOriginDatabaseInventoryV1([
      { name: "bb-thread-open-snapshots", version: 2 },
    ]),
  ).rejects.toThrow("requires its owner");
  await expect(
    bindOriginDatabaseInventoryV1([
      { name: "omnyo-boot-snapshot", version: 2 },
    ]),
  ).rejects.toThrow("requires its owner");
  await expect(
    bindOriginDatabaseInventoryV1([{ name: "omnyo-send-outbox", version: 2 }]),
  ).rejects.toThrow("requires its owner");
  await expect(
    bindOriginDatabaseInventoryV1([
      { name: "bb-thread-open-snapshots", version: 1 },
      { name: "bb-thread-open-snapshots", version: 1 },
    ]),
  ).rejects.toThrow("ambiguous");
  await expect(bindOriginDatabaseInventoryV1([{ version: 1 }])).rejects.toThrow(
    "metadata changed",
  );
});
