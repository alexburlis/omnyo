import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { createPreviewShell } from "../../../src/services/previews/preview-shell.js";
import { parse } from "acorn";
import {
  previewBootstrap,
  previewContentUrl,
  rewritePreviewJavaScript,
  rewritePreviewCss,
  rewritePreviewHtml,
} from "../../../src/services/previews/preview-runtime.js";

const context = {
  contentBase: "/preview-content/prv_test/cap",
  localUrl: new URL("http://localhost:4399/compare/superwhisper"),
  sourceUrl: new URL("http://localhost:4399/assets/main.js"),
};

describe("isolated preview runtime URLs", () => {
  it("gives application code the original path, query and browser-only fragment on first load", () => {
    const pageContext = {
      ...context,
      sourceUrl: new URL(
        "http://localhost:4399/compare/superwhisper?fixture=1",
      ),
    };

    class PreviewElement {}

    const result = runInNewContext(
      previewBootstrap(pageContext) +
        rewritePreviewJavaScript(
          `function route(options) {
            const browser = options?.window ?? (typeof document !== 'undefined' ? window : undefined);
            return browser?.location.pathname + browser.location.search + browser.location.hash;
          }
          ({href:location.href, route:route(), other:route({window:{location:new URL('https://other.test/other?q=2#elsewhere')}})})`,
          pageContext,
        ),
      {
        URL,
        window: {
          location: new URL(
            "http://omnyo.test/preview-content/prv_test/cap/compare/superwhisper?fixture=1#ready",
          ),
          fetch,
          WebSocket: class {},
        },
        history: {},
        document: { addEventListener() {} },
        XMLHttpRequest: class {},
        Element: PreviewElement,
        HTMLScriptElement: PreviewElement,
        HTMLImageElement: PreviewElement,
        HTMLSourceElement: PreviewElement,
        HTMLLinkElement: PreviewElement,
        HTMLAnchorElement: PreviewElement,
        HTMLFormElement: PreviewElement,
        HTMLIFrameElement: PreviewElement,
      },
    );

    expect(result).toEqual({
      href: "http://localhost:4399/compare/superwhisper?fixture=1#ready",
      route: "/compare/superwhisper?fixture=1#ready",
      other: "/other?q=2#elsewhere",
    });
  });
  it("routes loopback aliases and preserves root, relative, query and fragment paths", () => {
    expect(
      previewContentUrl("http://127.0.0.1:4399/a?x=1#ready", context),
    ).toBe(context.contentBase + "/a?x=1#ready");
    expect(previewContentUrl("./chunk.js", context)).toBe(
      context.contentBase + "/assets/chunk.js",
    );
    expect(previewContentUrl("http://localhost:4400/a", context)).toBe(
      "http://localhost:4400/a",
    );
    expect(previewContentUrl("https://example.com/a", context)).toBe(
      "https://example.com/a",
    );
  });
  it("uses parsed import and global references without changing strings, regexes or local variables", () => {
    const source = `import x from '/src/a.js';export {x};const text='window.location.href';const regexp=/window.location/;const y=window.location.pathname;const z=location.hash;const meta=import.meta.url;function own(window,location){return window.location+location.hash;}`;
    const result = rewritePreviewJavaScript(source, context);
    expect(result).toContain(`"${context.contentBase}/src/a.js"`);
    expect(result).toContain("'window.location.href'");
    expect(result).toContain("/window.location/");
    expect(result).toContain("globalThis.__OMNYO_PREVIEW__.location.pathname");
    expect(result).toContain("globalThis.__OMNYO_PREVIEW__.location.hash");
    expect(result).toContain("+location.hash;");
    expect(result).toContain(JSON.stringify(context.sourceUrl.href));
    expect(() =>
      parse(result, { ecmaVersion: "latest", sourceType: "module" }),
    ).not.toThrow();
  });
  it("keeps asset identities logical while rewriting native module specifiers", () => {
    const source = `const prefix='/_next/';const chunk='/_next/static/chunks/page.js';import '/_next/static/chunks/module.js';`;
    const result = rewritePreviewJavaScript(source, context);

    expect(result).toContain(`const prefix='/_next/'`);
    expect(result).toContain(`const chunk='/_next/static/chunks/page.js'`);
    expect(result).toContain(
      `import "${context.contentBase}/_next/static/chunks/module.js"`,
    );
  });
  it.each([
    "/_next/static/chunks/page.js?build=1",
    "http://localhost:4399/_next/static/chunks/page.js?build=1",
  ])(
    "resolves cached script loads using their original identity: %s",
    async (source) => {
      class PreviewElement {
        private readonly attributes = new Map<string, string>();

        getAttribute(name: string) {
          return this.attributes.get(name.toLowerCase()) ?? null;
        }

        setAttribute(name: string, value: string) {
          this.attributes.set(name.toLowerCase(), String(value));
        }
      }

      const nativeGetAttribute = PreviewElement.prototype.getAttribute;
      const nativeSetAttribute = PreviewElement.prototype.setAttribute;

      const documentUrl = new URL(
        `http://omnyo.test${context.contentBase}/compare/superwhisper`,
      );

      class PreviewScript extends PreviewElement {
        get src() {
          const value = nativeGetAttribute.call(this, "src");

          return value === null ? "" : new URL(value, documentUrl).href;
        }

        set src(value: string) {
          nativeSetAttribute.call(this, "src", value);
        }
      }

      class ResponsiveImage extends PreviewElement {
        get srcset() {
          return nativeGetAttribute.call(this, "srcset") ?? "";
        }

        set srcset(value: string) {
          nativeSetAttribute.call(this, "srcset", value);
        }
      }

      class ResponsiveSource extends PreviewElement {
        get srcset() {
          return nativeGetAttribute.call(this, "srcset") ?? "";
        }

        set srcset(value: string) {
          nativeSetAttribute.call(this, "srcset", value);
        }
      }

      const initial = new PreviewScript();
      nativeSetAttribute.call(
        initial,
        "src",
        previewContentUrl(source, context),
      );
      nativeSetAttribute.call(initial, "data-omnyo-preview-src", source);

      const foreign = new PreviewScript();
      nativeSetAttribute.call(
        foreign,
        "src",
        "/preview-content/other/cap/chunk.js",
      );
      nativeSetAttribute.call(foreign, "data-omnyo-preview-src", "/chunk.js");

      const result = await runInNewContext(
        previewBootstrap({
          ...context,
          sourceUrl: new URL("http://localhost:4399/compare/superwhisper"),
        }) +
          `(async()=>{
          const results=[];
          for(const mode of ["initial","property","attribute"]){
            let resolve;
            const loaded=new Promise(done=>{resolve=done;});
            const cache=new Map([[source,resolve]]);
            const script=mode==="initial"?initial:new HTMLScriptElement();
            if(mode==="property")script.src=source;
            if(mode==="attribute")script.setAttribute("src",source);
            cache.get(script.getAttribute("src"))?.("loaded");
            results.push({mode,state:await Promise.race([loaded,Promise.resolve("pending")]),attribute:script.getAttribute("src"),property:script.src,network:nativeGetAttribute.call(script,"src")});
          }
          history.pushState(null,"","/next");
            const responsive=[];
            for(const Constructor of [HTMLImageElement,HTMLSourceElement]){
              for(const mode of ["property","attribute"]){
                const image=new Constructor();
                const candidates="/_next/image?url=%2Fposter.jpg&w=384&q=75 384w, /_next/image?url=%2Fposter.jpg&w=640&q=75 640w";
                if(mode==="property")image.srcset=candidates;
                else image.setAttribute("srcSet",candidates);
                responsive.push(nativeGetAttribute.call(image,"srcset"));
              }
            }
            const dataImage=new HTMLImageElement();
            dataImage.srcset="data:image/png;base64,AAAA 1x, /poster.png 2x";
            return {results,responsive,dataSrcset:dataImage.srcset,initialAfterNavigation:initial.src,foreignAttribute:foreign.getAttribute("src"),foreignProperty:foreign.src};
        })()`,
        {
          URL,
          source,
          initial,
          foreign,
          nativeGetAttribute,
          window: {
            location: documentUrl,
            fetch,
            WebSocket: class {},
            parent: { postMessage() {} },
          },
          history: {},
          document: { addEventListener() {} },
          XMLHttpRequest: class {},
          Element: PreviewElement,
          HTMLScriptElement: PreviewScript,
          HTMLImageElement: ResponsiveImage,
          HTMLSourceElement: ResponsiveSource,
          HTMLLinkElement: class extends PreviewElement {},
          HTMLAnchorElement: class extends PreviewElement {},
          HTMLFormElement: class extends PreviewElement {},
          HTMLIFrameElement: class extends PreviewElement {},
        },
      );

      expect(result.results).toEqual(
        ["initial", "property", "attribute"].map((mode) => ({
          mode,
          state: "loaded",
          attribute: source,
          property: new URL(source, context.localUrl).href,
          network: previewContentUrl(source, context),
        })),
      );
      expect(result.initialAfterNavigation).toBe(
        new URL(source, context.localUrl).href,
      );
      expect(result.responsive).toEqual(
        Array(4).fill(
          `${context.contentBase}/_next/image?url=%2Fposter.jpg&w=384&q=75 384w, ${context.contentBase}/_next/image?url=%2Fposter.jpg&w=640&q=75 640w`,
        ),
      );
      expect(result.dataSrcset).toBe(
        `data:image/png;base64,AAAA 1x, ${context.contentBase}/poster.png 2x`,
      );
      expect(result.foreignAttribute).toBe(
        "/preview-content/other/cap/chunk.js",
      );
      expect(result.foreignProperty).toBe(
        "http://omnyo.test/preview-content/other/cap/chunk.js",
      );
    },
  );
  it("rewrites HTML assets, inline modules and CSS before their scripts execute", () => {
    const result = rewritePreviewHtml(
      `<html><head><link rel="stylesheet" href="/style.css"><script src="/_next/static/chunks/page.js"></script><script type="module">import '/src/a.js';window.route=location.pathname;</script></head><body><img src="/logo.svg"><a href="/next?q=1&amp;b=2">Next</a></body></html>`,
      context,
    );

    expect(result.indexOf("__OMNYO_PREVIEW__")).toBeLessThan(
      result.indexOf('href="' + context.contentBase + "/style.css"),
    );
    expect(result).toContain(`src="${context.contentBase}/logo.svg"`);
    expect(result).toContain(
      `data-omnyo-preview-src="/_next/static/chunks/page.js"`,
    );
    expect(result).toContain(`href="${context.contentBase}/next?q=1&amp;b=2"`);
    expect(
      rewritePreviewCss(
        `.logo{background:url('/logo.svg')}@import "/other.css";`,
        context,
      ),
    ).toContain(`url('${context.contentBase}/logo.svg')`);
  });
});

describe("preview shell branding and theme", () => {
  it.each([
    { preference: "light", systemDark: true, dark: false },
    { preference: "dark", systemDark: false, dark: true },
  ])(
    "uses the current Omnyo theme in a preview shell: $preference",
    async ({ preference, systemDark, dark }) => {
      const response = createPreviewShell("prv_registered");
      expect(response.status).toBe(200);
      const html = await response.text();
      const bootstrap = /<script nonce="[^"]+">([^<]+)<\/script>/u.exec(html);
      expect(bootstrap).not.toBeNull();
      const keys: string[] = [];
      const classes: string[] = [];
      runInNewContext(
        bootstrap?.[1] ?? "",
        {
          localStorage: {
            getItem(key: string) {
              keys.push(key);

              return key === "omnyo.theme" ? preference : null;
            },
          },
          matchMedia: () => ({ matches: systemDark }),
          document: {
            documentElement: {
              classList: { add: (name: string) => classes.push(name) },
            },
          },
        },
        { timeout: 1000 },
      );
      expect(keys).toEqual(["omnyo.theme"]);
      expect(classes.includes("dark")).toBe(dark);
      expect(html).toContain("<title>Omnyo preview</title>");
      expect(html).toContain(">Open Omnyo</a>");
    },
  );
});
