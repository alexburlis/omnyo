import { describe, expect, it } from "vitest";
import type { GitCheckoutRef, Host } from "@omnyo/domain";
import type { CreateThreadEnvironmentArgs } from "@omnyo/server-contract";
import {
  NEW_CHAT_HOST_IDS,
  NEW_CHAT_NOW,
  makeNewChatHosts,
} from "@/test/fixtures/new-chat";
import {
  describeCheckoutBranch,
  describeMachineSwitch,
  describeWhere,
  wherePickSelection,
  type NewChatWhere,
  type WherePick,
} from "./new-chat-where";

const MAC = NEW_CHAT_HOST_IDS.macPro;

const RTX3090 = NEW_CHAT_HOST_IDS.rtx3090;

const RTX5080 = NEW_CHAT_HOST_IDS.rtx5080;

const DAY_MS = 86_400_000;

describe("describeWhere", () => {
  it.each<{
    name: string;
    environment: CreateThreadEnvironmentArgs | null;
    projectless: boolean;
    where: NewChatWhere;
  }>([
    {
      name: "nothing resolved yet",
      environment: null,
      projectless: false,
      where: {
        machine: { kind: "unresolved" },
        workspace: { kind: "checkout" },
      },
    },
    {
      name: "nothing resolved for No project",
      environment: null,
      projectless: true,
      where: {
        machine: { kind: "unresolved" },
        workspace: { kind: "personal" },
      },
    },
    {
      name: "the project default",
      environment: { type: "project-default" },
      projectless: false,
      where: {
        machine: { kind: "unresolved" },
        workspace: { kind: "checkout" },
      },
    },
    {
      name: "a checkout on a host",
      environment: {
        type: "host",
        hostId: MAC,
        workspace: { type: "unmanaged", path: null },
      },
      projectless: false,
      where: {
        machine: { kind: "host", hostId: MAC },
        workspace: { kind: "checkout" },
      },
    },
    {
      name: "a new worktree on a host",
      environment: {
        type: "host",
        hostId: MAC,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      },
      projectless: false,
      where: {
        machine: { kind: "host", hostId: MAC },
        workspace: { kind: "new-worktree" },
      },
    },
    {
      name: "a project-checkout provider at a worktree path",
      environment: {
        type: "provider",
        environmentProviderId: "project-checkout",
        machine: { type: "existing", hostId: RTX3090 },
        inputs: { path: "/Users/developer/projects/omnyo-feature" },
      },
      projectless: false,
      where: {
        machine: { kind: "host", hostId: RTX3090 },
        workspace: {
          kind: "local-worktree",
          path: "/Users/developer/projects/omnyo-feature",
        },
      },
    },
    {
      name: "the git-worktree provider",
      environment: {
        type: "provider",
        environmentProviderId: "git-worktree",
        machine: { type: "existing", hostId: MAC },
        inputs: { branch: { kind: "default" } },
      },
      projectless: false,
      where: {
        machine: { kind: "host", hostId: MAC },
        workspace: { kind: "new-worktree" },
      },
    },
    {
      name: "a core provider whose machine is not chosen yet",
      environment: {
        type: "provider",
        environmentProviderId: "project-checkout",
        inputs: {},
      },
      projectless: false,
      where: {
        machine: { kind: "unresolved" },
        workspace: { kind: "checkout" },
      },
    },
    {
      name: "a plugin provider on a host",
      environment: {
        type: "provider",
        environmentProviderId: "sentry-worktree",
        machine: { type: "existing", hostId: MAC },
        inputs: null,
      },
      projectless: false,
      where: {
        machine: { kind: "host", hostId: MAC },
        workspace: { kind: "provider", providerId: "sentry-worktree" },
      },
    },
    {
      name: "a hostless machine provider",
      environment: {
        type: "provider",
        environmentProviderId: "modal-sandbox",
        inputs: null,
      },
      projectless: false,
      where: {
        machine: { kind: "hostless", providerId: "modal-sandbox" },
        workspace: { kind: "provider", providerId: "modal-sandbox" },
      },
    },
    {
      name: "a reused environment on a known host",
      environment: { type: "reuse", environmentId: "env_feature" },
      projectless: false,
      where: {
        machine: { kind: "host", hostId: RTX3090 },
        workspace: { kind: "environment", environmentId: "env_feature" },
      },
    },
    {
      name: "a reused environment whose host is unknown",
      environment: { type: "reuse", environmentId: "env_elsewhere" },
      projectless: false,
      where: {
        machine: { kind: "unresolved" },
        workspace: { kind: "environment", environmentId: "env_elsewhere" },
      },
    },
  ])("reads $name", ({ environment, projectless, where }) => {
    expect(
      describeWhere(environment, projectless, [
        { environmentId: "env_feature", hostId: RTX3090 },
      ]),
    ).toEqual(where);
  });
});

