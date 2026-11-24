import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatAppRuntimeFilePath } from "@omnyo/config/app-runtime-file";
import {
  createRuntimeIdentity,
  listServerOwnedEntries,
  readLastServerMoveFile,
  readMaintenanceHold,
  readRuntimeIdentity,
  verifyRuntimeIdentity,
  writeLastServerMoveFile,
  writeMaintenanceHold,
  writeServerImportFile,
  writeServerMovedFile,
} from "../src/index.js";
import {
  repairHeldRuntime,
  verifyHeldRuntimeRepair,
  HELD_RUNTIME_REPAIR_FILE_NAME,
} from "../src/held-runtime-repair.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-held-runtime-repair-")),
  );

  roots.push(root);
  const dataDir = join(root, "data");
  const runtimeRoot = join(root, "runtime");
  await mkdir(dataDir);

  for (const path of ["dist", "server/dist", "host-daemon/dist", "app/dist"]) {
    await mkdir(join(runtimeRoot, path), { recursive: true });
    await writeFile(join(runtimeRoot, path, "entry.js"), "export default 1;\n");
  }

  await writeFile(
    join(runtimeRoot, "package.json"),
    JSON.stringify({ name: "omnyo-app", version: "1.0.0+repair" }),
  );

  const identity = await createRuntimeIdentity(runtimeRoot, {
    runtimeVersion: "1.0.0+repair",
    hostDaemonProtocolVersion: 235,
  });

  await writeFile(
    join(runtimeRoot, "dist/runtime-identity.json"),
    JSON.stringify(identity),
  );
  await writeFile(join(dataDir, "host-id"), "host-new\n");
  await writeMaintenanceHold(dataDir, {
    version: 1,
    id: "move-1",
    ownerId: "owner-1",
    kind: "migration",
    phase: "releasing",
    serverHostId: "host-new",
    createdAt: 1,
    artifact: { archiveSha256: "a".repeat(64), runtimeSha256: "b".repeat(64) },
  });
  await writeLastServerMoveFile(dataDir, {
    version: 1,
    moveId: "move-1",
    fromHostId: "host-old",
    fromHostName: "old",
    toHostId: "host-new",
    toHostName: "new",
    completedAt: 2,
    oldCopyDeletedAt: null,
  });

  const holdBytes = await readFile(
    join(dataDir, "server-maintenance-hold.json"),
  );

  const input = {
    dataDir,
    runtimeRoot,
    id: "move-1",
    ownerId: "owner-1",
    serverHostId: "host-new",
    expectedHoldSha256: createHash("sha256").update(holdBytes).digest("hex"),
    expectedRuntimeSha256: identity.runtimeSha256,
  };

  return { dataDir, runtimeRoot, identity, input, holdBytes };
}

async function updatedRuntime(runtimeRoot: string) {
  await writeFile(
    join(runtimeRoot, "package.json"),
    JSON.stringify({ name: "omnyo-app", version: "1.0.0+update" }),
  );
  await writeFile(
    join(runtimeRoot, "server/dist/entry.js"),
    "export default 2;\n",
  );

  const identity = await createRuntimeIdentity(runtimeRoot, {
    runtimeVersion: "1.0.0+update",
    hostDaemonProtocolVersion: 235,
  });

  await writeFile(
    join(runtimeRoot, "dist/runtime-identity.json"),
    JSON.stringify(identity),
  );

  return verifyRuntimeIdentity(
    runtimeRoot,
    await readRuntimeIdentity(runtimeRoot),
  );
}

