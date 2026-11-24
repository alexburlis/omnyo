import { createBrowserOmnyoSdk } from "@omnyo/sdk/browser";
import { appSurfaceRequestInit } from "@/lib/app-surface";
import { serveBootRead } from "@/lib/boot-reads";

type FetchLike = typeof fetch;

export function createPluginsClient(fetchImpl: FetchLike) {
  const fetchWithAppSurface: FetchLike = (input, init) => {
    const network = () =>
      fetchImpl.call(globalThis, input, appSurfaceRequestInit(init));

    return serveBootRead(input, init, network) ?? network();
  };

  return createBrowserOmnyoSdk({ fetch: fetchWithAppSurface }).plugins;
}
