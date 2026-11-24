import type { ServiceTier, Thread } from "@omnyo/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { runLiveHostCommand } from "../hosts/live-command.js";
import { writeThreadServiceTier } from "./thread-session-options.js";

export async function setThreadServiceTier(
  deps: AppDeps,
  thread: Thread,
  serviceTier: ServiceTier,
): Promise<void> {
  if (thread.archivedAt !== null)
    throw new ApiError(
      409,
      "invalid_request",
      "Unarchive this chat before changing speed",
    );

  const execution = await buildExecutionOptions(
    deps,
    { serviceTier },
    { threadId: thread.id },
  );

  if (execution.serviceTier !== serviceTier)
    throw new ApiError(
      400,
      "invalid_request",
      "This speed is unavailable for the session",
    );

  if (thread.status === "active") {
    const environment = await requireThreadCommandEnvironment(deps, { thread });
    await runLiveHostCommand(deps, {
      command: {
        type: "thread.speed.set",
        threadId: thread.id,
        environmentId: environment.id,
        serviceTier,
      },
      hostId: environment.hostId,
      timeoutMs: 10_000,
    });
  }

  writeThreadServiceTier(deps, thread, serviceTier);
}