describe("offline held runtime repair", () => {
  it.each(["releasing", "released"] as const)(
    "accepts a verified runtime update only after repair hold release: %s",
    async (phase) => {
      const f = await fixture();
      await repairHeldRuntime(f.input);
      await writeMaintenanceHold(f.dataDir, {
        ...readMaintenanceHold(f.dataDir)!,
        phase,
      });

      const hold = readMaintenanceHold(f.dataDir)!;

      const holdBytes = await readFile(
        join(f.dataDir, "server-maintenance-hold.json"),
      );

      const receiptBytes = await readFile(
        join(f.dataDir, HELD_RUNTIME_REPAIR_FILE_NAME),
      );

      const identity = await updatedRuntime(f.runtimeRoot);
      expect(identity.runtimeSha256).not.toBe(f.identity.runtimeSha256);

      const boot = verifyHeldRuntimeRepair(
        f.dataDir,
        hold,
        identity,
        f.runtimeRoot,
      );

      if (phase === "releasing")
        await expect(boot).rejects.toThrow(/repair binding/);
      else await expect(boot).resolves.toBeUndefined();

      expect(
        await readFile(join(f.dataDir, "server-maintenance-hold.json")),
      ).toEqual(holdBytes);
      expect(
        await readFile(join(f.dataDir, HELD_RUNTIME_REPAIR_FILE_NAME)),
      ).toEqual(receiptBytes);
    },
  );

  it.each(["held", "releasing", "released"] as const)(
    "accepts a verified runtime update only after artifact hold release: %s",
    async (phase) => {
      const f = await fixture();
      await writeMaintenanceHold(f.dataDir, {
        ...readMaintenanceHold(f.dataDir)!,
        phase,
        artifact: {
          archiveSha256: "a".repeat(64),
          runtimeSha256: f.identity.runtimeSha256,
        },
      });

      const hold = readMaintenanceHold(f.dataDir)!;

      const holdBytes = await readFile(
        join(f.dataDir, "server-maintenance-hold.json"),
      );

      await expect(
        verifyHeldRuntimeRepair(f.dataDir, hold, f.identity, f.runtimeRoot),
      ).resolves.toBeUndefined();

      const identity = await updatedRuntime(f.runtimeRoot);

      const boot = verifyHeldRuntimeRepair(
        f.dataDir,
        hold,
        identity,
        f.runtimeRoot,
      );

      if (phase === "released") await expect(boot).resolves.toBeUndefined();
      else await expect(boot).rejects.toThrow(/runtime identity mismatch/);

      expect(
        await readFile(join(f.dataDir, "server-maintenance-hold.json")),
      ).toEqual(holdBytes);
      await expect(
        readFile(join(f.dataDir, HELD_RUNTIME_REPAIR_FILE_NAME)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    "owner",
    "hold-phase",
    "current-hold",
    "original-phase",
    "data-dir",
    "receipt-digest",
    "last-move",
    "host",
    "import",
    "moved",
    "protocol-schema",
    "receipt-schema",
  ])(
    "rejects released historical authority with corrupt %s",
    async (failure) => {
      const f = await fixture();
      await repairHeldRuntime(f.input);
      await writeMaintenanceHold(f.dataDir, {
        ...readMaintenanceHold(f.dataDir)!,
        phase: "released",
      });

      let hold = readMaintenanceHold(f.dataDir)!;
      const receiptPath = join(f.dataDir, HELD_RUNTIME_REPAIR_FILE_NAME);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));

      await expect(
        verifyHeldRuntimeRepair(f.dataDir, hold, f.identity, f.runtimeRoot),
      ).resolves.toBeUndefined();

      if (failure === "owner" || failure === "hold-phase") {
        await writeMaintenanceHold(f.dataDir, {
          ...hold,
          ...(failure === "owner"
            ? { ownerId: "foreign-owner" }
            : { phase: "held" as const }),
        });
        hold = readMaintenanceHold(f.dataDir)!;
      }

      if (failure === "current-hold") hold = { ...hold, id: "foreign-move" };

      if (failure === "original-phase") {
        receipt.originalHoldText = JSON.stringify({
          ...JSON.parse(receipt.originalHoldText),
          phase: "held",
        });
        receipt.originalHoldSha256 = createHash("sha256")
          .update(receipt.originalHoldText)
          .digest("hex");
      }

      if (failure === "data-dir") receipt.dataDir = join(f.dataDir, "other");

      if (failure === "receipt-digest")
        receipt.originalHoldSha256 = "c".repeat(64);

      if (failure === "last-move")
        await writeLastServerMoveFile(f.dataDir, {
          ...(await readLastServerMoveFile(f.dataDir))!,
          fromHostId: "foreign-host",
        });

      if (failure === "host")
        await writeFile(join(f.dataDir, "host-id"), "foreign-host\n");

      if (failure === "import")
        await writeServerImportFile(f.dataDir, {
          version: 1,
          kind: "move",
          moveId: "move-1",
          activationToken: "fixture-only-activation-token",
          sourceDataDir: "/fixture/source",
          sourceServerHostId: "host-old",
          targetHostId: "host-new",
          serverUrl: null,
          importedEntries: ["app.db"],
          createdAt: 1,
          fixupsAppliedAt: null,
        });

      if (failure === "moved")
        await writeServerMovedFile(f.dataDir, {
          version: 1,
          moveId: "move-1",
          movedAt: 1,
          fromHostId: "host-old",
          toHostId: "host-new",
          toHostName: "new",
          serverUrl: "https://fixture.invalid",
          mode: "direct",
          connectHandle: null,
          oldCopyEntries: ["app.db"],
        });

      if (failure === "protocol-schema") receipt.protocolVersion = 0;

      if (failure === "receipt-schema") receipt.version = 2;

      await writeFile(receiptPath, JSON.stringify(receipt));

      await expect(
        verifyHeldRuntimeRepair(f.dataDir, hold, f.identity, f.runtimeRoot),
      ).rejects.toThrow();
    },
  );

  it("authorizes only the verified repair while preserving historical hold bytes and strict boot ownership", async () => {
    const f = await fixture();
    const hold = readMaintenanceHold(f.dataDir)!;
    await expect(
      verifyHeldRuntimeRepair(f.dataDir, hold, f.identity, f.runtimeRoot),
    ).rejects.toThrow();
    const result = await repairHeldRuntime(f.input);
    expect(result.runtimeSha256).toBe(f.identity.runtimeSha256);
    expect(
      await readFile(join(f.dataDir, "server-maintenance-hold.json")),
    ).toEqual(f.holdBytes);

    const receipt = JSON.parse(
      await readFile(join(f.dataDir, HELD_RUNTIME_REPAIR_FILE_NAME), "utf8"),
    );

    expect(receipt.originalHoldText).toBe(f.holdBytes.toString());
    expect(receipt.originalHoldSha256).toBe(f.input.expectedHoldSha256);
    await expect(
      verifyHeldRuntimeRepair(f.dataDir, hold, f.identity, f.runtimeRoot),
    ).resolves.toBeUndefined();
    await expect(
      verifyHeldRuntimeRepair(
        f.dataDir,
        hold,
        { ...f.identity, runtimeSha256: "c".repeat(64) },
        f.runtimeRoot,
      ),
    ).rejects.toThrow();
    await expect(
      verifyHeldRuntimeRepair(f.dataDir, null, f.identity, f.runtimeRoot),
    ).rejects.toThrow(/repair binding/);
    await expect(
      verifyHeldRuntimeRepair(
        f.dataDir,
        { ...hold, artifact: null },
        f.identity,
        f.runtimeRoot,
      ),
    ).rejects.toThrow(/repair binding/);
    await expect(
      verifyHeldRuntimeRepair(
        f.dataDir,
        {
          ...hold,
          artifact: {
            archiveSha256: "a".repeat(64),
            runtimeSha256: f.identity.runtimeSha256,
          },
        },
        f.identity,
        f.runtimeRoot,
      ),
    ).rejects.toThrow(/repair binding/);
    expect(
      (await listServerOwnedEntries(f.dataDir)).entries
        .flatMap((entry) => entry.files)
        .map((file) => file.path),
    ).not.toContain(HELD_RUNTIME_REPAIR_FILE_NAME);
    await expect(repairHeldRuntime(f.input)).rejects.toThrow();
    await writeMaintenanceHold(f.dataDir, { ...hold, phase: "released" });
    await expect(
      verifyHeldRuntimeRepair(
        f.dataDir,
        readMaintenanceHold(f.dataDir)!,
        f.identity,
        f.runtimeRoot,
      ),
    ).resolves.toBeUndefined();
    await writeMaintenanceHold(f.dataDir, {
      ...hold,
      ownerId: "foreign-owner",
    });
    await expect(
      verifyHeldRuntimeRepair(
        f.dataDir,
        readMaintenanceHold(f.dataDir)!,
        f.identity,
        f.runtimeRoot,
      ),
    ).rejects.toThrow();
  });

  it.each([
    "wrong-owner",
    "wrong-host",
    "wrong-id",
    "wrong-preimage",
    "wrong-runtime",
    "active",
    "malformed-runtime",
    "import",
    "moved",
    "unpromoted",
    "wrong-phase",
    "noop",
    "tampered-runtime",
  ])(
    "refuses %s without changing the hold or creating repair authority",
    async (failure) => {
      const f = await fixture();

      if (failure === "wrong-owner") f.input.ownerId = "other";

      if (failure === "wrong-host") f.input.serverHostId = "other";

      if (failure === "wrong-id") f.input.id = "other";

      if (failure === "wrong-preimage")
        f.input.expectedHoldSha256 = "c".repeat(64);

      if (failure === "wrong-runtime")
        f.input.expectedRuntimeSha256 = "c".repeat(64);

      if (failure === "active")
        await writeFile(
          formatAppRuntimeFilePath(f.dataDir),
          JSON.stringify({ pid: process.pid }),
        );

      if (failure === "malformed-runtime")
        await writeFile(formatAppRuntimeFilePath(f.dataDir), "broken");

      if (failure === "import")
        await writeFile(
          join(f.dataDir, "server-import.json"),
          JSON.stringify({
            version: 1,
            kind: "move",
            moveId: "move-1",
            activationToken: "fixture-only-activation-token",
            sourceDataDir: "/fixture/source",
            sourceServerHostId: "host-old",
            targetHostId: "host-new",
            serverUrl: null,
            importedEntries: ["app.db"],
            createdAt: 1,
            fixupsAppliedAt: null,
          }),
        );

      if (failure === "moved")
        await writeFile(
          join(f.dataDir, "server-moved.json"),
          JSON.stringify({
            version: 1,
            moveId: "move-1",
            movedAt: 1,
            fromHostId: "host-old",
            toHostId: "host-new",
            toHostName: "new",
            serverUrl: "https://fixture.invalid",
            mode: "direct",
            connectHandle: null,
            oldCopyEntries: ["app.db"],
          }),
        );

      if (failure === "unpromoted")
        await rm(join(f.dataDir, "last-server-move.json"));

      if (failure === "wrong-phase")
        await writeMaintenanceHold(f.dataDir, {
          ...readMaintenanceHold(f.dataDir)!,
          phase: "held",
        });

      if (failure === "noop")
        await writeMaintenanceHold(f.dataDir, {
          ...readMaintenanceHold(f.dataDir)!,
          artifact: {
            archiveSha256: "a".repeat(64),
            runtimeSha256: f.identity.runtimeSha256,
          },
        });

      if (failure === "tampered-runtime")
        await writeFile(
          join(f.runtimeRoot, "server/dist/entry.js"),
          "tampered",
        );

      const before = await readFile(
        join(f.dataDir, "server-maintenance-hold.json"),
      );

      if (failure === "wrong-phase" || failure === "noop")
        f.input.expectedHoldSha256 = createHash("sha256")
          .update(before)
          .digest("hex");

      const expectedError =
        failure === "active"
          ? /Stop the server runtime/
          : failure === "malformed-runtime"
            ? /JSON|Unexpected/
            : ["import", "moved"].includes(failure)
              ? /Migration markers prevent/
              : failure === "unpromoted"
                ? /Promoted migration ownership/
                : ["wrong-runtime", "noop"].includes(failure)
                  ? /exact distinct approved runtime/
                  : failure === "tampered-runtime"
                    ? /inventory digest mismatch/
                    : /ownership does not match/;

      await expect(repairHeldRuntime(f.input)).rejects.toThrow(expectedError);
      expect(
        await readFile(join(f.dataDir, "server-maintenance-hold.json")),
      ).toEqual(before);
      await expect(
        readFile(join(f.dataDir, HELD_RUNTIME_REPAIR_FILE_NAME)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
