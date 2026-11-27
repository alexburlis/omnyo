import { describe, expect, it } from "vitest";
import {
  parseMacGpuPercent,
  parseNvidiaGpuPercent,
  parseWindowsGpuPercent,
  systemCpuPercent,
  type CpuSample,
} from "../system-usage";

function cpu(user: number, idle: number): CpuSample[number] {
  return { model: "test", speed: 1000, times: { user, idle, sys: 0, nice: 0, irq: 0 } };
}

describe("whole-machine counters", () => {
  it("normalizes across cores rather than adding per-core percentages", () => {
    expect(systemCpuPercent([cpu(10, 10), cpu(20, 20)], [cpu(110, 10), cpu(20, 120)])).toBe(50);
    expect(systemCpuPercent([cpu(10, 10)], [cpu(10, 110)])).toBe(0);
  });

  it("rejects missing, reset, unchanged, or changed-topology counters", () => {
    expect(systemCpuPercent([], [])).toBeNull();
    expect(systemCpuPercent([cpu(10, 10)], [cpu(9, 20)])).toBeNull();
    expect(systemCpuPercent([cpu(10, 10)], [cpu(10, 10)])).toBeNull();
    expect(systemCpuPercent([cpu(10, 10)], [cpu(20, 20), cpu(20, 20)])).toBeNull();
  });

  it("reads only the actual macOS device utilization counter", () => {
    expect(
      parseMacGpuPercent(
        '"PerformanceStatistics" = {"Device Utilization %"=34,"Renderer Utilization %"=55}',
      ),
    ).toBe(34);
    expect(parseMacGpuPercent('"Device Utilization %"=0}')).toBe(0);
    expect(parseMacGpuPercent('"Renderer Utilization %"=55}')).toBeNull();
    expect(parseMacGpuPercent('"Device Utilization %"=101}')).toBeNull();
    expect(parseMacGpuPercent('"Device Utilization %"=25}\n"Device Utilization %"=40}')).toBe(40);
  });

  it("reads NVIDIA driver utilization without inventing unsupported or empty values", () => {
    expect(parseNvidiaGpuPercent("54\r\n")).toBe(54);
    expect(parseNvidiaGpuPercent("0\n")).toBe(0);
    expect(parseNvidiaGpuPercent("34\n76\n")).toBe(76);

    for (const output of ["", " ", "N/A", "54\nN/A", "101", "-1", "54%", "54, 20"]) {
      expect(parseNvidiaGpuPercent(output)).toBeNull();
    }
  });

  it("groups Windows process counters by physical GPU engine and chooses the busiest", () => {
    expect(
      parseWindowsGpuPercent(
        JSON.stringify([
          {
            Name: "pid_10_luid_0x00000000_0x0000abcd_phys_0_eng_0_engtype_3D",
            UtilizationPercentage: 25,
          },
          {
            Name: "pid_20_luid_0x00000000_0x0000abcd_phys_0_eng_0_engtype_3D",
            UtilizationPercentage: 30,
          },
          {
            Name: "pid_20_luid_0x00000000_0x0000abcd_phys_0_eng_1_engtype_Copy",
            UtilizationPercentage: 40,
          },
        ]),
      ),
    ).toBe(55);
    expect(
      parseWindowsGpuPercent(
        '{"Name":"pid_10_luid_0x0_0x1_phys_0_eng_0_engtype_3D","UtilizationPercentage":0}',
      ),
    ).toBe(0);

    for (const value of [null, "", false]) {
      expect(
        parseWindowsGpuPercent(
          JSON.stringify({
            Name: "pid_10_luid_0x0_0x1_phys_0_eng_0_engtype_3D",
            UtilizationPercentage: value,
          }),
        ),
      ).toBeNull();
    }

    for (const output of [
      "",
      "[]",
      "null",
      '{"Name":"other","UtilizationPercentage":25}',
      '{"Name":"other","UtilizationPercentage":null}',
    ]) {
      expect(parseWindowsGpuPercent(output)).toBeNull();
    }
  });
});
