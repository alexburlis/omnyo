import { expect, it, vi } from "vitest";
import { fetchDesktopSession } from "../src/desktop-session.js";
import { listAccountServers } from "../src/list-servers.js";
import { redeemMachineCredential } from "../src/redeem-machine.js";

it("pins session credentials to the selected server without following redirects", async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://another.example" },
      }),
  );

  await expect(
    fetchDesktopSession(
      {
        serverUrl: "https://alice.omnyo.link",
        handle: "alice",
        credential: "test-credential",
      },
      fetchImpl,
    ),
  ).rejects.toThrow("Desktop session failed (302)");
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
    "https://alice.omnyo.link/api/connect/desktop-session",
    {
      method: "POST",
      headers: { "x-omnyo-connect-machine": "test-credential" },
      redirect: "error",
    },
  );
});

it("does not deliver the credential to a redirected local endpoint", async () => {
  const { createServer } = await import("node:http");
  const requests: string[] = [];

  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(request.url === "/redirected" ? 200 : 307, {
      location: "/redirected",
    });
    response.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();

    if (address === null || typeof address === "string")
      throw new Error("Local fixture has no port");
    await expect(
      fetchDesktopSession({
        serverUrl: `http://127.0.0.1:${address.port}`,
        handle: "fixture",
        credential: "synthetic-test-only",
      }),
    ).rejects.toThrow();
    await expect(
      listAccountServers({
        serverUrl: `http://127.0.0.1:${address.port}`,
        handle: "fixture",
        credential: "synthetic-test-only",
      }),
    ).rejects.toThrow();
    await expect(
      redeemMachineCredential({
        apexUrl: `http://127.0.0.1:${address.port}`,
        code: "SYNTHETIC",
      }),
    ).rejects.toThrow();
    expect(requests).toEqual([
      "/api/connect/desktop-session",
      "/api/connect/servers",
      "/api/connect/redeem-machine",
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
