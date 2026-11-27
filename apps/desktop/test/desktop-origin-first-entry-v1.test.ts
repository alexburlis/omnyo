import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { originNativeFirstEntryRequestSchemaV1 } from "@omnyo/desktop-contract/internal/origin-adoption-v1";
import { createDesktopOriginFirstEntryOwnerV1 } from "../src/desktop-origin-first-entry-v1.js";

const roots: string[] = [];

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function selection() {
  const jobDir = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-first-entry-")),
  );

  roots.push(jobDir);
  const selectedIds = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];

  const mapping = {
    version: 1 as const,
    adoptionId: "selected-multi-device-adoption",
    fromOrigin: "https://bb.alexburlis.com",
    toOrigin: "https://app.omnyohq.com",
    serverHostId: "fixture-host",
    runtimeId: "held-control-runtime",
    selectedIds,
    mappingSha256: "d".repeat(64),
  };

  const localWindows = selectedIds.slice(0, 2).map((id, index) => ({
    ticket: {
      version: 1 as const,
      adoptionId: mapping.adoptionId,
      id,
      selectedIds,
      nonce: String(index + 1).repeat(64),
      fromOrigin: mapping.fromOrigin,
      toOrigin: mapping.toOrigin,
    },
    windowKey: `window-${index}`,
    targetStageSha256: String(index + 3).repeat(64),
    originPayloadSha256: String(index + 5).repeat(64),
    composerTabId: `preserved-tab-${index}`,
  }));

  const bindings = localWindows.map((window) => ({
    transferId: window.ticket.id,
    windowKey: window.windowKey,
    targetStageSha256: window.targetStageSha256,
    nonceSha256: sha(window.ticket.nonce),
    originPayloadSha256: window.originPayloadSha256,
    composerTabId: window.composerTabId,
  }));

  const value = {
    version: 1 as const,
    nativeJobId: "private-profile-job",
    mapping,
    localWindows,
  };

  return {
    jobDir,
    value,
    request(
      index: number,
      kind:
        | "inspect"
        | "preflight"
        | "ready"
        | "prepared"
        | "retired"
        | "will-enter"
        | "entered",
    ) {
      const window = localWindows[index];

      if (window === undefined) throw new Error("Missing fixture window");

      return originNativeFirstEntryRequestSchemaV1.parse({
        version: 1,
        nativeJobId: value.nativeJobId,
        localSelectionSha256: sha(JSON.stringify(bindings)),
        transferId: window.ticket.id,
        windowKey: window.windowKey,
        targetStageSha256: window.targetStageSha256,
        originPayloadSha256: window.originPayloadSha256,
        composerTabId: window.composerTabId,
        mapping,
        kind,
        recipeSha256: kind === "inspect" ? null : "e".repeat(64),
      });
    },
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

test("keeps every local window closed until both preserved sessions retire under the full multi-device cohort", async () => {
  const input = await selection();
  let protectedAdmission: "closed" | "admitted" = "closed";
  const startOrdinaryNativeOwner = vi.fn(async () => {});
  const assertFinalRuntime = vi.fn(async () => {});

  const owner = await createDesktopOriginFirstEntryOwnerV1({
    jobDir: input.jobDir,
    selection: input.value,
    async readProtectedAdmission() {
      return protectedAdmission;
    },
    assertFinalRuntime,
    async admitProtectedProfile() {
      protectedAdmission = "admitted";
    },
    startOrdinaryNativeOwner,
  });

  const request = (index: number, kind: Parameters<typeof input.request>[1]) =>
    owner.request(`window-${index}`, input.request(index, kind));

  const first = request(0, "preflight");
  expect((await request(1, "inspect")).ordinaryEntryAuthorized).toBe(false);
  expect(protectedAdmission).toBe("closed");
  await Promise.all([first, request(1, "preflight")]);
  const ready = request(0, "ready");
  expect((await request(1, "inspect")).protectedAdmission).toBe(0);
  await Promise.all([ready, request(1, "ready")]);
  expect(protectedAdmission).toBe("admitted");
  expect(startOrdinaryNativeOwner).not.toHaveBeenCalled();
  await Promise.all([request(0, "prepared"), request(1, "prepared")]);
  const retired = request(0, "retired");
  await expect(request(0, "will-enter")).rejects.toThrow(
    "Every local controller",
  );
  expect(startOrdinaryNativeOwner).not.toHaveBeenCalled();
  await Promise.all([retired, request(1, "retired")]);
  await Promise.all([request(0, "will-enter"), request(1, "will-enter")]);
  expect(startOrdinaryNativeOwner).toHaveBeenCalledTimes(1);
  expect(assertFinalRuntime).toHaveBeenCalledTimes(2);
  await request(0, "entered");

  for (const index of [0, 1]) {
    const descriptor = await owner.descriptor(`window-${index}`);

    expect(descriptor).toMatchObject({
      kind: "origin-native-session-identity",
      windowKey: `window-${index}`,
      composerTabId: `preserved-tab-${index}`,
      recipeSha256: "e".repeat(64),
    });
    expect(descriptor).not.toHaveProperty("localWindows");
    expect(descriptor).not.toHaveProperty("ticket");
  }

  const reopened = await createDesktopOriginFirstEntryOwnerV1({
    jobDir: input.jobDir,
    selection: input.value,
    async readProtectedAdmission() {
      return protectedAdmission;
    },
    assertFinalRuntime,
    async admitProtectedProfile() {
      throw new Error("An admitted profile cannot be imported twice");
    },
    startOrdinaryNativeOwner,
  });

  expect(await reopened.descriptor("window-0")).toMatchObject({
    kind: "origin-native-session-identity",
    composerTabId: "preserved-tab-0",
  });
  await expect(request(1, "ready")).rejects.toThrow(
    "Old native session recovery",
  );
});

test("does not let a sibling window time out while its own protected admission is pending", async () => {
  const input = await selection();
  let protectedAdmission: "closed" | "admitted" = "closed";
  let releaseAdmission: (() => void) | undefined;
  let announceAdmission: (() => void) | undefined;

  const admissionStarted = new Promise<void>((resolve) => {
    announceAdmission = resolve;
  });

  const admission = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });

  const owner = await createDesktopOriginFirstEntryOwnerV1({
    jobDir: input.jobDir,
    selection: input.value,
    async readProtectedAdmission() {
      return protectedAdmission;
    },
    async assertFinalRuntime() {},
    async admitProtectedProfile() {
      announceAdmission?.();
      await admission;
      protectedAdmission = "admitted";
    },
    async startOrdinaryNativeOwner() {},
  });

  const request = (index: number, kind: Parameters<typeof input.request>[1]) =>
    owner.request(`window-${index}`, input.request(index, kind));

  await Promise.all([request(0, "preflight"), request(1, "preflight")]);
  const ready = Promise.all([request(0, "ready"), request(1, "ready")]);
  await admissionStarted;
  const sibling = request(0, "inspect");

  const settled = sibling.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

  await new Promise((resolve) => setTimeout(resolve, 1200));
  releaseAdmission?.();
  await ready;
  expect(await settled).toMatchObject({
    value: { protectedAdmission: 1, ordinaryEntryAuthorized: false },
  });
});
