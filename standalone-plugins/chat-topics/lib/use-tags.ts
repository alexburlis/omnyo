import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useRealtime, useRpc, useSdk } from "@omnyo/plugin-sdk/app";
import type { rpcContract } from "./contract.ts";
import { CHANGED_CHANNEL, changedPayloadSchema } from "./records.ts";
import {
  effectiveTagId,
  findTag,
  tagListSchema,
  metadataTagSchema,
  type Tag,
  type TagRecord,
} from "./tags.ts";

const METADATA_PAGE = 200;

const RETRY_MS = 5000;

interface PendingTag {
  tagId: string | null;
  token: number;
}

export interface TagState {
  tags: readonly Tag[];
  failed: boolean;
  tagIdOf: (threadId: string) => string | null;
  setTag: (threadId: string, tagId: string | null) => Promise<void>;
}

// A failed load retries until one succeeds, which clears its notice.
function useRetry(failed: boolean, attempt: number, retry: Dispatch<SetStateAction<number>>) {
  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(() => retry((value) => value + 1), RETRY_MS);

    return () => clearTimeout(timer);
  }, [failed, attempt, retry]);
}

export function useTagList() {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const [tags, setTags] = useState<readonly Tag[]>([]);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const request = useRef(0);

  useEffect(() => {
    const sequence = ++request.current;

    rpc.call("tags.list", {}).then(
      (result) => {
        if (sequence !== request.current) return;
        setTags(tagListSchema.parse(result.tags));
        setFailed(false);
      },
      (error) => {
        console.warn("Chat Topics could not load the tag list", error);

        if (sequence === request.current) setFailed(true);
      },
    );
  }, [rpc, reload]);

  useRetry(failed, reload, setReload);

  useEffect(
    () =>
      sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.state === "connected") setReload((value) => value + 1);
        },
      }),
    [sdk],
  );

  const replace = useCallback((next: readonly Tag[]) => {
    request.current += 1;
    setTags(next);
    setFailed(false);
  }, []);

  useRealtime(CHANGED_CHANNEL, (payload) => {
    const parsed = changedPayloadSchema.safeParse(payload);

    if (parsed.success && parsed.data.kind === "tags") replace(parsed.data.tags);
  });

  return { tags, failed, replace };
}

export function useTags(threadIds: readonly string[]): TagState {
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const list = useTagList();
  const [records, setRecords] = useState<ReadonlyMap<string, TagRecord>>(new Map());
  const [pending, setPending] = useState<ReadonlyMap<string, PendingTag>>(new Map());
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const tokens = useRef(0);
  const key = [...threadIds].sort().join(",");

  const load = useCallback(
    async (ids: readonly string[]) => {
      const found = new Map<string, TagRecord>();

      for (let start = 0; start < ids.length; start += METADATA_PAGE) {
        const { threads } = await sdk.threads.experimental_listPluginMetadata({
          threadIds: ids.slice(start, start + METADATA_PAGE),
        });

        for (const entry of threads) {
          const record = metadataTagSchema.parse(entry.metadata);

          if (record !== null) found.set(entry.threadId, record);
        }
      }

      return found;
    },
    [sdk],
  );

  useEffect(() => {
    let live = true;
    const ids = key === "" ? [] : key.split(",");

    load(ids).then(
      (found) => {
        if (!live) return;
        setRecords(found);
        setFailed(false);
      },
      (error) => {
        console.warn("Chat Topics could not load chat tags", error);

        if (live) setFailed(true);
      },
    );

    return () => {
      live = false;
    };
  }, [key, load, reload]);

  useRetry(failed, reload, setReload);

  useEffect(
    () =>
      sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.state === "connected") setReload((value) => value + 1);
        },
      }),
    [sdk],
  );

  useRealtime(CHANGED_CHANNEL, (payload) => {
    const parsed = changedPayloadSchema.safeParse(payload);

    if (!parsed.success || parsed.data.kind !== "threads" || parsed.data.threadIds.length === 0)
      return;
    const ids = parsed.data.threadIds;

    load(ids).then(
      (found) => {
        setRecords((previous) => {
          const next = new Map(previous);

          for (const id of ids) {
            const record = found.get(id);

            if (record === undefined) next.delete(id);
            else next.set(id, record);
          }

          return next;
        });
      },
      (error) => {
        console.warn("Chat Topics could not refresh chat tags", error);
        setFailed(true);
      },
    );
  });

  const setTag = useCallback(
    async (threadId: string, tagId: string | null) => {
      tokens.current += 1;
      const token = tokens.current;
      setPending((previous) => new Map(previous).set(threadId, { tagId, token }));

      try {
        const record = await rpc.call("tag.set", { threadId, tagId });
        setRecords((previous) => new Map(previous).set(threadId, record));
      } finally {
        setPending((previous) => {
          if (previous.get(threadId)?.token !== token) return previous;
          const next = new Map(previous);
          next.delete(threadId);

          return next;
        });
      }
    },
    [rpc],
  );

  const { tags } = list;

  const tagIdOf = useCallback(
    (threadId: string) => {
      const optimistic = pending.get(threadId);

      return optimistic === undefined
        ? effectiveTagId(records.get(threadId) ?? null, tags)
        : (findTag(tags, optimistic.tagId)?.id ?? null);
    },
    [pending, records, tags],
  );

  return useMemo(
    () => ({ tags, failed: failed || list.failed, tagIdOf, setTag }),
    [tags, failed, list.failed, tagIdOf, setTag],
  );
}
