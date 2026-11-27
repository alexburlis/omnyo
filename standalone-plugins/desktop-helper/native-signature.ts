import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function verifyNativeSignature(
  app: string,
  bundleId: string,
  teamId: string,
): Promise<void> {
  const requirement = `=identifier "${bundleId}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", requirement, app], {
    timeout: 5_000,
  });
}
