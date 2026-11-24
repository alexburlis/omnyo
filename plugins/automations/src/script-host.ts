import type { PluginApi } from "@omnyo/plugin-sdk";
import type { AutomationScriptWorkingDirectory } from "./rpc-types.js";
import {
  readAutomationScript,
  resolveDefaultInterpreter,
} from "./script-files.js";
import { automationScriptHostContract } from "./script-host-contract.js";
import {
  executeStoredScript,
  type ScriptRunResult,
  type StoredScriptRunArgs,
} from "./script-runner.js";

export interface ScriptHostRouting {
  hostId(serverHostId: string | null): string | null;
  execute(
    args: StoredScriptRunArgs,
    workingDirectory: AutomationScriptWorkingDirectory,
  ): Promise<ScriptRunResult>;
}

export function createScriptHostRouting(
  api: PluginApi,
  scriptHostId: string,
): ScriptHostRouting {
  const client = api.hosts.experimental_client({
    contract: automationScriptHostContract,
  });

  return {
    hostId(serverHostId) {
      return scriptHostId || serverHostId;
    },
    async execute(args, workingDirectory) {
      const serverHostId = (await api.sdk.system.config()).primaryHostId;

      if (scriptHostId === "" || scriptHostId === serverHostId)
        return executeStoredScript(args);
      const serverUrl = api.server.experimental_appUrl;

      if (serverUrl === null)
        throw new Error("Remote automation scripts require the Omnyo app URL");

      const content = await readAutomationScript({
        dataDir: args.pluginDataDir,
        automationId: args.automationId,
        scriptFile: args.scriptFile,
      });

      return client.call(
        "executeStoredScript",
        {
          automationId: args.automationId,
          runId: args.runId,
          projectId: args.projectId,
          scriptFile: args.scriptFile,
          content,
          interpreter:
            args.interpreter ?? resolveDefaultInterpreter(args.scriptFile),
          timeoutMs: args.timeoutMs,
          env: args.env ?? {},
          serverUrl,
          workingDirectory:
            workingDirectory.type === "automation-storage"
              ? workingDirectory
              : { type: "path", path: args.workingDir },
        },
        { hostId: scriptHostId, timeoutMs: args.timeoutMs + 5_000 },
      );
    },
  };
}
