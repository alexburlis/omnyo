import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { runWindowsStateOwnerProcess } from "@omnyo/config/windows-state-process";

export { runWindowsStateOwnerProcess } from "@omnyo/config/windows-state-process";

export async function moveWindowsStateDirectoryNoReplace(
  source: string,
  destination: string,
  args: { ownerKey: string },
): Promise<void> {
  if (
    process.platform !== "win32" ||
    !isAbsolute(source) ||
    !isAbsolute(destination) ||
    resolve(source) !== source ||
    resolve(destination) !== destination ||
    dirname(source).toLowerCase() !== dirname(destination).toLowerCase() ||
    source.toLowerCase() === destination.toLowerCase()
  )
    throw new Error(
      "Windows state adoption requires a same-parent native move",
    );
  const info = await lstat(source);

  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(
      "Windows state adoption source is not an ordinary directory",
    );
  await runWindowsStateOwnerProcess({
    ownerKey: args.ownerKey,
    inputName: "OMNYO_STATE_DIRECTORY_MOVE",
    input: { source, destination },
    timeoutMs: 15_000,
    script: String.raw`
$a=$env:OMNYO_STATE_DIRECTORY_MOVE|ConvertFrom-Json
$source=Get-Item -LiteralPath $a.source -Force
if(!$source.PSIsContainer -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'State adoption source is not an ordinary directory'}
if(Test-Path -LiteralPath $a.destination){throw 'State adoption destination collision'}
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class OmnyoStateDirectoryMove {[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool MoveFileEx(string source,string destination,uint flags);}'
if(![OmnyoStateDirectoryMove]::MoveFileEx($a.source,$a.destination,8)){throw ('Native durable state move refused: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error())}
`,
  });
}
