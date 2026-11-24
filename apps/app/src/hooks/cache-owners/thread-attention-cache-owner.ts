import type { QueryClient } from "@tanstack/react-query";
import type { ThreadAttentionSnapshot } from "@omnyo/domain";

export const threadAttentionQueryKey = ["native-thread-attention"] as const;

export function refreshThreadAttentionCache(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: threadAttentionQueryKey });
}

export function replaceThreadAttentionItems(
  client: QueryClient,
  threadId: string,
  items: ThreadAttentionSnapshot,
): void {
  const fetching = client.isFetching({ queryKey: threadAttentionQueryKey }) > 0;

  client.setQueryData<ThreadAttentionSnapshot>(
    threadAttentionQueryKey,
    (snapshot) =>
      snapshot && {
        questions: [
          ...snapshot.questions.filter(
            (question) => question.threadId !== threadId,
          ),
          ...items.questions,
        ],
        callbacks: [
          ...snapshot.callbacks.filter(
            (callback) => callback.threadId !== threadId,
          ),
          ...items.callbacks,
        ],
      },
  );

  if (fetching) refreshThreadAttentionCache(client);
}

export async function applyThreadQuestionCommandResult(
  client: QueryClient,
  result: Pick<ThreadAttentionSnapshot, "questions">,
): Promise<void> {
  await client.cancelQueries({ queryKey: threadAttentionQueryKey });
  client.setQueryData<ThreadAttentionSnapshot>(
    threadAttentionQueryKey,
    (snapshot) =>
      snapshot
        ? {
            ...snapshot,
            questions: snapshot.questions.filter(
              (entry) =>
                !result.questions.some(
                  (changed) =>
                    changed.id === entry.id &&
                    changed.revision >= entry.revision &&
                    changed.state !== "open",
                ),
            ),
          }
        : snapshot,
  );
  refreshThreadAttentionCache(client);
}
