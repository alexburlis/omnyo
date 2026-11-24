import { expect, it } from "vitest";
import { createOmnyoSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";

it("reads prepared command state through the scoped catalog route", async () => {
  const urls: URL[] = [];

  const sdk = createOmnyoSdk({
    transport: createHttpTransport({
      baseUrl: "http://omnyo.test",
      runtime: "node",
      fetch: async (input) => {
        urls.push(
          new URL(input instanceof Request ? input.url : String(input)),
        );

        return Response.json({
          state: "failed",
          commands: [
            {
              name: "clear",
              source: "command",
              origin: "builtin",
              description: null,
              argumentHint: null,
            },
          ],
          error: { code: "host_unavailable", message: "Machine unavailable" },
        });
      },
    }),
  });

  const result = await sdk.projects.commandCatalog({
    projectId: "project-1",
    provider: "pi",
    environmentId: "environment-1",
  });

  expect(urls[0]?.pathname).toBe("/api/v1/projects/project-1/command-catalog");
  expect(urls[0]?.searchParams.get("environmentId")).toBe("environment-1");
  expect(urls[0]?.searchParams.get("provider")).toBe("pi");
  expect(result).toMatchObject({
    state: "failed",
    error: { code: "host_unavailable" },
  });
  expect(result.commands.map(({ name }) => name)).toEqual(["clear"]);
});
