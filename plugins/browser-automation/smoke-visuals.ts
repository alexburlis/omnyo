import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "./runtime.js";
import {
  visualObservationSchema,
  nativeViewportSchema,
  viewportSchema,
} from "./contracts.js";
import {
  observeScript,
  inspectScript,
  viewportScript,
} from "./visual-scripts.js";
import { z } from "zod";

const binary = resolve(
  z.string().min(1).parse(process.env.DEV_BROWSER_SMOKE_BINARY),
);

const chrome = resolve(
  z.string().min(1).parse(process.env.DEV_BROWSER_SMOKE_CHROME),
);

const parent = resolve(z.string().min(1).parse(process.argv[2]));

assert.ok((await stat(parent)).isDirectory());

const root = await mkdtemp(join(tmpdir(), "omnyo-browser-visuals-"));

const ownerReceipt = join(parent, "browser-visual-smoke-owner.json");

const ownership = {
  owner: "browser-automation/smoke:visuals",
  scratch: root,
  class: "disposable browser fixture",
  restoreInputs:
    "pinned installed runtime, Chrome and tracked synthetic fixture",
  expectedBytes: 120000000,
};

await writeFile(
  ownerReceipt,
  JSON.stringify({ ...ownership, status: "preparing" }, null, 2),
);

const signal = AbortSignal.timeout(50_000);

let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;

const checks: string[] = [];

const fixtureHtml =
  '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;height:1800px}#selected{position:absolute;top:700px;left:30px;width:120px;height:60px;background:rgb(255,0,0);color:rgb(255,0,0);border:0}</style><button id="selected">Selected</button><input aria-label="Password" type="password" value="masked-test-marker" style="position:fixed;right:10px;top:10px">';

const fixtureServer = createServer((request, response) => {
  if (request.url !== "/visual.html") {
    response.writeHead(404).end();

    return;
  }

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(fixtureHtml);
});

