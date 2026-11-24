import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [session, destination, thread] = process.argv.slice(2);

if (!session || !destination || !thread) {
  throw new Error(
    "Usage: node scripts/benchmark-command-search.mjs SESSION OUTPUT_JSON THREAD",
  );
}

const script = `
const p = await browser.getPage("main");
await p.goto("http://127.0.0.1:6115/?story=promptbox--command-search--large-catalog");
await p.waitForSelector('main [role="textbox"]', {timeout: 10000});
const snapshot = await p.snapshot({interactive: true});
const line = snapshot.split("\\n").find(line => line.includes('textbox "Ask anything.'));
if (!line) throw new Error("Composer was not found");
const ref = "ref/" + line.match(/\\[ref=(e\\d+)\\]/)[1];
await p.fill(ref, "/");
await p.waitForFunction(() => [...document.querySelectorAll("main button")].filter(b => b.textContent.includes("skill-")).length === 40, {timeout: 3000});
await (await p.ref(ref.slice(4))).evaluate(editor => {
  const metrics = {samples: [], frames: [], target: 0, catalogRequests: 0, initialRows: [...document.querySelectorAll("main button")].filter(b => b.textContent.includes("skill-")).length};
  window.__slashMetrics = metrics;
  const original = window.fetch.bind(window);
  window.fetch = (...args) => {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    if (url.includes("/commands")) metrics.catalogRequests++;
    return original(...args);
  };
  let inputStarted = 0;
  editor.addEventListener("beforeinput", () => { inputStarted = performance.now(); }, {capture:true});
  editor.addEventListener("input", () => {
    if (editor.textContent.trim() !== "/security") return;
    metrics.target++;
    const start = inputStarted;
    let frames = 0;
    let domMs = null;
    const correctResult = () => {
      const matches = [...document.querySelectorAll("main button")].filter(b => b.textContent.includes("Audit code for security defects"));
      return matches.length === 1 && matches[0].textContent.trim().startsWith("security");
    };
    const observer = new MutationObserver(() => {
      if (correctResult()) { domMs = performance.now() - start; observer.disconnect(); }
    });
    observer.observe(document.querySelector("main"), {subtree:true, childList:true, characterData:true});
    const check = () => {
      const matches = [...document.querySelectorAll("main button")].filter(b => b.textContent.includes("Audit code for security defects"));
      const correct = matches.length === 1 && matches[0].textContent.trim().startsWith("security");
      if (correct || ++frames >= 20) { observer.disconnect(); metrics.samples.push({ms: performance.now() - start, domMs, correct}); }
      else requestAnimationFrame(check);
    };
    queueMicrotask(() => { if (correctResult()) domMs = performance.now() - start; });
    requestAnimationFrame(check);
  }, {capture: true});
});
await p.evaluate(async () => {
  let previous = await new Promise(requestAnimationFrame);
  for (let i = 0; i < 25; i++) {
    const next = await new Promise(requestAnimationFrame);
    window.__slashMetrics.frames.push(next - previous);
    previous = next;
  }
});
for (let i = 0; i < 25; i++) {
  await p.fill(ref, "/");
  await p.waitForFunction(() => ![...document.querySelectorAll("main button")].some(b => b.textContent.includes("Audit code for security defects")), {timeout: 2000});
  await p.fill(ref, "/security");
  await p.waitForFunction(() => window.__slashMetrics.samples.length === window.__slashMetrics.target && window.__slashMetrics.target > 0, {timeout: 2000});
}
const result = await p.evaluate(() => window.__slashMetrics);
await p.fill(ref, "");
console.log(JSON.stringify(result));
`;

const raw = execFileSync(
  "omnyo",
  [
    "browser-automation",
    "run",
    session,
    "--script",
    script,
    "--json",
    "--timeout",
    "30s",
    "--thread",
    thread,
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 1024 * 1024,
  },
);

const response = JSON.parse(raw);

if (response.exitCode !== 0) throw new Error(response.text);

const metrics = JSON.parse(response.text.trim());

if (
  metrics.samples.length !== 25 ||
  metrics.samples.some((sample) => !sample.correct) ||
  metrics.initialRows !== 40 ||
  metrics.catalogRequests !== 0
) {
  throw new Error(
    "Command search failed its correctness, row-count, or no-request criterion",
  );
}

const times = metrics.samples.map((sample) => sample.ms).sort((a, b) => a - b);

const domTimes = metrics.samples
  .map((sample) => sample.domMs)
  .filter((ms) => ms !== null)
  .sort((a, b) => a - b);

const sources = [
  "apps/app/src/components/promptbox/mentions/CommandSearch.stories.tsx",
  "apps/app/src/components/promptbox/PromptBoxInternal.tsx",
  "apps/app/src/components/promptbox/mentions/MentionMenu.tsx",
  "apps/app/src/hooks/useCommandSuggestions.ts",
  "apps/app/src/hooks/queries/project-queries.ts",
  "packages/client-core/src/prompt/mentions/types.ts",
];

const sourceHashes = Object.fromEntries(
  await Promise.all(
    sources.map(async (file) => [
      file,
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    ]),
  ),
);

const receipt = {
  capturedAt: new Date().toISOString(),
  method:
    "Optimized production fixture, headless Chrome through Omnyo browser automation; actual PromptBoxInternal, command hook, matcher and menu; 525-entry seeded catalog; automated typing of /security, beforeinput event to first animation-frame callback with the correct result. This is a next-frame proxy, not physical display latency or a live-server cold-load benchmark.",
  sampleCount: times.length,
  p50Ms: times[Math.floor(times.length * 0.5)],
  p95Ms: times[Math.ceil(times.length * 0.95) - 1],
  maxMs: times.at(-1),
  domReadyP95Ms: domTimes[Math.ceil(domTimes.length * 0.95) - 1],
  idleFrameGapsMs: metrics.frames,
  initialRows: metrics.initialRows,
  catalogRequestsWhileTyping: metrics.catalogRequests,
  samples: metrics.samples,
  sourceHashes,
};

await mkdir(path.dirname(destination), { recursive: true });

await writeFile(destination, JSON.stringify(receipt, null, 2) + "\n");

console.log(
  JSON.stringify({
    sampleCount: receipt.sampleCount,
    p50Ms: receipt.p50Ms,
    p95Ms: receipt.p95Ms,
    maxMs: receipt.maxMs,
    initialRows: receipt.initialRows,
    catalogRequestsWhileTyping: receipt.catalogRequestsWhileTyping,
  }),
);
