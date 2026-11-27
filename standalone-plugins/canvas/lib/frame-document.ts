import { z } from "zod";
import type { Dataset } from "../source-contract";
import { canvasFrameStyles } from "./frame-styles";

export const themeVariables = [
  "--background",
  "--foreground",
  "--muted",
  "--muted-foreground",
  "--card",
  "--card-foreground",
  "--border",
  "--attention",
  "--surface-recessed",
  "--primary",
  "--primary-foreground",
  "--success",
  "--warning",
  "--warning-text",
  "--ring",
  "--destructive",
  "--radius",
  "--font-sans",
  "--font-mono",
];

function frameDataset(dataset: Dataset | null) {
  return dataset === null
    ? null
    : {
        sourceId: dataset.sourceId,
        columns: dataset.columns,
        rows: dataset.rows,
        provenance: dataset.provenance,
        revision: dataset.revision,
        capturedAt: dataset.capturedAt,
      };
}

export function frameData(
  dataset: Dataset | null,
  sources: Readonly<Record<string, Dataset | null>> = {},
): string {
  return JSON.stringify({
    data: frameDataset(dataset),
    sources: Object.fromEntries(
      Object.entries(sources).map(([id, entry]) => [id, frameDataset(entry)]),
    ),
  })
    .replace(/</gu, "\\u003c")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
}

export function frameDocument(
  html: string,
  variables: ReadonlyMap<string, string>,
  colorScheme: string,
  canvasNavigation = false,
  data: string | null = null,
): string {
  const declarations = [...variables]
    .map(([name, value]) => `${name}:${value.replace(/[<>;{}]/gu, "")};`)
    .join("");

  const aliases =
    "--brand:var(--canvas-accent,var(--primary));--chart-1:var(--canvas-accent,var(--primary));--chart-2:var(--success);--chart-3:var(--warning);--chart-4:var(--destructive);--chart-5:var(--attention);--chart-6:var(--muted-foreground);";

  const scheme = /^(?:light|dark)(?: (?:light|dark))?$/u.test(colorScheme) ? colorScheme : "normal";

  const navigation = canvasNavigation
    ? `addEventListener("pointerdown",function(event){if(event.button!==1)return;event.preventDefault();event.stopImmediatePropagation();parent.postMessage({canvasFramePan:{clientX:event.clientX,clientY:event.clientY}},"*");},true);addEventListener("auxclick",function(event){if(event.button===1){event.preventDefault();event.stopImmediatePropagation();}},true);let pointerRevision=0;addEventListener("pointermove",function(event){if(event.movementX!==0||event.movementY!==0)pointerRevision+=1;});addEventListener("wheel",function(event){const control=event.target instanceof Element?event.target.closest("select,textarea,[contenteditable]:not([contenteditable='false'])"):null;if(event.defaultPrevented||(control&&(control.scrollHeight>control.clientHeight+1||control.scrollWidth>control.clientWidth+1))||(event.target instanceof Element&&event.target.closest("input[type='number']:focus")))return;event.preventDefault();parent.postMessage({canvasFrameWheel:{deltaX:event.deltaX,deltaY:event.deltaY,deltaMode:event.deltaMode,clientX:event.clientX,clientY:event.clientY,pointerRevision:pointerRevision,ctrlKey:event.ctrlKey,metaKey:event.metaKey,shiftKey:event.shiftKey}},"*")},{passive:false});`
    : "";

  const dataScript =
    data === null
      ? ""
      : `<script>(function(bound){window.canvasData=bound.data;window.canvasSources=bound.sources;})(${data});</script>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{color-scheme:${scheme};${declarations}${aliases}}${canvasFrameStyles}</style>${dataScript}</head><body>${html}<script>(function(){let layoutRetries=0;function post(){const body=document.body;const box=body.getBoundingClientRect();if(innerWidth===0||box.width===0){if(layoutRetries<50){layoutRetries+=1;setTimeout(post,40);}return;}const styles=getComputedStyle(body);const height=Math.max(body.scrollHeight,box.height)+parseFloat(styles.marginTop)+parseFloat(styles.marginBottom);parent.postMessage({canvasFrameHeight:Math.max(1,Math.ceil(height)),canvasFrameReport:{text:body.innerText.slice(0,3500),overflowX:document.documentElement.scrollWidth>innerWidth+1,overflowY:document.documentElement.scrollHeight>innerHeight+1}},"*")}new ResizeObserver(post).observe(document.body);addEventListener("load",post);addEventListener("resize",post);post();addEventListener("click",function(event){const anchor=event.target instanceof Element?event.target.closest("a[href]"):null;const href=anchor&&anchor.getAttribute("href");if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||!href||!href.startsWith("#canvas-node-"))return;event.preventDefault();parent.postMessage({canvasFrameNavigate:href.slice(13)},"*");});${navigation}})()</script></body></html>`;
}

export const frameReportSchema = z.object({
  text: z.string().max(3500),
  overflowX: z.boolean(),
  overflowY: z.boolean(),
});

export const frameRenderMessage = z.object({ canvasFrameReport: frameReportSchema });

export const canvasNavigationTarget = z.string().min(1).max(200);

export const frameNavigationMessage = z.object({ canvasFrameNavigate: canvasNavigationTarget });

export const frameHeightMessage = z.object({ canvasFrameHeight: z.number().finite().positive() });

export const framePanMessage = z.object({
  canvasFramePan: z.object({ clientX: z.number().finite(), clientY: z.number().finite() }),
});

export const frameWheelMessage = z.object({
  canvasFrameWheel: z.object({
    deltaX: z.number().finite(),
    deltaY: z.number().finite(),
    deltaMode: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    clientX: z.number().finite(),
    clientY: z.number().finite(),
    pointerRevision: z.number().int().nonnegative(),
    ctrlKey: z.boolean(),
    metaKey: z.boolean(),
    shiftKey: z.boolean(),
  }),
});
