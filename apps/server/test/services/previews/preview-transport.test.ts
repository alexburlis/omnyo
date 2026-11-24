import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import type { PreviewTransportCommand } from "@omnyo/host-daemon-contract";
import {
  registerPreviewTransport,
  type PreviewTransportBinding,
} from "../../../src/services/previews/preview-transport.js";
import { browserRequestProblem } from "../../../src/browser-request-guard.js";
import { ApiError } from "../../../src/errors.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(accessTtlMs = 30000) {
  const app = new Hono();
  app.onError((error) =>
    error instanceof ApiError
      ? error.toResponse()
      : new Response("error", { status: 500 }),
  );
  const sockets = createNodeWebSocket({ app });

  let binding: PreviewTransportBinding = {
    id: "prv_registered",
    hostId: "host_owner",
    sessionId: "session_owner",
    runId: "run_owner",
    localUrl: "http://localhost:4399/compare/superwhisper",
  };

  const calls: PreviewTransportCommand[] = [];

  let response = {
    status: 200,
    headers: [
      ["content-type", "text/plain"],
      ["set-cookie", "must-not-reach-omnyo=1"],
    ],
    bodyBase64: Buffer.from("fixture").toString("base64"),
  };

  const service = registerPreviewTransport(
    app,
    {
      accessTtlMs,
      validateBinding: async (expected) => {
        if (
          binding === null ||
          expected.id !== binding.id ||
          expected.hostId !== binding.hostId ||
          expected.sessionId !== binding.sessionId ||
          expected.runId !== binding.runId ||
          new URL(expected.localUrl).origin !== new URL(binding.localUrl).origin
        )
          throw new Error("Changed binding");
      },
      resolveBinding: async (id) => {
        if (id !== binding.id)
          throw new ApiError(404, "not_found", "Not found");

        return { ...binding };
      },
      call: async (_binding, command) => {
        calls.push(command);

        return response;
      },
      browserProblem: (context) =>
        browserRequestProblem(
          context,
          { config: { serverPort: 80 } },
          { requireJsonForMutation: true },
        ),
    },
    sockets.upgradeWebSocket,
  );

  cleanup.push(() => service.dispose());

  async function mint(origin = "http://localhost", body = "{}") {
    return app.request("http://localhost/preview/prv_registered/access", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body,
    });
  }

  const minted = await mint();
  expect(minted.status).toBe(200);
  const access: unknown = await minted.json();

  if (
    typeof access !== "object" ||
    access === null ||
    !("contentBase" in access) ||
    typeof access.contentBase !== "string"
  )
    throw new Error("Invalid fixture access");

  return {
    app,
    mint,
    contentBase: access.contentBase,
    calls,
    setResponse(value: typeof response) {
      response = value;
    },
    changeRun() {
      binding = { ...binding, runId: "run_replaced" };
    },
  };
}

describe("private preview transport access", () => {
  it("requires an Omnyo JSON origin for access and rejects launch data in that operation", async () => {
    const f = await fixture();
    expect((await f.mint("null")).status).toBe(403);
    expect((await f.mint("https://evil.example")).status).toBe(403);
    expect(
      (await f.mint("http://localhost", '{"command":"shell"}')).status,
    ).toBe(400);
    expect(
      (await f.app.request("/preview-content/prv_registered/unknown/")).status,
    ).toBe(403);
    expect(
      (
        await f.app.request(
          f.contentBase.replace("prv_registered", "prv_other") + "/",
        )
      ).status,
    ).toBe(403);
    expect(f.calls).toHaveLength(0);
  });
  it("never forwards Omnyo credentials into the host RPC or the target response into Omnyo cookies", async () => {
    const f = await fixture();

    const response = await f.app.request(f.contentBase + "/asset?q=1", {
      headers: {
        origin: "null",
        authorization: "Bearer omnyo-only",
        cookie: "omnyo=private",
        "x-omnyo-key": "private",
        accept: "text/plain",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(f.calls[0]).toMatchObject({
      type: "preview.http",
      previewId: "prv_registered",
      runId: "run_owner",
      path: "/asset?q=1",
      headers: [["accept", "text/plain"]],
    });
    f.changeRun();
    expect((await f.app.request(f.contentBase + "/")).status).toBe(409);
    expect(f.calls).toHaveLength(1);
  });
  it("admits and forwards the Next.js segment prefetch header", async () => {
    const f = await fixture();
    const path = `${f.contentBase}/templates?_rsc=segment`;

    const preflight = await f.app.request(path, {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "GET",
        "access-control-request-headers": "rsc,next-router-segment-prefetch",
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("null");
    expect(
      preflight.headers.get("access-control-allow-headers")?.split(/,\s*/u),
    ).toContain("next-router-segment-prefetch");
    expect(f.calls).toHaveLength(0);

    const response = await f.app.request(path, {
      headers: {
        origin: "null",
        rsc: "1",
        "next-router-segment-prefetch": "/_tree",
      },
    });

    expect(response.status).toBe(200);
    expect(f.calls).toEqual([
      expect.objectContaining({
        type: "preview.http",
        headers: expect.arrayContaining([
          ["next-router-segment-prefetch", "/_tree"],
          ["rsc", "1"],
        ]),
      }),
    ]);
  });
  it("keeps relative redirects inside the registered server and refuses an external redirect", async () => {
    const f = await fixture();
    f.setResponse({
      status: 302,
      headers: [["location", "../next?x=1"]],
      bodyBase64: "",
    });
    const relative = await f.app.request(f.contentBase + "/nested/path");
    expect(relative.status).toBe(302);
    expect(relative.headers.get("location")).toBe(f.contentBase + "/next?x=1");
    f.setResponse({
      status: 302,
      headers: [["location", "http://example.com/private"]],
      bodyBase64: "",
    });
    expect((await f.app.request(f.contentBase + "/")).status).toBe(502);
  });
  it("returns readable sandboxed HTML only for failed frame navigations", async () => {
    const f = await fixture();

    const navigation = await f.app.request(
      "/preview-content/prv_registered/unknown/path",
      { headers: { "sec-fetch-dest": "iframe" } },
    );

    expect(navigation.status).toBe(403);
    expect(navigation.headers.get("content-type")).toContain("text/html");
    expect(await navigation.text()).toContain("Can't load this page");
    expect(navigation.headers.get("content-security-policy")).toContain(
      "sandbox",
    );

    const asset = await f.app.request(
      "/preview-content/prv_registered/unknown/path",
    );

    expect(asset.headers.get("content-type")).toContain("application/json");
  });
  it("expires scoped access without replaying a host request", async () => {
    const f = await fixture(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await f.app.request(f.contentBase + "/")).status).toBe(403);
    expect(f.calls).toHaveLength(0);
  });
});
