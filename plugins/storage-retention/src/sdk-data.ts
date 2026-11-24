import type { PluginApi } from "@omnyo/plugin-sdk";

export async function readThreads(api: PluginApi, signal?: AbortSignal) {
  const rows: Awaited<ReturnType<typeof api.sdk.threads.list>> = [];

  for (let offset = 0; ; offset += 500) {
    signal?.throwIfAborted();

    const page = await api.sdk.threads.list({
      includeHidden: true,
      limit: 500,
      offset,
      signal,
    });

    rows.push(...page);

    if (page.length < 500) return rows;
  }
}

export async function readThreadsById(
  api: PluginApi,
  threadIds: readonly string[],
  signal?: AbortSignal,
) {
  const rows: Awaited<ReturnType<typeof api.sdk.threads.list>> = [];

  for (let offset = 0; offset < threadIds.length; offset += 200) {
    signal?.throwIfAborted();
    rows.push(
      ...(await api.sdk.threads.list({
        includeHidden: true,
        threadIds: threadIds.slice(offset, offset + 200),
        signal,
      })),
    );
  }

  return new Map(rows.map((thread) => [thread.id, thread]));
}

export async function readThreadsInEnvironments(
  api: PluginApi,
  environmentIds: readonly string[],
  signal?: AbortSignal,
) {
  const pages = await Promise.all(
    environmentIds.map((environmentId) =>
      api.sdk.threads.list({ environmentId, includeHidden: true, signal }),
    ),
  );

  return pages.flat();
}