describe("wherePickSelection", () => {
  const onMac: NewChatWhere = {
    machine: { kind: "host", hostId: MAC },
    workspace: { kind: "checkout" },
  };

  it.each<{
    name: string;
    where: NewChatWhere;
    pick: WherePick;
    environment: CreateThreadEnvironmentArgs;
  }>([
    {
      name: "the checkout",
      where: { ...onMac, workspace: { kind: "new-worktree" } },
      pick: { kind: "workspace", workspace: { kind: "checkout" } },
      environment: {
        type: "host",
        hostId: MAC,
        workspace: { type: "unmanaged", path: null },
      },
    },
    {
      name: "a new worktree",
      where: onMac,
      pick: { kind: "workspace", workspace: { kind: "new-worktree" } },
      environment: {
        type: "host",
        hostId: MAC,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      },
    },
    {
      name: "a local worktree",
      where: onMac,
      pick: {
        kind: "workspace",
        workspace: { kind: "local-worktree", path: "/Users/developer/wt/fix" },
      },
      environment: {
        type: "host",
        hostId: MAC,
        workspace: { type: "unmanaged", path: "/Users/developer/wt/fix" },
      },
    },
    {
      name: "an Omnyo environment",
      where: onMac,
      pick: {
        kind: "workspace",
        workspace: { kind: "environment", environmentId: "env_feature" },
      },
      environment: { type: "reuse", environmentId: "env_feature" },
    },
    {
      name: "a plugin provider",
      where: onMac,
      pick: {
        kind: "workspace",
        workspace: { kind: "provider", providerId: "sentry-worktree" },
      },
      environment: {
        type: "provider",
        environmentProviderId: "sentry-worktree",
        machine: { type: "existing", hostId: MAC },
        inputs: null,
      },
    },
    {
      name: "a hostless machine",
      where: onMac,
      pick: { kind: "hostless", providerId: "modal-sandbox" },
      environment: {
        type: "provider",
        environmentProviderId: "modal-sandbox",
        inputs: null,
      },
    },
    {
      name: "a machine for No project",
      where: {
        machine: { kind: "host", hostId: MAC },
        workspace: { kind: "personal" },
      },
      pick: { kind: "host", hostId: RTX3090 },
      environment: {
        type: "host",
        hostId: RTX3090,
        workspace: { type: "personal" },
      },
    },
    {
      name: "a machine that keeps a new worktree",
      where: { ...onMac, workspace: { kind: "new-worktree" } },
      pick: { kind: "host", hostId: RTX3090 },
      environment: {
        type: "host",
        hostId: RTX3090,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      },
    },
    {
      name: "a machine that resets a local worktree to the checkout",
      where: {
        ...onMac,
        workspace: { kind: "local-worktree", path: "/Users/developer/wt/fix" },
      },
      pick: { kind: "host", hostId: RTX3090 },
      environment: {
        type: "host",
        hostId: RTX3090,
        workspace: { type: "unmanaged", path: null },
      },
    },
    {
      name: "a machine that resets a reused environment to the checkout",
      where: {
        ...onMac,
        workspace: { kind: "environment", environmentId: "env_feature" },
      },
      pick: { kind: "host", hostId: RTX3090 },
      environment: {
        type: "host",
        hostId: RTX3090,
        workspace: { type: "unmanaged", path: null },
      },
    },
    {
      name: "a workspace while a hostless machine is selected",
      where: {
        machine: { kind: "hostless", providerId: "modal-sandbox" },
        workspace: { kind: "provider", providerId: "modal-sandbox" },
      },
      pick: { kind: "workspace", workspace: { kind: "checkout" } },
      environment: {
        type: "host",
        hostId: RTX5080,
        workspace: { type: "unmanaged", path: null },
      },
    },
  ])("selects $name", ({ where, pick, environment }) => {
    expect(wherePickSelection(where, pick, RTX5080)).toEqual({ environment });
  });

  it("offers no workspace when no machine is known", () => {
    expect(
      wherePickSelection(
        { machine: { kind: "unresolved" }, workspace: { kind: "checkout" } },
        { kind: "workspace", workspace: { kind: "new-worktree" } },
        null,
      ),
    ).toBeNull();
  });
});

