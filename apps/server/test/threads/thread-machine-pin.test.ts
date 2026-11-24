import { describe, expect, it } from "vitest";
import type { CreateThreadEnvironmentArgs } from "@omnyo/server-contract";
import { pendingThreadStartContextSchema } from "../../src/services/threads/dispatch-attempt.js";
import { machineCameFromDefault } from "../../src/services/threads/thread-create-request.js";

const managedWorkspace = {
  type: "managed-worktree",
  baseBranch: { kind: "default" },
} as const;

const cases: readonly {
  name: string;
  environment: CreateThreadEnvironmentArgs;
  fromDefault: boolean;
}[] = [
  {
    name: "project default",
    environment: { type: "project-default" },
    fromDefault: true,
  },
  {
    name: "host named without a choice",
    environment: {
      type: "host",
      hostId: "host_a",
      workspace: managedWorkspace,
    },
    fromDefault: false,
  },
  {
    name: "host named as the composer default",
    environment: {
      type: "host",
      hostId: "host_a",
      workspace: managedWorkspace,
      machineChoice: "default",
    },
    fromDefault: true,
  },
  {
    name: "host chosen explicitly",
    environment: {
      type: "host",
      hostId: "host_a",
      workspace: managedWorkspace,
      machineChoice: "explicit",
    },
    fromDefault: false,
  },
  {
    name: "personal workspace without a host",
    environment: { type: "host", workspace: { type: "personal" } },
    fromDefault: true,
  },
  {
    name: "provider on a named machine",
    environment: {
      type: "provider",
      environmentProviderId: "git-worktree",
      machine: { type: "existing", hostId: "host_a" },
      inputs: null,
    },
    fromDefault: false,
  },
  {
    name: "provider on the default machine",
    environment: {
      type: "provider",
      environmentProviderId: "git-worktree",
      machine: { type: "existing", hostId: "host_a" },
      inputs: null,
      machineChoice: "default",
    },
    fromDefault: true,
  },
  {
    name: "provider without a machine",
    environment: {
      type: "provider",
      environmentProviderId: "git-worktree",
      inputs: null,
    },
    fromDefault: true,
  },
  {
    name: "reused environment",
    environment: { type: "reuse", environmentId: "env_a" },
    fromDefault: false,
  },
];

describe("machineCameFromDefault", () => {
  it.each(cases)("$name", ({ environment, fromDefault }) => {
    expect(machineCameFromDefault(environment)).toBe(fromDefault);
  });
});

describe("pendingThreadStartContextSchema", () => {
  it("treats a waiting chat saved before pins existed as pinned", () => {
    const parsed = pendingThreadStartContextSchema.parse({
      environmentIntent: {
        type: "provider",
        environmentProviderId: "git-worktree",
        machine: { type: "existing", hostId: "host_a" },
        inputs: null,
      },
      fork: null,
      startedOnBehalfOf: null,
      titleProvided: false,
    });

    expect(parsed.machinePinned).toBe(true);
  });
});
