import { expect, test, vi } from "vitest";
import { assertDesktopFinalRuntimeV1 } from "../src/desktop-final-runtime-v1.js";

const binding = {
  version: 1,
  ownerKind: "coordinator",
  sourceDataDir: "/fixture/source",
  destinationDataDir: "/fixture/target",
  jobDir: "/fixture/job",
  runtimeRoot: "/fixture/runtime-242",
  runtimeSha256: "a".repeat(64),
  archiveSha256: "b".repeat(64),
  pluginArtifactsManifestSha256: "c".repeat(64),
};

const descriptor = {
  version: 1,
  appVersion: "0.46.247+private.1",
  protocolVersion: 254,
  serverHostId: "host_0000000002",
  hold: { id: "native-hold", ownerId: "native-owner", kind: "migration" },
  binding,
};

const current = {
  contractVersion: 1,
  privateUpdateManifestSchema: 2,
  runtime: {
    runtimeId: "actual-final-runtime",
    processId: 100,
    parentProcessId: 1,
    launchId: "actual-final-launch",
    dataDir: binding.destinationDataDir,
    serverHostId: descriptor.serverHostId,
    appVersion: descriptor.appVersion,
    protocolVersion: descriptor.protocolVersion,
  },
  hold: {
    version: 1,
    ...descriptor.hold,
    phase: "held",
    serverHostId: descriptor.serverHostId,
    createdAt: 100,
    identityAdoption: binding,
    artifact: {
      runtimeSha256: binding.runtimeSha256,
      archiveSha256: binding.archiveSha256,
    },
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

test("requires an explicit prepared final descriptor and its current held coordinator before the native writer opens", () => {
  const write = vi.fn();
  expect(() => assertDesktopFinalRuntimeV1(undefined, current)).toThrow();
  expect(write).not.toHaveBeenCalled();
  const accepted = assertDesktopFinalRuntimeV1(descriptor, current);
  expect(accepted.runtimeId).toBe("actual-final-runtime");
  write();
  expect(write).toHaveBeenCalledTimes(1);
});

test("refuses old-control, worker-offer, changed artifact, foreign owner and busy status without opening the writer", () => {
  const write = vi.fn();

  const cases = [
    {
      ...current,
      runtime: {
        ...current.runtime,
        appVersion: "0.46.241+private.1",
        protocolVersion: 252,
      },
    },
    {
      normal: { version: descriptor.appVersion, sha256: binding.runtimeSha256 },
    },
    {
      ...current,
      runtime: { ...current.runtime, serverHostId: "host-foreign" },
    },
    {
      ...current,
      runtime: { ...current.runtime, dataDir: "/fixture/other-profile" },
    },
    { ...current, hold: { ...current.hold, ownerId: "foreign-owner" } },
    { ...current, hold: { ...current.hold, phase: "released" } },
    {
      ...current,
      hold: {
        ...current.hold,
        identityAdoption: { ...binding, runtimeRoot: "/fixture/other-runtime" },
      },
    },
    {
      ...current,
      hold: {
        ...current.hold,
        identityAdoption: {
          ...binding,
          pluginArtifactsManifestSha256: "d".repeat(64),
        },
      },
    },
    {
      ...current,
      hold: {
        ...current.hold,
        artifact: { ...current.hold.artifact, archiveSha256: "d".repeat(64) },
      },
    },
    { ...current, activity: { ...current.activity, runningThreads: 1 } },
  ];

  for (const value of cases)
    expect(() => {
      assertDesktopFinalRuntimeV1(descriptor, value);
      write();
    }).toThrow();
  expect(write).not.toHaveBeenCalled();
});
