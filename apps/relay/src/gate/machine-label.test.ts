import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HANDLE_MAX_LENGTH, machine, user } from "@omnyo/connect-db";
import {
  RELAY_LABEL_LIMIT_PER_ACCOUNT,
  RELAY_LABEL_MIN_LENGTH,
  isClaimableRelayLabel,
} from "../reserved-labels.js";
import { type Harness, startHarness } from "./gate-test-harness.js";
import { classifyHost } from "./host.js";
import {
  assignMachineLabel,
  fallbackLabel,
  fallbackSeedFor,
  routableLabel,
  sanitizeMachineLabelBase,
} from "./machine-label.js";
import { sha256HexOf } from "./signed-token.js";

const MACHINE_ID = "abcdef0123456789";

describe("device label base", () => {
  it.each(["aws", "ibm", "hsbc", "x1y2"])(
    "gives the short device name %s the fallback label",
    (name) => {
      const label = sanitizeMachineLabelBase(name, MACHINE_ID);

      expect(label).toBe("machine-abcdef01");
      expect(label.length).toBeGreaterThanOrEqual(RELAY_LABEL_MIN_LENGTH);
    },
  );

  it.each(["31415926", "1234 5678", "2718281828"])(
    "never gives the digits-only device name %s a digits-only label",
    (name) => {
      expect(sanitizeMachineLabelBase(name, MACHINE_ID)).toBe(
        "machine-abcdef01",
      );
    },
  );

  it.each(["Githab Login", "Omny0 Laptop", "Sign In"])(
    "falls back for the look-alike device name %s",
    (name) => {
      expect(sanitizeMachineLabelBase(name, MACHINE_ID)).toBe(
        "machine-abcdef01",
      );
    },
  );

  it("never ends a device label in a hyphen", () => {
    expect(sanitizeMachineLabelBase("studio-box-", MACHINE_ID)).toBe(
      "studio-box",
    );
  });

  it("keeps an ordinary device name", () => {
    expect(sanitizeMachineLabelBase("Sawyer's MacBook", MACHINE_ID)).toBe(
      "sawyer-s-macbook",
    );
  });
});

