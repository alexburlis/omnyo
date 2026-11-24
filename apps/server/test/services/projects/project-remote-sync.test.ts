import { getProject, setProjectGitRemoteUrlIfMissing } from "@omnyo/db";
import { describe, expect, it, vi } from "vitest";
import { installProjectRemoteSync } from "../../../src/services/projects/project-remote-sync.js";
import { registerHostRpcResponder } from "../../helpers/host-rpc.js";
import { seedHostSession, seedProjectWithSource } from "../../helpers/seed.js";
import { withTestHarness } from "../../helpers/test-app.js";

const OLD_REMOTE = "https://github.com/example/bb-private.git";

const NEW_REMOTE = "https://github.com/example/omnyo.git";

describe("project remote sync", () => {
  it.each([
    { checkoutRemote: NEW_REMOTE, expected: NEW_REMOTE },
    { checkoutRemote: null, expected: OLD_REMOTE },
  ])(
    "records $checkoutRemote from the default checkout when its machine connects",
    async ({ checkoutRemote, expected }) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-project-remote-sync",
        });

        const { project, source } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/Users/developer/projects/omnyo",
        });

        setProjectGitRemoteUrlIfMissing(
          harness.db,
          harness.hub,
          project.id,
          OLD_REMOTE,
        );

        const { requests } = registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          handle: ({ command }) => {
            if (command.type !== "project.inspect") {
              throw new Error(`Unexpected RPC command ${command.type}`);
            }

            return {
              ok: true,
              result: { path: command.path, gitRemoteUrl: checkoutRemote },
            };
          },
        });

        const sync = installProjectRemoteSync(harness.deps);

        try {
          harness.hub.notifyHost(host.id, ["host-connected"]);

          await vi.waitFor(() => {
            expect(
              requests.some(
                ({ command }) =>
                  command.type === "project.inspect" &&
                  command.path === source.path,
              ),
            ).toBe(true);
          });

          await vi.waitFor(() => {
            expect(getProject(harness.db, project.id)?.gitRemoteUrl).toBe(
              expected,
            );
          });
        } finally {
          sync.stop();
        }
      });
    },
  );
});
