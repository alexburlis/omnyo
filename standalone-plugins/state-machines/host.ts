import { fileURLToPath } from "node:url";
import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from "@omnyo/plugin-sdk";
import { hostContract } from "./src/contracts/host.js";
import { CommandHost } from "./src/host/commands.js";
import { runSupervisor } from "./src/host/supervisor.js";

if (process.argv[2] === "--state-machine-command") {
  const directory = process.argv[3];

  if (!directory) throw new Error("Missing invocation directory");
  await runSupervisor(directory);
}

let commands: CommandHost | null = null;

let retain: ReturnType<ExperimentalHostRpcContext["experimental_retainWorker"]> | null = null;

function runner(context: ExperimentalHostRpcContext) {
  if (!commands) {
    commands = new CommandHost(
      context.experimental_paths.dataDir,
      fileURLToPath(import.meta.url),
      () => {
        retain?.dispose();
        retain = null;
      },
    );
    context.lifecycle.signal.addEventListener(
      "abort",
      () => {
        void commands?.dispose();
      },
      { once: true },
    );
  }

  return commands;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    submitInvocation: async (input, context) => {
      const instance = runner(context);
      retain ??= context.experimental_retainWorker();

      try {
        return await instance.submit(input);
      } finally {
        if (!instance.activeCount) {
          retain?.dispose();
          retain = null;
        }
      }
    },
    inspectInvocation: (input, context) => runner(context).inspect(input.attemptId, input.specHash),
    cancelInvocation: (input, context) => runner(context).cancel(input.attemptId, input.specHash),
    ackInvocation: (input, context) => runner(context).acknowledge(input.attemptId, input.specHash),
    readInvocationLog: async (input, context) => {
      await runner(context).inspect(input.attemptId, input.specHash);

      return runner(context).log(input.attemptId, input.cursor, input.limit);
    },
  },
  async dispose() {
    await commands?.dispose();
    retain?.dispose();
  },
});
