import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { HOST_ID_FILE_NAME } from "@omnyo/host-daemon-contract";
import { maintenanceStatusSchema } from "@omnyo/server-contract";
import { createTestAppHarness } from "../helpers/test-app.js";

async function fixture(errors: Array<{ name: string; message: string }>) {
  const source = "https://bb.alexburlis.com";
  const destination = "https://app.omnyohq.com";

  const dataDir = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-origin-route-")),
  );

  const harness = await createTestAppHarness({
    dataDir,
    appUrl: source,
    seedFirstPartyProviders: false,
  });

  harness.deps.logger.error = (...args: unknown[]) => {
    const fields = args[0];

    if (
      fields !== null &&
      typeof fields === "object" &&
      "err" in fields &&
      fields.err instanceof Error
    )
      errors.push({ name: fields.err.name, message: fields.err.message });
  };

  await writeFile(
    join(harness.config.dataDir, HOST_ID_FILE_NAME),
    "host-origin-fixture",
  );

  async function post(
    origin: string,
    path: string,
    value: unknown,
    extra: Record<string, string> = {},
  ) {
    return harness.app.request(`${origin}/api/v1/server/maintenance/${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...extra },
      body: JSON.stringify(value),
    });
  }

  const statusResponse = await harness.app.request(
    `${source}/api/v1/server/maintenance`,
  );

  expect(statusResponse.status).toBe(200);
  const status = maintenanceStatusSchema.parse(await statusResponse.json());

  const ticket = {
    version: 1,
    adoptionId: "origin-route-hold",
    id: "a".repeat(64),
    selectedIds: ["a".repeat(64)],
    nonce: "b".repeat(64),
    fromOrigin: source,
    toOrigin: destination,
  };

  const preparation = {
    ticket,
    holdId: ticket.adoptionId,
    ownerId: "origin-owner",
    expectedRuntimeId: status.runtime.runtimeId,
    expectedServerHostId: "host-origin-fixture",
  };

  const hold = {
    id: ticket.adoptionId,
    ownerId: preparation.ownerId,
    expectedRuntimeId: preparation.expectedRuntimeId,
    expectedServerHostId: preparation.expectedServerHostId,
    expectedDataDir: harness.config.dataDir,
  };

  return {
    ...harness,
    source,
    destination,
    ticket,
    preparation,
    hold,
    post,
    async cleanup() {
      try {
        await harness.cleanup();
      } finally {
        harness.db.$client.close();
        await rm(dataDir, { recursive: true });
      }
    },
  };
}

test("preserves machine, authorization, origin and nonce denial through the actual maintenance routes", async () => {
  const errors: Array<{ name: string; message: string }> = [];
  expect(errors, "The server emitted an unexpected boundary error").toEqual([]);
  const f = await fixture(errors);

  try {
    expect(
      (await f.post(f.source, "origin-adoption-v1/prepare", f.preparation))
        .status,
    ).toBe(409);
    expect((await f.post(f.source, "acquire", f.hold)).status).toBe(200);
    expect(
      (
        await f.post(f.source, "origin-adoption-v1/prepare", f.preparation, {
          "x-omnyo-gate-auth": "machine",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.post(f.source, "origin-adoption-v1/prepare", f.preparation, {
          authorization: "fixture",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.post(f.source, "origin-adoption-v1/prepare", f.preparation, {
          origin: "https://foreign.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (await f.post(f.source, "origin-adoption-v1/prepare", f.preparation))
        .status,
    ).toBe(200);

    const denied = await f.post(f.source, "origin-adoption-v1/check", {
      ticket: { ...f.ticket, nonce: "c".repeat(64) },
      action: "check",
      payloadSha256: null,
    });

    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "origin_adoption_auth" });
    expect(
      (
        await f.post(f.source, "origin-adoption-v1/check", {
          ticket: f.ticket,
          action: "check",
          payloadSha256: null,
        })
      ).status,
    ).toBe(200);
  } finally {
    await f.cleanup();
  }
});

test("admits only the held exact new-host migration control and keeps ordinary APIs and foreign origins closed", async () => {
  const errors: Array<{ name: string; message: string }> = [];
  expect(errors, "The server emitted an unexpected boundary error").toEqual([]);
  const f = await fixture(errors);

  try {
    const body = { ticket: f.ticket, action: "check", payloadSha256: null };
    expect(
      (await f.post(f.destination, "origin-adoption-v1/check", body)).status,
    ).toBe(403);
    expect((await f.post(f.source, "acquire", f.hold)).status).toBe(200);
    expect(
      (await f.post(f.source, "origin-adoption-v1/prepare", f.preparation))
        .status,
    ).toBe(200);

    const admitted = await f.post(
      f.destination,
      "origin-adoption-v1/check",
      body,
    );

    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toMatchObject({
      authorized: true,
      phase: "prepared",
      adoptionAccepted: false,
    });
    expect(
      (
        await f.app.request(`${f.destination}/api/v1/threads`, {
          method: "POST",
          headers: {
            origin: f.destination,
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.post(f.destination, "origin-adoption-v1/check", body, {
          origin: f.source,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.post(f.destination, "origin-adoption-v1/check", body, {
          authorization: "fixture",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.post(f.destination, "origin-adoption-v1/check", {
          ...body,
          ticket: { ...f.ticket, nonce: "d".repeat(64) },
        })
      ).status,
    ).toBe(403);
  } finally {
    await f.cleanup();
  }
});
