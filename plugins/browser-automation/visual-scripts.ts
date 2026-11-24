import type { NativeViewport, ViewportPreset } from "./contracts.js";

export const viewportPresets = {
  phone: {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  tablet: {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  desktop: {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
};

const pagePrelude = String.raw`
const stateKey = "__omnyoPreviewDesignObservation";
const documentId = () => {
  const bytes=crypto.getRandomValues(new Uint8Array(16)); bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,value=>value.toString(16).padStart(2,"0")).join("");
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join("-");
};
const state = window[stateKey] ??= {documentId:documentId(), observations:new Map()};
const viewport = () => ({width:innerWidth,height:innerHeight,scrollX,scrollY,dpr:devicePixelRatio,scale:visualViewport?.scale ?? 1});
const describe = (node,id) => {
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  const round = value => Math.round(value*100)/100;
  const selector = node.id ? "#"+CSS.escape(node.id) : node.tagName.toLowerCase()+Array.from(node.classList).slice(0,3).map(name=>"."+CSS.escape(name)).join("");
  return {id,selector:selector.slice(0,400),tag:node.tagName.toLowerCase(),text:String(node.getAttribute("aria-label") ?? node.getAttribute("alt") ?? node.innerText ?? "").trim().slice(0,240),rect:{x:round(rect.x),y:round(rect.y),width:round(rect.width),height:round(rect.height)},styles:Object.fromEntries(["display","position","color","background-color","font-size","font-family","font-weight","padding","gap","border-radius","opacity","transform"].map(key=>[key,style.getPropertyValue(key).slice(0,160)]))};
};
const stale = () => {throw new Error("This selection changed. Refresh the image and select it again; your notes are kept.");};
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const visibleNodes = () => {
  const candidates=document.querySelectorAll("body, body *");
  if(candidates.length>5000) throw new Error("This page has too many elements for visual selection. Narrow the page before annotating.");
  return Array.from(candidates).filter(node=>{
    const rect=node.getBoundingClientRect(); const style=getComputedStyle(node);
    return rect.width>=1 && rect.height>=1 && rect.right>0 && rect.bottom>0 && rect.left<innerWidth && rect.top<innerHeight && style.visibility==="visible" && style.display!=="none" && style.opacity!=="0";
  });
};
const validate = observation => {
  if (!observation || observation.documentId!==state.documentId || observation.fullUrl!==location.href || !same(observation.viewport,viewport())) stale();
  const current=visibleNodes();
  if(current.length!==observation.nodes.size || current.some((node,index)=>observation.nodes.get(String(index+1))!==node)) stale();
  for (const [id,node] of observation.nodes) {
    if (!node.isConnected || !same(observation.elements.find(element=>element.id===id),describe(node,id))) stale();
  }
  return observation;
};
`;

function pageExpression(body: string): string {
  return JSON.stringify(`(()=>{${pagePrelude}\n${body}})()`);
}

function exactPage(targetId: string): string {
  return `const targetId=${JSON.stringify(targetId)}; if (!(await browser.listPages()).some(page=>page.id===targetId)) throw new Error("The displayed tab closed. Refresh the preview."); const p=await browser.getPage(targetId);`;
}

export function observeScript(targetId: string, observationId: string): string {
  return `${exactPage(targetId)}
const observation=await p.evaluate(${pageExpression(`
const nodes=new Map(); const elements=[];
for(const node of visibleNodes()){
 if(elements.length===512) throw new Error("This view has too many elements for visual selection. Narrow the viewport before annotating.");
 const id=String(elements.length+1);nodes.set(id,node);elements.push(describe(node,id));
}
const observation={id:${JSON.stringify(observationId)},targetId:${JSON.stringify(targetId)},documentId:state.documentId,fullUrl:location.href,url:location.href.slice(0,2000),title:document.title.slice(0,300),viewport:viewport(),elements,nodes};
state.observations.set(observation.id,observation);
while(state.observations.size>4) state.observations.delete(state.observations.keys().next().value);
const {nodes:unused,fullUrl:privateUrl,...result}=observation;
if(JSON.stringify(result).length>100000) throw new Error("This view has too much element context. Narrow the viewport before annotating.");
return result;
`)});
await p.shot({type:"jpeg",maxEdge:1280,quality:70});
await p.evaluate(${pageExpression(`validate(state.observations.get(${JSON.stringify(observationId)})); return true;`)});
JSON.stringify(observation)`;
}

export function inspectScript(
  targetId: string,
  observationId: string,
  elementId: string,
): string {
  return `${exactPage(targetId)}
const selection=await p.evaluate(${pageExpression(`
const current=validate(state.observations.get(${JSON.stringify(observationId)}));
const element=current.elements.find(element=>element.id===${JSON.stringify(elementId)});
if(!element) stale();
const {nodes:unused,elements:all,fullUrl:privateUrl,...observation}=current;
const left=Math.max(0,element.rect.x),top=Math.max(0,element.rect.y);
const right=Math.min(innerWidth,element.rect.x+element.rect.width),bottom=Math.min(innerHeight,element.rect.y+element.rect.height);
return {observation,element,clip:{x:left+scrollX,y:top+scrollY,width:right-left,height:bottom-top}};
`)});
await p.shot({type:"jpeg",maxEdge:960,quality:70,clip:selection.clip});
await p.evaluate(${pageExpression(`validate(state.observations.get(${JSON.stringify(observationId)})); return true;`)});
JSON.stringify({observation:selection.observation,element:selection.element})`;
}

export function viewportScript(args: {
  targetId: string;
  preset: ViewportPreset;
  original?: NativeViewport;
  expected?: NativeViewport;
}): string {
  const value =
    args.preset === "original" ? args.original : viewportPresets[args.preset];

  return `${exactPage(args.targetId)}
const previous=await p.viewport();
${args.expected === undefined ? "" : `if(!((previous===null && ${JSON.stringify(args.expected)}===null) || (previous!==null && ${JSON.stringify(args.expected)}!==null && ["width","height","deviceScaleFactor","isMobile","hasTouch","isLandscape"].every(key=>previous[key]===${JSON.stringify(args.expected)}[key])))) throw new Error("Viewport changed outside this preset. Refresh before changing it again.");`}
await p.setViewport(${JSON.stringify(value)});
await p.evaluate(${pageExpression(`state.observations.clear(); return true;`)});
JSON.stringify({previous,applied:await p.viewport(),viewport:await p.evaluate(()=>({width:innerWidth,height:innerHeight,scrollX,scrollY,dpr:devicePixelRatio,scale:visualViewport?.scale ?? 1}))})`;
}
