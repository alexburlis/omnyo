import { expect, test } from "vitest";
import { originNativeFirstEntryRequestSchemaV1 } from "@omnyo/desktop-contract/internal/origin-adoption-v1";
import { restoreNativeOriginSessionV1 } from "./origin-native-session-restore-v1";

class Store implements Storage {
  readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function fixture() {
  const id = "a".repeat(64);

  const mapping = {
    version: 1,
    adoptionId: "selected-adoption",
    fromOrigin: "https://bb.alexburlis.com",
    toOrigin: "https://app.example.invalid",
    serverHostId: "original-host",
    runtimeId: "original-control",
    selectedIds: [id, "b".repeat(64)],
    mappingSha256: "c".repeat(64),
  };

  const descriptor = {
    version: 1,
    kind: "origin-native-session-identity",
    nativeJobId: "selected-native-job",
    localSelectionSha256: "d".repeat(64),
    transferId: id,
    windowKey: "preserved-native-window",
    targetStageSha256: "e".repeat(64),
    originPayloadSha256: "f".repeat(64),
    composerTabId: "exact-original-tab",
    mapping,
    recipeSha256: "1".repeat(64),
  };

  const local = new Store();
  const session = new Store();
  local.setItem("omnyo.promptbox.contents-draft-3", "later opaque draft");
  local.setItem("unknown-plugin-journal", "later unknown local work");
  session.setItem(
    "omnyo.pending-chats.v1",
    JSON.stringify([
      {
        id: "pending_later",
        projectId: "proj_opaque",
        realThreadId: "thr_later",
        futureWork: { requestId: "never-resubmit", nested: ["preserve"] },
      },
    ]),
  );
  session.setItem("unknown-session-work", "later unknown session work");
  const requests: string[] = [];

  const args = {
    currentOrigin: mapping.toOrigin,
    local,
    session,
    nativeOwner: {
      async request(value: unknown) {
        const input = originNativeFirstEntryRequestSchemaV1.parse(value);
        requests.push(input.kind);

        return {
          ...input,
          kind:
            input.kind === "inspect" ? "inspect-accepted" : "entry-confirmed",
          recipeSha256: descriptor.recipeSha256,
          phase: "ordinary-entry-authorized",
          protectedAdmission: 1,
          ordinaryEntryAuthorized: true,
        };
      },
    },
  };

  return { descriptor, args, local, session, requests };
}

test("restores only the sealed tab identity after ordinary entry and preserves all later work without replay or dispatch", async () => {
  const f = fixture();
  const localBefore = [...f.local.values];
  const sessionBefore = [...f.session.values];
  const confirm = await restoreNativeOriginSessionV1(f.descriptor, f.args);
  expect([...f.local.values]).toEqual(localBefore);
  expect([...f.session.values]).toEqual([
    ...sessionBefore,
    ["omnyo.composer-submission-tab.v1", "exact-original-tab"],
  ]);
  expect(f.requests).toEqual(["inspect"]);
  await confirm();
  const reopen = await restoreNativeOriginSessionV1(f.descriptor, f.args);
  await reopen();
  expect(f.requests).toEqual(["inspect", "entered", "inspect", "entered"]);
  expect([...f.local.values]).toEqual(localBefore);
  expect(f.session.getItem("omnyo.pending-chats.v1")).toBe(
    JSON.stringify([
      {
        id: "pending_later",
        projectId: "proj_opaque",
        realThreadId: "thr_later",
        futureWork: { requestId: "never-resubmit", nested: ["preserve"] },
      },
    ]),
  );
});

test("refuses a different current tab or origin before changing either store", async () => {
  for (const changed of ["identity", "origin"]) {
    const f = fixture();

    if (changed === "identity")
      f.session.setItem(
        "omnyo.composer-submission-tab.v1",
        "different-current-tab",
      );
    else f.args.currentOrigin = "https://different.example";

    const before = {
      local: [...f.local.values],
      session: [...f.session.values],
    };

    await expect(
      restoreNativeOriginSessionV1(f.descriptor, f.args),
    ).rejects.toThrow();
    expect({
      local: [...f.local.values],
      session: [...f.session.values],
    }).toEqual(before);
    expect(f.requests).not.toContain("entered");
  }
});

test("refuses the old full-session descriptor after ordinary admission without replaying old session bytes", async () => {
  const f = fixture();

  const ticket = {
    version: 1,
    adoptionId: f.descriptor.mapping.adoptionId,
    id: f.descriptor.transferId,
    selectedIds: f.descriptor.mapping.selectedIds,
    nonce: "2".repeat(64),
    fromOrigin: f.descriptor.mapping.fromOrigin,
    toOrigin: f.descriptor.mapping.toOrigin,
  };

  const stale = {
    version: 1,
    ticket,
    windowKey: f.descriptor.windowKey,
    targetStageSha256: f.descriptor.targetStageSha256,
    nativeJobId: f.descriptor.nativeJobId,
    mapping: f.descriptor.mapping,
    localWindows: [
      {
        ticket,
        windowKey: f.descriptor.windowKey,
        targetStageSha256: f.descriptor.targetStageSha256,
        originPayloadSha256: f.descriptor.originPayloadSha256,
        composerTabId: f.descriptor.composerTabId,
      },
    ],
  };

  const before = { local: [...f.local.values], session: [...f.session.values] };
  await expect(restoreNativeOriginSessionV1(stale, f.args)).rejects.toThrow(
    "old full-session descriptor",
  );
  expect({
    local: [...f.local.values],
    session: [...f.session.values],
  }).toEqual(before);
  expect(f.requests).toEqual(["inspect"]);
});