describe("device label assignment", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it("moves a device off a label that is now reserved, to one the gate routes", () => {
    const owner = h.addUser("alice");
    const device = h.addMachine(owner.id, "codex");

    const label = assignMachineLabel(h.database.db, device.id, "Alice Laptop");

    expect(label).toBe("alice-laptop");
    expect(
      classifyHost(`${label}.relay.test`, {
        baseDomain: "relay.test",
        appUrl: "https://relay.test",
      }).kind,
    ).toBe("tenant");
    expect(
      h.database.sqlite.prepare("SELECT label FROM relay_retired_label").all(),
    ).toEqual([{ label: "codex" }]);
  });

  it("gives a short-named host the same fallback label each time it pairs again, so re-pairing never reaches the account's label limit", () => {
    const owner = h.addUser("alice");
    const labels = new Set<string>();

    for (
      let pairing = 0;
      pairing <= RELAY_LABEL_LIMIT_PER_ACCOUNT;
      pairing += 1
    ) {
      const device = h.addMachine(owner.id, null);
      const label = assignMachineLabel(h.database.db, device.id, "mac");

      if (label === null) throw new Error("no label assigned");
      labels.add(label);
      h.database.db.delete(machine).where(eq(machine.id, device.id)).run();
    }

    expect(labels.size).toBe(1);
    expect([...labels][0]).toMatch(/^machine-[a-f0-9]{8}$/u);
  });

  it("gives a device with a sign-in word in its name a fallback label, and a second one the same fallback with an ordinal", () => {
    const owner = h.addUser("alice");
    const name = `${"a".repeat(HANDLE_MAX_LENGTH - "-loginxy".length)}-loginxy`;
    const first = h.addMachine(owner.id, null);
    const second = h.addMachine(owner.id, null);

    const firstLabel = assignMachineLabel(h.database.db, first.id, name);
    const secondLabel = assignMachineLabel(h.database.db, second.id, name);

    expect(firstLabel).toMatch(/^machine-[a-f0-9]{8}$/u);
    expect(secondLabel).toBe(`${firstLabel}-2`);
  });

  it("gives a newcomer its fallback label when other accounts hold a common host name and its first hundred suffixes", () => {
    for (let ordinal = 1; ordinal <= 100; ordinal += 1) {
      const label = ordinal === 1 ? "ubuntu" : `ubuntu-${ordinal}`;
      const holder = h.addUser(`holder-${ordinal}`);
      h.addMachine(holder.id, label);
    }

    const newcomer = h.addUser("newcomer");
    const device = h.addMachine(newcomer.id, null);

    const label = assignMachineLabel(h.database.db, device.id, "ubuntu");

    expect(label).toBe(fallbackLabel(fallbackSeedFor(newcomer.id)));
    expect(routableLabel(label ?? "")).toBe(true);
  });

  it("gives a newcomer its fallback label when other accounts retired a common host name and its first hundred suffixes", () => {
    const squatter = h.addUser("squatter");

    const retire = h.database.sqlite.prepare(
      "INSERT INTO relay_retired_label (label, kind, github_id, user_id, retired_at) VALUES (?, 'machine', NULL, ?, 0)",
    );

    for (let ordinal = 1; ordinal <= 100; ordinal += 1) {
      retire.run(
        ordinal === 1 ? "raspberrypi" : `raspberrypi-${ordinal}`,
        squatter.id,
      );
    }

    const newcomer = h.addUser("newcomer");
    const device = h.addMachine(newcomer.id, null);

    expect(assignMachineLabel(h.database.db, device.id, "raspberrypi")).toBe(
      fallbackLabel(fallbackSeedFor(newcomer.id)),
    );
  });

  it("treats every relay-generated fallback label as routable, even when the look-alike rule flags its hex", () => {
    expect(isClaimableRelayLabel("machine-da7deb2d")).toBe(false);
    expect(routableLabel("machine-da7deb2d")).toBe(true);
    expect(routableLabel("machine-da7deb2d-2")).toBe(true);
    expect(routableLabel("machine-google")).toBe(false);
    expect(routableLabel("machine-da7deb2d-x")).toBe(false);

    let unroutable = 0;

    for (let index = 0; index < 60_000; index += 1) {
      const label = fallbackLabel(sha256HexOf(`seed-${index}`));

      if (!routableLabel(label)) unroutable += 1;
    }

    expect(unroutable).toBe(0);
  });

  it("assigns the fallback label to a device whose account hashes to a hex the look-alike rule flags, instead of looping", () => {
    let flaggedId: string | null = null;

    for (let index = 0; index < 60_000 && flaggedId === null; index += 1) {
      const id = `flagged-${index}`;

      if (!isClaimableRelayLabel(fallbackLabel(fallbackSeedFor(id)))) {
        flaggedId = id;
      }
    }

    if (flaggedId === null) throw new Error("no flagged fallback found");
    const at = new Date(h.clock.now());

    h.database.db
      .insert(user)
      .values({
        id: flaggedId,
        name: "flagged",
        email: "flagged@example.test",
        emailVerified: true,
        image: null,
        githubLogin: "flagged",
        createdAt: at,
        updatedAt: at,
      })
      .run();
    const device = h.addMachine(flaggedId, null);

    const label = assignMachineLabel(h.database.db, device.id, "1234");

    expect(label).toBe(fallbackLabel(fallbackSeedFor(flaggedId)));
    expect(isClaimableRelayLabel(label ?? "")).toBe(false);
  });

  it("keeps one account's retired device addresses bounded when it pairs and revokes devices under ever new names", () => {
    const owner = h.addUser("cycler");

    const cycle = (name: string) => {
      const device = h.addMachine(owner.id, null);
      const label = assignMachineLabel(h.database.db, device.id, name);
      h.database.db
        .update(machine)
        .set({ subdomain: null, revokedAt: new Date(h.clock.now()) })
        .where(eq(machine.id, device.id))
        .run();

      return label;
    };

    for (let index = 0; index < 60; index += 1) {
      expect(cycle(String(10_000 + index))).toBe(
        fallbackLabel(fallbackSeedFor(owner.id)),
      );
    }

    for (let index = 0; index < 60; index += 1) {
      cycle(`machine-0123abcd-shop-${index}`);
    }

    expect(sanitizeMachineLabelBase("machine-0123abcd", "seed")).toBe(
      fallbackLabel("seed"),
    );

    const retired = h.database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM relay_retired_label WHERE user_id = ?",
      )
      .get(owner.id) as { count: number };

    expect(retired.count).toBeLessThanOrEqual(
      RELAY_LABEL_LIMIT_PER_ACCOUNT + 1,
    );
  });
});
