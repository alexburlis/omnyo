import { parse, type AnyNode, type Pattern } from "acorn";
import { fullAncestor } from "acorn-walk";
import { parse as parseHtml, type DefaultTreeAdapterMap } from "parse5";

interface PreviewContentContext {
  contentBase: string;
  localUrl: URL;
  sourceUrl: URL;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(source: string, edits: Edit[]): string {
  let result = source;
  let boundary = source.length;

  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (edit.end > boundary) continue;
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    boundary = edit.start;
  }

  return result;
}

function json(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function localOrigin(url: URL, target: URL): boolean {
  return (
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    url.protocol === target.protocol &&
    (url.port || (url.protocol === "https:" ? "443" : "80")) ===
      (target.port || (target.protocol === "https:" ? "443" : "80"))
  );
}

export function previewContentUrl(
  href: string,
  context: PreviewContentContext,
): string {
  if (href.startsWith(context.contentBase)) return href;
  let url: URL;

  try {
    url = new URL(href, context.sourceUrl);
  } catch {
    return href;
  }

  return localOrigin(url, context.localUrl)
    ? `${context.contentBase}${url.pathname}${url.search}${url.hash}`
    : href;
}

function bindingNames(pattern: Pattern): string[] {
  if (pattern.type === "Identifier") return [pattern.name];

  if (pattern.type === "RestElement") return bindingNames(pattern.argument);

  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);

  if (pattern.type === "ArrayPattern")
    return pattern.elements.flatMap((value) =>
      value === null ? [] : bindingNames(value),
    );

  if (pattern.type === "ObjectPattern")
    return pattern.properties.flatMap((value) =>
      bindingNames(value.type === "RestElement" ? value.argument : value.value),
    );

  return [];
}

function scopeNode(node: AnyNode): boolean {
  return [
    "Program",
    "BlockStatement",
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
    "CatchClause",
  ].includes(node.type);
}

export function rewritePreviewJavaScript(
  source: string,
  context: PreviewContentContext,
): string {
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  });

  const scopes = new Map<AnyNode, Set<string>>();
  const edits = new Map<string, Edit>();

  function bind(
    ancestors: AnyNode[],
    names: string[],
    functionOnly = false,
  ): void {
    const scope = [...ancestors]
      .reverse()
      .find(
        (node) =>
          scopeNode(node) &&
          (!functionOnly ||
            (node.type !== "BlockStatement" && node.type !== "CatchClause")),
      );

    if (!scope) return;
    const namesInScope = scopes.get(scope) ?? new Set<string>();
    names.forEach((name) => namesInScope.add(name));
    scopes.set(scope, namesInScope);
  }

  fullAncestor(ast, (node, _state, ancestors) => {
    if (node.type === "VariableDeclarator") {
      const parent = ancestors[ancestors.length - 2];
      bind(
        ancestors.slice(0, -1),
        bindingNames(node.id),
        parent?.type === "VariableDeclaration" && parent.kind === "var",
      );
    }

    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      bind(ancestors, node.params.flatMap(bindingNames));

      if (node.id)
        bind(
          node.type === "FunctionDeclaration"
            ? ancestors.slice(0, -1)
            : ancestors,
          [node.id.name],
        );
    }

    if (node.type === "CatchClause" && node.param)
      bind(ancestors, bindingNames(node.param));

    if (node.type === "ImportDeclaration")
      bind(
        ancestors,
        node.specifiers.map((specifier) => specifier.local.name),
      );

    if (node.type === "ClassDeclaration" && node.id)
      bind(ancestors.slice(0, -1), [node.id.name]);
  });

  function unbound(name: string, ancestors: AnyNode[]): boolean {
    return !ancestors.some((node) => scopes.get(node)?.has(name));
  }

  function edit(node: AnyNode, text: string): void {
    edits.set(`${node.start}:${node.end}`, {
      start: node.start,
      end: node.end,
      text,
    });
  }

  fullAncestor(ast, (node, _state, ancestors) => {
    const parent = ancestors[ancestors.length - 2];

    if (node.type === "ImportExpression") {
      edits.set(`import-prefix:${node.source.start}`, {
        start: node.source.start,
        end: node.source.start,
        text: "globalThis.__OMNYO_PREVIEW__.map(",
      });
      edits.set(`import-suffix:${node.source.end}`, {
        start: node.source.end,
        end: node.source.end,
        text: ")",
      });
    }

    if (node.type === "MemberExpression") {
      const property = node.computed
        ? node.property.type === "Literal"
          ? node.property.value
          : null
        : node.property.type === "Identifier"
          ? node.property.name
          : null;

      if (property === "location" && node.object.type === "Identifier") {
        const receiver = node.object;
        const global = unbound(receiver.name, ancestors);

        if (
          global &&
          ["window", "self", "globalThis", "document"].includes(receiver.name)
        )
          edit(node, "globalThis.__OMNYO_PREVIEW__.location");
        else if (receiver.name !== "location" || !global)
          edit(
            receiver,
            `(globalThis.__OMNYO_PREVIEW__.locationTarget(${receiver.name}))`,
          );
      }

      if (
        property === "url" &&
        node.object.type === "MetaProperty" &&
        node.object.meta.name === "import"
      )
        edit(node, json(context.sourceUrl.href));
    }

    if (
      node.type === "Identifier" &&
      node.name === "location" &&
      unbound("location", ancestors)
    ) {
      const isKey =
        (parent?.type === "MemberExpression" &&
          parent.property === node &&
          !parent.computed) ||
        (parent?.type === "Property" &&
          parent.key === node &&
          !parent.computed &&
          !parent.shorthand) ||
        (parent?.type === "MethodDefinition" &&
          parent.key === node &&
          !parent.computed);

      const isDeclaration =
        (parent?.type === "VariableDeclarator" && parent.id === node) ||
        parent?.type === "FunctionDeclaration" ||
        parent?.type === "FunctionExpression" ||
        parent?.type === "ArrowFunctionExpression" ||
        parent?.type === "LabeledStatement" ||
        parent?.type === "BreakStatement" ||
        parent?.type === "ContinueStatement";

      if (!isKey && !isDeclaration)
        edit(
          node,
          parent?.type === "Property" && parent.shorthand
            ? "location:globalThis.__OMNYO_PREVIEW__.location"
            : "globalThis.__OMNYO_PREVIEW__.location",
        );
    }

    if (node.type === "Literal" && typeof node.value === "string") {
      const modulePath =
        parent?.type === "ImportDeclaration" ||
        parent?.type === "ExportNamedDeclaration" ||
        parent?.type === "ExportAllDeclaration" ||
        (parent?.type === "ImportExpression" && parent.source === node);

      if (modulePath) {
        const href = previewContentUrl(node.value, context);

        if (href !== node.value) edit(node, json(href));
      }
    }
  });

  return applyEdits(source, [...edits.values()]);
}

