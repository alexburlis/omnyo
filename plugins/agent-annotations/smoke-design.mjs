import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [
  coreInput,
  evidenceInput,
  scratchInput,
  hostId,
  instanceId,
  threadId,
  scaleInput,
] = process.argv.slice(2);

const core = resolve(coreInput),
  evidence = resolve(evidenceInput),
  scale = Number(scaleInput);

assert.ok(scale === 0 || scale === 1 || scale === 2);

const source = resolve(new URL("visual-capture.ts", import.meta.url).pathname);

const sourceHash = createHash("sha256")
  .update(await readFile(source))
  .digest("hex");

const { createNodeOmnyoSdk } = await import(
  pathToFileURL(join(core, "packages/sdk/src/node.ts")).href
);

const sdk = createNodeOmnyoSdk({ timeoutMs: 8000 });

const { rpcContract } = await import(
  pathToFileURL(join(core, "plugins/browser-automation/contracts.ts")).href
);

const { build } = createRequire(join(core, "package.json"))("esbuild");

const built = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "omnyoDesignCapture",
  platform: "browser",
  alias: {
    zod: createRequire(
      join(core, "plugins/agent-annotations/package.json"),
    ).resolve("zod"),
  },
});

const renderer = built.outputFiles[0].text;

const policySource = resolve(
  new URL("../../apps/desktop/src/desktop-browser-capture.ts", import.meta.url)
    .pathname,
);

const policyHash = createHash("sha256")
  .update(await readFile(policySource))
  .digest("hex");

const policyBuild = await build({
  entryPoints: [policySource],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "omnyoNativeCapturePolicy",
  platform: "browser",
  alias: {
    zod: createRequire(
      join(core, "plugins/agent-annotations/package.json"),
    ).resolve("zod"),
  },
  plugins: [
    {
      name: "native-image-boundary",
      setup(api) {
        api.onResolve({ filter: /^electron$/ }, () => ({
          path: "electron",
          namespace: "fixture",
        }));
        api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `export const nativeImage={createFromBuffer(bytes){let offset=2;while(offset+9<bytes.length){const marker=bytes[offset+1];if(marker>=192&&marker<=207&&![196,200,204].includes(marker))return {bytes,width:bytes.readUInt16BE(offset+7),height:bytes.readUInt16BE(offset+5),isEmpty:()=>false};offset+=2+bytes.readUInt16BE(offset+2);}throw new Error('Invalid native JPEG');}};`,
        }));
      },
    },
  ],
});

const policyRenderer = policyBuild.outputFiles[0].text;

const scratch = await mkdtemp(join(resolve(scratchInput), "design-native-"));

const ownerFile = join(evidence, `design-native-dpr${scale}-owner.json`);

await writeFile(
  ownerFile,
  JSON.stringify(
    {
      owner: threadId,
      scratch,
      source,
      sourceHash,
      hostId,
      instanceId,
      scale,
      status: "preparing",
      disposable: true,
    },
    null,
    2,
  ),
);

let phase = "before",
  scope,
  tabId,
  session,
  origin,
  captures = 0,
  proof;

const nonce = randomUUID(),
  imagePaths = [],
  deadline = AbortSignal.timeout(40_000);

const rpc = (method, input, signal = deadline) =>
  sdk.plugins.callRpc({
    pluginId: "browser-automation",
    method,
    input,
    outputSchema: rpcContract[method].output,
    signal,
  });

const fixture =
  () => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:1800px;height:2400px;background:rgb(20,30,200)}#pay{position:absolute;left:300px;top:700px;width:100px;height:40px;border:0;padding:0;background:${phase === "before" ? "rgb(240,20,30)" : "rgb(20,240,30)"};color:transparent}</style><button id="pay" data-omnyo-annotation-fixture="">Pay</button><script>${renderer}</script><script>
