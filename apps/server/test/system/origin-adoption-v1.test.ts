import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { MaintenanceStatus } from "@omnyo/server-contract";
import { createOriginAdoptionV1 } from "../../src/services/maintenance/origin-adoption-v1.js";

async function fixture() {
  const dataDir = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-origin-owner-")),
  );

  const status: MaintenanceStatus = {
    contractVersion: 1,
    privateUpdateManifestSchema: 2,
    runtime: {
      runtimeId: "runtime-owner",
      processId: process.pid,
      parentProcessId: process.ppid,
      launchId: "launch",
      dataDir,
      serverHostId: "host-owner",
      appVersion: "0.46.242+private.1",
      protocolVersion: 253,
    },
    hold: {
      version: 1,
      id: "hold",
      ownerId: "owner",
      kind: "desktop-update",
      phase: "held",
      serverHostId: "host-owner",
      createdAt: Date.now(),
      artifact: null,
    },
    activity: {
      runningThreads: 0,
      pendingInteractions: 0,
      hostRpcs: 0,
      provisioning: 0,
      queuedDispatches: 0,
      pluginLoads: 0,
      pluginInvocations: 0,
      hungServices: 0,
    },
  };

  const owner = createOriginAdoptionV1({
    dataDir,
    status: () => status,
    assetPaths: async () => ["/origin-adoption-v1/assets/origin-abcd1234.js"],
  });

  const ticket = {
    version: 1,
    adoptionId: "hold",
    id: "a".repeat(64),
    selectedIds: ["a".repeat(64)],
    nonce: "b".repeat(64),
    fromOrigin: "https://bb.alexburlis.com",
    toOrigin: "https://app.example.invalid",
  };

  const preparation = {
    ticket,
    holdId: "hold",
    ownerId: "owner",
    expectedRuntimeId: "runtime-owner",
    expectedServerHostId: "host-owner",
  };

  return {
    dataDir,
    status,
    owner,
    ticket,
    preparation,
    cleanup: () => rm(dataDir, { recursive: true }),
  };
}

test("binds independent selected windows and persists only nonce hashes under one exact idle owner", async () => {
  const f = await fixture();

  try {
    f.preparation.ticket.selectedIds = [f.ticket.id, "c".repeat(64)];

    const other = {
      ...f.preparation,
      ticket: { ...f.ticket, id: "c".repeat(64), nonce: "d".repeat(64) },
    };

    await Promise.all([f.owner.prepare(f.preparation), f.owner.prepare(other)]);
    const prepared = await f.owner.prepare(f.preparation);
    expect(prepared).toMatchObject({
      prepared: true,
      phase: "prepared",
      mapping: {
        version: 1,
        adoptionId: "hold",
        fromOrigin: f.ticket.fromOrigin,
        toOrigin: f.ticket.toOrigin,
        serverHostId: "host-owner",
        runtimeId: "runtime-owner",
        selectedIds: f.ticket.selectedIds,
      },
    });
    expect(prepared.mapping.mappingSha256).toMatch(/^[a-f0-9]{64}$/u);

    const [oldOrigin, newOrigin] = await Promise.all([
      f.owner.control(
        { ticket: f.ticket, action: "check", payloadSha256: null },
        f.ticket.fromOrigin,
      ),
      f.owner.control(
        { ticket: f.ticket, action: "check", payloadSha256: null },
        f.ticket.toOrigin,
      ),
    ]);

    expect(oldOrigin.mapping).toEqual(prepared.mapping);
    expect(newOrigin.mapping).toEqual(prepared.mapping);

    const records = (
      await readdir(join(f.dataDir, "origin-adoption-v1"))
    ).filter((name) => name.endsWith(".json"));

    expect(records).toHaveLength(2);

    const bytes = await readFile(
      join(f.dataDir, "origin-adoption-v1", `${f.ticket.id}.json`),
      "utf8",
    );

    expect(bytes).not.toContain(f.ticket.nonce);
    expect(bytes).not.toContain("localStorage");
    await expect(
      f.owner.prepare({
        ...f.preparation,
        ticket: { ...f.ticket, nonce: "e".repeat(64) },
      }),
    ).rejects.toThrow("capability");
    expect(
      await f.owner.control(
        { ticket: other.ticket, action: "check", payloadSha256: null },
        other.ticket.fromOrigin,
      ),
    ).toMatchObject({ phase: "prepared" });
    const first = { ticket: f.ticket, payloadSha256: "1".repeat(64) };
    const second = { ticket: other.ticket, payloadSha256: "2".repeat(64) };
    await f.owner.control({ ...first, action: "verified" }, f.ticket.toOrigin);
    await f.owner.control({ ...first, action: "accept" }, f.ticket.fromOrigin);
    expect(
      await f.owner.control(
        { ...first, action: "admitted" },
        f.ticket.toOrigin,
      ),
    ).toMatchObject({ phase: "admitted", adoptionAccepted: false });
    await f.owner.control(
      { ...second, action: "verified" },
      other.ticket.toOrigin,
    );
    expect(
      await f.owner.control(
        { ...second, action: "accept" },
        other.ticket.fromOrigin,
      ),
    ).toMatchObject({ adoptionAccepted: false });
    expect(
      await f.owner.control(
        { ...second, action: "admitted" },
        other.ticket.toOrigin,
      ),
    ).toMatchObject({ phase: "admitted", adoptionAccepted: true });
    expect(
      await f.owner.control(
        { ticket: f.ticket, action: "check", payloadSha256: null },
        f.ticket.toOrigin,
      ),
    ).toMatchObject({ phase: "admitted", adoptionAccepted: true });
  } finally {
    await f.cleanup();
  }
});

