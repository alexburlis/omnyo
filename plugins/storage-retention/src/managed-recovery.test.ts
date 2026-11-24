import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createManagedHost } from "./managed-host.js";
import { MANAGED_HOLDING_MS, managedIdSchema } from "./managed-contract.js";
import {
  managedExact,
  managedFixture,
  TEST_OWNER,
} from "./managed-test-fixture.js";

describe("managed durable transition recovery", () => {
  it.each(["after-intent", "after-rename"] as const)(
    "reconciles interrupted quarantine at %s without replay",
    async (faultStage) => {
      let armed = true;

      const fixture = await managedFixture({
        fault: async (stage) => {
          if (armed && stage === faultStage)
            throw new Error("Owned injected interruption");
        },
      });

      try {
        const allocation = await fixture.allocate();
        await fs.writeFile(
          path.join(allocation.path, "work"),
          "recover exact bytes",
        );

        const interrupted = await fixture.transition(
          await fixture.approve(allocation),
          "quarantine",
        );

        expect(interrupted.phase).toBe("quarantine-intent");
        fixture.advance(MANAGED_HOLDING_MS + 20);
        armed = false;
        const restarted = createManagedHost(fixture.options);

        const [recovered] = await restarted.managedReconcile({
          id: allocation.id,
        });

        expect(recovered?.phase).toBe(
          faultStage === "after-intent" ? "approved" : "quarantined",
        );
        expect(
          await fs.readFile(path.join(recovered!.path, "work"), "utf8"),
        ).toBe("recover exact bytes");

        if (faultStage === "after-rename") {
          if (!recovered)
            throw new Error(
              "The interrupted quarantine fixture was not recovered.",
            );

          const early = await restarted.managedTransition({
            ...managedExact(recovered),
            action: "purge",
            expiryEnabledAt: null,
            settledConsumerThreadIds: [],
          });

          expect(early.phase).toBe("quarantined");
          expect(early.hold?.code).toBe("holding-period");
          expect(recovered.quarantinedAt).toBe(
            allocation.createdAt + MANAGED_HOLDING_MS + 20,
          );
          expect(recovered.purgeEligibleAt).toBe(
            allocation.createdAt + MANAGED_HOLDING_MS * 2 + 20,
          );
          expect(await fs.readFile(path.join(early.path, "work"), "utf8")).toBe(
            "recover exact bytes",
          );
          fixture.advance(MANAGED_HOLDING_MS - 1);

          const stillEarly = await restarted.managedTransition({
            ...managedExact(early),
            action: "purge",
            expiryEnabledAt: null,
            settledConsumerThreadIds: [],
          });

          expect(stillEarly.hold?.code).toBe("holding-period");
          expect(
            await fs.readFile(path.join(stillEarly.path, "work"), "utf8"),
          ).toBe("recover exact bytes");
          fixture.advance(1);

          const removed = await restarted.managedTransition({
            ...managedExact(stillEarly),
            action: "purge",
            expiryEnabledAt: null,
            settledConsumerThreadIds: [],
          });

          expect(removed.phase).toBe("removed");
        }
      } finally {
        await fixture.cleanup();
      }
    },
  );
  it("holds an interrupted partial purge without false completion or deletion replay", async () => {
    let armed = false;
    let unlinks = 0;

    const fixture = await managedFixture({
      fault: async (stage) => {
        if (armed && stage === "after-unlink" && ++unlinks === 1)
          throw new Error("Owned partial purge interruption");
      },
    });

    try {
      const allocation = await fixture.allocate();
      await fs.writeFile(path.join(allocation.path, "a"), "A");
      await fs.writeFile(path.join(allocation.path, "b"), "B");

      const quarantined = await fixture.transition(
        await fixture.approve(allocation),
        "quarantine",
      );

      fixture.advance(MANAGED_HOLDING_MS + 1);
      armed = true;
      const partial = await fixture.transition(quarantined, "purge");
      expect(partial.phase).toBe("purge-intent");
      expect(partial.removedLogicalBytes).toBe(0);
      const remaining = await fs.readdir(quarantined.path);
      expect(remaining).toHaveLength(1);
      const restarted = createManagedHost(fixture.options);

      const [recovered] = await restarted.managedReconcile({
        id: allocation.id,
      });

      expect(recovered?.phase).toBe("purge-intent");
      expect(recovered?.hold?.code).toBe("partial-purge");
      expect(await fs.readdir(quarantined.path)).toEqual(remaining);
      await expect(
        restarted.managedTransition({
          ...managedExact(recovered!),
          action: "purge",
          expiryEnabledAt: null,
          settledConsumerThreadIds: [],
        }),
      ).rejects.toThrow("cannot be replayed");
      expect(await fs.readdir(quarantined.path)).toEqual(remaining);
    } finally {
      await fixture.cleanup();
    }
  });
  it("revokes an advance grant even after quarantine and does not remove after restart", async () => {
    const fixture = await managedFixture();

    try {
      const allocation = await fixture.allocate();
      await fs.writeFile(path.join(allocation.path, "work"), "owner resumed");

      const inspected = await fixture.host.managedInspect({
        id: allocation.id,
      });

      const proposed = await fixture.host.managedOwnerDecision({
        ...managedExact(inspected),
        actorThreadId: TEST_OWNER,
        decision: { action: "owner-ended" },
      });

      const quarantined = await fixture.transition(
        await fixture.host.managedReview(managedExact(proposed)),
        "quarantine",
      );

      const resumed = await fixture.host.managedOwnerDecision({
        ...managedExact(quarantined),
        actorThreadId: TEST_OWNER,
        decision: { action: "owner-unarchived" },
      });

      fixture.advance(MANAGED_HOLDING_MS + 1);
      const restarted = createManagedHost(fixture.options);

      const held = await restarted.managedTransition({
        ...managedExact(resumed),
        action: "purge",
        expiryEnabledAt: 0,
        settledConsumerThreadIds: [],
      });

      expect(held.phase).toBe("quarantined");
      expect(held.hold?.code).toBe("owner-grant");
      expect(await fs.readFile(path.join(held.path, "work"), "utf8")).toBe(
        "owner resumed",
      );
    } finally {
      await fixture.cleanup();
    }
  });
  it("recovers a real terminated worker after its durable intent", async () => {
    const fixture = await managedFixture();
    let child: ReturnType<typeof spawn> | null = null;
    let childClosed: Promise<void> | null = null;

    try {
      const allocation = await fixture.allocate();
      await fs.writeFile(
        path.join(allocation.path, "work"),
        "survives a killed worker",
      );
      const approved = await fixture.approve(allocation);
      const moduleUrl = new URL("./managed-host.ts", import.meta.url).href;
      const script = `import {createManagedHost} from ${JSON.stringify(moduleUrl)}; const keepalive=setInterval(()=>{},1000); const host=createManagedHost({dataDir:${JSON.stringify(fixture.options.dataDir)},homeDirectory:${JSON.stringify(fixture.home)},inspectProcesses:async()=>({kind:'idle'}),fault:async(stage)=>{if(stage==='after-intent'){process.send('durable-intent');await new Promise(()=>{});}}});await host.managedTransition(${JSON.stringify({ ...managedExact(approved), action: "quarantine", expiryEnabledAt: null, settledConsumerThreadIds: [] })});clearInterval(keepalive);`;
      child = spawn(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script,
        ],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      const worker = child;
      childClosed = new Promise<void>((resolve) => {
        worker.once("close", () => resolve());
      });
      let errors = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      await Promise.race([
        once(child, "message"),
        childClosed.then(() => {
          throw new Error(`Fixture worker exited before intent: ${errors}`);
        }),
      ]);
      child.kill("SIGKILL");
      await childClosed;
      expect(child.signalCode).toBe("SIGKILL");
      child = null;
      const restarted = createManagedHost(fixture.options);

      const [recovered] = await restarted.managedReconcile({
        id: allocation.id,
      });

      expect(recovered?.phase).toBe("approved");
      expect(
        await fs.readFile(path.join(recovered!.path, "work"), "utf8"),
      ).toBe("survives a killed worker");
    } finally {
      if (child) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await childClosed;
      }

      await fixture.cleanup();
    }
  }, 10000);
  it("retains an allocation interrupted before its manifest without duplicating or adopting it", async () => {
    const fixture = await managedFixture();
    let child: ReturnType<typeof spawn> | null = null;
    let childClosed: Promise<void> | null = null;

    try {
      const moduleUrl = new URL("./managed-host.ts", import.meta.url).href;

      const input = {
        hostId: "hst_managedhost",
        ownerThreadId: TEST_OWNER,
        projectId: null,
        requestKey: "crashed-request",
        storage: {
          role: "verification",
          budgetBytes: 1024 ** 2,
          minimumFreeBytes: 1024 ** 2,
          restoreInputs: [],
        },
        purpose: "Interrupted allocation fixture",
        disposition: "disposable-when-owner-ends",
      };

      const script = `import {createManagedHost} from ${JSON.stringify(moduleUrl)}; const keepalive=setInterval(()=>{},1000); const host=createManagedHost({dataDir:${JSON.stringify(fixture.options.dataDir)},homeDirectory:${JSON.stringify(fixture.home)},fault:async(stage,id)=>{if(stage==='after-allocation-payload'){process.send(id);await new Promise(()=>{});}}});await host.managedAllocate(${JSON.stringify(input)});clearInterval(keepalive);`;
      child = spawn(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script,
        ],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      const worker = child;
      childClosed = new Promise<void>((resolve) => {
        worker.once("close", () => resolve());
      });

      const [message] = await Promise.race([
        once(child, "message"),
        childClosed.then(() => {
          throw new Error(
            "Owned fixture exited before creating its allocation payload.",
          );
        }),
      ]);

      const id = managedIdSchema.parse(message);

      const namespace = (
        await fs.readdir(path.join(fixture.home, "scratch", "omnyo"))
      )[0];

      if (!namespace)
        throw new Error("The owned managed namespace was not created.");

      const payload = path.join(
        fixture.home,
        "scratch",
        "omnyo",
        namespace,
        TEST_OWNER,
        id,
        "payload",
      );

      await fs.writeFile(
        path.join(payload, "canary"),
        "interrupted bytes remain held",
      );
      child.kill("SIGKILL");
      await childClosed;
      expect(child.signalCode).toBe("SIGKILL");
      child = null;
      await expect(fixture.allocate("crashed-request")).rejects.toThrow(
        "will not create a duplicate or adopt existing files",
      );
      await expect(fixture.allocate("crashed-request")).rejects.toThrow(
        "will not create a duplicate or adopt existing files",
      );
      expect(await fixture.host.managedList()).toEqual([]);
      expect(await fs.readdir(path.dirname(payload))).toEqual(["payload"]);
      expect(await fs.readFile(path.join(payload, "canary"), "utf8")).toBe(
        "interrupted bytes remain held",
      );
      expect(
        (
          await fs.readdir(
            path.join(fixture.options.dataDir, "managed-cleanup", "requests"),
          )
        ).length,
      ).toBe(1);
    } finally {
      if (child) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await childClosed;
      }

      await fixture.cleanup();
    }
  }, 10000);
});
