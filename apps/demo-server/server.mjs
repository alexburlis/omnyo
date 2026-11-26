import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { api, READ_ONLY_ERROR } from "./fixtures.mjs";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const MAX_FRAME_BYTES = 0xffff;

const MAX_CONTROL_FRAME_BYTES = 125;

const MAX_PENDING_BYTES = 1 << 16;

const BAD_UPGRADE = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";

const PONG = Buffer.from(JSON.stringify({ type: "pong" }));

const ENCODINGS = [
  { name: "br", extension: ".br", pattern: /\bbr\b/u },
  { name: "gzip", extension: ".gz", pattern: /\bgzip\b/u },
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function indexFiles(dir, prefix, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const urlPath = `${prefix}/${entry.name}`;

    if (entry.isDirectory()) indexFiles(path, urlPath, files);
    else if (entry.isFile())
      files.set(urlPath, { path, size: statSync(path).size });
  }

  return files;
}

const FILES = indexFiles(PUBLIC_DIR, "", new Map());

if (!FILES.has("/index.html"))
  throw new Error(`No index.html in ${PUBLIC_DIR}`);

const sockets = new Set();

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function sendFile(req, res, urlPath) {
  const accepted = String(req.headers["accept-encoding"] ?? "");

  const encoding = ENCODINGS.find(
    (candidate) =>
      candidate.pattern.test(accepted) &&
      FILES.has(urlPath + candidate.extension),
  );

  const served = FILES.get(encoding ? urlPath + encoding.extension : urlPath);

  const headers = {
    "content-type": MIME_TYPES[extname(urlPath)] ?? "application/octet-stream",
    "content-length": served.size,
    "cache-control": urlPath.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "x-content-type-options": "nosniff",
    vary: "Accept-Encoding",
  };

  if (encoding) headers["content-encoding"] = encoding.name;
  res.writeHead(200, headers);

  if (req.method === "HEAD") res.end();
  else pipeline(createReadStream(served.path), res, () => {});
}

function publicOrigin(req) {
  const protocol =
    req.headers["x-forwarded-proto"] === "https" ? "https" : "http";

  return new URL(`${protocol}://${req.headers.host}`).origin;
}

async function handle(req, res) {
  let path;
  let query;
  let serverUrl;

  try {
    const url = new URL(req.url, "http://demo");

    path = decodeURIComponent(url.pathname);
    query = url.searchParams;
    serverUrl = publicOrigin(req);
  } catch {
    sendJson(res, 400, {
      error: { code: "bad_request", message: "Bad request." },
    });

    return;
  }

  const read = req.method === "GET" || req.method === "HEAD";
  const isApi = path === "/health" || path.startsWith("/api/");

  const result = isApi
    ? api({ method: req.method, path, query, serverUrl })
    : null;

  if (result) {
    sendJson(res, result.status, result.body);

    return;
  }

  if (isApi || !read) {
    sendJson(res, 501, READ_ONLY_ERROR);

    return;
  }

  const urlPath = FILES.has(path)
    ? path
    : path.startsWith("/assets/")
      ? null
      : "/index.html";

  if (!urlPath) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");

    return;
  }

  sendFile(req, res, urlPath);
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  const limit = opcode >= 0x8 ? MAX_CONTROL_FRAME_BYTES : MAX_FRAME_BYTES;

  if (!masked || length > limit) {
    return { opcode: 0x8, payload: Buffer.alloc(0), size: buffer.length };
  }

  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));

  for (let index = 0; index < length; index += 1)
    payload[index] ^= mask[index % 4];

  return { opcode, payload, size: offset + 4 + length };
}

function sendFrame(socket, opcode, payload) {
  if (!socket.writable) return;

  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.from([
          0x80 | opcode,
          126,
          payload.length >> 8,
          payload.length & 0xff,
        ]);

  socket.write(Buffer.concat([header, payload]));

  if (socket.writableLength > MAX_PENDING_BYTES) socket.destroy();
}

function isPing(payload) {
  try {
    return JSON.parse(payload.toString("utf8")).type === "ping";
  } catch {
    return false;
  }
}

function isSocketPath(req) {
  try {
    return new URL(req.url, "http://demo").pathname === "/ws";
  } catch {
    return false;
  }
}

function acceptWebSocket(req, socket, head) {
  socket.on("error", () => socket.destroy());
  const key = req.headers["sec-websocket-key"];

  if (
    !isSocketPath(req) ||
    String(req.headers.upgrade).toLowerCase() !== "websocket" ||
    typeof key !== "string"
  ) {
    socket.end(BAD_UPGRADE, () => socket.destroy());

    return;
  }

  const accept = createHash("sha1")
    .update(key + WEBSOCKET_GUID)
    .digest("base64");

  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  let buffer = Buffer.alloc(0);

  const receive = (chunk) => {
    if (!socket.writable) return;
    buffer = Buffer.concat([buffer, chunk]);
    let frame = readFrame(buffer);

    while (frame && socket.writable) {
      buffer = buffer.subarray(frame.size);

      if (frame.opcode === 0x1 && isPing(frame.payload))
        sendFrame(socket, 0x1, PONG);
      else if (frame.opcode === 0x9) sendFrame(socket, 0xa, frame.payload);
      else if (frame.opcode === 0x8) {
        sendFrame(socket, 0x8, frame.payload.subarray(0, 2));
        socket.end(() => socket.destroy());
      }

      frame = readFrame(buffer);
    }
  };

  socket.on("data", receive);
  receive(head);
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);

    if (res.headersSent) res.destroy();
    else
      sendJson(res, 500, {
        error: { code: "internal", message: "The demo server failed." },
      });
  });
});

server.on("upgrade", acceptWebSocket);

function stop() {
  server.close();
  server.closeAllConnections();

  for (const socket of sockets) socket.destroy();
}

process.on("SIGTERM", stop);

process.on("SIGINT", stop);

server.listen(
  Number(process.env.PORT ?? 8080),
  process.env.HOST ?? "0.0.0.0",
  () => {
    console.log(`omnyo-demo listening on ${server.address().port}`);
  },
);
