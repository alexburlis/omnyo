export const WINDOWS_DIRECTORY_PROCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class OmnyoDirectoryInspection {
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes, CreatedLow, CreatedHigh, AccessedLow, AccessedHigh;
    public uint WrittenLow, WrittenHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  sealed class Entry {
    public string Path;
    public FileInfo Identity;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  static extern int RmStartSession(out uint handle, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  static extern int RmRegisterResources(uint handle, uint filesCount, string[] files, uint applicationsCount, IntPtr applications, uint servicesCount, IntPtr services);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint handle, out uint needed, ref uint count, IntPtr applications, ref uint reasons);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint handle);

  static bool Same(FileInfo left, FileInfo right) {
    return left.Volume == right.Volume && left.IndexHigh == right.IndexHigh && left.IndexLow == right.IndexLow &&
      left.Attributes == right.Attributes && left.SizeHigh == right.SizeHigh && left.SizeLow == right.SizeLow &&
      left.WrittenHigh == right.WrittenHigh && left.WrittenLow == right.WrittenLow && left.Links == right.Links;
  }
  static FileInfo Identity(string path) {
    using (var file = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      FileInfo info;
      if (file.IsInvalid || !GetFileInformationByHandle(file, out info)) throw new IOException();
      if ((info.Attributes & 0x400) != 0) throw new IOException();
      return info;
    }
  }
  public static string Inspect(string directory) {
    var timer = Stopwatch.StartNew();
    var entries = new List<Entry>();
    var files = new List<string>();
    var pending = new Stack<string>();
    var locked = new List<SafeFileHandle>();
    uint session = 0;
    bool started = false;
    try {
      string root = Path.GetFullPath(directory);
      pending.Push(root);
      while (pending.Count > 0) {
        if (timer.ElapsedMilliseconds > 3000 || entries.Count >= 4096) return "unknown";
        string path = pending.Pop();
        FileInfo info = Identity(path);
        entries.Add(new Entry { Path = path, Identity = info });
        if ((info.Attributes & 0x10) != 0) {
          foreach (string child in Directory.EnumerateFileSystemEntries(path)) {
            if (entries.Count + pending.Count >= 4096) return "unknown";
            pending.Push(child);
          }
        } else files.Add(path);
      }
      if ((entries[0].Identity.Attributes & 0x10) == 0) return "unknown";
      if (files.Count > 0) {
        if (RmStartSession(out session, 0, new StringBuilder(33)) != 0) return "unknown";
        started = true;
        if (RmRegisterResources(session, (uint)files.Count, files.ToArray(), 0, IntPtr.Zero, 0, IntPtr.Zero) != 0) return "unknown";
        uint needed, count = 0, reasons = 0;
        int result = RmGetList(session, out needed, ref count, IntPtr.Zero, ref reasons);
        if (result == 234 || needed > 0) return "busy";
        if (result != 0) return "unknown";
      }
      foreach (Entry entry in entries) {
        if (timer.ElapsedMilliseconds > 3000) return "unknown";
        var handle = CreateFileW(entry.Path, 0x10000, 0, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid) {
          int error = Marshal.GetLastWin32Error();
          handle.Dispose();
          return error == 32 || error == 33 ? "busy" : "unknown";
        }
        locked.Add(handle);
        FileInfo current;
        if (!GetFileInformationByHandle(handle, out current) || !Same(entry.Identity, current)) return "unknown";
      }
      for (int index = 0; index < entries.Count; index++) {
        if (timer.ElapsedMilliseconds > 3000) return "unknown";
        FileInfo current;
        if (!GetFileInformationByHandle(locked[index], out current) || !Same(entries[index].Identity, current)) return "unknown";
      }
      return "idle";
    } catch {
      return "unknown";
    } finally {
      foreach (var handle in locked) handle.Dispose();
      if (started) RmEndSession(session);
    }
  }
}
'@
[Console]::Out.WriteLine([OmnyoDirectoryInspection]::Inspect([Console]::In.ReadToEnd()))
`;
