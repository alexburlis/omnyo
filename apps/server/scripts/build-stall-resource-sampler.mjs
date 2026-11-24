import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin")
  execFileSync(
    "/usr/bin/cc",
    [
      "-O2",
      "-mmacosx-version-min=13.0",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      "-Wall",
      "-Wextra",
      "-Werror",
      fileURLToPath(new URL("./stall-resource-sampler.c", import.meta.url)),
      "-o",
      fileURLToPath(new URL("../dist/stall-resource-sampler", import.meta.url)),
    ],
    { stdio: "inherit" },
  );
