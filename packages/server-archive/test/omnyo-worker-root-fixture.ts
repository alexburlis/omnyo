import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createOmnyoWorkerRuntimeFixture } from "./omnyo-worker-runtime-fixture.js";

export { createOmnyoWorkerRuntimeFixture } from "./omnyo-worker-runtime-fixture.js";

import {
  promoteDesktopUpdateHoldForIdentityV1,
  writeMaintenanceHold,
} from "../src/maintenance-hold.js";
import { inspectOmnyoStateRoot } from "../src/omnyo-state-root.js";
import { createOmnyoRootFixture } from "./omnyo-root-fixture.js";

export async function createOmnyoWorkerRootFixture() {
  const profile = await createOmnyoRootFixture();
  await rm(join(profile.input.sourceDataDir, "bb.db"));
  const runtimeRoot = join(profile.root, "runtime");

  const identity = await createOmnyoWorkerRuntimeFixture(runtimeRoot);
  await writeMaintenanceHold(profile.input.sourceDataDir, {
    version: 1,
    id: profile.input.migrationId,
    ownerId: profile.input.ownerId,
    kind: "desktop-update",
    phase: "held",
    serverHostId: profile.input.serverHostId,
    createdAt: 17,
    artifact: null,
  });

  const expectedHoldSha256 = createHash("sha256")
    .update(
      await readFile(
        join(profile.input.sourceDataDir, "server-maintenance-hold.json"),
      ),
    )
    .digest("hex");

  await promoteDesktopUpdateHoldForIdentityV1({
    id: profile.input.migrationId,
    ownerId: profile.input.ownerId,
    serverHostId: profile.input.serverHostId,
    expectedHoldSha256,
    binding: {
      version: 1,
      ownerKind: "worker",
      sourceDataDir: profile.input.sourceDataDir,
      destinationDataDir: profile.input.destinationDataDir,
      jobDir: profile.input.jobDir,
      runtimeRoot,
      runtimeSha256: identity.runtimeSha256,
      archiveSha256: "a".repeat(64),
    },
  });

  return {
    ...profile,
    input: {
      ...profile.input,
      artifactDigest: identity.runtimeSha256,
      expectedSourceDigest: (
        await inspectOmnyoStateRoot(profile.input.sourceDataDir)
      ).digest,
    },
  };
}
