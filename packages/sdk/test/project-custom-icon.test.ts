import { describe, expect, it } from "vitest";
import { createOmnyoSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

describe("project custom icons", () => {
  it("sends icon updates and explicit resets through the existing update route", async () => {
    const bodies: unknown[] = [];

    const sdk = createOmnyoSdk({
      transport: createHttpTransport({
        baseUrl: "http://omnyo.test",
        runtime: "node",
        fetch: async (_input, init) => {
          const body: unknown = JSON.parse(String(init?.body));
          bodies.push(body);

          return Response.json({
            id: "proj_icons",
            name: "Icons",
            kind: "standard",
            gitRemoteUrl: null,
            sources: [],
            createdAt: 1,
            updatedAt: 2,
          });
        },
      }),
    });

    await sdk.projects.update({ projectId: "proj_icons", customIcon: PNG });
    await sdk.projects.update({ projectId: "proj_icons", customIcon: null });
    expect(bodies).toEqual([{ customIcon: PNG }, { customIcon: null }]);
  });
});