export function rewritePreviewCss(
  source: string,
  context: PreviewContentContext,
): string {
  return source
    .replace(
      /url\(\s*(?:(['"])(.*?)\1|([^)'"\s][^)]*))\s*\)/giu,
      (
        _match,
        quote: string | undefined,
        quoted: string | undefined,
        bare: string | undefined,
      ) => {
        const value = (quoted ?? bare ?? "").trim();
        const href = previewContentUrl(value, context);

        return `url(${quote ?? '"'}${href}${quote ?? '"'})`;
      },
    )
    .replace(
      /(@import\s+)(['"])([^'"]+)\2/giu,
      (_match, prefix: string, quote: string, value: string) =>
        `${prefix}${quote}${previewContentUrl(value, context)}${quote}`,
    );
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

export function previewBootstrap(context: PreviewContentContext): string {
  return `(${String.raw`function(config) {
  const nativeLocation=window.location;
  const nativeOrigin=new URL(nativeLocation.href).origin;
  const base=config.contentBase;
  const target=new URL(config.localUrl);
  let current=new URL(config.sourceUrl);
  current.hash=nativeLocation.hash;
  const nativeFetch=window.fetch.bind(window);
  const nativeWebSocket=window.WebSocket;
  function local(url) { return ["localhost","127.0.0.1","[::1]"].includes(url.hostname) && url.port===target.port && [target.protocol,target.protocol==="https:"?"wss:":"ws:"].includes(url.protocol); }
  function map(value,from=current) {
    const text=String(value);
    if(text.startsWith(base)||text.startsWith(nativeOrigin+base))return text;
    let url;try{url=new URL(text,from);}catch{return text;}
    if(!local(url))return text;
    const path=base+url.pathname+url.search+url.hash;
    return url.protocol==="ws:"||url.protocol==="wss:"?nativeOrigin.replace(/^http/,"ws")+path:path;
  }
  function mapSrcset(value){const text=String(value);let result="",index=0;while(index<text.length){let start=index;while(index<text.length&&/[\s,]/u.test(text[index]))index++;result+=text.slice(start,index);if(index===text.length)break;start=index;while(index<text.length&&!/\s/u.test(text[index]))index++;const token=text.slice(start,index),commas=token.match(/,+$/u)?.[0]??"";result+=map(commas?token.slice(0,-commas.length):token)+commas;if(commas)continue;start=index;while(index<text.length&&text[index]!==",")index++;result+=text.slice(start,index);}return result;}
  function navigate(value,replace) { const url=new URL(String(value),current);nativeLocation[replace?"replace":"assign"](map(url)); }
  const virtualLocation={assign(value){navigate(value,false);},replace(value){navigate(value,true);},reload(){nativeLocation.reload();},toString(){return current.href;}};
  for(const key of ["href","protocol","host","hostname","port","pathname","search","hash","origin"]){Object.defineProperty(virtualLocation,key,{enumerable:true,get(){return current[key];},set(value){const next=new URL(current);next[key]=value;navigate(next,false);}});}
  const virtualLocationTarget={get location(){return virtualLocation;},set location(value){navigate(value,false);}};
  const api={location:virtualLocation,locationTarget(receiver){return receiver===window||receiver===document?virtualLocationTarget:receiver;},map};
  Object.defineProperty(globalThis,"__OMNYO_PREVIEW__",{value:api});
  const entries=[{url:current.href,state:null}];let index=0;
  function update(state,value,push){if(value!==undefined&&value!==null){const next=new URL(String(value),current);if(!local(next))throw new DOMException("Preview navigation must stay on its server","SecurityError");current=next;}if(push){entries.splice(index+1);entries.push({url:current.href,state});index++;}else entries[index]={url:current.href,state};window.parent.postMessage({type:"omnyo-preview:navigate",path:current.pathname+current.search+current.hash},nativeOrigin);}
  history.pushState=function(state,_title,url){update(state,url,true);};
  history.replaceState=function(state,_title,url){update(state,url,false);};
  Object.defineProperty(history,"state",{get(){return entries[index].state;}});
  history.go=function(delta){const next=Math.max(0,Math.min(entries.length-1,index+Number(delta||0)));if(next!==index){index=next;current=new URL(entries[index].url);window.dispatchEvent(new PopStateEvent("popstate",{state:entries[index].state}));}};
  history.back=()=>history.go(-1);history.forward=()=>history.go(1);
  for(const key of ["localStorage","sessionStorage"]){const values=new Map();Object.defineProperty(window,key,{value:{get length(){return values.size;},key(index){return [...values.keys()][index]??null;},getItem(key){return values.get(String(key))??null;},setItem(key,value){values.set(String(key),String(value));},removeItem(key){values.delete(String(key));},clear(){values.clear();}}});}
  let scriptCookies="";Object.defineProperty(document,"cookie",{get(){return scriptCookies;},set(value){scriptCookies=String(value).split(";",1)[0];}});
  window.fetch=function(input,init){const request=input instanceof Request?new Request(map(input.url),input):map(input);return nativeFetch(request,{...init,credentials:"omit"});};
  const open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url,...rest){return open.call(this,method,map(url),...rest);};
  window.WebSocket=class extends nativeWebSocket{constructor(url,protocols){super(map(url),protocols);}};
  const setAttribute=Element.prototype.setAttribute;
  const getAttribute=Element.prototype.getAttribute;
  const scriptSources=new WeakMap();
  function rememberScript(element,value,mapped){const text=String(value);scriptSources.set(element,{value:text,mapped,href:mapped===text?null:new URL(text,current).href});}
  function scriptSource(element){const physical=getAttribute.call(element,"src");if(physical===null)return null;const saved=scriptSources.get(element);if(saved?.mapped===physical)return saved;const value=getAttribute.call(element,"data-omnyo-preview-src");return value!==null&&map(value,config.sourceUrl)===physical?{value,href:new URL(value,config.sourceUrl).href}:null;}
  Element.prototype.setAttribute=function(name,value){const key=name.toLowerCase(),mapped=key==="srcset"?mapSrcset(value):["src","href","action","poster","data"].includes(key)?map(value):value;if(this instanceof HTMLScriptElement&&key==="src")rememberScript(this,value,mapped);return setAttribute.call(this,name,mapped);};
  Element.prototype.getAttribute=function(name){return this instanceof HTMLScriptElement&&name.toLowerCase()==="src"?scriptSource(this)?.value??getAttribute.call(this,name):getAttribute.call(this,name);};
  const scriptDescriptor=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,"src");
  if(scriptDescriptor?.set&&scriptDescriptor.get)Object.defineProperty(HTMLScriptElement.prototype,"src",{...scriptDescriptor,get(){return scriptSource(this)?.href??scriptDescriptor.get.call(this);},set(value){const mapped=map(value);rememberScript(this,value,mapped);scriptDescriptor.set.call(this,mapped);}});
  for(const [constructor,key] of [[HTMLImageElement,"src"],[HTMLImageElement,"srcset"],[HTMLSourceElement,"srcset"],[HTMLLinkElement,"href"],[HTMLAnchorElement,"href"],[HTMLFormElement,"action"],[HTMLIFrameElement,"src"]]){const descriptor=Object.getOwnPropertyDescriptor(constructor.prototype,key);if(descriptor?.set&&descriptor.get)Object.defineProperty(constructor.prototype,key,{...descriptor,set(value){descriptor.set.call(this,key==="srcset"?mapSrcset(value):map(value));}});}
  document.addEventListener("click",event=>{const anchor=event.target instanceof Element?event.target.closest("a[href]"):null;if(anchor)anchor.setAttribute("href",map(anchor.getAttribute("href")));},true);
  document.addEventListener("submit",event=>{if(event.target instanceof HTMLFormElement)event.target.action=map(event.target.getAttribute("action")||current.href);},true);
}`})(${json({ contentBase: context.contentBase, localUrl: context.localUrl.href, sourceUrl: context.sourceUrl.href })});`;
}

export function rewritePreviewHtml(
  source: string,
  context: PreviewContentContext,
): string {
  const document = parseHtml(source, { sourceCodeLocationInfo: true });
  const edits: Edit[] = [];
  let headEnd: number | null = null;

  function visit(node: DefaultTreeAdapterMap["node"]): void {
    if ("tagName" in node) {
      const location = node.sourceCodeLocation;

      if (node.tagName === "head" && location?.startTag)
        headEnd = location.startTag.endOffset;

      for (const attribute of node.attrs) {
        const span = location?.attrs?.[attribute.name];

        if (!span) continue;
        let value = attribute.value;

        if (
          ["src", "href", "action", "poster", "data"].includes(attribute.name)
        )
          value = previewContentUrl(value, context);

        if (attribute.name === "srcset")
          value = value
            .split(",")
            .map((candidate) =>
              candidate
                .trim()
                .split(/\s+/u)
                .map((part, index) =>
                  index === 0 ? previewContentUrl(part, context) : part,
                )
                .join(" "),
            )
            .join(", ");

        if (attribute.name === "style")
          value = rewritePreviewCss(value, context);

        if (value !== attribute.value)
          edits.push({
            start: span.startOffset,
            end: span.endOffset,
            text: `${attribute.name}="${escapeAttribute(value)}"`,
          });

        if (
          node.tagName === "script" &&
          attribute.name === "src" &&
          value !== attribute.value &&
          location?.startTag
        )
          edits.push({
            start: location.startTag.startOffset + node.tagName.length + 1,
            end: location.startTag.startOffset + node.tagName.length + 1,
            text: ` data-omnyo-preview-src="${escapeAttribute(attribute.value)}"`,
          });

        if (
          attribute.name === "integrity" &&
          (node.tagName === "script" || node.tagName === "link")
        )
          edits.push({
            start: span.startOffset,
            end: span.endOffset,
            text: "",
          });
      }

      if (
        node.tagName === "script" &&
        !node.attrs.some((attribute) => attribute.name === "src")
      ) {
        const type = node.attrs
          .find((attribute) => attribute.name === "type")
          ?.value.toLowerCase();

        if (
          (type === undefined ||
            type === "module" ||
            type === "text/javascript" ||
            type === "application/javascript") &&
          location?.startTag &&
          location.endTag
        ) {
          const start = location.startTag.endOffset,
            end = location.endTag.startOffset;

          edits.push({
            start,
            end,
            text: rewritePreviewJavaScript(source.slice(start, end), context),
          });
        }
      }

      if (node.tagName === "style" && location?.startTag && location.endTag) {
        const start = location.startTag.endOffset,
          end = location.endTag.startOffset;

        edits.push({
          start,
          end,
          text: rewritePreviewCss(source.slice(start, end), context),
        });
      }
    }

    if ("childNodes" in node) node.childNodes.forEach(visit);
  }

  visit(document);
  const insert = headEnd ?? 0;
  edits.push({
    start: insert,
    end: insert,
    text: `<script>${previewBootstrap(context)}</script>`,
  });

  return applyEdits(source, edits);
}
