import { useThreadInitialLoadPending } from "@/components/thread/ThreadInitialLoad";
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";
import { REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY } from "./query-policies";
import type { QueryOptions } from "./query-helpers";
import {
  projectSubmittedNativeQuestions,
  useNativeQuestionSubmissions,
} from "./native-question-submissions";

import {
  refreshThreadAttentionCache,
  replaceThreadAttentionItems,
  threadAttentionQueryKey,
} from "../cache-owners/thread-attention-cache-owner";

function useThreadAttentionSnapshot(options?: QueryOptions) {
  return useQuery({
    queryKey: threadAttentionQueryKey,
    queryFn: ({ signal }) => sdk.experimental_attention.snapshot({ signal }),
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
    enabled: options?.enabled ?? true,
  });
}

export function useThreadAttentionCache() {
  const client = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      refreshThreadAttentionCache(client);
    };

    const changed = wsManager.onChanged((message) => {
      if (message.entity !== "thread" || !message.id) return;
      const items = message.metadata?.attentionItems;

      if (items) {
        replaceThreadAttentionItems(client, message.id, items);
      } else if (message.changes.includes("thread-deleted")) {
        replaceThreadAttentionItems(client, message.id, {
          questions: [],
          callbacks: [],
        });
      } else if (message.changes.includes("archived-changed")) {
        refresh();
      }
    });

    const connected = wsManager.onConnected(refresh);
    const resumed = wsManager.onResumed(refresh);

    return () => {
      changed();
      connected();
      resumed();
    };
  }, [client]);

  useThreadAttentionSnapshot();
}

export function useThreadAttention(options?: QueryOptions) {
  const query = useThreadAttentionSnapshot(options);
  const submittedQuestions = useNativeQuestionSubmissions();

  const data = useMemo(
    () => projectSubmittedNativeQuestions(query.data, submittedQuestions),
    [query.data, submittedQuestions],
  );

  useThreadInitialLoadPending(
    options?.enabled !== false && query.data === undefined && query.isFetching,
  );

  return { ...query, data, submittedQuestions };
}
