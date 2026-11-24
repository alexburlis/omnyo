import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";

import { registerUpdatesCommands } from "../../commands/updates.js";

setupCommandOutputTestEnvironment();

const register = (program: Parameters<typeof registerUpdatesCommands>[0]) =>
  registerUpdatesCommands(program, () => "http://omnyo.test");

it("uploads checked bytes before activation and closes the session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnyo-web-cli-"));

  try {
    const html = "<!doctype html><p>new interface</p>";

    const paths = [
      "index.html",
      "one.html",
      "two.html",
      "three.html",
      "four.html",
    ];

    const build = {
      schema: 1,
      sourceCommit: "a".repeat(40),
      compatibilityHash: "b".repeat(64),
      files: paths.map((path) => ({
        path,
        size: Buffer.byteLength(html),
        sha256: createHash("sha256").update(html).digest("hex"),
      })),
    };

    await Promise.all(
      paths.map((path) => writeFile(join(directory, path), html)),
    );
    await writeFile(join(directory, "web-build.json"), JSON.stringify(build));
    const effects: string[] = [];
    let activeUploads = 0;
    let peakUploads = 0;
    stubServerApi({
      "v1.system.web-update.$get": vi.fn(async () => ({
        supported: true,
        compatibilityHash: build.compatibilityHash,
        active: null,
        previous: null,
        inactiveReason: null,
      })),
      "v1.system.web-update.begin.$post": vi.fn(async () => {
        effects.push("begin");

        return { uploadId: "00000000-0000-4000-8000-000000000000" };
      }),
      "v1.system.web-update.upload.$post": vi.fn(async (request) => {
        effects.push("upload");
        activeUploads++;
        peakUploads = Math.max(peakUploads, activeUploads);
        expect(Buffer.from(request.json.content, "base64").toString()).toBe(
          html,
        );

        await new Promise((resolve) => setTimeout(resolve, 10));
        activeUploads--;

        return { ok: true };
      }),
      "v1.system.web-update.apply.$post": vi.fn(async () => {
        expect(activeUploads).toBe(0);
        effects.push("apply");

        return {
          supported: true,
          compatibilityHash: build.compatibilityHash,
          active: { id: "c".repeat(64), sourceCommit: build.sourceCommit },
          previous: null,
          inactiveReason: null,
        };
      }),
      "v1.system.web-update.abort.$post": vi.fn(async () => {
        effects.push("abort");

        return { ok: true };
      }),
    });
    await runCommand(
      ["updates", "web", "apply", "--directory", directory],
      register,
    );
    expect(effects).toEqual([
      "begin",
      ...paths.map(() => "upload"),
      "apply",
      "abort",
    ]);
    expect(peakUploads).toBe(4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses changed bytes and drains other uploads before aborting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnyo-web-cli-"));

  try {
    const build = {
      schema: 1,
      sourceCommit: "a".repeat(40),
      compatibilityHash: "b".repeat(64),
      files: [
        { path: "index.html", size: 1, sha256: "d".repeat(64) },
        {
          path: "valid.html",
          size: 5,
          sha256: createHash("sha256").update("valid").digest("hex"),
        },
      ],
    };

    await writeFile(join(directory, "index.html"), "changed");
    await writeFile(join(directory, "valid.html"), "valid");
    await writeFile(join(directory, "web-build.json"), JSON.stringify(build));
    let activeUploads = 0;

    const upload = vi.fn(async (request) => {
      expect(request.json.path).toBe("valid.html");
      activeUploads++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeUploads--;

      return { ok: true };
    });

    const apply = vi.fn();

    const abort = vi.fn(async () => {
      expect(activeUploads).toBe(0);

      return { ok: true };
    });

    stubServerApi({
      "v1.system.web-update.$get": vi.fn(async () => ({
        supported: true,
        compatibilityHash: build.compatibilityHash,
        active: null,
        previous: null,
        inactiveReason: null,
      })),
      "v1.system.web-update.begin.$post": vi.fn(async () => ({
        uploadId: "00000000-0000-4000-8000-000000000000",
      })),
      "v1.system.web-update.upload.$post": upload,
      "v1.system.web-update.apply.$post": apply,
      "v1.system.web-update.abort.$post": abort,
    });
    await expect(
      runCommand(
        ["updates", "web", "apply", "--directory", directory],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(upload).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const activeGeneration = { id: "c".repeat(64), sourceCommit: "a".repeat(40) };

const webStatus = (active: typeof activeGeneration | null) => ({
  supported: true,
  packagedSourceCommit: "e".repeat(40),
  compatibilityHash: "b".repeat(64),
  active,
  previous: null,
  inactiveReason: null,
});

it("requires a named generation before rolling back an active one", async () => {
  const rollback = vi.fn(async () => webStatus(null));
  stubServerApi({
    "v1.system.web-update.$get": vi.fn(async () => webStatus(activeGeneration)),
    "v1.system.web-update.rollback.$post": rollback,
  });
  await expect(
    runCommand(["updates", "web", "rollback"], register),
  ).rejects.toThrow("process.exit:1");
  expect(rollback).not.toHaveBeenCalled();
});

it.each([
  [activeGeneration, activeGeneration.id, activeGeneration.id],
  [activeGeneration, "d".repeat(64), "d".repeat(64)],
  [null, "packaged", null],
  [null, undefined, null],
])(
  "sends the named rollback target as expectedActive",
  async (active, flag, expected) => {
    const rollback = vi.fn(async () => webStatus(null));
    stubServerApi({
      "v1.system.web-update.$get": vi.fn(async () => webStatus(active)),
      "v1.system.web-update.rollback.$post": rollback,
    });
    await runCommand(
      [
        "updates",
        "web",
        "rollback",
        ...(flag === undefined ? [] : ["--replace-active", flag]),
      ],
      register,
    );
    expect(rollback.mock.calls[0]).toMatchObject([
      { json: { expectedActive: expected } },
    ]);
  },
);

it("refuses to replace an active generation until it is named", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnyo-web-cli-"));

  try {
    const html = "<!doctype html>";

    const build = {
      schema: 1,
      sourceCommit: "f".repeat(40),
      compatibilityHash: "b".repeat(64),
      files: [
        {
          path: "index.html",
          size: Buffer.byteLength(html),
          sha256: createHash("sha256").update(html).digest("hex"),
        },
      ],
    };

    await writeFile(join(directory, "index.html"), html);
    await writeFile(join(directory, "web-build.json"), JSON.stringify(build));

    const begin = vi.fn(async () => ({
      uploadId: "00000000-0000-4000-8000-000000000000",
    }));

    const apply = vi.fn(async () => webStatus(activeGeneration));
    stubServerApi({
      "v1.system.web-update.$get": vi.fn(async () =>
        webStatus(activeGeneration),
      ),
      "v1.system.web-update.begin.$post": begin,
      "v1.system.web-update.upload.$post": vi.fn(async () => ({ ok: true })),
      "v1.system.web-update.apply.$post": apply,
      "v1.system.web-update.abort.$post": vi.fn(async () => ({ ok: true })),
    });
    await expect(
      runCommand(
        ["updates", "web", "apply", "--directory", directory],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(begin).not.toHaveBeenCalled();

    await runCommand(
      [
        "updates",
        "web",
        "apply",
        "--directory",
        directory,
        "--replace-active",
        activeGeneration.id,
      ],
      register,
    );
    expect(begin.mock.calls[0]).toMatchObject([
      { json: { expectedActive: activeGeneration.id } },
    ]);
    expect(apply.mock.calls[0]).toMatchObject([
      { json: { expectedActive: activeGeneration.id } },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
