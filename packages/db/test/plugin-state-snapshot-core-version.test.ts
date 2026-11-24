import { expect, it } from "vitest";
import { createConnection } from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import {
  createPluginStateSnapshot,
  getPluginStateSnapshot,
  setPluginStateSnapshotRollbackPending,
} from "../src/data/plugin-state-snapshots.js";

it("records the neutral core version in the existing rollback column exactly once", () => {
  const db = createConnection(":memory:");

  try {
    migrate(db);

    const snapshot = createPluginStateSnapshot(db, {
      id: "snapshot-stable",
      pluginId: "plugin-stable",
      fromArtifactId: null,
      toArtifactId: "artifact-stable",
      snapshotPath: "/fixture/user work/snapshot",
      databasePath: null,
      statePath: "/fixture/user work/state.json",
      secretsPath: null,
      registrationPath: null,
      status: "ready",
      rollbackCandidateVersion: null,
      rollbackSourceFingerprint: null,
      rollbackCoreVersion: null,
      rollbackSdkVersion: null,
      rollbackDetail: null,
      createdAt: 1,
      retainedUntil: 100,
      updatedAt: 1,
    });

    const rollback = {
      candidateVersion: "candidate-stable",
      sourceFingerprint: "source-stable",
      coreVersion: "0.46.242+private.1",
      sdkVersion: "0.6.45",
      detail: "Retained failure detail",
      updatedAt: 2,
    };

    expect(
      setPluginStateSnapshotRollbackPending(db, snapshot.id, rollback),
    ).toBe(true);

    const stored = getPluginStateSnapshot(db, snapshot.id);
    expect(stored).toEqual({
      ...snapshot,
      status: "rollback-pending",
      rollbackCandidateVersion: rollback.candidateVersion,
      rollbackSourceFingerprint: rollback.sourceFingerprint,
      rollbackCoreVersion: rollback.coreVersion,
      rollbackSdkVersion: rollback.sdkVersion,
      rollbackDetail: rollback.detail,
      updatedAt: 2,
    });
    expect(
      db.$client
        .prepare(
          "SELECT rollback_core_version FROM plugin_state_snapshots WHERE id = ?",
        )
        .get(snapshot.id),
    ).toEqual({ rollback_core_version: rollback.coreVersion });
    expect(
      setPluginStateSnapshotRollbackPending(db, snapshot.id, {
        ...rollback,
        coreVersion: "0.46.243+private.1",
        updatedAt: 3,
      }),
    ).toBe(false);
    expect(getPluginStateSnapshot(db, snapshot.id)).toEqual(stored);
  } finally {
    db.$client.close();
  }
});
