import {
  chmod,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enrollMachine } from "./machine-enrollment.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("machine enrollment launcher lookup", () => {
  it.skipIf(process.platform === "win32")(
    "links the omnyo-app launcher from PATH, not a legacy bb-app",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "omnyo-enroll-launcher-"));
      roots.push(root);
      const bin = join(root, "bin");
      const dataDir = join(root, "machine");
      await mkdir(bin);

      for (const name of ["omnyo-app", "bb-app"]) {
        await writeFile(join(bin, name), "#!/bin/sh\n");
        await chmod(join(bin, name), 0o755);
      }

      const env: NodeJS.ProcessEnv = {
        PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
        OMNYO_TEST_BOOTSTRAP: JSON.stringify({
          hostId: "host_launcher",
          serverUrl: "http://127.0.0.1:9",
          credential: "enrollment-test",
          expiresAt: Date.now() + 60_000,
          dataDir,
        }),
      };

      await expect(
        enrollMachine(
          { bootstrapEnv: "OMNYO_TEST_BOOTSTRAP" },
          {
            env,
            homeDir: root,
            fetchFn: async () => {
              throw new Error("offline");
            },
          },
        ),
      ).rejects.toThrow();

      await expect(
        readlink(join(dataDir, "npm", "bin", "omnyo-app")),
      ).resolves.toBe(join(bin, "omnyo-app"));
    },
  );
});
