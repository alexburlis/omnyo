import { readFile, rm } from "node:fs/promises";
import { join, win32 } from "node:path";
import { SecretVaultError, clipDiagnostic } from "../errors.js";
import {
  createFileExclusive,
  ensurePrivateDirectory,
  errorCode,
} from "../files.js";
import {
  VAULT_KEY_BYTES,
  vaultDirectory,
  type DpapiScope,
  type VaultKeyStore,
} from "./key-store.js";
import {
  DEFAULT_CHILD_TIMEOUT_MS,
  runProcess,
  type ChildProcessOptions,
} from "./process-runner.js";

const PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Security
  $scope = [System.Security.Cryptography.DataProtectionScope]$request.scope
  $entropy = $null
  if ($request.entropy) { $entropy = [System.Text.Encoding]::UTF8.GetBytes([string]$request.entropy) }
  $data = [Convert]::FromBase64String([string]$request.data)
  if ($request.operation -eq 'protect') {
    $result = [System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope)
  } elseif ($request.operation -eq 'unprotect') {
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope)
  } else {
    throw 'Unknown DPAPI operation'
  }
  [Console]::Out.Write([Convert]::ToBase64String($result))
  exit 0
} catch {
  [Console]::Error.Write($_.Exception.GetType().FullName + ': ' + $_.Exception.Message)
  exit 1
}
`;

const DETECT_SCOPE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $principal = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
  $batch = $principal.IsInRole([System.Security.Principal.SecurityIdentifier]'S-1-5-3')
  $service = $principal.IsInRole([System.Security.Principal.SecurityIdentifier]'S-1-5-6')
  if ($batch -or $service) { [Console]::Out.Write('machine') } else { [Console]::Out.Write('user') }
  exit 0
} catch {
  [Console]::Error.Write($_.Exception.GetType().FullName + ': ' + $_.Exception.Message)
  exit 1
}
`;

export interface WindowsProcessOptions extends ChildProcessOptions {
  env?: NodeJS.ProcessEnv;
}

function powershellExecutable(env: NodeJS.ProcessEnv): string {
  const windowsRoot = env.SystemRoot;

  if (
    windowsRoot === undefined ||
    !win32.isAbsolute(windowsRoot) ||
    win32.resolve(windowsRoot) !== windowsRoot
  )
    throw new SecretVaultError(
      "key_unavailable",
      "Windows DPAPI needs an absolute SystemRoot to locate PowerShell",
    );

  return win32.join(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function runPowerShell(
  script: string,
  stdin: string,
  options: WindowsProcessOptions,
  action: string,
): Promise<string> {
  const run = options.run ?? runProcess;

  const result = await run({
    executable: powershellExecutable(options.env ?? process.env),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    stdin,
    timeoutMs: options.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS,
  });

  if (result.exitCode !== 0) {
    const detail = clipDiagnostic(result.stderr);

    throw new SecretVaultError(
      "key_unavailable",
      `Windows DPAPI could not ${action} (exit ${String(result.exitCode)})${detail ? `: ${detail}` : ""}`,
    );
  }

  return result.stdout.trim();
}

export function parseDpapiScope(output: string): DpapiScope {
  const scope = output.trim();

  if (scope === "machine" || scope === "user") return scope;

  throw new SecretVaultError(
    "key_unavailable",
    "Windows DPAPI scope detection returned an unexpected answer",
  );
}

export async function detectWindowsDpapiScope(
  options: WindowsProcessOptions = {},
): Promise<DpapiScope> {
  return parseDpapiScope(
    await runPowerShell(DETECT_SCOPE_SCRIPT, "", options, "detect its scope"),
  );
}

export function createWindowsDpapiKeyStore(
  dataDir: string,
  scope: DpapiScope,
  options: WindowsProcessOptions = {},
): VaultKeyStore {
  const blobPath = (vaultId: string) =>
    join(vaultDirectory(dataDir), `key-${vaultId}.dpapi`);

  const transform = (
    operation: "protect" | "unprotect",
    vaultId: string,
    data: string,
  ) =>
    runPowerShell(
      PROTECT_SCRIPT,
      JSON.stringify({
        operation,
        scope: scope === "machine" ? "LocalMachine" : "CurrentUser",
        entropy: scope === "machine" ? vaultId : "",
        data,
      }),
      options,
      `${operation} the vault key in ${scope} scope`,
    );

  return {
    protection: { kind: "windows-dpapi", scope },

    async store(vaultId, key) {
      const blob = await transform("protect", vaultId, key.toString("base64"));
      await ensurePrivateDirectory(vaultDirectory(dataDir));

      if (!(await createFileExclusive(blobPath(vaultId), blob)))
        throw new SecretVaultError(
          "key_unavailable",
          `Vault key blob for ${vaultId} already exists`,
        );
    },

    async load(vaultId) {
      let blob: string;

      try {
        blob = (await readFile(blobPath(vaultId), "utf8")).trim();
      } catch (error) {
        if (errorCode(error) === "ENOENT")
          throw new SecretVaultError(
            "key_missing",
            `Vault key blob ${blobPath(vaultId)} is missing`,
          );
        throw new SecretVaultError(
          "key_unavailable",
          `Vault key blob ${blobPath(vaultId)} cannot be read (${String(errorCode(error))})`,
        );
      }

      const key = Buffer.from(
        await transform("unprotect", vaultId, blob),
        "base64",
      );

      if (key.length !== VAULT_KEY_BYTES)
        throw new SecretVaultError(
          "key_unavailable",
          `Windows DPAPI returned an invalid vault key for vault ${vaultId}`,
        );

      return key;
    },

    async remove(vaultId) {
      await rm(blobPath(vaultId), { force: true });
    },
  };
}
