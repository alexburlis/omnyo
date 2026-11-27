/**
 * The synchronous styles content script retains Omnyo's primary CSS asset. The
 * panel waits here outside the host's content-script DOM guard. The host's final
 * matching link is current; an older stylesheet may remain during replacement.
 */
export async function waitForStatsStyles(pluginId: string, signal: AbortSignal): Promise<void> {
  const links = document.querySelectorAll<HTMLLinkElement>(
    `link[data-omnyo-plugin-css="${CSS.escape(pluginId)}"]`,
  );

  const link = links.item(links.length - 1);

  if (!link) throw new Error("Stats stylesheet was not registered by Omnyo.");

  if (signal.aborted) throw new DOMException("Stats stylesheet mount was cancelled.", "AbortError");

  if (link.sheet) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      link.removeEventListener("load", loaded);
      link.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };

    const loaded = () => {
      cleanup();
      resolve();
    };

    const failed = () => {
      cleanup();
      reject(new Error("Stats stylesheet could not load."));
    };

    const aborted = () => {
      cleanup();
      reject(new DOMException("Stats stylesheet mount was cancelled.", "AbortError"));
    };

    link.addEventListener("load", loaded);
    link.addEventListener("error", failed);
    signal.addEventListener("abort", aborted);

    if (signal.aborted) aborted();
    else if (link.sheet) loaded();
  });
}
