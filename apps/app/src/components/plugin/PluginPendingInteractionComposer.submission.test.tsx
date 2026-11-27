// @vitest-environment jsdom

import { resolve } from "node:path";
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  collectPluginAppRegistrations,
  definePluginApp,
  isPluginAppDefinition,
} from "@/lib/plugin-app-definition";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { sdk } from "@/lib/sdk";
import { resetAllCrashedPluginSlotsForTest } from "./PluginSlotMount";
import { PluginPendingInteractionComposer } from "./PluginPendingInteractionComposer";

vi.mock("@omnyo/shared-ui/icon-extended", () => ({}));

vi.mock("@omnyo/plugin-sdk/app", () => ({ definePluginApp }));

vi.mock("@omnyo/shared-ui/icon", () => ({ Icon: () => null }));

vi.mock(
  "@/components/thread/pending-interactions/PendingInteractionShell",
  () => ({
    PendingInteractionShell: ({
      children,
      errorMessage,
    }: {
      children: (expanded: boolean) => React.ReactNode;
      errorMessage?: string | null;
    }) => (
      <section>
        {children(true)}
        {errorMessage ? <div role="alert">{errorMessage}</div> : null}
      </section>
    ),
  }),
);

vi.mock("@/components/ui/app-route-anchor", () => ({
  useRouteAnchorDelegate: () => () => {},
}));

vi.mock("@/lib/plugin-css", () => ({
  usePluginCss: () => {},
  usePluginCssStatus: () => "ready",
}));

vi.mock("@/lib/plugin-logos", () => ({
  usePluginDisplayName: (pluginId: string) => pluginId,
}));

const stopThread = vi.hoisted(() => ({
  isPending: false,
  mutateAsync: vi.fn(async (_threadId: string) => {}),
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useStopThread: () => stopThread,
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: {
      interactions: { respond: vi.fn(), cancel: vi.fn() },
    },
  },
}));

const QUESTION_APP_MODULE = resolve(
  __dirname,
  "../../../../../plugins/ask-user-question/app.tsx",
);

let previousPluginRuntime: unknown;

let hadPluginRuntime = false;

beforeEach(() => {
  hadPluginRuntime = Reflect.has(globalThis, "__omnyoPluginRuntime");
  previousPluginRuntime = Reflect.get(globalThis, "__omnyoPluginRuntime");
  Reflect.set(globalThis, "__omnyoPluginRuntime", {
    react: React,
    pluginSdkApp: { definePluginApp },
  });
});

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  vi.restoreAllMocks();
  vi.clearAllMocks();

  if (hadPluginRuntime)
    Reflect.set(globalThis, "__omnyoPluginRuntime", previousPluginRuntime);
  else Reflect.deleteProperty(globalThis, "__omnyoPluginRuntime");
});

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

it.each(["click", "shortcut"] as const)(
  "keeps a legacy %s answer pending across chat switches and restores a rejected draft",
  async (method) => {
    const module: { default?: unknown } = await import(
      /* @vite-ignore */ QUESTION_APP_MODULE
    );

    if (!isPluginAppDefinition(module.default))
      throw new Error("Question renderer is unavailable");
    setPluginSlotRegistrations(
      "ask-user-question",
      makePluginRegistrationSet({
        pendingInteractions: collectPluginAppRegistrations(module.default)
          .pendingInteractions,
      }),
    );

    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });

    const id = `pint_legacy_${method}`;
    const storageKey = `omnyo.question-draft.v1:thr_test:${id}`;

    const request =
      createDeferredPromise<
        Awaited<ReturnType<typeof sdk.threads.interactions.respond>>
      >();

    const respond = vi
      .spyOn(sdk.threads.interactions, "respond")
      .mockReturnValue(request.promise);

    const composer = (visible: boolean) => (
      <QueryClientProvider client={client}>
        {visible ? (
          <PluginPendingInteractionComposer
            collapsedByDefault={false}
            interaction={{
              id,
              threadId: "thr_test",
              createdAt: 1,
              expiresAt: null,
            }}
            request={{
              pluginId: "ask-user-question",
              rendererId: "ask-user-question",
              title: "Question",
              data: {
                questions: [
                  {
                    id: "q0",
                    prompt: "Choose a direction",
                    shortLabel: "Direction",
                    multiSelect: false,
                    allowFreeText: true,
                    options: [
                      { value: "a", label: "Compact" },
                      { value: "b", label: "Detailed" },
                    ],
                  },
                ],
              },
            }}
            origin="plugin"
          />
        ) : (
          <div>Another chat</div>
        )}
      </QueryClientProvider>
    );

    const view = render(composer(true));

    try {
      fireEvent.click(screen.getByRole("radio", { name: /Other/ }));
      const input = screen.getByRole("textbox", { name: "Direction answer" });
      fireEvent.change(input, { target: { value: "Keep my legacy answer" } });

      if (method === "click")
        fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
      else fireEvent.keyDown(input, { key: "Enter", metaKey: true });
      expect(screen.getByRole("status").textContent).toContain(
        "Sending answer",
      );
      expect(screen.queryByRole("textbox")).toBeNull();
      view.rerender(composer(false));
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      view.rerender(composer(true));
      expect(screen.getByRole("status").textContent).toContain(
        "Sending answer",
      );
      expect(
        screen.queryByRole("button", { name: "Submit answer" }),
      ).toBeNull();
      expect(respond).toHaveBeenCalledExactlyOnceWith({
        interactionId: id,
        threadId: "thr_test",
        value: {
          answers: { q0: { selected: [], freeText: "Keep my legacy answer" } },
        },
      });
      view.rerender(composer(false));
      await act(async () => request.reject(new Error("Legacy answer failed")));
      view.rerender(composer(true));
      expect(screen.getByRole("alert").textContent).toBe(
        "Legacy answer failed",
      );
      expect(
        screen.getByRole("textbox", { name: "Direction answer" }),
      ).toHaveProperty("value", "Keep my legacy answer");
      expect(
        screen.getByRole("button", { name: "Submit answer" }),
      ).toHaveProperty("disabled", false);
    } finally {
      view.unmount();
      client.clear();
      window.localStorage.removeItem(storageKey);
    }
  },
);
