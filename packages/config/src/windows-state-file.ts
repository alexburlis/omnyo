import { resolve } from "node:path";
import { runWindowsStateOwnerProcess } from "./windows-state-process.js";

const windowsReplaceScript = String.raw`
$ErrorActionPreference='Stop'
$a=$env:OMNYO_STATE_FILE_INPUT | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OmnyoStateFile {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string source,string destination,uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  public static void CopyStream(string source,string destination) {
    using(var input=CreateFile(source,0x80000000,7,IntPtr.Zero,3,0,IntPtr.Zero)) {
      if(input.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      using(var output=CreateFile(destination,0x40000000,7,IntPtr.Zero,1,0x80000080,IntPtr.Zero)) {
        if(output.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        using(var reader=new FileStream(input,FileAccess.Read)) using(var writer=new FileStream(output,FileAccess.Write)) {reader.CopyTo(writer);writer.Flush(true);}
      }
    }
  }
}
'@
if($a.operation -eq 'prepare'){
  if(Test-Path -LiteralPath $a.destination){Set-Acl -LiteralPath $a.source -AclObject (Get-Acl -LiteralPath $a.destination)}
  exit 0
}
if(!$a.exclusive -and (Test-Path -LiteralPath $a.destination)){
  Set-Acl -LiteralPath $a.source -AclObject (Get-Acl -LiteralPath $a.destination)
  foreach($stream in @(Get-Item -LiteralPath $a.destination -Stream '*')){
    if($stream.Stream -ne ':$DATA'){[OmnyoStateFile]::CopyStream(($a.destination+':'+$stream.Stream),($a.source+':'+$stream.Stream))}
  }
  [IO.File]::SetAttributes($a.source,[IO.File]::GetAttributes($a.destination))
}
$flags=if($a.exclusive){8}else{9}
if(![OmnyoStateFile]::MoveFileEx($a.source,$a.destination,$flags)){throw ('Native durable state replacement refused: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error())}
`;

export async function replaceWindowsStateFile(
  source: string,
  destination: string,
  exclusive: boolean,
  operation: "prepare" | "replace" = "replace",
): Promise<void> {
  await runWindowsStateOwnerProcess({
    script: windowsReplaceScript,
    inputName: "OMNYO_STATE_FILE_INPUT",
    ownerKey: `file:${resolve(destination)}`,
    timeoutMs: 15_000,
    input: {
      source: resolve(source),
      destination: resolve(destination),
      exclusive,
      operation,
    },
  });
}
