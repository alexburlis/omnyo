export const WINDOWS_HOST_JOB_SCRIPT = String.raw`
param([Parameter(Mandatory)][long]$MemoryLimitBytes)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class OmnyoHostJob {
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr Minimum, Maximum;
    public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public Limits Basic; public Io Counters; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Entry {
    public uint Size, Usage, Pid; public IntPtr Heap; public uint Module, Threads, Parent; public int Base; public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Exe;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, IntPtr name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits info, int length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out ExtendedLimits info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  const uint Access = 0x0100 | 0x0001 | 0x1000;
  static readonly object gate = new object();
  static IntPtr job;
  static long limit;
  static readonly Dictionary<uint, long> roots = new Dictionary<uint, long>();
  static long adoptedDescendants, unadoptable;

  static void Check(bool good) { if (!good) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Emit(string line) { lock (gate) { Console.Out.WriteLine(line); Console.Out.Flush(); } }

  static long Created(uint pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return -1;
    try {
      long created, exited, kernel, user;
      return GetProcessTimes(process, out created, out exited, out kernel, out user) ? created : -1;
    } finally { CloseHandle(process); }
  }

  static HashSet<uint> Members() {
    int capacity = 8192;
    IntPtr buffer = Marshal.AllocHGlobal(8 + IntPtr.Size * capacity);
    try {
      Check(QueryInformationJobObject(job, 3, buffer, 8 + IntPtr.Size * capacity, IntPtr.Zero));
      int count = Marshal.ReadInt32(buffer, 4);
      HashSet<uint> result = new HashSet<uint>();
      for (int i = 0; i < count; i++) result.Add((uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
      return result;
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  static int Assign(uint pid) {
    IntPtr process = OpenProcess(Access, false, pid);
    if (process == IntPtr.Zero) return Marshal.GetLastWin32Error();
    try {
      bool member;
      if (IsProcessInJob(process, job, out member) && member) return 0;
      if (!AssignProcessToJobObject(job, process)) return Marshal.GetLastWin32Error();
      if (!IsProcessInJob(process, job, out member)) return Marshal.GetLastWin32Error();
      return member ? 0 : -2;
    } finally { CloseHandle(process); }
  }

  static void Sweep() {
    Dictionary<uint, uint> parents = new Dictionary<uint, uint>();
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) return;
    try {
      Entry entry = new Entry(); entry.Size = (uint)Marshal.SizeOf(typeof(Entry));
      if (!Process32FirstW(snapshot, ref entry)) return;
      do { parents[entry.Pid] = entry.Parent; } while (Process32NextW(snapshot, ref entry));
    } finally { CloseHandle(snapshot); }
    HashSet<uint> members;
    lock (gate) {
      members = Members();
      List<uint> gone = new List<uint>();
      foreach (KeyValuePair<uint, long> root in roots) if (!parents.ContainsKey(root.Key) || Created(root.Key) != root.Value) gone.Add(root.Key);
      foreach (uint pid in gone) roots.Remove(pid);
    }
    Dictionary<uint, long> created = new Dictionary<uint, long>();
    Func<uint, long> createdOf = pid => { long value; if (!created.TryGetValue(pid, out value)) { value = Created(pid); created[pid] = value; } return value; };
    foreach (KeyValuePair<uint, uint> pair in parents) {
      uint pid = pair.Key;
      if (pid == 0 || members.Contains(pid)) continue;
      uint child = pid, parent = pair.Value; bool owned = false;
      for (int depth = 0; depth < 64 && parent != 0 && parent != child; depth++) {
        long childCreated = createdOf(child), parentCreated = createdOf(parent);
        if (childCreated < 0 || parentCreated < 0 || parentCreated > childCreated) break;
        if (members.Contains(parent) || roots.ContainsKey(parent)) { owned = true; break; }
        uint next;
        if (!parents.TryGetValue(parent, out next)) break;
        child = parent; parent = next;
      }
      if (!owned) continue;
      lock (gate) {
        if (Assign(pid) == 0) { adoptedDescendants++; members.Add(pid); } else unadoptable++;
      }
    }
  }

  static string Status() {
    ExtendedLimits limits; Accounting accounting;
    lock (gate) {
      Check(QueryInformationJobObject(job, 9, out limits, Marshal.SizeOf(typeof(ExtendedLimits)), IntPtr.Zero));
      Check(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
      StringBuilder pids = new StringBuilder();
      foreach (uint pid in Members()) { if (pids.Length > 0) pids.Append(','); pids.Append(pid); }
      return "{\"type\":\"status\",\"active\":" + accounting.Active + ",\"peakJobMemoryBytes\":" + limits.PeakJob.ToUInt64() + ",\"jobMemoryLimitBytes\":" + limit + ",\"adoptedDescendants\":" + adoptedDescendants + ",\"unadoptable\":" + unadoptable + ",\"pids\":[" + pids + "]}";
    }
  }

  static string Terminate() {
    Accounting accounting;
    lock (gate) {
      Check(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
      uint before = accounting.Active;
      if (before > 0) Check(TerminateJobObject(job, 1));
      roots.Clear();
      Stopwatch wait = Stopwatch.StartNew();
      while (true) {
        Check(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        if (accounting.Active == 0) break;
        if (wait.ElapsedMilliseconds > 10000) throw new Exception("Omnyo host job processes did not exit");
        Thread.Sleep(20);
      }
      return "{\"type\":\"terminated\",\"count\":" + before + "}";
    }
  }

  public static void Run(long memoryLimitBytes) {
    limit = memoryLimitBytes;
    job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    ExtendedLimits limits = new ExtendedLimits();
    limits.Basic.Flags = 0x2000 | 0x0400 | 0x0020;
    limits.Basic.Priority = 0x4000;
    if (memoryLimitBytes > 0) { limits.Basic.Flags |= 0x0200; limits.JobMemory = new UIntPtr((ulong)memoryLimitBytes); }
    Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));
    Thread sweeper = new Thread(() => {
      while (true) {
        try { Sweep(); } catch { }
        Thread.Sleep(500);
      }
    });
    sweeper.IsBackground = true; sweeper.Start();
    Emit("{\"type\":\"ready\"}");
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string[] parts = line.Split(' ');
      try {
        if (parts[0] == "adopt" && parts.Length == 2) {
          uint pid = UInt32.Parse(parts[1]);
          long created = Created(pid);
          int code;
          lock (gate) {
            code = created < 0 ? -3 : Assign(pid);
            if (code == 0) roots[pid] = created;
          }
          Emit(code == 0 ? "{\"type\":\"adopted\",\"pid\":" + pid + "}" : "{\"type\":\"error\",\"pid\":" + pid + ",\"code\":" + code + "}");
        } else if (parts[0] == "status") {
          Emit(Status());
        } else if (parts[0] == "terminate") {
          Emit(Terminate());
        } else {
          Emit("{\"type\":\"error\",\"code\":-1}");
        }
      } catch (Exception failure) {
        int code = failure is Win32Exception ? ((Win32Exception)failure).NativeErrorCode : -1;
        Emit("{\"type\":\"error\",\"code\":" + code + "}");
      }
    }
  }
}
'@
[OmnyoHostJob]::Run($MemoryLimitBytes)
`;
