import { describe, expect, it } from "vitest";
import { createPluginsArea } from "../src/areas/plugins.js";
import { createHttpTransport } from "../src/transport-http.js";

describe("bundled plugin update transport", () => {
  it.each(["applyUpdate", "experimental_startUpdate"] as const)(
    "%s sends candidate bytes and stale-registration guards through the update endpoint",
    async (method) => {
      const requests: {
        url: string;
        method: string | undefined;
        body: unknown;
      }[] = [];

      const from = { version: "1.0.0", display: "1.0.0" };

      const result = {
        applied: true,
        from,
        to: { version: "2.0.0", display: "2.0.0" },
        outcome: "updated",
      };

      const plugins = createPluginsArea({
        transport: createHttpTransport({
          baseUrl: "http://omnyo.test",
          runtime: "node",
          fetch: async (url, init) => {
            requests.push({
              url: String(url),
              method: init?.method,
              body: JSON.parse(String(init?.body)),
            });

            return new Response(
              JSON.stringify({
                job: {
                  id: "job-fixture",
                  pluginId: "omnyo--fixture",
                  displayName: "Fixture",
                  state: "completed",
                  result,
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        }),
      });

      const bundledCandidate = {
        expectedVersion: "1.0.0",
        expectedArtifactId: "prior-artifact",
        files: [
          { path: "package.json", base64: "e30=", sha256: "a".repeat(64) },
        ],
      };

      await plugins[method]({ pluginId: "omnyo--fixture", bundledCandidate });
      expect(requests).toEqual([
        {
          url: "http://omnyo.test/api/v1/plugins/omnyo--fixture/update",
          method: "POST",
          body: { bundledCandidate },
        },
      ]);
    },
  );
});
