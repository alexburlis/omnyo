import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_ARTIFACT_SIGNING_PUBLIC_KEYS,
  hostArtifactSignatureMessage,
} from "@omnyo/host-daemon-contract/host-artifact-signature";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTALL_MACHINE_WINDOWS_SCRIPT_PATH } from "../../src/install-machine-asset.js";
import { withTestHarness } from "../helpers/test-app.js";

interface WindowsInstallerOptions {
  action: "run" | "start" | "stop" | "uninstall" | "repair-runtime" | null;
  bootstrapEnv: string | null;
  dataDir: string | null;
  hostDaemonPort: string | null;
  hostId: string | null;
}

interface WindowsInstallerBootstrap {
  dataDir: string | null;
  headers: Record<string, string>;
  hostId: string;
  reconnect: boolean;
  serverUrl: string;
}

interface WindowsProcessEntry {
  pid: number;
  ppid: number;
  created: number;
  name: string;
  executablePath: string;
  commandLine: string;
}

interface SignedServerArtifact {
  version: string;
  protocolVersion: number;
  artifactDigest: string;
  artifactSignature?: string | null;
  artifactSignatureKeyId?: string | null;
}

interface WindowsInstallerModule {
  HOST_ARTIFACT_SIGNING_PUBLIC_KEYS: readonly string[];
  verifyServerArtifactSignature(
    target: SignedServerArtifact,
    keys?: readonly string[],
  ): boolean;
  downloadServerArtifact(
    serverUrl: string,
    headers: Record<string, string>,
    signingKeys?: readonly string[],
  ): Promise<unknown>;
  readMachineHeaders(dataDir: string): Record<string, string>;
  installerTreeSurvivors(
    processes: WindowsProcessEntry[],
    window: { rootPid: number; startedAt: number; markers: RegExp[] },
  ): WindowsProcessEntry[];
  legacyProfileRemoval(dataDir: string, hostId: string): string | null;
  packageRoot(npmPrefix: string): string;
  repairedWorkerAdmitsCommands(status: unknown, version: string): boolean;
  parseArguments(argv: string[]): WindowsInstallerOptions;
  parseBootstrap(raw: string): WindowsInstallerBootstrap;
  serviceName(serverUrl: string, hostId: string): string;
  startupCommand(args: {
    dataDir: string;
    hostId: string;
    nodePath: string;
  }): string;
}

async function loadInstaller(): Promise<WindowsInstallerModule> {
  const module: WindowsInstallerModule = await import(
    new URL("../../src/assets/install-machine-windows.mjs", import.meta.url)
      .href
  );

  return module;
}

function releaseKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);

  const field = (value: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);

    return Buffer.concat([length, value]);
  };

  const blob = Buffer.concat([
    field(Buffer.from("ssh-ed25519")),
    field(Buffer.from(raw)),
  ]);

  return {
    line: `ssh-ed25519 ${blob.toString("base64")}`,
    keyId: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    signTarget: (subject: {
      version: string;
      protocolVersion: number;
      artifactDigest: string;
    }) =>
      sign(
        null,
        Buffer.from(
          hostArtifactSignatureMessage({
            version: subject.version,
            protocolVersion: subject.protocolVersion,
            digest: subject.artifactDigest,
          }),
        ),
        privateKey,
      ).toString("base64"),
  };
}