test("refuses wrong origin, nonce, payload, active writer and unverified admission before accepting the exact destination", async () => {
  const f = await fixture();

  try {
    await f.owner.prepare(f.preparation);

    const control = {
      ticket: f.ticket,
      action: "accept",
      payloadSha256: "e".repeat(64),
    };

    await expect(f.owner.control(control, f.ticket.fromOrigin)).rejects.toThrow(
      "not verified",
    );
    await expect(
      f.owner.control({ ...control, action: "check" }, "https://evil.example"),
    ).rejects.toThrow("outside");
    await expect(
      f.owner.control(
        {
          ...control,
          ticket: { ...f.ticket, nonce: "f".repeat(64) },
          action: "check",
        },
        f.ticket.fromOrigin,
      ),
    ).rejects.toThrow("capability");
    f.status.activity.pluginInvocations = 1;
    await expect(
      f.owner.control({ ...control, action: "check" }, f.ticket.toOrigin),
    ).rejects.toThrow("idle maintenance");
    f.status.activity.pluginInvocations = 0;
    expect(
      await f.owner.control(
        { ...control, action: "verified" },
        f.ticket.toOrigin,
      ),
    ).toMatchObject({ phase: "verified" });
    await expect(
      f.owner.control(
        { ...control, payloadSha256: "f".repeat(64) },
        f.ticket.fromOrigin,
      ),
    ).rejects.toThrow("not verified");
    expect(await f.owner.control(control, f.ticket.fromOrigin)).toMatchObject({
      phase: "accepted",
      adoptionAccepted: false,
    });
    expect(await f.owner.control(control, f.ticket.fromOrigin)).toMatchObject({
      phase: "accepted",
    });
    expect(
      await f.owner.control(
        { ...control, action: "verified" },
        f.ticket.toOrigin,
      ),
    ).toMatchObject({ phase: "accepted" });
  } finally {
    await f.cleanup();
  }
});

test("opens only finite bootstrap assets and same-origin control while the exact hold remains idle", async () => {
  const f = await fixture();

  try {
    const destination = f.ticket.toOrigin;
    expect(
      await f.owner.permitsRequest(
        `${destination}/origin-adoption-v1.html`,
        "GET",
        undefined,
      ),
    ).toBe(false);
    await f.owner.prepare(f.preparation);
    expect(
      await f.owner.permitsRequest(
        `${destination}/origin-adoption-v1.html`,
        "GET",
        undefined,
      ),
    ).toBe(true);
    expect(
      await f.owner.permitsRequest(
        `${destination}/origin-adoption-v1/assets/origin-abcd1234.js`,
        "GET",
        undefined,
      ),
    ).toBe(true);
    expect(
      await f.owner.permitsRequest(
        `${destination}/api/v1/threads`,
        "POST",
        destination,
      ),
    ).toBe(false);
    expect(
      await f.owner.permitsRequest(
        `https://app.example.invalid.evil.example/assets/app.js`,
        "GET",
        undefined,
      ),
    ).toBe(false);
    expect(
      await f.owner.permitsRequest(
        `${destination}/assets/unlisted.js`,
        "GET",
        undefined,
      ),
    ).toBe(false);
    const control = `${destination}/api/v1/server/maintenance/origin-adoption-v1/check`;
    expect(
      await f.owner.permitsRequest(control, "POST", f.ticket.fromOrigin),
    ).toBe(false);
    expect(await f.owner.permitsRequest(control, "POST", destination)).toBe(
      true,
    );
    f.status.hold = null;
    expect(await f.owner.permitsRequest(control, "POST", destination)).toBe(
      false,
    );
    expect(
      await f.owner.permitsRequest(
        `${destination}/origin-adoption-v1/assets/origin-abcd1234.js`,
        "GET",
        undefined,
      ),
    ).toBe(false);
  } finally {
    await f.cleanup();
  }
});
