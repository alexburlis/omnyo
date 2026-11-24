import { describe, expect, it } from "vitest";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import { seedHostSession } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("host housekeeping inspection", () => {
  it.each(["not-run", "failed"] as const)(
    "returns a truthful %s snapshot through the host RPC",
    async (status) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps);

        const snapshot =
          status === "not-run"
            ? { status }
            : {
                status,
                checkedAt: 1_000,
                idleGraceMs: 600_000,
                memoryPressure: {
                  status: "unavailable" as const,
                  reason: "unsupported-platform" as const,
                },
              };

        const responder = registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          handle: () => ({ ok: true, result: snapshot }),
        });

        try {
          const response = await harness.app.request(
            `/api/v1/hosts/${host.id}/housekeeping`,
          );

          const body = await readJson(response);

          expect({ status: response.status, body }).toEqual({
            status: 200,
            body: snapshot,
          });
          expect(responder.requests.map((request) => request.command)).toEqual([
            { type: "host.housekeeping.status" },
          ]);
        } finally {
          responder.unregister();
        }
      });
    },
  );
});
