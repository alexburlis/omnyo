// @vitest-environment jsdom

import type { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  makeWorkspaceStatus,
  makeWorkspaceWorkingTree,
} from "@omnyo/test-helpers";
import {
  makeEnvironment,
  makeThread,
  makeThreadQueuedMessage,
} from "@omnyo/test-helpers/domain-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { appToast } from "@/components/ui/app-toast";
import { useThreadGitActions } from "./useThreadGitActions";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(["sent", "queued"] as const)(
  "uses the target chat's normal send path when the commit request is %s",
  async (delivery) => {
    const queryClient = new QueryClient();
    const thread = makeThread();

    const send = vi
      .spyOn(sdk.threads, "send")
      .mockResolvedValue(
        delivery === "sent"
          ? { ok: true, delivery }
          : { ok: true, delivery, queuedMessage: makeThreadQueuedMessage() },
      );

    const success = vi.spyOn(appToast, "success").mockReturnValue("success");

    const { result } = renderHook(
      () =>
        useThreadGitActions({
          thread,
          environment: makeEnvironment(),
          workspaceStatus: makeWorkspaceStatus({
            workingTree: makeWorkspaceWorkingTree({
              state: "dirty_uncommitted",
              hasUncommittedChanges: true,
            }),
          }),
        }),
      {
        wrapper: ({ children }: PropsWithChildren) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      },
    );

    expect(result.current.canCommit).toBe(true);
    await act(() => result.current.handleCommitThread());
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        threadId: thread.id,
        mode: "queue-if-active",
        messageSource: { kind: "script", label: "Omnyo · Commit changes" },
        input: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("create a local Git commit"),
          }),
        ],
      }),
    );
    expect(success).toHaveBeenCalledWith(`Commit request ${delivery}`);
  },
);
