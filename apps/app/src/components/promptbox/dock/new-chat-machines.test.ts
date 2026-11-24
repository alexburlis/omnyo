import { describe, expect, it } from "vitest";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract/protocol";
import { makeHost } from "@omnyo/test-helpers/domain-fixtures";
import { PROVIDER_INPUTS_CONTROL_MISSING_REASON } from "@/components/pickers/environment-provider-scope";
import {
  NEW_CHAT_ENVIRONMENT_PROVIDERS,
  NEW_CHAT_HOST_IDS,
  NEW_CHAT_INPUTS_CONTROL_PROVIDER_IDS,
  NEW_CHAT_MODAL_PROVIDER,
  NEW_CHAT_NOW,
  newChatProjectNamed,
  newChatProvidersByHostId,
  makeNewChatHosts,
} from "@/test/fixtures/new-chat";
import {
  buildNewChatHostlessProviders,
  buildNewChatMachines,
} from "./new-chat-machines";

const hosts = makeNewChatHosts();

function machinesFor({
  projectName = "omnyo-private",
  machineHosts = hosts,
  projectless = false,
  canRequestSetup = true,
}: {
  projectName?: string;
  machineHosts?: typeof hosts;
  projectless?: boolean;
  canRequestSetup?: boolean;
} = {}) {
  const sources = projectless ? [] : newChatProjectNamed(projectName).sources;

  return buildNewChatMachines({
    hosts: machineHosts,
    localDaemonHostId: NEW_CHAT_HOST_IDS.macPro,
    sources,
    providersByHostId: newChatProvidersByHostId({
      hosts: machineHosts,
      sources,
      projectless,
    }),
    inputsControlProviderIds: NEW_CHAT_INPUTS_CONTROL_PROVIDER_IDS,
    projectless,
    canRequestSetup,
    now: NEW_CHAT_NOW,
  });
}

describe("buildNewChatMachines", () => {
  it("puts this machine first, then keeps server order", () => {
    expect(machinesFor().map((machine) => machine.host.name)).toEqual([
      "Mac Pro",
      "5080",
      "Mac Air",
      "3090",
      "omnyo-vps",
    ]);
  });

  it("offers setup, not selection, on machines without a checkout", () => {
    const machines = machinesFor({ projectName: "Stratoclash" });

    expect(
      machines.map((machine) => [machine.host.name, machine.state]),
    ).toEqual([
      ["Mac Pro", "setup"],
      ["5080", "ready"],
      ["Mac Air", "setup"],
      ["3090", "ready"],
      ["omnyo-vps", "setup"],
    ]);
    expect(machines[0]?.title).toBe("Set up on Mac Pro…");
  });

  it("reports missing checkouts as unavailable when setup cannot be opened", () => {
    expect(
      machinesFor({ projectName: "prim", canRequestSetup: false })[0],
    ).toMatchObject({
      state: "unavailable",
      title: "Not set up for this project",
    });
  });

  it("disables offline, updating and inactive machines with their reason", () => {
    const machineHosts = makeNewChatHosts({
      rtx3090: {
        status: "disconnected",
        lastSeenAt: NEW_CHAT_NOW - 2 * 60 * 60 * 1000,
      },
      rtx5080: {
        status: "disconnected",
        lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
      },
      macAir: {
        lifecycle: { ...makeHost().lifecycle, phase: "suspended" },
      },
    });

    const byName = new Map(
      machinesFor({ projectName: "physicscrafter", machineHosts }).map(
        (machine) => [machine.host.name, machine],
      ),
    );

    expect(byName.get("3090")).toMatchObject({
      state: "offline",
      title: "Offline · last seen 2h ago",
    });
    expect(byName.get("5080")).toMatchObject({
      state: "unavailable",
      title: `Needs update · daemon protocol ${HOST_DAEMON_PROTOCOL_VERSION - 1} · server protocol ${HOST_DAEMON_PROTOCOL_VERSION}`,
    });
    expect(byName.get("Mac Air")).toMatchObject({
      state: "unavailable",
      title: "Machine is suspended",
    });
    expect(byName.get("Mac Pro")?.state).toBe("ready");
  });

  it("treats every connected machine as ready without a project", () => {
    expect(
      machinesFor({ projectless: true }).every(
        (machine) => machine.state === "ready",
      ),
    ).toBe(true);
  });

  it("leaves out provider-made machines", () => {
    const machineHosts = [
      ...hosts,
      makeHost({
        id: "host_modal",
        name: "Modal sandbox 3f9a",
        type: "ephemeral",
        machineProviderId: "modal-sandbox",
      }),
    ];

    expect(
      machinesFor({ machineHosts }).map((machine) => machine.host.id),
    ).not.toContain("host_modal");
  });
});

describe("buildNewChatHostlessProviders", () => {
  it("lists hostless providers for the project mode with their disabled reason", () => {
    const modalNeedingControl = {
      ...NEW_CHAT_MODAL_PROVIDER,
      inputs: { type: "object" },
      acceptsEmptyInputs: false,
    };

    expect(
      buildNewChatHostlessProviders({
        providers: [...NEW_CHAT_ENVIRONMENT_PROVIDERS, modalNeedingControl],
        projectless: false,
        inputsControlProviderIds: NEW_CHAT_INPUTS_CONTROL_PROVIDER_IDS,
      }),
    ).toEqual([
      {
        provider: modalNeedingControl,
        disabledReason: PROVIDER_INPUTS_CONTROL_MISSING_REASON,
      },
    ]);
    expect(
      buildNewChatHostlessProviders({
        providers: [NEW_CHAT_MODAL_PROVIDER],
        projectless: true,
        inputsControlProviderIds: NEW_CHAT_INPUTS_CONTROL_PROVIDER_IDS,
      }),
    ).toEqual([]);
  });
});
