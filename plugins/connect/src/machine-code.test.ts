import { createServer, type Server, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { redeemMachineCode } from "./machine-code.js";

const servers: Server[] = [];

async function fixture(reply: RequestListener) {
  const server = createServer(reply);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const address = server.address();

  if (address === null || typeof address === "string")
    throw new Error("Missing fixture address");

  return {
    origin: `http://localhost:${address.port}`,
    serverUrl: `http://tenant.localhost:${address.port}`,
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

describe("machine code redemption origin", () => {
  it("keeps the machine credential bound to the requested tenant", async () => {
    const site = await fixture((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          credential: "fixture",
          machineId: "machine-kept",
          serverUrl: site.serverUrl,
        }),
      );
    });

    expect(
      await redeemMachineCode({
        serverUrl: site.serverUrl,
        code: "fixture-code",
        signal: new AbortController().signal,
      }),
    ).toEqual({
      credential: "fixture",
      machineId: "machine-kept",
      serverUrl: site.serverUrl,
    });
  });

  it("refuses a different tenant returned with the machine credential", async () => {
    const site = await fixture((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          credential: "fixture",
          machineId: "machine-kept",
          serverUrl: "https://other.omnyo.link",
        }),
      );
    });

    await expect(
      redeemMachineCode({
        serverUrl: site.serverUrl,
        code: "fixture-code",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("different server origin");
  });

  it("never forwards the one-time code through a redirect", async () => {
    let forwarded = 0;

    const target = await fixture((_request, response) => {
      forwarded += 1;
      response.end();
    });

    const source = await fixture((_request, response) => {
      response.writeHead(307, {
        location: `${target.origin}/api/connect/redeem-machine`,
      });
      response.end();
    });

    await expect(
      redeemMachineCode({
        serverUrl: source.serverUrl,
        code: "fixture-code",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(forwarded).toBe(0);
  });
});
