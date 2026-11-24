import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { MANAGED_HOLDING_MS } from "./managed-contract.js";
import {
  managedExact,
  managedFixture,
  TEST_OWNER,
  TEST_HOST,
  TEST_STORAGE,
  TEST_CLOSEOUT,
} from "./managed-test-fixture.js";

describe("managed allocation conservation", () => {
  it("refuses real filesystem overcommit before reserving an allocation", async () => {
    const fixture = await managedFixture();

    try {
      await expect(
        fixture.host.managedAllocate({
          hostId: TEST_HOST,
          ownerThreadId: TEST_OWNER,
          projectId: null,
          requestKey: "too-large",
          purpose: "Admission fixture",
          disposition: "keep-until-released",
          storage: {
            ...TEST_STORAGE,
            budgetBytes: Number.MAX_SAFE_INTEGER,
            minimumFreeBytes: 0,
          },
        }),
      ).rejects.toThrow("No allocation was created");
      expect(await fixture.host.managedList()).toEqual([]);
      await expect(
        fs.stat(
          path.join(fixture.options.dataDir, "managed-cleanup", "requests"),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("holds exceeded and legacy budgets without deleting files or inventing approval", async () => {
    const fixture = await managedFixture();

    try {
      const allocation = await fixture.allocate();
      await fs.writeFile(
        path.join(allocation.path, "work"),
        Buffer.alloc(TEST_STORAGE.budgetBytes + 1),
      );
      const held = await fixture.host.managedInspect({ id: allocation.id });
      expect(held.hold?.code).toBe("storage-budget-exceeded");
      expect(held.grant).toBeNull();

      const extended = await fixture.host.managedOwnerDecision({
        ...managedExact(held),
        actorThreadId: TEST_OWNER,
        decision: {
          action: "budget-extend",
          budgetBytes: TEST_STORAGE.budgetBytes * 2,
          reason: "The measured next verification needs this finite extension.",
        },
      });

      expect(extended.storage?.budgetBytes).toBe(TEST_STORAGE.budgetBytes * 2);
      expect(extended.grant).toBeNull();

      const manifestPath = path.join(
        fixture.options.dataDir,
        "managed-cleanup",
        "allocations",
        `${allocation.id}.json`,
      );

      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      delete manifest.storage;
      delete manifest.closeout;
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
      const legacy = await fixture.host.managedInspect({ id: allocation.id });
      expect(legacy.storage).toBeNull();
      expect(legacy.hold?.code).toBe("storage-declaration-unknown");
      await expect(
        fixture.host.managedOwnerDecision({
          ...managedExact(legacy),
          actorThreadId: TEST_OWNER,
          decision: {
            action: "release",
            reason: "Legacy completion",
            closeout: TEST_CLOSEOUT,
          },
        }),
      ).rejects.toThrow("legacy allocation");
      expect((await fs.stat(path.join(allocation.path, "work"))).size).toBe(
        TEST_STORAGE.budgetBytes + 1,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("records failure closeout only after keepers leave the disposable allocation", async () => {
    const fixture = await managedFixture();

    try {
      const allocation = await fixture.allocate();
      await fs.writeFile(
        path.join(allocation.path, "proof"),
        "failure evidence",
      );

      const inspected = await fixture.host.managedInspect({
        id: allocation.id,
      });

      await expect(
        fixture.host.managedOwnerDecision({
          ...managedExact(inspected),
          actorThreadId: TEST_OWNER,
          decision: {
            action: "release",
            reason: "Failed producer",
            closeout: {
              outcome: "failure",
              retainedOutputs: [
                {
                  path: path.join(allocation.path, "proof"),
                  reason: "Required failure evidence",
                  removalCondition: "Review finishes",
                },
              ],
            },
          },
        }),
      ).rejects.toThrow("outside");
      const keeper = path.join(fixture.root, "proof");
      await fs.copyFile(path.join(allocation.path, "proof"), keeper);

      const proposed = await fixture.host.managedOwnerDecision({
        ...managedExact(inspected),
        actorThreadId: TEST_OWNER,
        decision: {
          action: "release",
          reason: "Failed producer",
          closeout: {
            outcome: "failure",
            retainedOutputs: [
              {
                path: keeper,
                reason: "Required failure evidence",
                removalCondition: "Review finishes",
              },
            ],
          },
        },
      });

      expect(proposed.closeout?.outcome).toBe("failure");
      expect(proposed.phase).toBe("proposed");
      expect(await fs.readFile(keeper, "utf8")).toBe("failure evidence");
      expect(
        await fs.readFile(path.join(allocation.path, "proof"), "utf8"),
      ).toBe("failure evidence");
    } finally {
      await fixture.cleanup();
    }
  });
  it("scopes retry keys by owner and serializes concurrent allocation retries", async () => {
    const fixture = await managedFixture();

    try {
      const [first, retry] = await Promise.all([
        fixture.allocate("stable"),
        fixture.allocate("stable"),
      ]);

      const other = await fixture.allocate("stable", "thr_otherowner");
      expect(retry.id).toBe(first.id);
      expect(other.id).not.toBe(first.id);
      expect(other.ownerThreadId).toBe("thr_otherowner");
      expect(await fs.readdir(first.path)).toEqual([]);
      expect((await fixture.host.managedList()).length).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });
  it("keeps active allocation intent through repeated inspect and producer-write cycles", async () => {
    const fixture = await managedFixture();

    try {
      const allocation = await fixture.allocate();
      let inspected = await fixture.host.managedInspect({ id: allocation.id });

      expect(inspected.phase).toBe("allocated");
      expect(inspected.grant).toBeNull();

      for (const contents of [
        "first producer output",
        "second producer output with more bytes",
      ]) {
        const previousRevision = inspected.revision;
        const previousDigest = inspected.snapshot?.digest;
        await fs.writeFile(path.join(allocation.path, "work"), contents);
        inspected = await fixture.host.managedInspect({ id: allocation.id });

        expect(inspected.phase).toBe("allocated");
        expect(inspected.grant).toBeNull();
        expect(inspected.reviewedAt).toBeNull();
        expect(inspected.revision).toBeGreaterThan(previousRevision);
        expect(inspected.snapshot?.digest).not.toBe(previousDigest);
        expect(
          await fs.readFile(path.join(inspected.path, "work"), "utf8"),
        ).toBe(contents);
      }

      const registered = await fixture.host.managedOwnerDecision({
        ...managedExact(inspected),
        actorThreadId: TEST_OWNER,
        decision: {
          action: "consumer-register",
          consumerThreadId: "thr_intentconsumer",
        },
      });

      expect(registered.phase).toBe("allocated");
      expect(registered.grant).toBeNull();
      expect(registered.reviewedAt).toBeNull();
      expect(registered.consumers).toEqual([
        { threadId: "thr_intentconsumer", releasedAt: null },
      ]);

      const reused = await fixture.host.managedOwnerDecision({
        ...managedExact(registered),
        actorThreadId: TEST_OWNER,
        decision: {
          action: "reuse",
          reason: "The producer is still using its original allocation.",
        },
      });

      expect(reused.phase).toBe("allocated");
      expect(reused.grant).toBeNull();
      expect(reused.reviewedAt).toBeNull();

      const consumerReleased = await fixture.host.managedOwnerDecision({
        ...managedExact(reused),
        actorThreadId: "thr_intentconsumer",
        decision: { action: "consumer-release" },
      });

      expect(consumerReleased.phase).toBe("allocated");
      expect(consumerReleased.grant).toBeNull();

      const ended = await fixture.host.managedOwnerDecision({
        ...managedExact(consumerReleased),
        actorThreadId: TEST_OWNER,
        decision: { action: "owner-ended" },
      });

      expect(ended.phase).toBe("proposed");
      expect(ended.grant?.kind).toBe("owner-ended");
    } finally {
      await fixture.cleanup();
    }
  });
  it("quarantines and restores exact bytes without reclaiming logical bytes", async () => {
    const fixture = await managedFixture();

    try {
      const allocation = await fixture.allocate();
      await fs.writeFile(
        path.join(allocation.path, "work"),
        "preserve these bytes",
      );
      const approved = await fixture.approve(allocation);
      const quarantined = await fixture.transition(approved, "quarantine");
      expect(quarantined.phase).toBe("quarantined");
      expect(quarantined.removedLogicalBytes).toBe(0);
      expect(
        await fs.readFile(path.join(quarantined.path, "work"), "utf8"),
      ).toBe("preserve these bytes");
      const restored = await fixture.transition(quarantined, "restore");
      expect(restored.phase).toBe("kept");
      expect(restored.grant).toBeNull();
      expect(await fs.readFile(path.join(restored.path, "work"), "utf8")).toBe(
        "preserve these bytes",
      );
      await fs.writeFile(
        path.join(restored.path, "work"),
        "restored producer output",
      );

      const reinspected = await fixture.host.managedInspect({
        id: restored.id,
      });

      expect(reinspected.phase).toBe("kept");
      expect(reinspected.grant).toBeNull();
      expect(reinspected.reviewedAt).toBeNull();
      expect(
        await fs.readFile(path.join(reinspected.path, "work"), "utf8"),
      ).toBe("restored producer output");
    } finally {
      await fixture.cleanup();
    }
  });
  it("unlinks only managed leaf links and hardlink names after the fixed floor", async () => {
    const fixture = await managedFixture();

    try {
      const allocation = await fixture.allocate();
      const outside = path.join(fixture.root, "external");
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "canary"), "EXTERNAL CANARY");
      const original = await fs.stat(path.join(outside, "canary"));
      await fs.mkdir(path.join(allocation.path, "internal"));
      await fs.writeFile(
        path.join(allocation.path, "internal", "work"),
        "owned",
      );
      await fs.symlink(
        outside,
        path.join(allocation.path, "external-directory"),
      );
      await fs.symlink(
        path.join(outside, "canary"),
        path.join(allocation.path, "external-file"),
      );
      await fs.symlink(
        path.join(outside, "absent"),
        path.join(allocation.path, "broken"),
      );
      await fs.symlink("internal", path.join(allocation.path, "internal-link"));
      await fs.link(
        path.join(outside, "canary"),
        path.join(allocation.path, "hardlink"),
      );

      const quarantined = await fixture.transition(
        await fixture.approve(allocation),
        "quarantine",
      );

      const early = await fixture.transition(quarantined, "purge");
      expect(early.hold?.code).toBe("holding-period");
      expect(await fs.readFile(path.join(outside, "canary"), "utf8")).toBe(
        "EXTERNAL CANARY",
      );
      fixture.advance(MANAGED_HOLDING_MS + 1);
      const removed = await fixture.transition(early, "purge");
      expect(removed.phase).toBe("removed");
      expect(removed.removedLogicalBytes).toBe(20);
      expect(await fs.readdir(outside)).toEqual(["canary"]);
      expect(await fs.readFile(path.join(outside, "canary"), "utf8")).toBe(
        "EXTERNAL CANARY",
      );
      expect((await fs.stat(path.join(outside, "canary"))).ino).toBe(
        original.ino,
      );
      await expect(fs.lstat(quarantined.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fixture.cleanup();
    }
  });
  it("holds repository markers and existing retention receipts", async () => {
    const fixture = await managedFixture();

    try {
      for (const [index, marker] of [
        ".git",
        "storage-retention.json",
      ].entries()) {
        const allocation = await fixture.allocate(`protected-${index}`);
        await fs.writeFile(path.join(allocation.path, marker), "must survive");

        const inspected = await fixture.host.managedInspect({
          id: allocation.id,
        });

        expect(inspected.hold?.code).toBe(
          index === 0 ? "repository" : "retention-receipt",
        );
        expect(inspected.snapshot).toBeNull();
        expect(
          await fs.readFile(path.join(allocation.path, marker), "utf8"),
        ).toBe("must survive");
      }
    } finally {
      await fixture.cleanup();
    }
  });
  it("invalidates changed snapshots and refuses a late directory-to-link swap", async () => {
    let swap: (() => Promise<void>) | null = null;

    const fixture = await managedFixture({
      fault: async (stage) => {
        if (stage === "after-intent") await swap?.();
      },
    });

    try {
      const allocation = await fixture.allocate();
      const canary = path.join(fixture.root, "outside");
      await fs.mkdir(canary);
      await fs.writeFile(path.join(canary, "canary"), "external");
      await fs.writeFile(path.join(allocation.path, "work"), "owned");
      const approved = await fixture.approve(allocation);
      swap = async () => {
        await fs.rename(allocation.path, `${allocation.path}-saved`);
        await fs.symlink(canary, allocation.path);
      };

      const held = await fixture.transition(approved, "quarantine");
      expect(held.hold).not.toBeNull();
      expect(held.phase).toBe("quarantine-intent");
      expect(await fs.readFile(path.join(canary, "canary"), "utf8")).toBe(
        "external",
      );
      expect(
        await fs.readFile(
          path.join(`${allocation.path}-saved`, "work"),
          "utf8",
        ),
      ).toBe("owned");
    } finally {
      await fixture.cleanup();
    }
  });
  it("keeps restore collisions and revoked quarantined grants intact", async () => {
    const fixture = await managedFixture();

    try {
      const allocation = await fixture.allocate();
      await fs.writeFile(path.join(allocation.path, "work"), "restore me");

      const quarantined = await fixture.transition(
        await fixture.approve(allocation),
        "quarantine",
      );

      await fs.mkdir(allocation.path);
      await fs.writeFile(
        path.join(allocation.path, "other"),
        "do not overwrite",
      );
      const collision = await fixture.transition(quarantined, "restore");
      expect(collision.hold?.code).toBe("restore-collision");

      const resumed = await fixture.host.managedOwnerDecision({
        ...managedExact(collision),
        actorThreadId: TEST_OWNER,
        decision: { action: "owner-unarchived" },
      });

      expect(resumed.grant).toBeNull();
      fixture.advance(MANAGED_HOLDING_MS + 1);
      const held = await fixture.transition(resumed, "purge");
      expect(held.hold?.code).toBe("owner-grant");
      expect(
        await fs.readFile(path.join(quarantined.path, "work"), "utf8"),
      ).toBe("restore me");
      expect(
        await fs.readFile(path.join(allocation.path, "other"), "utf8"),
      ).toBe("do not overwrite");
    } finally {
      await fixture.cleanup();
    }
  });
  it("serializes a keep racing cleanup and never accepts another owner's decision", async () => {
    const fixture = await managedFixture();

    try {
      const allocation = await fixture.allocate();
      await fs.writeFile(path.join(allocation.path, "work"), "owned");
      const approved = await fixture.approve(allocation);
      await expect(
        fixture.host.managedOwnerDecision({
          ...managedExact(approved),
          actorThreadId: "thr_foreignowner",
          decision: {
            action: "release",
            closeout: { outcome: "success", retainedOutputs: [] },
            reason: "forged",
          },
        }),
      ).rejects.toThrow("trusted allocation owner");

      const keep = fixture.host.managedOwnerDecision({
        ...managedExact(approved),
        actorThreadId: TEST_OWNER,
        decision: { action: "keep", reason: "Still useful." },
      });

      const removal = fixture.transition(approved, "quarantine");
      expect((await keep).phase).toBe("kept");
      await expect(removal).rejects.toThrow("allocation changed");
      expect(
        await fs.readFile(path.join(allocation.path, "work"), "utf8"),
      ).toBe("owned");
    } finally {
      await fixture.cleanup();
    }
  });
  it("retains consumer holds and accepts only fresh settled consumer evidence", async () => {
    const fixture = await managedFixture();

    try {
      const allocation = await fixture.allocate();

      const inspected = await fixture.host.managedInspect({
        id: allocation.id,
      });

      const shared = await fixture.host.managedOwnerDecision({
        ...managedExact(inspected),
        actorThreadId: TEST_OWNER,
        decision: {
          action: "consumer-register",
          consumerThreadId: "thr_consumer",
        },
      });

      const approved = await fixture.approve(shared);
      const held = await fixture.transition(approved, "quarantine");
      expect(held.hold?.code).toBe("consumer-hold");

      const quarantined = await fixture.host.managedTransition({
        ...managedExact(held),
        action: "quarantine",
        expiryEnabledAt: null,
        settledConsumerThreadIds: ["thr_consumer"],
      });

      expect(quarantined.phase).toBe("quarantined");
      expect(quarantined.consumers[0]?.releasedAt).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });
  it("never adopts a replaced root before the first snapshot", async () => {
    const fixture = await managedFixture();

    try {
      const allocation = await fixture.allocate();
      await fs.rename(allocation.path, `${allocation.path}-original`);
      await fs.mkdir(allocation.path);
      await fs.writeFile(
        path.join(allocation.path, "foreign"),
        "never adopted",
      );

      const inspected = await fixture.host.managedInspect({
        id: allocation.id,
      });

      expect(inspected.hold?.code).toBe("root-identity");
      expect(inspected.snapshot).toBeNull();
      expect(
        await fs.readFile(path.join(allocation.path, "foreign"), "utf8"),
      ).toBe("never adopted");
    } finally {
      await fixture.cleanup();
    }
  });
  it("requires renewed review after a quarantined owner revokes and releases again", async () => {
    const fixture = await managedFixture();

    try {
      const allocation = await fixture.allocate();
      await fs.writeFile(path.join(allocation.path, "work"), "renew review");

      const quarantined = await fixture.transition(
        await fixture.approve(allocation),
        "quarantine",
      );

      const kept = await fixture.host.managedOwnerDecision({
        ...managedExact(quarantined),
        actorThreadId: TEST_OWNER,
        decision: { action: "keep", reason: "Useful again." },
      });

      expect(kept.disposition).toBe("keep-until-released");
      await expect(
        fixture.host.managedReview(managedExact(kept)),
      ).rejects.toThrow("missing native owner grant");

      const released = await fixture.host.managedOwnerDecision({
        ...managedExact(kept),
        actorThreadId: TEST_OWNER,
        decision: {
          action: "release",
          closeout: { outcome: "success", retainedOutputs: [] },
          reason: "No longer useful.",
        },
      });

      expect(released.reviewedAt).toBeNull();
      fixture.advance(MANAGED_HOLDING_MS + 1);
      const held = await fixture.transition(released, "purge");
      expect(held.hold?.code).toBe("owner-grant");
      const reviewed = await fixture.host.managedReview(managedExact(held));
      expect((await fixture.transition(reviewed, "purge")).phase).toBe(
        "removed",
      );
    } finally {
      await fixture.cleanup();
    }
  });
  it.each(["content", "metadata"])(
    "renews the restore floor for an aged quarantined %s change",
    async (change) => {
      const fixture = await managedFixture();

      try {
        const allocation = await fixture.allocate();
        await fs.writeFile(
          path.join(allocation.path, "work"),
          "original quarantined bytes",
        );

        const quarantined = await fixture.transition(
          await fixture.approve(allocation),
          "quarantine",
        );

        if (quarantined.quarantinedAt === null)
          throw new Error("The fixture did not enter quarantine.");

        const initialDate = quarantined.quarantinedAt;
        fixture.advance(MANAGED_HOLDING_MS + 10);

        const unchanged = await fixture.host.managedInspect({
          id: quarantined.id,
        });

        expect(unchanged.quarantinedAt).toBe(initialDate);
        expect(unchanged.purgeEligibleAt).toBe(
          initialDate + MANAGED_HOLDING_MS,
        );

        const file = path.join(quarantined.path, "work");

        const contents =
          change === "content"
            ? "new producer bytes need their own restore window"
            : "original quarantined bytes";

        if (change === "content") await fs.writeFile(file, contents);
        else {
          const mode = (await fs.stat(file)).mode & 0o777;
          await fs.chmod(file, mode === 0o600 ? 0o640 : 0o600);
        }

        const changed = await fixture.host.managedInspect({
          id: quarantined.id,
        });

        expect(changed.grant).toBeNull();
        expect(changed.reviewedAt).toBeNull();

        const released = await fixture.host.managedOwnerDecision({
          ...managedExact(changed),
          actorThreadId: TEST_OWNER,
          decision: {
            action: "release",
            closeout: { outcome: "success", retainedOutputs: [] },
            reason: "The changed generation is now disposable.",
          },
        });

        const reviewed = await fixture.host.managedReview(
          managedExact(released),
        );

        const early = await fixture.transition(reviewed, "purge");

        expect(early.phase).toBe("quarantined");
        expect(early.hold?.code).toBe("holding-period");
        expect(changed.quarantinedAt).toBe(
          initialDate + MANAGED_HOLDING_MS + 10,
        );
        expect(changed.purgeEligibleAt).toBe(
          initialDate + MANAGED_HOLDING_MS * 2 + 10,
        );
        expect(await fs.readFile(file, "utf8")).toBe(contents);

        fixture.advance(MANAGED_HOLDING_MS - 1);

        const unchangedAgain = await fixture.host.managedInspect({
          id: quarantined.id,
        });

        expect(unchangedAgain.quarantinedAt).toBe(changed.quarantinedAt);
        expect(unchangedAgain.purgeEligibleAt).toBe(changed.purgeEligibleAt);
        const stillEarly = await fixture.transition(unchangedAgain, "purge");

        expect(stillEarly.hold?.code).toBe("holding-period");
        expect(await fs.readFile(file, "utf8")).toBe(contents);
        fixture.advance(1);
        expect((await fixture.transition(stillEarly, "purge")).phase).toBe(
          "removed",
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );
  it("never shortens a changed quarantine generation floor when the clock moves backwards", async () => {
    const fixture = await managedFixture();

    try {
      const allocation = await fixture.allocate();
      await fs.writeFile(path.join(allocation.path, "work"), "original");

      const quarantined = await fixture.transition(
        await fixture.approve(allocation),
        "quarantine",
      );

      fixture.advance(-1000);
      await fs.writeFile(
        path.join(quarantined.path, "work"),
        "changed after clock rollback",
      );
      const changed = await fixture.host.managedInspect({ id: quarantined.id });

      expect(changed.grant).toBeNull();
      expect(changed.quarantinedAt).toBe(quarantined.quarantinedAt);
      expect(changed.purgeEligibleAt).toBe(quarantined.purgeEligibleAt);
      expect(await fs.readFile(path.join(changed.path, "work"), "utf8")).toBe(
        "changed after clock rollback",
      );
    } finally {
      await fixture.cleanup();
    }
  });
  it("handles multiple owned hardlink names while preserving the external inode contents", async () => {
    const fixture = await managedFixture();

    try {
      const allocation = await fixture.allocate();
      const external = path.join(fixture.root, "external-hardlink");
      await fs.writeFile(external, "shared bytes");
      await fs.link(external, path.join(allocation.path, "one"));
      await fs.link(external, path.join(allocation.path, "two"));

      const quarantined = await fixture.transition(
        await fixture.approve(allocation),
        "quarantine",
      );

      fixture.advance(MANAGED_HOLDING_MS + 1);
      const removed = await fixture.transition(quarantined, "purge");
      expect(removed.phase).toBe("removed");
      expect(await fs.readFile(external, "utf8")).toBe("shared bytes");
      expect((await fs.stat(external)).nlink).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });
});
