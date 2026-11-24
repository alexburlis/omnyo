import { describe, expect, it } from "vitest";
import { createThreadsArea } from "../src/areas/threads.js";
import { createHttpTransport } from "../src/transport-http.js";

function capture() {
  const bodies: unknown[] = [];

  const threads = createThreadsArea({
    transport: createHttpTransport({
      baseUrl: "http://omnyo.test",
      runtime: "browser",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));

        return Response.json({});
      },
    }),
  });

  return { threads, bodies };
}

describe("plugin home chats in the threads SDK", () => {
  it("sends the home flag on update", async () => {
    const { threads, bodies } = capture();

    await threads
      .update({ threadId: "thr_a", experimental_pluginHome: true })
      .catch(() => {});

    expect(bodies[0]).toMatchObject({ experimental_pluginHome: true });
  });

  it("spawns an idle home chat with empty input and no prompt", async () => {
    const { threads, bodies } = capture();

    await threads
      .spawn({
        projectId: "proj_personal",
        environment: { type: "reuse", environmentId: "env_a" },
        experimental_idle: true,
        experimental_pluginHome: true,
      })
      .catch(() => {});

    expect(bodies[0]).toMatchObject({
      input: [],
      idle: true,
      pluginHome: true,
    });
    expect(bodies[0]).not.toHaveProperty("experimental_idle");
  });
});
