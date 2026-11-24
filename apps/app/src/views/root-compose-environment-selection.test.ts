import { findLocalPathProjectSourceForHost, type Host } from "@omnyo/domain";
import { describe, expect, it } from "vitest";
import {
  NEW_CHAT_HOST_IDS,
  newChatProjectNamed,
  makeNewChatHosts,
} from "@/test/fixtures/new-chat";
import { resolveProjectMachine } from "./root-compose-environment-selection";

const OFFLINE = { status: "disconnected" } as const;

interface MachineCase {
  name: string;
  project: string;
  hosts: Host[];
  defaultThreadMachineId?: string | null;
  rememberedHostId?: string | null;
  expected: string | null;
}

describe("resolveProjectMachine", () => {
  it.each<MachineCase>([
    {
      name: "skips the offline home and runs on the 3090",
      project: "Stratoclash",
      hosts: makeNewChatHosts({ rtx5080: OFFLINE }),
      expected: NEW_CHAT_HOST_IDS.rtx3090,
    },
    {
      name: "uses the project's default source when the default machine lacks it",
      project: "Stratoclash",
      hosts: makeNewChatHosts(),
      expected: NEW_CHAT_HOST_IDS.rtx5080,
    },
    {
      name: "uses the only machine that has the project",
      project: "prim",
      hosts: makeNewChatHosts(),
      expected: NEW_CHAT_HOST_IDS.rtx3090,
    },
    {
      name: "keeps an offline home when every home is offline",
      project: "Stratoclash",
      hosts: makeNewChatHosts({ rtx5080: OFFLINE, rtx3090: OFFLINE }),
      expected: NEW_CHAT_HOST_IDS.rtx5080,
    },
    {
      name: "keeps a usable default machine",
      project: "physicscrafter",
      hosts: makeNewChatHosts(),
      rememberedHostId: NEW_CHAT_HOST_IDS.rtx3090,
      expected: NEW_CHAT_HOST_IDS.macPro,
    },
    {
      name: "prefers the remembered machine over the project's other homes",
      project: "Stratoclash",
      hosts: makeNewChatHosts(),
      rememberedHostId: NEW_CHAT_HOST_IDS.rtx3090,
      expected: NEW_CHAT_HOST_IDS.rtx3090,
    },
    {
      name: "prefers a connected home over an offline default machine",
      project: "physicscrafter",
      hosts: makeNewChatHosts({ macPro: OFFLINE }),
      expected: NEW_CHAT_HOST_IDS.rtx5080,
    },
    {
      name: "keeps the default machine when no machine has the project",
      project: "Stratoclash",
      hosts: makeNewChatHosts().filter(
        (host) =>
          host.id !== NEW_CHAT_HOST_IDS.rtx3090 &&
          host.id !== NEW_CHAT_HOST_IDS.rtx5080,
      ),
      expected: NEW_CHAT_HOST_IDS.macPro,
    },
    {
      name: "picks nothing without a default machine or a usable one",
      project: "Stratoclash",
      hosts: [],
      defaultThreadMachineId: null,
      expected: null,
    },
  ])(
    "$name",
    ({
      project: projectName,
      hosts,
      defaultThreadMachineId = NEW_CHAT_HOST_IDS.macPro,
      rememberedHostId = null,
      expected,
    }) => {
      const project = newChatProjectNamed(projectName);
      const knownHostIds = new Set(hosts.map((host) => host.id));

      expect(
        resolveProjectMachine({
          defaultThreadMachineId,
          rememberedHostId,
          localHostId: null,
          primaryHostId: NEW_CHAT_HOST_IDS.macPro,
          sources: project.sources,
          hostOrder: hosts.map((host) => host.id),
          connectedHostIds: new Set(
            hosts
              .filter((host) => host.status === "connected")
              .map((host) => host.id),
          ),
          isUsable: (hostId) =>
            knownHostIds.has(hostId) &&
            findLocalPathProjectSourceForHost(project.sources, hostId) !==
              undefined,
        }),
      ).toBe(expected);
    },
  );
});
