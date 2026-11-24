import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SecretVaultError } from "../src/errors.js";
import { createKeyFileKeyStore } from "../src/key-stores/key-file.js";
import { createMacosKeychainKeyStore } from "../src/key-stores/macos-keychain.js";
import {
  runProcess,
  type ProcessRequest,
  type ProcessResult,
} from "../src/key-stores/process-runner.js";
import {
  createWindowsDpapiKeyStore,
  detectWindowsDpapiScope,
} from "../src/key-stores/windows-dpapi.js";
import { modeOf, posixModes, trackTempDirs } from "./helpers.js";

const makeTempDir = trackTempDirs();

const vaultId = "0123456789abcdef0123456789abcdef";

function scriptedRunner(
  respond: (request: ProcessRequest) => Partial<ProcessResult>,
) {
  const requests: ProcessRequest[] = [];

  const run = async (request: ProcessRequest): Promise<ProcessResult> => {
    requests.push(request);

    return { exitCode: 0, stdout: "", stderr: "", ...respond(request) };
  };

  return { run, requests };
}

async function rejection(promise: Promise<unknown>): Promise<SecretVaultError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(SecretVaultError);

  return error as SecretVaultError;
}

describe("key store child processes", () => {
  it("kills a child that outlives its timeout and reports key_unavailable", async () => {
    const started = Date.now();

    const store = createMacosKeychainKeyStore({
      timeoutMs: 200,
      run: (request) =>
        runProcess({
          ...request,
          executable: process.execPath,
          args: ["-e", "setTimeout(() => {}, 10000)"],
        }),
    });

    const error = await rejection(store.load(vaultId));

    expect(error.code).toBe("key_unavailable");
    expect(error.message).toContain("did not finish within 200 ms");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("macOS Keychain key store", () => {
  it("passes the key on stdin only and refuses to overwrite an item", async () => {
    const key = randomBytes(32);
    const { run, requests } = scriptedRunner(() => ({}));

    await createMacosKeychainKeyStore({ run }).store(vaultId, key);

    const [request] = requests;
    expect(request?.executable).toBe("/usr/bin/security");
    expect(request?.args).toEqual(["-i"]);
    expect(request?.args.join(" ")).not.toContain(key.toString("hex"));
    expect(request?.stdin).toBe(
      `add-generic-password -s app.omnyo.vault -a ${vaultId} -l "Omnyo secret vault" -w ${key.toString("hex")}\n`,
    );
    expect(request?.stdin).not.toContain(" -U");
  });

  it("maps a failed store to key_unavailable", async () => {
    const { run } = scriptedRunner(() => ({
      exitCode: 45,
      stderr: "The specified item already exists in the keychain.",
    }));

    const error = await rejection(
      createMacosKeychainKeyStore({ run }).store(vaultId, randomBytes(32)),
    );

    expect(error.code).toBe("key_unavailable");
    expect(error.message).toContain("already exists");
  });

  it("loads the key with an argv that names only the service and account", async () => {
    const key = randomBytes(32);

    const { run, requests } = scriptedRunner(() => ({
      stdout: `${key.toString("hex")}\n`,
    }));

    expect(await createMacosKeychainKeyStore({ run }).load(vaultId)).toEqual(
      key,
    );
    expect(requests[0]?.args).toEqual([
      "find-generic-password",
      "-s",
      "app.omnyo.vault",
      "-a",
      vaultId,
      "-w",
    ]);
  });

  it("maps exit 44 to key_missing and other failures to key_unavailable", async () => {
    const missing = await rejection(
      createMacosKeychainKeyStore({
        run: scriptedRunner(() => ({ exitCode: 44 })).run,
      }).load(vaultId),
    );

    const denied = await rejection(
      createMacosKeychainKeyStore({
        run: scriptedRunner(() => ({
          exitCode: 51,
          stderr: "User interaction is not allowed.",
        })).run,
      }).load(vaultId),
    );

    const timedOut = await rejection(
      createMacosKeychainKeyStore({
        run: scriptedRunner(() => ({ exitCode: null, stderr: "timed out" }))
          .run,
      }).load(vaultId),
    );

    expect(missing.code).toBe("key_missing");
    expect(denied.code).toBe("key_unavailable");
    expect(denied.message).toContain("User interaction is not allowed");
    expect(timedOut.code).toBe("key_unavailable");
  });

  it("rejects a malformed key without echoing what the Keychain returned", async () => {
    const error = await rejection(
      createMacosKeychainKeyStore({
        run: scriptedRunner(() => ({ stdout: "not-a-hex-key-value\n" })).run,
      }).load(vaultId),
    );

    expect(error.code).toBe("key_unavailable");
    expect(error.message).not.toContain("not-a-hex-key-value");
  });

  it("treats a missing item as already removed", async () => {
    const { run, requests } = scriptedRunner(() => ({ exitCode: 44 }));

    await createMacosKeychainKeyStore({ run }).remove(vaultId);

    expect(requests[0]?.args).toEqual([
      "delete-generic-password",
      "-s",
      "app.omnyo.vault",
      "-a",
      vaultId,
    ]);

    const error = await rejection(
      createMacosKeychainKeyStore({
        run: scriptedRunner(() => ({ exitCode: 1 })).run,
      }).remove(vaultId),
    );

    expect(error.code).toBe("key_unavailable");
  });
});

function decodedScript(request: ProcessRequest): string {
  return Buffer.from(request.args[3] ?? "", "base64").toString("utf16le");
}

function fakeDpapi() {
  return scriptedRunner((request) => {
    const input = JSON.parse(request.stdin) as {
      operation: string;
      data: string;
    };

    const data = Buffer.from(input.data, "base64");

    const transformed =
      input.operation === "protect"
        ? Buffer.concat([Buffer.from("blob:"), data.reverse()])
        : data.subarray(5).reverse();

    return { stdout: `${transformed.toString("base64")}\r\n` };
  });
}

const windowsEnv = { SystemRoot: "C:\\Windows" };

describe("Windows DPAPI key store", () => {
  it("protects in machine scope with the vault id as entropy and keeps the key off argv", async () => {
    const dataDir = await makeTempDir();
    const key = randomBytes(32);
    const { run, requests } = fakeDpapi();

    const store = createWindowsDpapiKeyStore(dataDir, "machine", {
      run,
      env: windowsEnv,
    });

    await store.store(vaultId, key);
    expect(await store.load(vaultId)).toEqual(key);

    const [protect, unprotect] = requests;
    expect(protect?.executable).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(protect?.args.slice(0, 3)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(protect?.args).toHaveLength(4);
    expect(protect?.args.join(" ")).not.toContain(key.toString("base64"));
    expect(decodedScript(protect as ProcessRequest)).toContain(
      "ProtectedData]::Protect",
    );
    expect(unprotect?.args).toEqual(protect?.args);
    expect(JSON.parse(protect?.stdin ?? "")).toEqual({
      operation: "protect",
      scope: "LocalMachine",
      entropy: vaultId,
      data: key.toString("base64"),
    });

    const blobPath = path.join(dataDir, "vault", `key-${vaultId}.dpapi`);
    const blob = await readFile(blobPath, "utf8");
    expect(blob).not.toContain(key.toString("base64"));
    expect(Buffer.from(blob, "base64").subarray(0, 5).toString()).toBe("blob:");

    if (posixModes) expect(await modeOf(blobPath)).toBe(0o600);
  });

  it("uses CurrentUser scope without entropy for user scope", async () => {
    const { run, requests } = fakeDpapi();

    await createWindowsDpapiKeyStore(await makeTempDir(), "user", {
      run,
      env: windowsEnv,
    }).store(vaultId, randomBytes(32));

    expect(JSON.parse(requests[0]?.stdin ?? "")).toMatchObject({
      scope: "CurrentUser",
      entropy: "",
    });
  });

  it("maps a missing blob to key_missing and a PowerShell failure to key_unavailable", async () => {
    const dataDir = await makeTempDir();

    const failing = scriptedRunner(() => ({
      exitCode: 1,
      stderr:
        "System.Security.Cryptography.CryptographicException: Access is denied.",
    }));

    const store = createWindowsDpapiKeyStore(dataDir, "user", {
      run: failing.run,
      env: windowsEnv,
    });

    expect((await rejection(store.load(vaultId))).code).toBe("key_missing");
    expect(failing.requests).toHaveLength(0);

    await mkdir(path.join(dataDir, "vault"));
    await writeFile(
      path.join(dataDir, "vault", `key-${vaultId}.dpapi`),
      "AAAA",
    );
    const denied = await rejection(store.load(vaultId));

    expect(denied.code).toBe("key_unavailable");
    expect(denied.message).toContain("Access is denied");
    expect((await rejection(store.store(vaultId, randomBytes(32)))).code).toBe(
      "key_unavailable",
    );
  });

  it("rejects a key of the wrong length and a missing SystemRoot", async () => {
    const dataDir = await makeTempDir();
    await mkdir(path.join(dataDir, "vault"));
    await writeFile(
      path.join(dataDir, "vault", `key-${vaultId}.dpapi`),
      "AAAA",
    );

    const short = createWindowsDpapiKeyStore(dataDir, "user", {
      run: scriptedRunner(() => ({ stdout: "AAAA" })).run,
      env: windowsEnv,
    });

    const noRoot = createWindowsDpapiKeyStore(dataDir, "user", {
      run: scriptedRunner(() => ({})).run,
      env: {},
    });

    expect((await rejection(short.load(vaultId))).code).toBe("key_unavailable");
    expect((await rejection(noRoot.load(vaultId))).code).toBe(
      "key_unavailable",
    );
  });
});

describe("detectWindowsDpapiScope", () => {
  it("reads the scope the detection script reports", async () => {
    const machine = scriptedRunner(() => ({ stdout: "machine\r\n" }));
    const user = scriptedRunner(() => ({ stdout: "user" }));

    expect(
      await detectWindowsDpapiScope({ run: machine.run, env: windowsEnv }),
    ).toBe("machine");
    expect(
      await detectWindowsDpapiScope({ run: user.run, env: windowsEnv }),
    ).toBe("user");

    const script = decodedScript(machine.requests[0] as ProcessRequest);
    expect(script).toContain("S-1-5-3");
    expect(script).toContain("S-1-5-6");
  });

  it("refuses unexpected output and failed detection", async () => {
    const odd = scriptedRunner(() => ({ stdout: "admin" }));
    const failed = scriptedRunner(() => ({ exitCode: 1, stderr: "boom" }));

    expect(
      (
        await rejection(
          detectWindowsDpapiScope({ run: odd.run, env: windowsEnv }),
        )
      ).code,
    ).toBe("key_unavailable");
    expect(
      (
        await rejection(
          detectWindowsDpapiScope({ run: failed.run, env: windowsEnv }),
        )
      ).code,
    ).toBe("key_unavailable");
  });
});

describe("key file store", () => {
  it("stores a private hex key once and loads it back", async () => {
    const dataDir = await makeTempDir();
    const key = randomBytes(32);
    const store = createKeyFileKeyStore(dataDir);
    const keyPath = path.join(dataDir, "vault", `key-${vaultId}`);

    await store.store(vaultId, key);

    expect(await readFile(keyPath, "utf8")).toBe(key.toString("hex"));
    expect(await store.load(vaultId)).toEqual(key);
    expect((await rejection(store.store(vaultId, randomBytes(32)))).code).toBe(
      "key_unavailable",
    );
    expect(await store.load(vaultId)).toEqual(key);

    if (posixModes) expect(await modeOf(keyPath)).toBe(0o600);

    await store.remove(vaultId);
    expect((await rejection(store.load(vaultId))).code).toBe("key_missing");
  });

  it("rejects a key file that does not hold a key", async () => {
    const dataDir = await makeTempDir();
    await mkdir(path.join(dataDir, "vault"));
    await writeFile(path.join(dataDir, "vault", `key-${vaultId}`), "short");

    expect(
      (await rejection(createKeyFileKeyStore(dataDir).load(vaultId))).code,
    ).toBe("key_unavailable");
  });
});
