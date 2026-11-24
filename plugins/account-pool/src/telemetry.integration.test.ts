import { afterEach, it, expect } from "vitest";
import { createPool, cleanupPools } from "./fixtures/codex-model-pool.js";

afterEach(cleanupPools);

const terminal =
  '{"type":"response.completed","response":{"service_tier":"default","usage":{"input_tokens":30,"output_tokens":20}}}';

it.each(["response.completed", "response.done"])(
  "records %s measurements through the real proxy and model inspection",
  async (eventType) => {
    const event = terminal.replace("response.completed", eventType);

    const pool = await createPool(
      "event-stream",
      [{ name: "one", plan: "pro", unsupported: [] }],
      () =>
        new Response("data: " + event + "\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const response = await pool.request("gpt-6.1-sol");
    expect(response.body).toBe("data: " + event + "\n\n");
    expect(pool.telemetry().rows[0]).toMatchObject({
      completed: 1,
      outputTokens: 20,
      servedTier: "default",
    });
  },
);
