import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { experimental_defineHostEntry } from "@omnyo/plugin-sdk/host";
import { automationScriptHostContract } from "./script-host-contract.js";
import { automationScriptDir, scriptsRoot } from "./script-files.js";
import { executeScriptFile } from "./script-runner.js";

export default experimental_defineHostEntry({
  contract: automationScriptHostContract,
  handlers: {
    async executeStoredScript(input, context) {
      context.signal.throwIfAborted();
      const dataDir = context.experimental_paths.dataDir;
      const dir = automationScriptDir(dataDir, input.automationId);
      await mkdir(dir, { recursive: true });
      const root = await realpath(dataDir);
      const resolved = await realpath(dir);
      const contained = relative(root, resolved);

      if (contained.startsWith("..") || isAbsolute(contained))
        throw new Error(
          "Automation script directory escapes host plugin storage",
        );
      const scriptPath = join(resolved, input.scriptFile);

      const temporary = join(
        resolved,
        `.${input.scriptFile}.${randomUUID()}.tmp`,
      );

      try {
        await writeFile(temporary, input.content, { mode: 0o700, flag: "wx" });
        context.signal.throwIfAborted();
        await rename(temporary, scriptPath);

        const workingDir =
          input.workingDirectory.type === "automation-storage"
            ? scriptsRoot(dataDir)
            : input.workingDirectory.path;

        if (!isAbsolute(workingDir))
          throw new Error(
            "Script working directory must be absolute on its host",
          );

        const result = await executeScriptFile({
          ...input,
          scriptPath,
          workingDir,
          signal: context.signal,
        });

        context.signal.throwIfAborted();

        return result;
      } finally {
        await rm(temporary, { force: true });
      }
    },
  },
});
