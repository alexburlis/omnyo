import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const [playwrightModule, destination] = process.argv.slice(2);

assert(
  playwrightModule && destination,
  "Pass the Playwright module and output directory",
);

const output = resolve(destination);

await mkdir(output, { recursive: true });

const app = join(root, "apps/app");

const fixture = `
import React,{useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {useEditor} from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import {BottomAnchoredScrollBody,useBottomAnchoredScroll} from './src/components/ui/bottom-anchored-scroll-body';
import {MessageActionBar} from './src/components/thread/timeline/MessageActionBar';
import {ComposerEditorSlot} from './src/components/promptbox/ComposerEditorSlot';
import {ThreadContinueControl} from './src/components/thread/ThreadContinueControl';
import {ExpandableTimelineRow} from './src/components/thread/timeline/ExpandableTimelineRow';
import {QueuedMessagesList} from './src/components/promptbox/banner/QueuedMessagesList';
import {makeThreadQueuedMessage} from '@omnyo/test-helpers/domain-fixtures';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
const noop=()=>{};
function Queue({count}){const [expanded,setExpanded]=useState(false);const [messages]=useState(()=>Array.from({length:count},(_,index)=>makeThreadQueuedMessage({id:'q'+count+'-'+index,content:[{type:'text',text:'Queued note '+(index+1),mentions:[]}]})));return <QueuedMessagesList queuedMessages={messages} attachedToComposer sendAction="send-now" expanded={expanded} onExpandedChange={setExpanded} sendDisabled={false} actionDisabled={false} processingMessageId={null} processingAction={null} onSend={noop} onEdit={noop} onDelete={noop} onReorder={noop} onSetGroupBoundary={noop}/>;}
function FollowProbe(){const context=useBottomAnchoredScroll();window.proof.follow=context;return null;}
function App(){
 const [heights,setHeights]=useState(Array.from({length:12},()=>130));
 const [empty,setEmpty]=useState(true);const editorRef=useRef(null);
 const [model,setModel]=useState('original');
 const editor=useEditor({extensions:[Document,Paragraph,Text],content:'',onUpdate:({editor})=>setEmpty(editor.isEmpty)});
 window.proof.grow=()=>setHeights(previous=>previous.map((height,index)=>index===11?height+150:height));
 window.proof.shrink=()=>setHeights(previous=>previous.map((height,index)=>index===11?90:height));
 return <main style={{maxWidth:760,margin:'auto'}}>
  <section aria-label="Conversation fixture" style={{height:420,display:'flex',flexDirection:'column'}}>
   <BottomAnchoredScrollBody animateFollowLatest={false} maxWidthClassName="max-w-none"><FollowProbe/>
    <div data-timeline-row-list="top-level">{heights.map((height,index)=><article key={index} data-timeline-row-id={'row-'+index} style={{height,borderBottom:'1px solid var(--border)'}}>Message {index+1}</article>)}</div>
   </BottomAnchoredScrollBody>
  </section>
  <section aria-label="Message actions" className="group/message"><MessageActionBar timestamp={1731844800000} messageText="Fixture answer" alignment="start" mobileActionDisplay="inline" onAddToChat={()=>window.proof.action='add'} onCopyLink={()=>window.proof.action='link'} onFork={()=>window.proof.action='fork'}/></section>
  <section aria-label="Tool execution"><ExpandableTimelineRow activityTone="positive" forceExpanded title={{segments:[],decorations:[],tone:'default',action:null,plain:'Command completed'}} titleContent="Command completed" renderBody={()=><pre>Verified command output</pre>}/></section>
  <section aria-label="Composer" style={{border:'1px solid var(--border)',borderRadius:12}}><ComposerEditorSlot editor={editor} scrollContainerRef={editorRef} inputLocked={false} isCompactLayout={false} isEmpty={empty} minHeight={28} layout="thread" resolveMentionLink={undefined} leadingInset={false} suggestion={null} animateSuggestion={false} onPointerDown={()=>{}}/></section>
  <section aria-label="Recovery"><ThreadContinueControl threadId="fixture-recovery" errored model={model} modelControl={<button onClick={()=>setModel('alternate')}>Choose alternate model</button>}/></section>
  <section aria-label="Single queued item"><Queue count={1}/></section>
  <section aria-label="Multiple queued items"><Queue count={3}/></section>
 </main>;
}
window.proof={action:null,follow:null,recoveries:[]};createRoot(document.getElementById('root')).render(<QueryClientProvider client={queryClient}><App/></QueryClientProvider>);
`;

