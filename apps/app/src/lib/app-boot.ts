import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  BOOT_API_PATH,
  formatBootPartList,
  type BootPartName,
} from "@omnyo/server-contract";
import { startBootCache } from "@/hooks/cache-owners/boot-cache-owner";
import { fetchWithAppSurface } from "./app-surface";
import {
  installBootReads,
  parseBootOutcome,
  type BootOutcome,
  type PageBoot,
} from "./boot-reads";
import { indexedDbBootSnapshotStore } from "./boot-snapshot-store";
import { clearCachedEnvironmentProviderLists } from "./environment-provider-list-cache";
import { clearCachedModelCatalogs } from "./model-catalog-cache";
import { clearCachedProviderLists } from "./provider-list-cache";
import { clearCachedSidebarBootstrap } from "./sidebar-bootstrap-cache";
import { clearCachedThreadExecutionOptions } from "./thread-execution-options-cache";
import { wsManager } from "./ws";

const PAGE_BOOT_GLOBAL = "__omnyoBootV1";

const inlineBootResultSchema = z.object({
  status: z.number().int(),
  text: z.string(),
  receivedAt: z.number(),
});

function failedOutcome(): BootOutcome {
  return { kind: "failed" };
}

export function readInlinePageBoot(source: unknown): PageBoot | null {
  if (typeof source !== "object" || source === null) return null;
  const version: unknown = Reflect.get(source, "version");
  const startedAt: unknown = Reflect.get(source, "startedAt");
  const promise: unknown = Reflect.get(source, "promise");

  if (
    version !== 1 ||
    typeof startedAt !== "number" ||
    !(promise instanceof Promise)
  )
    return null;

  const outcome = promise.then((raw: unknown): BootOutcome => {
    const parsed = inlineBootResultSchema.safeParse(raw);

    return parsed.success ? parseBootOutcome(parsed.data) : failedOutcome();
  }, failedOutcome);

  return {
    startedAt,
    settled: Reflect.get(source, "settled") === true,
    outcome,
  };
}

async function requestBoot(
  parts: readonly BootPartName[],
): Promise<BootOutcome> {
  const search = new URLSearchParams({ parts: formatBootPartList(parts) });

  try {
    const response = await fetchWithAppSurface(
      `${window.location.origin}${BOOT_API_PATH}?${search.toString()}`,
    );

    return parseBootOutcome({
      status: response.status,
      text: await response.text(),
      receivedAt: Date.now(),
    });
  } catch {
    return failedOutcome();
  }
}

function clearLastKnownCaches(): void {
  clearCachedSidebarBootstrap();
  clearCachedProviderLists();
  clearCachedModelCatalogs();
  clearCachedEnvironmentProviderLists();
  clearCachedThreadExecutionOptions();
}

export async function startAppBootCache(
  queryClient: QueryClient,
): Promise<void> {
  let warned = false;

  const cache = await startBootCache({
    queryClient,
    origin: window.location.origin,
    page: readInlinePageBoot(Reflect.get(window, PAGE_BOOT_GLOBAL)),
    store: indexedDbBootSnapshotStore,
    requestBoot,
    clearLastKnownCaches,
    install: (reads) => {
      installBootReads(reads);
      wsManager.onConnected(() => reads.openRefreshWindow());
    },
    onBootFailure: () => {
      if (warned) return;
      warned = true;
      console.warn(
        "[Omnyo] The combined startup read failed; loading each item separately",
      );
    },
    onSnapshotReadTimeout: () => {
      console.warn(
        "[Omnyo] The saved startup copy did not open in time; starting without it",
      );
    },
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void cache.persist();
  });
}
