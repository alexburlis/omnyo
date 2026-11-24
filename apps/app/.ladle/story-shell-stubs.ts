import { sdk } from "../src/lib/sdk";
import { wsManager } from "../src/lib/ws";
import type { StoryHostFile } from "./sidebar-shell-fixtures";

export type StoryPluginRpcHandlers = Readonly<
  Record<string, Readonly<Record<string, (input: unknown) => unknown>>>
>;

const PLUGIN_RPC_PATH = /^\/api\/v1\/plugins\/([^/]+)\/rpc\/([^/]+)$/u;

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  const href =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  return new URL(href, window.location.origin);
}

function requestInput(init: RequestInit | undefined): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : null;
}

export function installStoryPluginRpc(
  handlers: StoryPluginRpcHandlers,
): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const match = PLUGIN_RPC_PATH.exec(requestUrl(input).pathname);

    const handler =
      match?.[1] === undefined || match[2] === undefined
        ? undefined
        : handlers[decodeURIComponent(match[1])]?.[
            decodeURIComponent(match[2])
          ];

    if (handler === undefined) return originalFetch(input, init);

    return new Response(
      JSON.stringify({ ok: true, result: handler(requestInput(init)) }),
      { headers: { "content-type": "application/json" } },
    );
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export function installStoryHostFiles(
  files: readonly StoryHostFile[],
): () => void {
  const originalList = sdk.files.list;

  sdk.files.list = async ({ hostId, path, query }) => {
    const needle = (query ?? "").toLowerCase();

    const matches = files.filter(
      (file) =>
        file.hostId === hostId &&
        file.root === path &&
        file.path.toLowerCase().includes(needle),
    );

    return {
      files: matches.map((file) => ({
        path: file.path,
        name: fileName(file.path),
      })),
      truncated: false,
    };
  };

  return () => {
    sdk.files.list = originalList;
  };
}

export function installStoryProjectFileImages(
  images: ReadonlyMap<string, string>,
): () => void {
  const imagePrototype = HTMLImageElement.prototype;
  const setElementAttribute = Element.prototype.setAttribute;
  const srcDescriptor = Object.getOwnPropertyDescriptor(imagePrototype, "src");
  const setImageSrc = srcDescriptor?.set;
  const storyImage = (value: string) => images.get(value) ?? value;

  imagePrototype.setAttribute = function setStoryImageAttribute(
    this: HTMLImageElement,
    name: string,
    value: string,
  ) {
    setElementAttribute.call(
      this,
      name,
      name === "src" ? storyImage(value) : value,
    );
  };

  if (srcDescriptor !== undefined && setImageSrc !== undefined) {
    Object.defineProperty(imagePrototype, "src", {
      ...srcDescriptor,
      set(this: HTMLImageElement, value: string) {
        setImageSrc.call(this, storyImage(value));
      },
    });
  }

  return () => {
    Reflect.deleteProperty(imagePrototype, "setAttribute");

    if (srcDescriptor !== undefined) {
      Object.defineProperty(imagePrototype, "src", srcDescriptor);
    }
  };
}

export function installStoryRealtimeConnected(): () => void {
  wsManager.getConnectionState = () => "connected";

  return () => {
    Reflect.deleteProperty(wsManager, "getConnectionState");
  };
}
