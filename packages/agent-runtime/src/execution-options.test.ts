import { expect, it } from "vitest";
import { keepRunningTurnApprovals } from "./execution-options.js";
import { fullRuntimeOptions } from "./test/runtime-test-harness.js";
import type { AgentRuntimeExecutionOptions } from "./types.js";

const deniedWorkspace: AgentRuntimeExecutionOptions = {
  ...fullRuntimeOptions,
  permissionMode: "accept-edits",
  permissionScope: "workspace",
  approvalReviewer: "user",
  permissionEscalation: "deny",
};

it.each([
  { running: deniedWorkspace, requested: fullRuntimeOptions },
  { running: fullRuntimeOptions, requested: deniedWorkspace },
])(
  "keeps the active permission boundary on a non-user steer",
  ({ running, requested }) => {
    const options = {
      ...requested,
      model: "next-model",
      promptMode: "plan",
      providerOptions: { marker: "next" },
    } as const;

    const effective = keepRunningTurnApprovals({
      running,
      requested: options,
      steerSource: "non-user",
    });

    expect(effective).toMatchObject({
      permissionMode: running.permissionMode,
      permissionScope: running.permissionScope,
      approvalReviewer: running.approvalReviewer,
      permissionEscalation: running.permissionEscalation,
      model: "next-model",
      promptMode: "plan",
      providerOptions: { marker: "next" },
    });
  },
);

it.each(["user", undefined] as const)(
  "honors an explicit user policy change with source %s",
  (steerSource) => {
    expect(
      keepRunningTurnApprovals({
        running: fullRuntimeOptions,
        requested: deniedWorkspace,
        steerSource,
      }),
    ).toBe(deniedWorkspace);
  },
);