const adapters = {
  "@/hooks/useSenderThreadMetadataById":
    "export const useSenderThreadMetadataById=()=>new Map();",
  "@/lib/plugin-logos":
    "export const usePluginDisplayName=id=>id;export const usePluginCompactBranding=()=>null;",
  "@/components/promptbox/banner/QueuedMessageStartOnMenu":
    "export const QueuedMessageStartOnMenu=()=>null;",
  "@/components/ui/app-route-anchor.js":
    "import React from 'react';export const RouteAnchor=props=>React.createElement('a',props);",
  "@/components/thread/ThreadTitleMentions.js":
    "export const useThreadRoutePath=()=>()=>'/fixture';export const isMentionBoundary=()=>true;export const isMentionEndBoundary=()=>true;export const isRawThreadIdBoundary=()=>true;export const isRawThreadIdEndBoundary=()=>true;export const useRawThreadMentionResource=()=>null;export const useSidebarThreadMentionResource=()=>null;export const useThreadMentionResource=()=>null;",
  "@/components/thread/ThreadTitleMentions":
    "export const useThreadRoutePath=()=>()=>'/fixture';export const useResolveThreadTitle=()=>title=>title;export const ThreadTitleMentions=()=>null;",
  "@/components/plugin/PluginIcon":
    "export const pluginIconName=()=> 'Copy';export const PluginItemIcon=()=>null;export const PluginIcon=()=>null;",
  "@/hooks/queries/thread-continuation-queries": `export const useThreadContinuation=()=>({data:{available:true,pending:true,canRetryNow:true,action:'retry-queued',model:'original',retryAt:Date.now()+3600000,message:'Waiting for account availability.',cause:'The account is temporarily rate limited.'},isError:false});export const useContinueThread=()=>({isPending:false,mutate(args,handlers){window.proof.recoveries.push(args);handlers.onSuccess({message:'Continuation accepted.'});}});`,
};

const bundled = await build({
  stdin: { contents: fixture, loader: "tsx", resolveDir: app },
  bundle: true,
  write: false,
  metafile: true,
  minify: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  conditions: ["source"],
  tsconfig: join(app, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "synthetic-external-adapters",
      setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) =>
          adapters[args.path]
            ? { path: args.path, namespace: "fixture" }
            : null,
        );
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: adapters[args.path],
          loader: "js",
          resolveDir: app,
        }));
      },
    },
  ],
});

const files = Object.keys(bundled.metafile.inputs).filter(
  (path) =>
    !path.includes("node_modules") &&
    !path.startsWith("fixture:") &&
    path !== "<stdin>",
);

const sourceTexts = await Promise.all(
  files.map((path) => readFile(resolve(root, path), "utf8")),
);

const hashes = Object.fromEntries(
  files.map((path, index) => [
    path,
    createHash("sha256").update(sourceTexts[index]).digest("hex"),
  ]),
);

const theme = await readFile(join(app, "src/components/ui/theme.css"), "utf8");

const appCss = (await readFile(join(app, "src/app.css"), "utf8")).replace(
  '@import "@/components/ui/theme.css";',
  theme,
);

const tailwind = (await readdir(join(root, "node_modules/.pnpm"))).find(
  (name) => name.startsWith("@tailwindcss+node@4."),
);

assert(tailwind, "Tailwind is installed");

const { compile } = await import(
  pathToFileURL(
    join(
      root,
      "node_modules/.pnpm",
      tailwind,
      "node_modules/@tailwindcss/node/dist/index.mjs",
    ),
  ).href
);

const compiler = await compile(appCss, {
  base: join(app, "src/components/ui"),
  onDependency() {},
});

