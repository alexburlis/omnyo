import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { win32 } from "node:path";

export async function runWindowsStateOwnerProcess(args: {
  script: string;
  input: Record<string, unknown>;
  inputName: string;
  ownerKey: string;
  timeoutMs: number;
  maxBuffer?: number;
}): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== "win32")
    throw new Error("Windows state effects require their native owner");
  const windowsRoot = process.env.SystemRoot;

  if (
    windowsRoot === undefined ||
    !win32.isAbsolute(windowsRoot) ||
    win32.resolve(windowsRoot) !== windowsRoot
  )
    throw new Error(
      "Windows state owner requires its OS PowerShell executable",
    );

  const executable = win32.join(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

  const executableInfo = await lstat(executable);

  if (!executableInfo.isFile() || executableInfo.isSymbolicLink())
    throw new Error(
      "Windows state PowerShell owner is not an ordinary executable",
    );

  const script =
    String.raw`
$ErrorActionPreference='Stop'
$guard=$env:OMNYO_STATE_PROCESS_OWNER | ConvertFrom-Json
$parent=[Diagnostics.Process]::GetProcessById($guard.pid);$null=$parent.Handle
if($parent.StartTime.Ticks -gt [Diagnostics.Process]::GetCurrentProcess().StartTime.Ticks){throw 'State effect parent identity changed'}
$sha=[Security.Cryptography.SHA256]::Create()
try {$key=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($guard.key))).Replace('-','')} finally {$sha.Dispose()}
$mutex=New-Object Threading.Mutex($false,('Global\OmnyoStateOwnerV1-'+$key));$acquired=$false
try {
  try {$acquired=$mutex.WaitOne(5000)} catch [Threading.AbandonedMutexException] {$acquired=$true}
  if(!$acquired){throw 'State effect owner is still busy'}
  if($parent.HasExited){throw 'State effect caller exited before admission'}
  & {
` +
    args.script +
    String.raw`
  }
} finally {if($acquired){$mutex.ReleaseMutex()};$mutex.Dispose();$parent.Dispose()}
`;

  const bootstrap =
    "$ErrorActionPreference='Stop';$utf8=New-Object Text.UTF8Encoding($false);[Console]::InputEncoding=$utf8;[Console]::OutputEncoding=$utf8;& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))";

  return new Promise((resolveResult, reject) => {
    let inputError: Error | null = null;

    const child = execFile(
      executable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(bootstrap, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: args.timeoutMs,
        maxBuffer: args.maxBuffer,
        env: {
          ...process.env,
          [args.inputName]: JSON.stringify(args.input),
          OMNYO_STATE_PROCESS_OWNER: JSON.stringify({
            pid: process.pid,
            key: args.ownerKey.toLowerCase(),
          }),
        },
      },
      (error, stdout, stderr) => {
        if (error !== null || inputError !== null) reject(error ?? inputError);
        else resolveResult({ stdout, stderr });
      },
    );

    child.stdin?.once("error", (error: Error) => {
      inputError = error;
    });
    child.stdin?.end(script, "utf8");
  });
}
