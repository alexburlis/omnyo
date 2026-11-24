import { createServer } from "node:http";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createUsageCollector } from "./collector.js";

const [file, portText] = process.argv.slice(2);

const port = Number(portText);

if (
  !file ||
  !isAbsolute(file) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
) {
  throw new Error(
    "Usage: node dist/usage-collector.js /absolute/path/usage.sqlite PORT",
  );
}

process.umask(0o077);

const database = new DatabaseSync(file);

const collector = createUsageCollector(database);

const server = createServer(
  { requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8192 },
  (req, res) => {
    void collector.respond(req, res);
  },
);

const maintenance = setInterval(collector.maintain, 30_000).unref();

server.on("close", () => {
  clearInterval(maintenance);
  database.close();
});

process.once("SIGTERM", () => server.close());

process.once("SIGINT", () => server.close());

server.listen(port, "127.0.0.1");
