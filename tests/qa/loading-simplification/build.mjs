import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const require = createRequire(join(repository, "package.json"));

const { build } = require("esbuild");

const [outputDirectory, sourceOverride] = process.argv.slice(2);

if (!outputDirectory) throw new Error("Pass a new output directory");

const output = resolve(outputDirectory);

const source = join(output, "source");

const dist = join(output, "dist");

await mkdir(source, { recursive: true });

const sourceRoot = sourceOverride
  ? resolve(sourceOverride)
  : join(repository, "apps/app/src/lib");

const splitFile = join(sourceRoot, "define-split.tsx");

const oldState = join(sourceRoot, "split-prefetch.ts");

const stateFile = await readFile(oldState).then(
  () => oldState,
  () => join(sourceRoot, "split-load.ts"),
);

const stateSource = await readFile(stateFile, "utf8");

const autoStart = stateSource.includes("export function startSplitPreloading")
  ? `import {startSplitPreloading} from ${JSON.stringify(stateFile)}; startSplitPreloading();`
  : "";

const loads = Array.from(
  { length: 8 },
  (_, i) => `()=>import("./feature${i}.tsx")`,
).join(",");

await writeFile(
  join(source, "main.tsx"),
  `import {useState} from "react";
import {createRoot} from "react-dom/client";
import {defineSplit} from ${JSON.stringify(splitFile)};
const loads=[${loads}];
const features=loads.map((load,index)=>defineSplit({id:"feature-"+index,${autoStart ? 'tier:"background",' : ""}loading:()=> <p>Loading feature</p>,load:()=>load().then(m=>m.default)}));
function App(){const [selected,setSelected]=useState(-1);const Feature=features[selected];return <main><h1>Ready chat</h1><textarea aria-label="Draft" defaultValue={localStorage.getItem("draft")??""} onChange={e=>localStorage.setItem("draft",e.target.value)}/>{features.map((Feature,i)=><button key={i} {...Feature.intentProps} onClick={()=>setSelected(i)}>Open {i}</button>)}{Feature&&<Feature/>}</main>}
createRoot(document.getElementById("root")).render(<App/>);
${autoStart}`,
);

await writeFile(
  join(source, "dependency.ts"),
  `export const dependency = ${JSON.stringify("shared-".repeat(5000))};`,
);

for (let i = 0; i < 8; i += 1) {
  const payload = Array.from({ length: 6000 }, (_, n) =>
    createHash("sha256").update(`${i}-${n}`).digest("hex").slice(0, 8),
  ).join("");

  await writeFile(
    join(source, `feature${i}.tsx`),
    `import {dependency} from "./dependency";const text=${JSON.stringify(payload)};export default function View(){return <p data-feature="${i}">Feature ${i} ready {text.length+dependency.length}</p>}`,
  );
}

const result = await build({
  entryPoints: [join(source, "main.tsx")],
  outdir: dist,
  entryNames: "main",
  chunkNames: "[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  minify: true,
  nodePaths: [join(repository, "apps/app/node_modules")],
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "silent",
});

const outputs = result.metafile.outputs;

const paths = [];

const splits = {};

const collect = (name, found) => {
  if (found.has(name)) return;
  found.add(name);

  for (const item of outputs[name]?.imports ?? [])
    if (item.kind !== "dynamic-import" && !item.external)
      collect(item.path, found);
};

for (const [name, info] of Object.entries(outputs)) {
  const id = info.entryPoint?.match(/feature(\d+)\.tsx$/)?.[1];

  if (id === undefined) continue;
  const closure = new Set();
  collect(name, closure);
  splits[`feature-${id}`] = [...closure].map((file) => {
    const url = "/" + relative(dist, resolve(file));
    let index = paths.indexOf(url);

    if (index < 0) {
      index = paths.length;
      paths.push(url);
    }

    return index;
  });
}

await writeFile(
  join(dist, "index.html"),
  `<!doctype html><html><head><link rel="icon" href="data:,"><script type="application/json" id="omnyo-prefetch-manifest">${JSON.stringify({ files: paths, splits })}</script></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>`,
);

const hashes = {};

for (const file of await readdir(dist))
  hashes[file] = createHash("sha256")
    .update(await readFile(join(dist, file)))
    .digest("hex");

await writeFile(
  join(output, "build.json"),
  JSON.stringify(
    {
      repository,
      sourceHashes: {
        defineSplit: createHash("sha256")
          .update(await readFile(splitFile))
          .digest("hex"),
        loadState: createHash("sha256").update(stateSource).digest("hex"),
      },
      hashes,
      paths,
      splits,
      automaticWarming: Boolean(autoStart),
    },
    null,
    2,
  ),
);

console.log(
  JSON.stringify({
    output,
    automaticWarming: Boolean(autoStart),
    assets: paths.length,
  }),
);