const candidates = [
  ...new Set(
    [...sourceTexts, fixture]
      .join(" ")
      .split(/[\s"'`{}(),;]+/)
      .filter(Boolean),
  ),
];

const css = compiler.build(candidates);

await writeFile(join(output, "app.js"), bundled.outputFiles[0].contents);

await writeFile(join(output, "app.css"), css);

const report = {
  surface:
    "Production React components with synthetic content in headless Chrome",
  hashes,
  checks: [],
  errors: [],
  cleanup: false,
};

const server = createServer(async (request, response) => {
  if (request.url === "/app.js" || request.url === "/app.css") {
    response.setHeader(
      "Content-Type",
      request.url.endsWith(".js") ? "text/javascript" : "text/css",
    );
    response.end(await readFile(join(output, request.url.slice(1))));
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>body{margin:0;background:var(--background);color:var(--foreground)}section{padding:8px}button{cursor:pointer}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
    );
  }
});

let browser;

try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));

  const { chromium } = await import(
    pathToFileURL(resolve(playwrightModule)).href
  );

  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    chromiumSandbox: true,
  });
  report.browser = browser.version();
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => report.errors.push(error.message));

  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const viewport = page.locator("[data-page-scroll-viewport]");
    await viewport.waitFor();
    await page.waitForFunction(() => {
      const v = document.querySelector("[data-page-scroll-viewport]");

      return v && v.scrollHeight - v.clientHeight - v.scrollTop < 2;
    });
    await page.evaluate(() => window.proof.grow());
    await page.waitForFunction(() => {
      const v = document.querySelector("[data-page-scroll-viewport]");

      return v.scrollHeight - v.clientHeight - v.scrollTop < 2;
    });
    report.checks.push({
      width,
      check: "Initial bottom and growing final row follow",
      passed: true,
    });
    await viewport.hover();
    await page.mouse.wheel(0, -400);
    await page.waitForFunction(() => !window.proof.follow.isAtBottom);
    const readingTop = await viewport.evaluate((node) => node.scrollTop);
    await page.evaluate(() => window.proof.grow());
    await page.waitForFunction(
      (previous) =>
        Math.abs(
          document.querySelector("[data-page-scroll-viewport]").scrollTop -
            previous,
        ) < 2,
      readingTop,
    );
    assert.equal(
      await page.evaluate(() => window.proof.follow.isAtBottom),
      false,
    );
    report.checks.push({
      width,
      check: "Manual upward reading survives new output",
      passed: true,
    });
    await page.evaluate(() => window.proof.follow.scrollToBottom());
    await page.waitForFunction(() => window.proof.follow.isAtBottom);
    await page.evaluate(() => window.proof.shrink());
    await page.waitForFunction(() => window.proof.follow.isAtBottom);
    report.checks.push({
      width,
      check: "Returning to bottom resumes following through shrink",
      passed: true,
    });
    const actions = page.getByRole("region", { name: "Message actions" });

    await actions.hover();
    await page.waitForFunction(() => {
      const button = document.querySelector('button[aria-label="Add to chat"]');

      return button && Number(getComputedStyle(button).opacity) > 0.9;
    });

    for (const [name, value] of [
      ["Add to chat", "add"],
      ["Fork into new thread", "fork"],
      ["Copy link", "link"],
    ]) {
      const button = actions.getByRole("button", { name, exact: true });
      await button.click();
      assert.equal(await page.evaluate(() => window.proof.action), value);
    }

    report.checks.push({
      width,
      check: "Direct message actions dispatch once",
      passed: true,
    });
    const editor = page.locator("[contenteditable=true]");

    const before = await page
      .locator("[data-promptbox-editor-scroll]")
      .evaluate((node) => node.clientHeight);

    assert(before <= 64, `Empty composer height ${before}`);
    await editor.fill(
      "A first line\nA second line\nA third line\nA fourth line",
    );
    await page.waitForFunction(
      (height) =>
        document.querySelector("[data-promptbox-editor-scroll]").clientHeight >
        height,
      before,
    );
    await editor.fill("");
    await page.waitForFunction(
      (height) =>
        document.querySelector("[data-promptbox-editor-scroll]")
          .clientHeight === height,
      before,
    );
    report.checks.push({
      width,
      check: "Composer grows with lines and shrinks after clearing",
      passed: true,
      emptyHeight: before,
    });

    await editor.fill("Ask for a follow-up");
    await actions.hover();

    const recovery = page.getByRole("region", { name: "Recovery" });

    await recovery.getByRole("button", { name: "Continue now" }).click();
    await recovery
      .getByText("Continue with a different model", { exact: true })
      .click();
    await recovery
      .getByRole("button", { name: "Choose alternate model" })
      .click();
    await recovery
      .getByRole("button", { name: "Continue with selected model" })
      .click();
    assert.deepEqual(await page.evaluate(() => window.proof.recoveries), [
      { threadId: "fixture-recovery", now: true },
      { threadId: "fixture-recovery", now: true, model: "alternate" },
    ]);
    assert.equal(
      await recovery
        .locator("details")
        .first()
        .evaluate((node) => node.open),
      false,
    );
    report.checks.push({
      width,
      check:
        "Recovery has one scheduled status, collapsed failure details and explicit retry/model actions",
      passed: true,
    });

    const singleQueue = page.getByRole("region", {
      name: "Single queued item",
    });

    const geometry = await singleQueue
      .locator("[data-queued-messages-scroll]")
      .evaluate((node) => ({
        client: node.clientHeight,
        scroll: node.scrollHeight,
      }));

    assert(
      geometry.client > 0 && geometry.scroll <= geometry.client + 1,
      JSON.stringify(geometry),
    );

    const multipleQueue = page.getByRole("region", {
      name: "Multiple queued items",
    });

    assert.equal(
      await multipleQueue.locator("[data-queued-message-row]:visible").count(),
      0,
    );
    await multipleQueue
      .getByRole("button", { name: "Show 3 queued messages" })
      .click();
    assert.equal(
      await multipleQueue.locator("[data-queued-message-row]:visible").count(),
      3,
    );
    report.checks.push({
      width,
      check:
        "One queued item fits without scrolling and multiple items expand from their count",
      passed: true,
      geometry,
    });

    const toolGeometry = await page
      .getByRole("region", { name: "Tool execution" })
      .evaluate((section) => {
        const rule = [...section.querySelectorAll("*")].find(
          (node) => getComputedStyle(node).borderLeftWidth === "2px",
        );

        if (!rule) return null;

        return {
          inset:
            rule.getBoundingClientRect().left -
            section.getBoundingClientRect().left,
          padding: parseFloat(getComputedStyle(rule).paddingLeft),
        };
      });

    assert(
      toolGeometry && toolGeometry.inset >= 16 && toolGeometry.padding >= 8,
      JSON.stringify(toolGeometry),
    );
    report.checks.push({
      width,
      check: "Execution status rule is inset with readable content padding",
      passed: true,
      toolGeometry,
    });
    await page.screenshot({
      path: join(output, `chat-ux-${width}.png`),
      fullPage: true,
    });
  }

  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error);
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  report.cleanup = true;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      cleanup: report.cleanup,
      report: join(output, "report.json"),
    }),
  );
}
