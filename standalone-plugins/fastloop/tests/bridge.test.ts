import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SdkBridge } from "../bridge.js";

it("executes only finite public SDK methods in Node 24 and drains before scoped close", async () => {
  const root = await mkdtemp(join(tmpdir(), "fastloop-bridge-contract-"));
  let bridge: SdkBridge | undefined;

  try {
    const versions = join(homedir(), ".nvm/versions/node");

    const version = (await readdir(versions))
      .filter((name) => name.startsWith("v24."))
      .sort()
      .at(-1);

    if (!version) throw new Error("The bridge qualification requires an installed Node 24.");
    const sdkPath = join(root, "sdk.mjs");
    await writeFile(
      sdkPath,
      `import {writeFile} from "node:fs/promises";
export async function createClient(options){return {
 lookupSubmission: async requestId => ({requestId,clientId:options.clientId,node:process.versions.node}),
 events: async (runId,after,waitMs) => {await new Promise(r=>setTimeout(r,waitMs));return {runId,after}},
 artifact: async () => ({evidence:{id:"evidence"},mimeType:"text/plain",bytes:new Uint8Array([104,105])}),
 dispose: async () => {},
 close: async () => {await writeFile(options.projectRoot+"/closed.json",JSON.stringify(options))}
}}`,
    );
    bridge = await SdkBridge.connect({
      nodeExecutable: join(versions, version, "bin/node"),
      sdkPath,
      projectRoot: root,
      dataRoot: root,
      clientId: "owned-thread-scope",
      onExit() {},
    });
    const found = await bridge.request("submission", { requestId: "request-a" });
    expect(found).toMatchObject({
      requestId: "request-a",
      clientId: "owned-thread-scope",
      node: expect.stringMatching(/^24\./),
    });
    expect(
      await bridge.request("artifact", { runId: "run-a", evidenceId: "evidence" }),
    ).toMatchObject({ bytesBase64: "aGk=", mimeType: "text/plain" });
    const pending = bridge.request("events", { runId: "run-a", after: 3, waitMs: 50 });
    await bridge.close();
    expect(await pending).toEqual({ runId: "run-a", after: 3 });
    expect(JSON.parse(await readFile(join(root, "closed.json"), "utf8"))).toMatchObject({
      clientId: "owned-thread-scope",
      projectRoot: root,
      dataRoot: root,
    });
    await expect(bridge.request("result", { runId: "run-a" })).rejects.toThrow(
      "RUNTIME_CLIENT_CLOSED",
    );
  } finally {
    await bridge?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 5000);

it("opens the readonly SDK archive with persistent dataRoot and refuses mutation methods", async () => {
  const root = await mkdtemp(join(tmpdir(), "fastloop-archive-bridge-"));
  let bridge: SdkBridge | undefined;

  try {
    const versions = join(homedir(), ".nvm/versions/node");

    const version = (await readdir(versions))
      .filter((name) => name.startsWith("v24."))
      .sort()
      .at(-1);

    if (!version) throw new Error("Node24 qualification is required");
    const sdkPath = join(root, "archive.mjs");
    await writeFile(
      sdkPath,
      `export async function createClient(){throw Error("live client must never start")}
export async function openArchive(options){return {result:async(runId)=>({runId,options}),artifact:async()=>({evidence:{id:"report"},mimeType:"text/plain",bytes:new Uint8Array([120])}),close:async()=>{}}}`,
    );
    bridge = await SdkBridge.connect({
      nodeExecutable: join(versions, version, "bin/node"),
      sdkPath,
      projectRoot: join(root, "missing-checkout"),
      dataRoot: root,
      clientId: "owned",
      archive: true,
      onExit() {},
    });
    expect(await bridge.request("result", { runId: "run-a" })).toMatchObject({
      options: { dataRoot: root, projectRoot: join(root, "missing-checkout"), clientId: "owned" },
    });
    await expect(
      bridge.request("submit", { requestId: "forbidden", submission: {} }),
    ).rejects.toThrow("ARCHIVE_READ_ONLY");
    expect(
      await bridge.request("artifact", { runId: "run-a", evidenceId: "report" }),
    ).toMatchObject({ bytesBase64: "eA==" });
  } finally {
    await bridge?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 5000);
