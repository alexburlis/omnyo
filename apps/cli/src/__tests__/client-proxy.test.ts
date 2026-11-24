import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function stubProxyEnv(proxy: string) {
  for (const name of ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"])
    vi.stubEnv(name, "");
  vi.stubEnv("HTTP_PROXY", proxy);
  vi.stubEnv("http_proxy", proxy);
}

async function listenTunnelProxy(tunnels: string[]): Promise<string> {
  const proxyServer = createServer();

  proxyServer.on("connect", (req, clientSocket, head) => {
    tunnels.push(req.url ?? "");
    const [host, port] = (req.url ?? "").split(":");

    const upstream = connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
  });

  return listen(proxyServer);
}

it("sends CLI requests through the proxy named in the environment", async () => {
  const target = await listen(
    createServer((_req, res) => res.end("from target")),
  );

  const tunnels: string[] = [];
  const proxy = await listenTunnelProxy(tunnels);
  stubProxyEnv(`http://${proxy}`);
  vi.resetModules();
  const { cliFetch } = await import("../client.js");
  const response = await cliFetch(`http://${target}/api/v1/hosts`);

  expect(await response.text()).toBe("from target");
  expect(tunnels).toEqual([target]);
});

it("connects directly when no proxy is configured", async () => {
  const target = await listen(createServer((_req, res) => res.end("direct")));

  stubProxyEnv("");
  vi.resetModules();
  const { cliFetch } = await import("../client.js");

  expect(await (await cliFetch(`http://${target}`)).text()).toBe("direct");
});

it("sends plugin CLI commands through the proxy named in the environment", async () => {
  const target = await listen(
    createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ exitCode: 0, stdout: `ran ${req.method} ${req.url}` }),
      );
    }),
  );

  const tunnels: string[] = [];
  const proxy = await listenTunnelProxy(tunnels);
  stubProxyEnv(`http://${proxy}`);
  vi.resetModules();
  const { runPluginCliCommand } = await import("../plugin-cli-proxy.js");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output: string[] = [];
  stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  const exitCode = await runPluginCliCommand(
    `http://${target}`,
    "canvas",
    ["show"],
    { stdout, stderr },
    Readable.from([]),
  );

  expect(exitCode).toBe(0);
  expect(output.join("")).toContain("ran POST /api/v1/plugins/canvas/cli");
  expect(tunnels).toEqual([target]);
});