describe("describeMachineSwitch", () => {
  const hosts = makeNewChatHosts({
    rtx5080: {
      status: "disconnected",
      lastSeenAt: NEW_CHAT_NOW - 3 * DAY_MS,
    },
  });

  function host(id: string): Host {
    const found = hosts.find((candidate) => candidate.id === id);

    if (found === undefined) throw new Error(`Missing fixture host ${id}`);

    return found;
  }

  const macPro = host(MAC);
  const rtx3090 = host(RTX3090);
  const rtx5080 = host(RTX5080);

  it("explains why Stratoclash runs on the 3090", () => {
    expect(
      describeMachineSwitch({
        projectName: "Stratoclash",
        defaultHost: macPro,
        resolvedHostId: RTX3090,
        hostsWithProject: [rtx5080, rtx3090],
        now: NEW_CHAT_NOW,
      }),
    ).toBe(
      "Stratoclash isn't on the Mac Pro, so it runs on the 3090. The 5080 has it too but has been offline for 3 days.",
    );
  });

  it("names every offline machine that also has the project", () => {
    const macAir = {
      ...host(NEW_CHAT_HOST_IDS.macAir),
      status: "disconnected" as const,
    };

    expect(
      describeMachineSwitch({
        projectName: "Stratoclash",
        defaultHost: macPro,
        resolvedHostId: RTX3090,
        hostsWithProject: [rtx5080, macAir, rtx3090],
        now: NEW_CHAT_NOW,
      }),
    ).toBe(
      "Stratoclash isn't on the Mac Pro, so it runs on the 3090. The 5080 and the Mac Air have it too but are offline.",
    );
  });

  it("stays quiet when the default machine has the project", () => {
    expect(
      describeMachineSwitch({
        projectName: "omnyo-private",
        defaultHost: macPro,
        resolvedHostId: RTX3090,
        hostsWithProject: [macPro, rtx3090],
        now: NEW_CHAT_NOW,
      }),
    ).toBeNull();
  });

  it("stays quiet when the chat runs on the default machine", () => {
    expect(
      describeMachineSwitch({
        projectName: "Stratoclash",
        defaultHost: macPro,
        resolvedHostId: MAC,
        hostsWithProject: [rtx3090],
        now: NEW_CHAT_NOW,
      }),
    ).toBeNull();
  });
});

describe("describeCheckoutBranch", () => {
  it.each<{ checkout: GitCheckoutRef; label: string; title: string | null }>([
    {
      checkout: { kind: "branch", branchName: "main", headSha: "abc1234def" },
      label: "main",
      title: null,
    },
    {
      checkout: { kind: "unborn", branchName: "main" },
      label: "main",
      title: "No commits yet",
    },
    {
      checkout: { kind: "detached", headSha: "abc1234def" },
      label: "Detached",
      title: "Detached at abc1234",
    },
    {
      checkout: { kind: "detached", headSha: null },
      label: "Detached",
      title: "Detached HEAD",
    },
    {
      checkout: { kind: "unknown", reason: "Not a git repository" },
      label: "Unknown branch",
      title: "Not a git repository",
    },
  ])("labels a $checkout.kind checkout", ({ checkout, label, title }) => {
    expect(describeCheckoutBranch(checkout)).toEqual({ label, title });
  });
});
