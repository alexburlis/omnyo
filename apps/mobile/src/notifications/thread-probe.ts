import type { ThreadProbe } from "@/data/notifications";
import { createMobileFetch } from "@/lib/sdk/mobile-fetch";

const probeFetch = createMobileFetch((input, init) => fetch(input, init));

export async function probeThreadOnServer(
  serverUrl: string,
  threadId: string,
): Promise<ThreadProbe> {
  const url = `${serverUrl.replace(/\/+$/u, "")}/api/v1/threads/${encodeURIComponent(threadId)}`;

  const response = await probeFetch(url, {
    method: "GET",
    headers: new Headers({ accept: "application/json" }),
    signal: AbortSignal.timeout(8_000),
  });

  if (response.ok) return "found";

  return response.status === 404 ? "missing" : "unknown";
}
