import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  brotliCompress,
  constants as zlibConstants,
  createGzip,
  gzip,
} from "node:zlib";
import { promisify } from "node:util";

import site from "./dist/server/server-entry.js";

const clientRoot = fileURLToPath(new URL("./dist/client/", import.meta.url));

const port = Number(process.env.PORT ?? "8080");

const host = process.env.HOSTNAME ?? "0.0.0.0";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const compressibleExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".svg",
  ".txt",
]);

const compressibleTypes =
  /^(?:text\/|application\/(?:json|javascript|xml|rss\+xml|manifest\+json)|image\/svg\+xml)/;

const MIN_COMPRESSED_BYTES = 1024;

const compressBrotli = promisify(brotliCompress);

const compressGzip = promisify(gzip);

const compressedFiles = new Map();

function acceptedEncoding(request) {
  const header = String(request.headers["accept-encoding"] ?? "").toLowerCase();

  const offered = new Set(
    header
      .split(",")
      .map((part) => part.trim())
      .filter((part) => !/;\s*q=0(?:\.0*)?$/.test(part))
      .map((part) => part.split(";")[0].trim()),
  );

  if (offered.has("br")) return "br";

  if (offered.has("gzip")) return "gzip";

  return null;
}

function compressedFile(file, encoding) {
  const key = `${encoding}:${file}`;
  let entry = compressedFiles.get(key);

  if (entry === undefined) {
    entry = readFile(file).then((bytes) =>
      encoding === "br"
        ? compressBrotli(bytes, {
            params: {
              [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
              [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
            },
          })
        : compressGzip(bytes, { level: 6 }),
    );
    entry.catch(() => compressedFiles.delete(key));
    compressedFiles.set(key, entry);
  }

  return entry;
}

async function staticFile(pathname) {
  let decoded;

  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const file = normalize(join(clientRoot, decoded));

  if (!file.startsWith(clientRoot) || file.endsWith(sep)) return null;

  const info = await stat(file).catch(() => null);

  return info?.isFile() ? { file, size: info.size } : null;
}

async function sendStatic(request, response, { file, size }, pathname) {
  const extension = extname(file).toLowerCase();
  const compressible = compressibleExtensions.has(extension);

  const encoding =
    compressible && size >= MIN_COMPRESSED_BYTES
      ? acceptedEncoding(request)
      : null;

  const compressed =
    encoding === null ? null : await compressedFile(file, encoding);

  response.writeHead(200, {
    "content-type": contentTypes[extension] ?? "application/octet-stream",
    "content-length": String(compressed === null ? size : compressed.length),
    ...(compressed === null ? {} : { "content-encoding": encoding }),
    ...(compressible ? { vary: "accept-encoding" } : {}),
    "cache-control": pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600",
    "x-content-type-options": "nosniff",
  });

  if (request.method === "HEAD") {
    response.end();

    return;
  }

  if (compressed !== null) {
    response.end(compressed);

    return;
  }

  await pipeline(createReadStream(file), response);
}

function requestUrl(request) {
  const base = `http://${request.headers.host ?? "localhost"}`;

  return URL.canParse(request.url ?? "/", base)
    ? new URL(request.url ?? "/", base)
    : null;
}

function webRequest(request, url) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  return new Request(url, {
    method: request.method,
    headers,
    body: hasBody ? Readable.toWeb(request) : undefined,
    duplex: hasBody ? "half" : undefined,
  });
}

async function sendWeb(request, response, result) {
  const headers = {};

  for (const [name, value] of result.headers) {
    if (name !== "set-cookie") headers[name] = value;
  }

  const cookies = result.headers.getSetCookie();

  if (cookies.length > 0) headers["set-cookie"] = cookies;

  const compress =
    result.body !== null &&
    request.method !== "HEAD" &&
    result.status !== 204 &&
    result.status !== 304 &&
    !result.headers.has("content-encoding") &&
    compressibleTypes.test(result.headers.get("content-type") ?? "") &&
    acceptedEncoding(request) !== null;

  if (compress) {
    delete headers["content-length"];
    headers["content-encoding"] = "gzip";
    headers.vary = headers.vary
      ? `${headers.vary}, accept-encoding`
      : "accept-encoding";
  }

  response.writeHead(result.status, result.statusText, headers);

  if (result.body === null || request.method === "HEAD") {
    response.end();

    return;
  }

  if (compress) {
    await pipeline(
      Readable.fromWeb(result.body),
      createGzip({ flush: zlibConstants.Z_SYNC_FLUSH }),
      response,
    );

    return;
  }

  await pipeline(Readable.fromWeb(result.body), response);
}

async function handle(request, response) {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (request.method === "GET" || request.method === "HEAD") {
    const file = pathname === "/" ? null : await staticFile(pathname);

    if (file !== null) {
      await sendStatic(request, response, file, pathname);

      return;
    }
  }

  const url = requestUrl(request);

  if (url === null) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Bad Request");

    return;
  }

  await sendWeb(request, response, await site.fetch(webRequest(request, url)));
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error(error);

    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Internal Server Error");
    } else {
      response.destroy(error);
    }
  });
});

function shutDown() {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
}

let crashing = false;

function crash(error) {
  console.error(error);

  if (crashing) return;
  crashing = true;
  const exit = () => process.exit(1);

  site.reportFatalServerError(error).then(exit, exit);
}

process.on("uncaughtException", crash);

process.once("SIGTERM", shutDown);

process.once("SIGINT", shutDown);

server.listen(port, host, () => {
  console.log(`Omnyo site listening on http://${host}:${port}`);
});