window.captureFixture=async function(baseline,mutation){
 const target=document.querySelector('#pay'),rect=target.getBoundingClientRect();
 const annotation={id:'fixture',number:1,comment:'Visual fixture',url:location.href,title:'Fixture',viewport:{width:innerWidth,height:innerHeight},element:{tagName:'button',name:'Pay',selector:'#pay',text:'Pay',attributes:{id:'pay'},styles:{},rect:{x:Math.round(rect.x+scrollX),y:Math.round(rect.y+scrollY),width:Math.round(rect.width),height:Math.round(rect.height)}}};
 const page={evaluate:async expression=>(0,eval)(expression),experimental_capture:async()=>{const capture=await omnyoControlledCapture();window.fixtureCaptures=capture.captureIndex;if(mutation==='move')target.style.left='330px';if(mutation==='replace')target.outerHTML=target.outerHTML;return capture;}};
 const result=await omnyoDesignCapture.captureElement(page,annotation,baseline);
 const bitmap=await createImageBitmap(result.blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);const pixel=[...context.getImageData(Math.floor(bitmap.width/2),Math.floor(bitmap.height/2),1,1).data];
 const bytes=new Uint8Array(await result.blob.arrayBuffer());let binary='';for(const value of bytes)binary+=String.fromCharCode(value);await fetch('/image/${nonce}',{method:'POST',body:JSON.stringify({base64:btoa(binary),captures:window.fixtureCaptures})});bitmap.close();return {observation:result.observation,width:canvas.width,height:canvas.height,pixel};
};</script>`;

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/policy.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(policyRenderer);

      return;
    }

    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end(fixture());

      return;
    }

    assert.equal(request.headers.host, new URL(origin).host);

    if (request.url === `/capture/${nonce}`) {
      assert.ok(scope && tabId && captures < 8);
      captures += 1;

      const capture = await sdk.experimental_desktopBrowsers.captureTab({
        ...scope,
        tabId,
      });

      assert.equal(capture.mimeType, "image/jpeg");
      assert.ok(capture.width > 0 && capture.height > 0);

      if (captures === 1)
        await writeFile(
          join(evidence, `design-native-full-dpr${scale}.jpg`),
          Buffer.from(capture.base64, "base64"),
        );
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(capture));

      return;
    }

    if (request.url === `/image/${nonce}` && request.method === "POST") {
      let size = 0;
      const chunks = [];

      for await (const chunk of request) {
        size += chunk.length;
        assert.ok(size < 1_000_000);
        chunks.push(chunk);
      }

      const { base64, captures: count } = JSON.parse(
        Buffer.concat(chunks).toString(),
      );

      captures = count;

      const path = join(
        evidence,
        `design-native-${imagePaths.length === 0 ? "before" : "result"}-dpr${scale}.jpg`,
      );

      await writeFile(path, Buffer.from(base64, "base64"));
      imagePaths.push(path);
      response.end("ok");

      return;
    }

    response.writeHead(404).end();
  } catch (error) {
    response
      .writeHead(500)
      .end(error instanceof Error ? error.message : "Capture failed");
  }
});

try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${server.address().port}`;

  const { instances } = await sdk.experimental_desktopBrowsers.listInstances({
    hostId,
  });

  const instance = instances.find((value) => value.instanceId === instanceId);
  assert.ok(instance, "The selected desktop window is unavailable");
  scope = { hostId, instanceId, generation: instance.generation, threadId };
  const prior = await sdk.experimental_desktopBrowsers.listTabs(scope);
  session = await rpc("open", {
    threadId,
    selection: { backend: "desktop", hostId, instanceId },
  });
  assert.equal(session.state, "ready");
  const after = await sdk.experimental_desktopBrowsers.listTabs(scope);

  const created = after.tabs.filter(
    (value) => !prior.tabs.some((old) => old.tabId === value.tabId),
  );

  assert.equal(
    created.length,
    1,
    "The session must own exactly one new native tab",
  );
  tabId = created[0].tabId;
  await writeFile(
    ownerFile,
    JSON.stringify(
      {
        owner: threadId,
        scratch,
        source,
        sourceHash,
        ...scope,
        tabId,
        sessionId: session.id,
        scale,
        status: "running",
        disposable: true,
      },
      null,
      2,
    ),
  );

  const run = async (script) => {
    const output = await rpc("run", {
      threadId,
      sessionId: session.id,
      timeoutMs: 20_000,
      script,
    });

    assert.equal(output.exitCode, 0, output.text);

    for (const image of output.images)
      await copyFile(
        image.path,
        join(evidence, `design-native-cdp-dpr${scale}.jpg`),
      );

    return JSON.parse(output.text.trim());
  };

  const setup = `const p=await browser.getPage('main');if(typeof p.exposeFunction!=='function'||typeof p.createCDPSession!=='function')throw new Error('Owned CDP callback capability unavailable');(0,eval)(await (await fetch(${JSON.stringify(origin + "/policy.js")})).text());const child=await p.createCDPSession();let count=0;const contents={debugger:{isAttached:()=>true,sendCommand:(method,params)=>child.send(method,params),attach:()=>{throw new Error('Unexpected attachment')},detach:()=>{throw new Error('Foreign attachment must remain')},on:()=>{},off:()=>{}},capturePage:async()=>({isEmpty:()=>false}),isDestroyed:()=>false,getBackgroundThrottling:()=>true,setBackgroundThrottling:()=>{throw new Error('Unexpected throttling change')}};await p.exposeFunction('omnyoControlledCapture',async()=>{const image=await omnyoNativeCapturePolicy.captureDesktopBrowserPage(contents);count+=1;return {base64:image.bytes.toString('base64'),width:image.width,height:image.height,mimeType:'image/jpeg',captureIndex:count}});await p.exposeFunction('omnyoReleaseCapture',()=>child.detach());JSON.stringify(true)`;
  assert.equal(await run(setup), true);

  const before = await run(
    `const p=await browser.getPage('main');await p.setViewport({width:1000,height:600,deviceScaleFactor:${scale || 2},isMobile:false,hasTouch:false});await p.goto(${JSON.stringify(origin)});await p.evaluate('scrollTo(200,500)');const paint=await p.evaluate("Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({painted:true,visibility:document.visibilityState,ready:document.readyState})))),new Promise(resolve=>setTimeout(()=>resolve({painted:false,visibility:document.visibilityState,ready:document.readyState}),1500))])");const result=await p.evaluate('captureFixture()');JSON.stringify({...result,paint})`,
  );

  if (scale !== 0) assert.equal(before.observation.viewport.dpr, scale);
  await writeFile(
    join(evidence, `design-native-observation-dpr${scale}.json`),
    JSON.stringify(before, null, 2),
  );
  assert.deepEqual(
    [before.observation.viewport.scrollX, before.observation.viewport.scrollY],
    [200, 500],
  );
  assert.ok(
    before.pixel[0] > 200 && before.pixel[1] < 60 && before.pixel[2] < 70,
    JSON.stringify(before.pixel),
  );

  const rejected = await run(
    "const p=await browser.getPage('main');const cases=await p.evaluate(`(async()=>{const cases=[];for(const mutation of ['move','replace']){try{await captureFixture(undefined,mutation);throw new Error('stale capture accepted')}catch(error){if(!error.message.includes('page changed during capture'))throw error;cases.push(mutation)}document.querySelector('#pay').style.left='300px'}return cases})()`);JSON.stringify(cases)",
  );

  assert.deepEqual(rejected, ["move", "replace"]);
  phase = "result";

  const result = await run(
    `const p=await browser.getPage('main');await p.goto(${JSON.stringify(origin)});await p.setViewport({width:${before.observation.viewport.width},height:${before.observation.viewport.height},deviceScaleFactor:${before.observation.viewport.dpr},isMobile:false,hasTouch:false});await p.evaluate('scrollTo(200,500)');await p.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const result=await p.evaluate(${JSON.stringify(`captureFixture(${JSON.stringify(before.observation)})`)});JSON.stringify(result)`,
  );

  assert.notEqual(result.observation.documentId, before.observation.documentId);
  assert.deepEqual(result.observation.viewport, before.observation.viewport);
  assert.ok(
    result.pixel[1] > 200 && result.pixel[0] < 60 && result.pixel[2] < 70,
    JSON.stringify(result.pixel),
  );

  const changed = await run(
    `const p=await browser.getPage('main');await p.evaluate('scrollTo(200,501)');const message=await p.evaluate(${JSON.stringify(`captureFixture(${JSON.stringify(before.observation)}).then(()=>{throw new Error('changed viewport accepted')},error=>error.message)`)});JSON.stringify(message)`,
  );

  assert.match(changed, /original route, scroll position and viewport/);
  assert.equal(
    sourceHash,
    createHash("sha256")
      .update(await readFile(source))
      .digest("hex"),
  );
  proof = {
    status: "passed",
    surface:
      "source-local capture policy through the existing owned Omnyo native CDP connection with worktree captureElement",
    imageBoundary:
      "nativeImage wrapper replaced by JPEG dimensions; browser decodes actual native bytes",
    viewportEmulated: true,
    installedSdk: "unchanged black-frame before-state",
    policySource,
    policyHash,
    source,
    sourceHash,
    scale,
    ...scope,
    tabId,
    sessionId: session.id,
    captures,
    crop: { width: before.width, height: before.height },
    paint: before.paint,
    actualDpr: before.observation.viewport.dpr,
    beforePixel: before.pixel,
    resultPixel: result.pixel,
    cases: [
      "document scroll",
      "actual DPR",
      "native bitmap crop",
      "same-document movement rejected",
      "DOM replacement rejected",
      "fresh document result paired",
      "changed viewport rejected",
    ],
    images: imagePaths,
  };
} catch (error) {
  proof = {
    status: "failed",
    source,
    sourceHash,
    scale,
    captures,
    error: error instanceof Error ? error.message : String(error),
  };
  throw error;
} finally {
  const cleanup = {};

  if (session) {
    try {
      await rpc(
        "run",
        {
          threadId,
          sessionId: session.id,
          timeoutMs: 3000,
          script:
            "const p=await browser.getPage('main');await p.evaluate('omnyoReleaseCapture()');undefined",
        },
        AbortSignal.timeout(5000),
      );
    } catch (error) {
      cleanup.childSessionError =
        error instanceof Error ? error.message : String(error);
    }

    try {
      const closed = await rpc(
        "close",
        { threadId, sessionId: session.id },
        AbortSignal.timeout(8000),
      );

      cleanup.sessionClosed = closed.state === "closed";
      const tabs = await sdk.experimental_desktopBrowsers.listTabs(scope);
      cleanup.ownedTabAbsent = !tabs.tabs.some(
        (value) => value.tabId === tabId,
      );
    } catch (error) {
      cleanup.error = error instanceof Error ? error.message : String(error);
    }
  }

  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(scratch, { recursive: true });
  cleanup.scratchAbsent = true;
  await writeFile(
    join(evidence, `design-native-dpr${scale}.json`),
    JSON.stringify({ ...proof, cleanup }, null, 2),
  );
}

console.log(
  JSON.stringify({
    status: proof.status,
    scale,
    captures,
    sourceHash,
    images: imagePaths.length,
  }),
);
