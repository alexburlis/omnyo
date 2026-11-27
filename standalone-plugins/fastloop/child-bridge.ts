export const childBridgeSource = String.raw`
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const [sdkPath, projectRoot, clientId, dataRoot, mode] = process.argv.slice(1);
const parent = process.ppid;
const pending = new Set();
let closing;
let client;
let connecting;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const code = (error) => typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : "RUNTIME_SDK_CALL_FAILED";
const close = () => closing ??= (async () => {
  clearInterval(orphan);
  if (connecting) await connecting.catch(() => {});
  if (client) {
    if (typeof client.dispose === "function") await client.dispose();
    await Promise.allSettled([...pending]);
    await client.close();
  }
})();
const orphan = setInterval(() => {
  if (process.ppid !== parent) void close().finally(() => process.exit(1));
}, 500);

try {
  const sdk = await import(pathToFileURL(sdkPath).href);
  const factory = mode === "archive" ? sdk.openArchive : sdk.createClient;
  if (typeof factory !== "function") throw Object.assign(new Error(), {code:"RUNTIME_ARCHIVE_CAPABILITY_REQUIRED"});
  connecting = factory({ projectRoot, clientId, ...(dataRoot ? {dataRoot} : {}) }).then((value) => {client = value});
  await connecting;
  if (mode !== "archive" && (typeof client.lookupSubmission !== "function" || typeof client.dispose !== "function")) throw Object.assign(new Error(), { code: "RUNTIME_SCOPE_CAPABILITY_REQUIRED" });
  send({ ready: true, node: process.versions.node });
} catch (error) {
  send({ ready: false, code: code(error) });
  await close();
  process.exit(1);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let request;
  try {
    if (Buffer.byteLength(line) > 1048576) throw Error();
    request = JSON.parse(line);
    if (!request || typeof request.id !== "string" || typeof request.method !== "string") throw Error();
  } catch {
    send({ id: "invalid", ok: false, code: "RUNTIME_BRIDGE_INPUT_INVALID" });
    return;
  }
  if (request.method === "close") {
    void close().then(() => {send({id: request.id, ok: true, result: {closed: true}}); process.exit(0)}, (error) => {send({id: request.id, ok: false, code: code(error)}); process.exit(1)});
    return;
  }
  if (closing) {send({id: request.id, ok: false, code: "RUNTIME_CLIENT_CLOSED"}); return}
  const task = (async () => {
    try {
      if (mode === "archive" && !["result", "artifact"].includes(request.method)) throw Object.assign(new Error(), {code:"ARCHIVE_READ_ONLY"});
      const p = request.payload;
      let result;
      switch (request.method) {
        case "submit": result = await client.submit(p.submission, {requestId: p.requestId}); break;
        case "submission": result = await client.lookupSubmission(p.requestId); break;
        case "result": result = await client.result(p.runId); break;
        case "events": result = await client.events(p.runId, p.after ?? 0, p.waitMs ?? 0); break;
        case "cancel": result = await client.cancel(p.runId); break;
        case "artifact": {
          const artifact = await client.artifact({runId:p.runId,evidenceId:p.evidenceId,maxBytes:p.maxBytes ?? 10485760});
          result = {evidence: artifact.evidence, mimeType: artifact.mimeType, bytesBase64: Buffer.from(artifact.bytes).toString("base64")};
          break;
        }
        default: throw Object.assign(new Error(), {code:"RUNTIME_BRIDGE_METHOD_INVALID"});
      }
      send({id:request.id,ok:true,result});
    } catch (error) {send({id:request.id,ok:false,code:code(error)})}
  })();
  pending.add(task);
  void task.finally(() => pending.delete(task));
});
lines.on("close", () => {void close().finally(() => process.exit(0))});
process.on("SIGTERM", () => {void close().finally(() => process.exit(0))});
`;
