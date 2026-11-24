import { randomBytes } from "node:crypto";

const SPINNER =
  '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 3V6M12 18V21M21 12L18 12M6 12L3 12M18.3635 5.63672L16.2422 7.75804M7.75804 16.2422L5.63672 18.3635M18.3635 18.3635L16.2422 16.2422M7.75804 7.75804L5.63672 5.63672"/></svg>';

const RESTART =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.4879 15C19.2524 18.4956 15.9187 21 12 21C7.02943 21 3 16.9706 3 12C3 7.02943 7.02943 3 12 3C15.7292 3 18.9286 5.26806 20.2941 8.5"/><path d="M15 9H18C19.4142 9 20.1213 9 20.5607 8.56066C21 8.12132 21 7.41421 21 6V3"/></svg>';

const PREVIEW_STATE_CSS = `:root{--canvas:oklch(1 0 0);--ink:oklch(0.3211 0 0);--muted:color-mix(in oklch, var(--ink) 82.5%, var(--canvas));--subtle:color-mix(in oklch, var(--ink) 73.6%, var(--canvas));--input:color-mix(in oklch, var(--ink) 29.5%, var(--canvas));--hover:color-mix(in oklab, var(--ink) 5.9%, transparent);--ring:var(--ink);--destructive:oklch(0.45 0.19 25.8625)}
:root.dark{--canvas:oklch(0.178 0.011 268);--ink:oklch(0.897 0.01 267);--muted:color-mix(in oklch, var(--ink) 83.7%, var(--canvas));--subtle:color-mix(in oklch, var(--ink) 69.8%, var(--canvas));--input:color-mix(in oklch, var(--ink) 32.6%, var(--canvas));--hover:color-mix(in oklab, var(--ink) 13.8%, transparent);--ring:color-mix(in oklch, var(--ink) 89.3%, var(--canvas));--destructive:oklch(0.56 0.19 22.1703)}
html,body{margin:0;height:100%}[hidden]{display:none!important}iframe{position:fixed;inset:0;display:block;width:100%;height:100%;border:0}
.state{--head:.9375rem;--head-lh:1.375rem;--text:.8125rem;--text-lh:1.25rem;--btn:2.25rem;position:fixed;inset:0;z-index:1;display:grid;justify-items:center;align-content:start;padding:33dvh 1.5rem 1.5rem;overflow:auto;background:var(--canvas);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:var(--text);line-height:var(--text-lh)}
.state-body{display:grid;grid-template-columns:1rem minmax(0,1fr);column-gap:.5rem;width:min(100%,24rem)}.ind{display:grid;place-items:center;height:var(--head-lh)}.dot{width:.5rem;height:.5rem;border-radius:999px}.dot.red{background:var(--destructive)}.dot.ring{box-shadow:inset 0 0 0 1px var(--subtle)}.spin{width:1rem;height:1rem;color:var(--subtle);animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.opening .state-body{animation:appear 150ms 200ms both}@keyframes appear{from{opacity:0}}.msg h1{margin:0;font-size:var(--head);line-height:var(--head-lh);font-weight:500}.msg h1:focus{outline:none}.msg p{margin:.25rem 0 0;color:var(--muted);overflow-wrap:anywhere;text-wrap:pretty}.act{grid-column:2;justify-self:start;display:inline-flex;align-items:center;gap:.5rem;height:var(--btn);margin-top:.75rem;padding:0 1rem;border:1px solid transparent;border-radius:.375rem;font:inherit;font-weight:500;text-decoration:none;cursor:pointer}.act svg{width:1rem;height:1rem}.act.primary{background:var(--ink);color:var(--canvas)}.act.primary:hover{background:color-mix(in oklab,var(--ink) 90%,transparent)}.act.secondary{border-color:var(--input);background:transparent;color:var(--ink)}.act.secondary:hover{background:var(--hover)}.act:focus-visible{outline:2px solid var(--ring);outline-offset:2px}@media(pointer:coarse){.state{--head:1rem;--head-lh:1.5rem;--text:.9375rem;--text-lh:1.375rem;--btn:2.75rem}}@media(prefers-reduced-motion:reduce){.spin,.opening .state-body{animation:none}}`;

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function createPreviewShell(id: string): Response {
  const nonce = randomBytes(18).toString("base64");

  const bootstrap = `(${String.raw`function(config){
  const frame=document.getElementById("preview"),layer=document.getElementById("state"),indicator=document.getElementById("indicator"),heading=document.getElementById("heading"),detail=document.getElementById("detail"),action=document.getElementById("action"),openOmnyo=document.getElementById("open-omnyo");
  const prefix="/preview/"+encodeURIComponent(config.id),api="/api/v1/previews/"+encodeURIComponent(config.id);
  let record=null,state="opening",loaded=false,busy=false,focusAfter=false,poll=null,revealTimer=null;
  const endpoint=()=>{try{return new URL(record.url).host;}catch{return "Preview";}};
  const path=()=>location.pathname.slice(prefix.length)||"/";
  const displayUrl=()=>endpoint()+path();
  function textWithBreaks(text){detail.replaceChildren();const parts=text.split("/");parts.forEach((part,index)=>{if(index){detail.append("/");detail.append(document.createElement("wbr"));}detail.append(part);});detail.hidden=!text;}
  function title(text){heading.textContent=text;document.title=text+" · "+endpoint();}
  function render(next,message){clearTimeout(poll);state=next;layer.hidden=false;layer.classList.toggle("opening",next==="opening");indicator.replaceChildren();detail.hidden=true;action.hidden=true;openOmnyo.hidden=true;action.removeAttribute("aria-disabled");action.removeAttribute("aria-busy");
    const host=record?.hostName||"The computer",url=displayUrl();let label="",description="",kind="ring",button="";
    switch(next){case "opening":label="Opening preview…";kind="spin";break;case "starting":label="Starting server…";description=url+" opens when it's ready.";kind="spin";break;case "stopped":label="Server stopped";description=url+" on "+host;kind="red";button="restart";break;case "error":label="Server didn't start";description=String(message||"It didn't become ready.").slice(0,200);kind="red";button="restart";break;case "conflict":label="Port "+(new URL(record.url).port||(new URL(record.url).protocol==="https:"?443:80))+" is in use";description="Another app on "+host+" is using it. Omnyo won't stop that app.";kind="red";button="retry";break;case "host-offline":label=host+" is offline";description=url+" can't open until it's back.";button="retry";break;case "unknown":label="Can't check this server";description=url+" on "+host;button="retry";break;case "unavailable":label="Preview not available";description="It may have been removed, or you may need to sign in.";openOmnyo.hidden=false;break;default:label="Can't open this preview";description="Check your connection, then try again.";button="retry";}
    if(kind==="spin")indicator.innerHTML=config.spinner;else{const dot=document.createElement("span");dot.className="dot "+kind;indicator.append(dot);}title(label);textWithBreaks(description);
    if(button){action.hidden=false;action.dataset.action=button;action.className="act "+(button==="restart"?"primary":"secondary");action.replaceChildren();if(button==="restart"){action.innerHTML=config.restart;action.append("Restart");action.setAttribute("aria-label","Restart server on "+host);}else{action.textContent="Try again";action.removeAttribute("aria-label");}}
    if(focusAfter){if(!action.hidden)action.focus();else if(!openOmnyo.hidden)openOmnyo.focus();}if(next==="starting"&&document.visibilityState==="visible")poll=setTimeout(checkStatus,2000);
  }
  async function read(response){if([401,403,404].includes(response.status)){const error=new Error("Unavailable");error.unavailable=true;throw error;}if(!response.ok)throw new Error("Request failed");return response.json();}
  async function readRecord(){if(record?.hostName)return;record=await read(await fetch(api,{credentials:"same-origin"}));}
  async function checkStatus(shouldOpen=true){clearTimeout(poll);try{const results=await Promise.all([fetch(api+"/status",{credentials:"same-origin"}).then(read),readRecord()]);const observed=results[0];if(observed.state==="online"){if(!loaded||!layer.hidden){if(shouldOpen)await open();else render("cant-open");}}else render(observed.state,observed.detail);}catch(error){render(error.unavailable?"unavailable":"cant-open");}}
  function reveal(){if(state!=="opening")return;clearTimeout(revealTimer);layer.hidden=true;loaded=true;document.title=endpoint();frame.focus();}
  async function open(){try{const access=await read(await fetch(prefix+"/access",{method:"POST",headers:{"content-type":"application/json"},body:"{}",credentials:"same-origin"}));if(access.hostPort)record={...(record||{}),url:"http://"+access.hostPort,hostName:record?.hostName};loaded=false;render("opening");frame.title="Preview of "+endpoint();frame.onload=reveal;frame.src=access.contentBase+path()+location.search+location.hash;clearTimeout(revealTimer);revealTimer=setTimeout(reveal,15000);}catch{await checkStatus(false);}}
  action.addEventListener("click",async()=>{if(busy)return;busy=true;focusAfter=true;if(action.dataset.action==="restart"){render("starting");heading.focus();try{const requestId=Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16).padStart(8,"0")).join("");const result=await read(await fetch(api+"/restart",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({requestId}),credentials:"same-origin"}));if(result.state==="online")await open();else render(result.state,result.detail);}catch{await checkStatus();}}else{action.textContent="Checking…";action.setAttribute("aria-disabled","true");action.setAttribute("aria-busy","true");await checkStatus();}busy=false;});
  window.addEventListener("message",event=>{if(event.source!==frame.contentWindow||event.origin!=="null"||!event.data||event.data.type!=="omnyo-preview:navigate"||typeof event.data.path!=="string"||!event.data.path.startsWith("/")||event.data.path.startsWith("//")||/[\\\u0000-\u001f]/.test(event.data.path))return;history.replaceState(null,"",prefix+event.data.path);});
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")void checkStatus();else clearTimeout(poll);});window.addEventListener("online",()=>void checkStatus());void open();
}`})(${scriptJson({ id, spinner: SPINNER, restart: RESTART })});`;

  const theme = `try{const theme=localStorage.getItem("omnyo.theme");if(theme==="dark"||(theme!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches))document.documentElement.classList.add("dark");}catch{}`;

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Omnyo preview</title><script nonce="${nonce}">${theme}</script><style nonce="${nonce}">${PREVIEW_STATE_CSS}</style></head><body><main id="state" class="state opening"><div class="state-body"><span id="indicator" class="ind" aria-hidden="true">${SPINNER}</span><div class="msg" role="status"><h1 id="heading" tabindex="-1">Opening preview…</h1><p id="detail" hidden></p></div><button id="action" class="act primary" type="button" hidden></button><a id="open-omnyo" class="act secondary" href="/" hidden>Open Omnyo</a></div></main><iframe id="preview" title="Preview" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe><script nonce="${nonce}">${bootstrap}</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'self'`,
      },
    },
  );
}

export function createPreviewFrameFailure(status: number): Response {
  const nonce = randomBytes(18).toString("base64");

  const css =
    PREVIEW_STATE_CSS +
    "@media(prefers-color-scheme:dark){:root{--canvas:oklch(0.178 0.011 268);--ink:oklch(0.897 0.01 267);--muted:color-mix(in oklch,var(--ink) 83.7%,var(--canvas));--subtle:color-mix(in oklch,var(--ink) 69.8%,var(--canvas))}}";

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Can't load this page</title><style nonce="${nonce}">${css}</style></head><body><main class="state"><div class="state-body"><span class="ind" aria-hidden="true"><span class="dot ring"></span></span><div class="msg" role="status"><h1>Can't load this page</h1><p>Reload to try again.</p></div></div></main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; sandbox allow-scripts allow-forms`,
      },
    },
  );
}