describe("Windows machine installer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the machine credential headers from config.json", async () => {
    const { readMachineHeaders } = await loadInstaller();
    const dataDir = mkdtempSync(join(tmpdir(), "omnyo-win-headers-"));

    try {
      const write = (config: unknown) =>
        writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));

      write({ serverHeaders: { "x-omnyo-connect-machine": "a" } });
      expect(readMachineHeaders(dataDir)).toEqual({
        "x-omnyo-connect-machine": "a",
      });
      write({ machineCredential: "legacy" });
      expect(readMachineHeaders(dataDir)).toEqual({
        "x-omnyo-connect-machine": "legacy",
      });
      write({});
      expect(readMachineHeaders(dataDir)).toEqual({});
      write({ serverHeaders: { x: 1 } });
      expect(() => readMachineHeaders(dataDir)).toThrow(/invalid/u);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("sends the machine credential without following redirects when repairing the runtime", async () => {
    const { downloadServerArtifact } = await loadInstaller();
    const key = releaseKey();

    const subject = {
      version: "1.0.0+private.1",
      protocolVersion: 1,
      artifactDigest: "a".repeat(64),
    };

    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/install/version")
        ? Response.json({
            ...subject,
            artifactSignature: key.signTarget(subject),
            artifactSignatureKeyId: key.keyId,
          })
        : new Response("denied", { status: 403 }),
    );

    vi.stubGlobal("fetch", fetchMock);
    const headers = { "x-omnyo-connect-machine": "machine-credential" };

    await expect(
      downloadServerArtifact("https://coordinator.example", headers, [
        key.line,
      ]),
    ).rejects.toThrow(/refused this machine's access/u);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://coordinator.example/install/version",
      "https://coordinator.example/install/omnyo-app.tgz",
    ]);

    for (const [, init] of fetchMock.mock.calls as unknown as [
      string,
      RequestInit,
    ][]) {
      expect(init.headers).toEqual(headers);
      expect(init.redirect).toBe("error");
    }
  });

  it("verifies the runtime signature against the supplied release keys", async () => {
    const { verifyServerArtifactSignature } = await loadInstaller();
    const key = releaseKey();
    const other = releaseKey();

    const subject = {
      version: "1.0.0+private.1",
      protocolVersion: 3,
      artifactDigest: "b".repeat(64),
    };

    const signed = {
      ...subject,
      artifactSignature: key.signTarget(subject),
      artifactSignatureKeyId: key.keyId,
    };

    expect(verifyServerArtifactSignature(signed, [key.line])).toBe(true);
    expect(verifyServerArtifactSignature(signed, [other.line, key.line])).toBe(
      true,
    );
    expect(verifyServerArtifactSignature(signed, [other.line])).toBe(false);
    expect(verifyServerArtifactSignature(signed)).toBe(false);

    const refused = [
      { ...signed, artifactSignature: null },
      { ...subject, artifactSignatureKeyId: key.keyId },
      { ...signed, artifactSignatureKeyId: null },
      { ...signed, artifactSignatureKeyId: other.keyId },
      { ...signed, artifactDigest: "c".repeat(64) },
      { ...signed, version: "1.0.1+private.1" },
      { ...signed, protocolVersion: 4 },
      { ...signed, artifactSignature: other.signTarget(subject) },
    ];

    for (const target of refused)
      expect(verifyServerArtifactSignature(target, [key.line])).toBe(false);
  });

  it("refuses a runtime the release key did not sign before downloading it", async () => {
    const { downloadServerArtifact } = await loadInstaller();
    const key = releaseKey();

    const subject = {
      version: "1.0.0+private.1",
      protocolVersion: 1,
      artifactDigest: "a".repeat(64),
    };

    for (const target of [
      subject,
      {
        ...subject,
        artifactSignature: key.signTarget({
          ...subject,
          artifactDigest: "d".repeat(64),
        }),
        artifactSignatureKeyId: key.keyId,
      },
    ]) {
      const fetchMock = vi.fn(async () => Response.json(target));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        downloadServerArtifact("https://coordinator.example", {}, [key.line]),
      ).rejects.toThrow(/not signed by the Omnyo release key/u);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("embeds the same pinned release keys as the host daemon contract", async () => {
    const installer = await loadInstaller();

    expect(installer.HOST_ARTIFACT_SIGNING_PUBLIC_KEYS).toEqual([
      ...HOST_ARTIFACT_SIGNING_PUBLIC_KEYS,
    ]);
  });

  it("reports a refused version request as refused access", async () => {
    const { downloadServerArtifact } = await loadInstaller();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 })),
    );

    await expect(
      downloadServerArtifact("https://coordinator.example", {}),
    ).rejects.toThrow(/refused this machine's access/u);
  });

  it("contains no line that would end the PowerShell here-string it is served in", () => {
    const source = readFileSync(INSTALL_MACHINE_WINDOWS_SCRIPT_PATH, "utf8");
    expect(/^'@/mu.test(source)).toBe(false);
  });

  it("accepts an install or one lifecycle action and refuses mixed arguments", async () => {
    const { parseArguments } = await loadInstaller();
    expect(
      parseArguments(["--bootstrap-env", "OMNYO_ENROLLMENT"]),
    ).toMatchObject({
      action: null,
      bootstrapEnv: "OMNYO_ENROLLMENT",
    });
    expect(
      parseArguments(["--uninstall", "--host-id", "host_1"]),
    ).toMatchObject({ action: "uninstall", hostId: "host_1" });
    expect(
      parseArguments(["--repair-runtime", "--host-id", "host_1"]),
    ).toMatchObject({ action: "repair-runtime", hostId: "host_1" });
    expect(() =>
      parseArguments([
        "--repair-runtime",
        "--host-id",
        "host_1",
        "--state-request",
        "request.json",
      ]),
    ).toThrow("Usage:");
    expect(() => parseArguments([])).toThrow("Usage:");
    expect(() => parseArguments(["--start"])).toThrow("Usage:");
    expect(() =>
      parseArguments(["--start", "--stop", "--host-id", "host_1"]),
    ).toThrow("Usage:");
    expect(() =>
      parseArguments(["--bootstrap-env", "OMNYO_ENROLLMENT", "--host-id", "x"]),
    ).toThrow("Usage:");
  });

  it("finds every process an exited installer could have left behind", async () => {
    const { installerTreeSurvivors } = await loadInstaller();

    const entry = (
      pid: number,
      ppid: number,
      created: number,
      commandLine = "",
    ): WindowsProcessEntry => ({
      pid,
      ppid,
      created,
      name: `p${pid}`,
      executablePath: "",
      commandLine,
    });

    const window = {
      rootPid: 50,
      startedAt: 1_000,
      markers: [/update\.tgz/iu],
    };

    const unrelated = [
      entry(4, 0, 0),
      entry(10, 4, 100),
      entry(11, 10, 2_000),
      entry(12, 11, 2_500),
      entry(50, 10, 500),
    ];

    expect(installerTreeSurvivors(unrelated, window)).toEqual([]);
    expect(
      installerTreeSurvivors(
        [entry(4, 0, 0), entry(60, 50, 1_200), entry(61, 60, 1_300)],
        window,
      ).map(({ pid }) => pid),
    ).toEqual([60, 61]);
    expect(
      installerTreeSurvivors(
        [entry(4, 0, 0), entry(70, 71, 1_500), entry(71, 4, 1_900)],
        window,
      ).map(({ pid }) => pid),
    ).toEqual([70]);
    expect(
      installerTreeSurvivors(
        [entry(4, 0, 0), entry(80, 4, 200, "node npm-cli.js C:/x/update.tgz")],
        window,
      ).map(({ pid }) => pid),
    ).toEqual([80]);
    expect(
      installerTreeSurvivors([entry(4, 0, 0), entry(50, 4, 1_100)], window).map(
        ({ pid }) => pid,
      ),
    ).toEqual([50]);
  });

  it("treats a repaired worker as admitted while it is already running work", async () => {
    const { repairedWorkerAdmitsCommands } = await loadInstaller();

    const status = {
      runtimeVersion: "1.0.0+private.1",
      connected: true,
      admission: {
        activity: { commands: 6, pluginHosts: 12 },
        held: false,
        directProbe: false,
        activation: false,
        blockers: ["commands", "pluginHosts"],
      },
      update: { reason: "current" },
    };

    expect(repairedWorkerAdmitsCommands(status, "1.0.0+private.1")).toBe(true);
    expect(repairedWorkerAdmitsCommands(status, "1.0.1+private.1")).toBe(false);
    expect(
      repairedWorkerAdmitsCommands(
        { ...status, admission: { ...status.admission, held: true } },
        "1.0.0+private.1",
      ),
    ).toBe(false);
    expect(
      repairedWorkerAdmitsCommands(
        { ...status, update: { reason: "installer_unverified" } },
        "1.0.0+private.1",
      ),
    ).toBe(false);
    expect(repairedWorkerAdmitsCommands(null, "1.0.0+private.1")).toBe(false);
  });

  it("reads the enrollment bundle and refuses a server URL with credentials", async () => {
    const { parseBootstrap } = await loadInstaller();
    expect(
      parseBootstrap(
        JSON.stringify({
          hostId: "host_1",
          serverUrl: "https://omnyo.example.com/",
          headers: { "x-access": "token", ignored: 1 },
          reconnect: true,
          dataDir: "C:\\Users\\me\\.bb-machines\\omnyo.example.com",
        }),
      ),
    ).toEqual({
      dataDir: "C:\\Users\\me\\.bb-machines\\omnyo.example.com",
      headers: { "x-access": "token" },
      hostId: "host_1",
      reconnect: true,
      serverUrl: "https://omnyo.example.com",
    });
    expect(() =>
      parseBootstrap(
        JSON.stringify({
          hostId: "host_1",
          serverUrl: "https://user:secret@omnyo.example.com",
        }),
      ),
    ).toThrow("invalid server URL");
    expect(() => parseBootstrap("{")).toThrow("not valid JSON");
  });

  it("sends an old profile to its own installer copy for removal", async () => {
    const { legacyProfileRemoval } = await loadInstaller();
    expect(
      legacyProfileRemoval(
        "C:\\Users\\me\\.omnyo-machines\\omnyo.example.com",
        "host_1",
      ),
    ).toBeNull();

    const removal = legacyProfileRemoval(
      "C:\\Users\\me\\.bb-machines\\omnyo.example.com",
      "host_1",
    );

    expect(removal).toContain(".bb-machines");
    expect(removal).toContain("install-machine-windows.mjs");
    expect(removal).toContain("--uninstall --host-id host_1");
  });

  it("installs into the omnyo-app package root", async () => {
    const { packageRoot } = await loadInstaller();
    expect(packageRoot("prefix")).toMatch(/node_modules[/\\]omnyo-app$/u);
  });

  it("names the startup entry after the server and machine", async () => {
    const { serviceName } = await loadInstaller();
    expect(serviceName("http://127.0.0.1:38886", "host_a/b")).toBe(
      "omnyo-host-daemon-127-0-0-1-38886-host_a-b",
    );
  });

  it("starts the daemon at sign-in through a hidden PowerShell with quoted paths", async () => {
    const { startupCommand } = await loadInstaller();

    const command = startupCommand({
      dataDir: "C:\\Users\\O'Brien\\.omnyo-machines\\fixture",
      hostId: "host_1",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
    });

    expect(
      command.startsWith(
        'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "& ',
      ),
    ).toBe(true);
    expect(command).toContain("'C:\\Program Files\\nodejs\\node.exe'");
    expect(command).toContain("O''Brien");
    expect(command).toContain("--start --host-id 'host_1' --data-dir");
  });

  it("serves a PowerShell error when the request carries no usable enrollment", async () => {
    await withTestHarness(async (harness) => {
      const anonymous = await harness.app.request("/install.ps1");
      expect(anonymous.status).toBe(200);
      expect(anonymous.headers.get("cache-control")).toBe("no-store");
      expect(await anonymous.text()).toMatch(/^throw 'This installer needs/u);

      const unknown = await harness.app.request("/install.ps1", {
        headers: { "X-Omnyo-Enrollment": "omnyode_unknown" },
      });

      expect(unknown.status).toBe(200);
      expect(await unknown.text()).toMatch(
        /^throw 'This enrollment command has already been used/u,
      );
    });
  });
});
