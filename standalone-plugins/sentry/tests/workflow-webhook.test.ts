import { createHmac } from "node:crypto";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { WorkflowWebhook } from "../src/workflow-webhook";

const body = JSON.stringify({
  action: "created",
  data: { issue: { id: "123", project: { id: "456" } } },
});

const secret = "test-only-webhook-signing-secret";

function request(value = body, signed = body) {
  return new Request("http://localhost/webhook", {
    method: "POST",
    body: value,
    headers: {
      "request-id": "evt_one",
      "sentry-hook-signature": createHmac("sha256", secret).update(signed).digest("hex"),
    },
  });
}

describe("signed Sentry webhook intake", () => {
  it("rejects tampering without scanning or persisting an event", async () => {
    const host = createFakePluginHost({ pluginId: "sentry" });
    const scan = vi.fn(async () => {});
    const receiver = new WorkflowWebhook(host.api, async () => secret, scan);
    expect((await receiver.receive(request(body + " "))).status).toBe(401);
    expect(scan).not.toHaveBeenCalled();
    await host.harness.lifecycle.dispose();
  });

  it("acknowledges before scanning completes and deduplicates the signed body", async () => {
    const host = createFakePluginHost({ pluginId: "sentry" });
    let finish: () => void = () => {};

    const scan = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    const receiver = new WorkflowWebhook(host.api, async () => secret, scan);
    expect((await receiver.receive(request())).status).toBe(202);
    expect(scan).toHaveBeenCalledWith(["456"]);
    expect((await receiver.receive(request())).status).toBe(202);
    finish();
    await receiver.drain();
    await receiver.drain();
    expect(scan).toHaveBeenCalledTimes(1);
    await host.harness.lifecycle.dispose();
  });

  it("retains a failed scan for the next intake owner", async () => {
    const host = createFakePluginHost({ pluginId: "sentry" });

    const scan = vi.fn(async () => {
      throw new Error("provider unavailable");
    });

    const receiver = new WorkflowWebhook(host.api, async () => secret, scan);
    await receiver.receive(request());
    await expect(receiver.drain()).rejects.toThrow("provider unavailable");
    const recovered = vi.fn(async () => {});
    const replacement = new WorkflowWebhook(host.api, async () => secret, recovered);
    await replacement.drain();
    expect(recovered).toHaveBeenCalledWith(["456"]);
    await host.harness.lifecycle.dispose();
  });
});