try {
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(0, "127.0.0.1", () => {
      fixtureServer.off("error", reject);
      resolve();
    });
  });
  const address = fixtureServer.address();
  assert.ok(address !== null && typeof address !== "string");
  const fixture = `http://127.0.0.1:${address.port}/visual.html`;

  const dataDir = join(root, "data");
  await mkdir(join(dataDir, "runtime"), { recursive: true });
  await symlink(chrome, join(dataDir, "runtime", "chrome"));
  runtime = await createRuntime({
    runtime: { binary, version: "1.0.0-rc.4", source: "developer-artifact" },
    dataDir,
    tempDir: join(root, "sessions"),
    signal,
  });
  const session = runtime;

  const run = async (script: string) => {
    const result = await session.run(script, 10_000, signal);
    assert.equal(result.exitCode, 0, result.text);

    return result;
  };

  const initial = await run(
    `const p=await browser.getPage("visual-main"); await p.goto(${JSON.stringify(fixture)}); await p.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true}); await p.evaluate(()=>scrollTo(0,600)); JSON.stringify({id:(await browser.listPages()).find(page=>page.name==="visual-main").id,coarse:await p.evaluate(()=>matchMedia("(pointer:coarse)").matches),touch:await p.evaluate(()=>navigator.maxTouchPoints)})`,
  );

  const target = z
    .object({
      id: z.string(),
      coarse: z.literal(true),
      touch: z.number().positive(),
    })
    .parse(JSON.parse(initial.text));

  checks.push("actual phone viewport, DPR2 and coarse touch");

  const observe = async () => {
    const result = await run(observeScript(target.id, randomUUID()));
    assert.equal(result.images.length, 1);

    return {
      observation: visualObservationSchema.parse(JSON.parse(result.text)),
      image: result.images[0]!,
    };
  };

  const before = await observe();
  assert.equal(before.observation.targetId, target.id);
  assert.equal(before.observation.viewport.scrollY, 600);
  assert.equal(before.observation.viewport.width, 390);
  assert.equal(before.observation.viewport.dpr, 2);
  assert.equal(before.observation.url, fixture);
  assert.ok(!JSON.stringify(before.observation).includes("masked-test-marker"));

  const chosen = before.observation.elements.find(
    (element) => element.selector === "#selected",
  );

  assert.ok(chosen);

  const crop = await run(
    inspectScript(target.id, before.observation.id, chosen.id),
  );

  assert.equal(crop.images.length, 1);
  const bytes = await readFile(crop.images[0]!.path);

  const pixels = await run(
    `const p=await browser.getPage(${JSON.stringify(target.id)}); await p.evaluate(async data=>{const image=new Image();image.src="data:image/jpeg;base64,"+data;await image.decode();const canvas=document.createElement("canvas");canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext("2d");ctx.drawImage(image,0,0);return {width:image.naturalWidth,height:image.naturalHeight,pixel:Array.from(ctx.getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data)};},${JSON.stringify(bytes.toString("base64"))})`,
  );

  const actual = z
    .object({
      width: z.number().positive(),
      height: z.number().positive(),
      pixel: z.array(z.number()).length(4),
    })
    .parse(JSON.parse(pixels.text));

  assert.equal(actual.width / actual.height, 2);
  assert.ok(
    actual.pixel[0]! > 230 && actual.pixel[1]! < 30 && actual.pixel[2]! < 30,
  );
  await writeFile(join(parent, "browser-visual-crop.jpg"), bytes);
  checks.push("scrolled crop actual pixels and 2:1 bitmap geometry");

  for (const [label, mutation] of [
    [
      "same-document movement",
      'document.querySelector("#selected").style.left="70px"',
    ],
    [
      "same-document replacement",
      'const node=document.querySelector("#selected");node.replaceWith(node.cloneNode(true))',
    ],
    [
      "new visible occluder",
      'const node=document.createElement("div");node.style="position:fixed;inset:0;background:white";document.body.append(node)',
    ],
  ]) {
    const frozen = await observe();

    const selected = frozen.observation.elements.find(
      (element) => element.selector === "#selected",
    );

    assert.ok(selected);
    await run(
      `const p=await browser.getPage(${JSON.stringify(target.id)}); await p.evaluate(${JSON.stringify(`(()=>{${mutation}})()`)}); undefined`,
    );

    const stale = await session.run(
      inspectScript(target.id, frozen.observation.id, selected.id),
      10_000,
      signal,
    );

    assert.notEqual(stale.exitCode, 0, label);
    assert.match(stale.text, /selection changed/);
    checks.push(`${label} rejects stale selection`);
  }

  await run(
    `const p=await browser.getPage(${JSON.stringify(target.id)}); await p.goto(${JSON.stringify(fixture)}); await p.evaluate(()=>scrollTo(0,600)); undefined`,
  );
  const reload = await observe();

  const reloadElement = reload.observation.elements.find(
    (element) => element.selector === "#selected",
  );

  assert.ok(reloadElement);
  await run(
    `const p=await browser.getPage(${JSON.stringify(target.id)}); await p.reload(); undefined`,
  );

  const staleReload = await session.run(
    inspectScript(target.id, reload.observation.id, reloadElement.id),
    10_000,
    signal,
  );

  assert.notEqual(staleReload.exitCode, 0);
  assert.match(staleReload.text, /selection changed/);
  checks.push("same-URL document reload rejects stale selection");

  const viewportResult = await run(
    viewportScript({ targetId: target.id, preset: "tablet" }),
  );

  const changed = z
    .object({
      previous: nativeViewportSchema,
      applied: nativeViewportSchema,
      viewport: viewportSchema,
    })
    .parse(JSON.parse(viewportResult.text));

  assert.equal(changed.viewport.width, 820);

  const restored = await run(
    viewportScript({
      targetId: target.id,
      preset: "original",
      original: changed.previous,
      expected: changed.applied,
    }),
  );

  const original = z
    .object({
      previous: nativeViewportSchema,
      applied: nativeViewportSchema,
      viewport: viewportSchema,
    })
    .parse(JSON.parse(restored.text));

  assert.equal(original.viewport.width, 390);

  const drifted = await session.run(
    viewportScript({
      targetId: target.id,
      preset: "desktop",
      expected: changed.applied,
    }),
    10_000,
    signal,
  );

  assert.notEqual(drifted.exitCode, 0);
  assert.match(drifted.text, /changed outside/);
  checks.push(
    "real tablet metrics, exact prior restore and foreign emulation rejection",
  );

  const second = await run(
    `const p=await browser.getPage("visual-second");await p.goto("data:text/html,<h1>Other target</h1>");JSON.stringify((await browser.listPages()).find(page=>page.name==="visual-second").id)`,
  );

  const secondId = z.string().parse(JSON.parse(second.text));
  const secondCapture = await run(observeScript(secondId, randomUUID()));
  assert.equal(
    visualObservationSchema.parse(JSON.parse(secondCapture.text)).targetId,
    secondId,
  );
  const firstCapture = await observe();
  assert.equal(firstCapture.observation.targetId, target.id);
  await run(
    `await (await browser.getPage(${JSON.stringify(secondId)})).close();undefined`,
  );

  const closed = await session.run(
    observeScript(secondId, randomUUID()),
    10_000,
    signal,
  );

  assert.notEqual(closed.exitCode, 0);
  assert.match(closed.text, /displayed tab closed/);
  checks.push("exact multi-target affinity and no closed-target recreation");

  await writeFile(
    join(parent, "browser-visual-smoke.json"),
    JSON.stringify(
      {
        owner: "browser-automation/smoke:visuals",
        checkedAt: new Date().toISOString(),
        checks,
        crop: {
          width: actual.width,
          height: actual.height,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        result: "passed",
      },
      null,
      2,
    ),
  );
  process.stdout.write(JSON.stringify({ result: "passed", checks }) + "\n");
} finally {
  try {
    await runtime?.close();
  } finally {
    if (fixtureServer.listening)
      await new Promise<void>((resolve, reject) => {
        fixtureServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        fixtureServer.closeAllConnections();
      });
  }

  await rm(root, { recursive: true, force: true });

  const absent = await stat(root).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return true;

      throw error;
    },
  );

  assert.ok(absent);
  await writeFile(
    ownerReceipt,
    JSON.stringify(
      {
        ...ownership,
        status: "closed",
        scratchAbsent: true,
        fixtureServerClosed: !fixtureServer.listening,
      },
      null,
      2,
    ),
  );
}
