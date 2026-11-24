import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createManagedHost, type ManagedHostOptions } from "./managed-host.js";
import type { ManagedAllocation } from "./managed-contract.js";

export const TEST_OWNER = "thr_managedowner";

export const TEST_HOST = "hst_managedhost";

export const TEST_STORAGE = {
  role: "verification",
  budgetBytes: 1024 ** 2,
  minimumFreeBytes: 1024 ** 2,
  restoreInputs: [],
} satisfies NonNullable<ManagedAllocation["storage"]>;

export const TEST_CLOSEOUT = {
  outcome: "success",
  retainedOutputs: [],
} satisfies NonNullable<ManagedAllocation["closeout"]>;

export function managedExact(allocation: ManagedAllocation) {
  return {
    id: allocation.id,
    revision: allocation.revision,
    snapshotDigest: allocation.snapshot?.digest ?? null,
  };
}

export async function managedFixture(
  overrides: Partial<ManagedHostOptions> = {},
) {
  const scratch = path.join(os.homedir(), "scratch", "omnyo");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "managed-host-test-"));
  const home = path.join(root, "home");
  await fs.mkdir(home);
  let clock = Date.now();

  const options: ManagedHostOptions = {
    dataDir: path.join(root, "state"),
    homeDirectory: home,
    now: () => clock,
    inspectProcesses: async () => ({ kind: "idle" }),
    volumeIdentity: async () => null,
    ...overrides,
  };

  const host = createManagedHost(options);

  return {
    root,
    home,
    host,
    options,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    async allocate(requestKey = "request", ownerThreadId = TEST_OWNER) {
      return host.managedAllocate({
        hostId: TEST_HOST,
        ownerThreadId,
        projectId: null,
        requestKey,
        purpose: "Disposable test intermediate",
        disposition: "disposable-when-owner-ends",
        storage: TEST_STORAGE,
      });
    },
    async approve(allocation: ManagedAllocation) {
      const inspected = await host.managedInspect({ id: allocation.id });

      const proposed = await host.managedOwnerDecision({
        ...managedExact(inspected),
        actorThreadId: TEST_OWNER,
        decision: {
          action: "release",
          closeout: TEST_CLOSEOUT,
          reason: "The fixture no longer needs this intermediate.",
        },
      });

      return host.managedReview(managedExact(proposed));
    },
    async transition(
      allocation: ManagedAllocation,
      action: "quarantine" | "restore" | "purge",
    ) {
      return host.managedTransition({
        ...managedExact(allocation),
        action,
        expiryEnabledAt: null,
        settledConsumerThreadIds: [],
      });
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
