import { execFile } from "node:child_process";
import { arch, availableParallelism } from "node:os";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@omnyo/plugin-sdk/host";
import {
  concurrencyLimitHostContract,
  type MachineFacts,
  type MachineOs,
} from "./contract.js";

const run = promisify(execFile);

const PROBE_TIMEOUT_MS = 5_000;

function machineOs(platform: NodeJS.Platform): MachineOs {
  if (platform === "darwin") return "macos";

  if (platform === "win32") return "windows";

  return "linux";
}

async function probe(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(command, args, {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });

    const firstLine = stdout.split(/\r?\n/u)[0]?.trim() ?? "";

    return firstLine === "" ? null : firstLine;
  } catch {
    return null;
  }
}

async function hasFullXcode(os: MachineOs): Promise<boolean> {
  if (os !== "macos") return false;
  const developerDirectory = await probe("xcode-select", ["-p"]);

  return (
    developerDirectory !== null &&
    !developerDirectory.includes("CommandLineTools")
  );
}

export async function readMachineFacts(): Promise<MachineFacts> {
  const os = machineOs(process.platform);

  const [xcode, nvidiaGpu] = await Promise.all([
    hasFullXcode(os),
    probe("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]),
  ]);

  return {
    availableParallelism: availableParallelism(),
    os,
    arch: arch(),
    tools: { xcode, nvidiaGpu },
  };
}

export default experimental_defineHostEntry({
  contract: concurrencyLimitHostContract,
  handlers: {
    getCapacity() {
      return { availableParallelism: availableParallelism() };
    },
    getMachineFacts() {
      return readMachineFacts();
    },
  },
});
