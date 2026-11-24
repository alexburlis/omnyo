// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExperimentalPluginBrowserPage,
  ExperimentalPluginBrowserPageEvaluateOptions,
  ExperimentalPluginBrowserToolbarActionProps,
  JsonValue,
} from "@omnyo/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { makeThreadResponse } from "@omnyo/plugin-sdk/testing";
import type { AnnotationRecord } from "./annotations.js";
import type { agentAnnotationsRpcContract } from "./server.js";
import {
  readTabReferences,
  tabStateKey,
  writeTabReferences,
} from "./tab-state.js";

const renderRevisionSlot = renderSlot<
  ExperimentalPluginBrowserToolbarActionProps,
  Pick<
    typeof agentAnnotationsRpcContract,
    "saveRevision" | "readRevisions" | "revise"
  >
>;

const app = await loadPluginApp(() => import("./app"));

const { useComposer } = await import("@omnyo/plugin-sdk/app");

const originalContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);

afterEach(async () => {
  cleanup();
  await act(async () => {});
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  if (originalContext !== undefined)
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "getContext",
      originalContext,
    );
});

const pageAnnotation = {
  id: "mfx12abc",
  number: 1,
  comment: "Make this green",
  url: "http://localhost:5173/checkout",
  title: "Checkout",
  viewport: { width: 1280, height: 720 },
  element: {
    tagName: "button",
    name: 'button#pay "Pay now"',
    selector: "#pay",
    text: "Pay",
    attributes: { id: "pay" },
    rect: { x: 40, y: 300, width: 120, height: 36 },
    styles: {},
  },
};

function createFakePage() {
  const listeners = new Set<(data: JsonValue) => void>();

  const evaluate = vi.fn(
    async (
      expression: string,
      options?: ExperimentalPluginBrowserPageEvaluateOptions,
    ): Promise<JsonValue> => {
      if (options?.world === "main") {
        return {
          components: [
            { name: "SubmitButton", source: "src/SubmitButton.tsx:12" },
          ],
        };
      }

      return expression.includes(".activate()")
        ? { active: true, count: 0 }
        : { active: false, count: 0 };
    },
  );

  const page: ExperimentalPluginBrowserPage = {
    evaluate,
    onMessage(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    page,
    evaluate,
    emit(data: JsonValue) {
      for (const listener of listeners) {
        listener(data);
      }
    },
  };
}

function registration() {
  const action = app.browserToolbarActions[0];

  if (action === undefined) {
    throw new Error("Expected the browser toolbar action.");
  }

  return action;
}

function composerRegistration() {
  const action = registration();
  const AnnotateAction = action.component;
  let composer: ReturnType<typeof useComposer> | null = null;

  const AnnotateWithComposer = (
    props: ExperimentalPluginBrowserToolbarActionProps,
  ) => {
    composer = useComposer();

    return <AnnotateAction {...props} />;
  };

  return {
    action: { ...action, component: AnnotateWithComposer },
    composer() {
      if (composer === null) throw new Error("Composer probe is not mounted");

      return composer;
    },
  };
}

function designPage() {
  const fake = createFakePage();
  fake.evaluate.mockImplementation(
    async (expression, options): Promise<JsonValue> => {
      if (options?.world === "main") return { components: [] };

      if (expression.includes("__omnyoDesignObservation"))
        return {
          documentId: "document-1",
          elementId: "element-1",
          url: pageAnnotation.url,
          viewport: {
            ...pageAnnotation.viewport,
            dpr: 1,
            scrollX: 0,
            scrollY: 0,
          },
          rect: pageAnnotation.element.rect,
          text: pageAnnotation.element.text,
          styles: {},
        };

      return { active: true, count: 0 };
    },
  );
  fake.page.experimental_capture = vi.fn(async () => ({
    base64: btoa("jpeg"),
    width: 1280,
    height: 720,
    mimeType: "image/jpeg" as const,
  }));
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 1280, height: 720, close() {} })),
  );
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ drawImage() {} }),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) =>
      callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" })),
  );

  return fake;
}

const stateKey = tabStateKey("agent-annotations", "thr_1", "browser:1");

function visualRecord(id = pageAnnotation.id): AnnotationRecord {
  return {
    ...pageAnnotation,
    id,
    components: [],
    visual: {
      visualRequestId: `visual-${id}`,
      before: {
        kind: "project-image",
        projectId: "proj_1",
        path: `attachments/before-${id}.jpg`,
        mimeType: "image/jpeg",
        alt: "Before",
      },
      viewport: { ...pageAnnotation.viewport, scrollX: 0, scrollY: 0, dpr: 1 },
    },
  };
}

function toolbarProps(
  page: ExperimentalPluginBrowserPage,
  tabId = "browser:1",
) {
  return {
    threadId: "thr_1",
    tabId,
    url: pageAnnotation.url,
    isCompactViewport: false,
    experimental_page: page,
  };
}

function readRecords(records: Map<string, AnnotationRecord>, ids: string[]) {
  return ids.map((id) => {
    const record = records.get(id);

    if (record === undefined) throw new Error("Missing annotation revision");

    return { id, record };
  });
}

describe("AnnotateAction", () => {
  it("restores an edited or deleted pin after a toolbar remount without sharing another same-URL tab", async () => {
    const fake = createFakePage();
    const records = new Map<string, AnnotationRecord>();

    const rpc = {
      saveRevision: (record: AnnotationRecord) => {
        records.set("saved-revision", record);

        return { id: "saved-revision" };
      },
      readRevisions: ({ ids }: { ids: string[] }) => readRecords(records, ids),
      revise: vi.fn(({ id, comment }: { id: string; comment: string }) => {
        const record = records.get(id);

        if (record === undefined) throw new Error("Missing record");
        records.set("edited-revision", { ...record, comment });

        return { id: "edited-revision" };
      }),
    };

    const first = renderRevisionSlot(registration(), toolbarProps(fake.page), {
      pluginId: "agent-annotations",
      rpc,
    });

    act(() => fake.emit({ type: "annotation", annotation: pageAnnotation }));
    await waitFor(() => expect(first.composer.draft.mentions).toHaveLength(1));
    const draft = structuredClone(first.composer.draft);
    first.unmount();

    const other = renderRevisionSlot(
      registration(),
      toolbarProps(fake.page, "browser:2"),
      { pluginId: "agent-annotations", rpc },
    );

    act(() =>
      fake.emit({
        type: "annotation-update",
        id: pageAnnotation.id,
        comment: "Other tab",
        revision: 1,
      }),
    );
    await act(async () => {});
    expect(rpc.revise).not.toHaveBeenCalled();
    other.unmount();

    const restored = renderRevisionSlot(
      registration(),
      toolbarProps(fake.page),
      {
        pluginId: "agent-annotations",
        rpc,
        composer: draft,
      },
    );

    await waitFor(() =>
      expect(
        restored.inspection.rpcCalls.some(
          (call) => call.method === "readRevisions",
        ),
      ).toBe(true),
    );
    act(() =>
      fake.emit({
        type: "annotation-update",
        id: pageAnnotation.id,
        comment: "After remount",
        revision: 1,
      }),
    );
    await waitFor(() =>
      expect(restored.composer.draft.mentions).toMatchObject([
        { id: "edited-revision" },
      ]),
    );
    expect(rpc.revise).toHaveBeenCalledWith({
      id: "saved-revision",
      comment: "After remount",
    });
    act(() => fake.emit({ type: "annotation-delete", id: pageAnnotation.id }));
    await waitFor(() =>
      expect(restored.composer.draft.mentions).toHaveLength(0),
    );
    expect(readTabReferences(stateKey)?.notes).toEqual([]);
  });

  it("releases an accepted batch so the 24-note cap does not become a lifetime limit", async () => {
    const fake = designPage();
    const probe = composerRegistration();

    const records = Array.from({ length: 24 }, (_, index) =>
      visualRecord(`note-${index}`),
    );

    writeTabReferences(stateKey, {
      notes: records.map((record, index) => ({
        id: record.id,
        revisionId: `revision-${index}`,
        pageRevision: 0,
      })),
      reviews: [],
      pending: [],
      designMode: true,
      reviewId: null,
    });
    const saveRevision = vi.fn(() => ({ id: "next-batch" }));

    const slot = renderSlot(probe.action, toolbarProps(fake.page), {
      pluginId: "agent-annotations",
      rpc: {
        readRevisions: () =>
          records.map((record, index) => ({ id: `revision-${index}`, record })),
        saveRevision,
      },
      sdk: {
        threads: {
          get: async () =>
            makeThreadResponse({ id: "thr_1", projectId: "proj_1" }),
        },
        projects: {
          attachments: {
            upload: async () => ({
              type: "localImage",
              path: "attachments/new.jpg",
              name: "new.jpg",
              mimeType: "image/jpeg",
              sizeBytes: 3,
            }),
          },
        },
      },
    });

    await waitFor(() =>
      expect(
        slot
          .getByRole("button", { name: "Design Mode" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );

    act(() => {
      for (let index = 0; index < 24; index += 1)
        probe.composer().insert(
          {
            provider: "annotation",
            id: `revision-${index}`,
            label: `Note ${index}`,
          },
          { at: "end" },
        );
    });
    await act(async () => {
      await probe.composer().submit({ experimental_data: null });
    });
    await waitFor(() => expect(readTabReferences(stateKey)?.notes).toEqual([]));
    act(() => fake.emit({ type: "annotation", annotation: pageAnnotation }));
    await waitFor(() => expect(saveRevision).toHaveBeenCalledTimes(1));
    expect(slot.queryByRole("alert")).toBeNull();
    expect(slot.composer.draft.mentions).toMatchObject([{ id: "next-batch" }]);
  });

  it("replaces result revisions and images, then restores the review after acceptance", async () => {
    const fake = designPage();
    const probe = composerRegistration();
    const initial = visualRecord();
    const records = new Map([["baseline", initial]]);
    writeTabReferences(stateKey, {
      notes: [{ id: initial.id, revisionId: "baseline", pageRevision: 0 }],
      reviews: [{ id: `visual-${initial.id}`, revisionId: "baseline" }],
      pending: [],
      designMode: true,
      reviewId: `visual-${initial.id}`,
    });
    let saved = 0;
    let uploaded = 0;

    const revise = vi.fn(({ id, comment }: { id: string; comment: string }) => {
      const record = records.get(id);

      if (record === undefined) throw new Error("Missing record");
      records.set("edited-result", { ...record, comment });

      return { id: "edited-result" };
    });

    const options = {
      pluginId: "agent-annotations",
      rpc: {
        readRevisions: ({ ids }: { ids: string[] }) =>
          readRecords(records, ids),
        saveRevision: (record: AnnotationRecord) => {
          saved += 1;
          const id = `result-${saved}`;
          records.set(id, record);

          return { id };
        },
        revise,
      },
      sdk: {
        projects: {
          attachments: {
            upload: async () => {
              uploaded += 1;

              return {
                type: "localImage" as const,
                path: `attachments/result-${uploaded}.jpg`,
                name: `result-${uploaded}.jpg`,
                mimeType: "image/jpeg",
                sizeBytes: 3,
              };
            },
          },
        },
      },
    };

    const slot = renderRevisionSlot(
      probe.action,
      toolbarProps(fake.page),
      options,
    );

    await waitFor(() =>
      expect(
        slot.getByRole("button", { name: "Capture result for visual review" }),
      ).toBeTruthy(),
    );
    act(() => {
      probe
        .composer()
        .insert(
          { provider: "annotation", id: "baseline", label: "Baseline" },
          { at: "end" },
        );
      probe.composer().replace((draft) => ({
        ...draft,
        attachments: [
          {
            type: "localImage",
            path: `attachments/before-${initial.id}.jpg`,
            name: "foreign.jpg",
            sourceProjectId: "proj_other",
          },
        ],
      }));
    });
    fireEvent.click(
      slot.getByRole("button", { name: "Capture result for visual review" }),
    );
    await waitFor(() =>
      expect(slot.composer.draft.mentions).toMatchObject([{ id: "result-1" }]),
    );
    act(() =>
      fake.emit({
        type: "annotation-update",
        id: initial.id,
        comment: "Edited result",
        revision: 1,
      }),
    );
    await waitFor(() =>
      expect(revise).toHaveBeenCalledWith({
        id: "result-1",
        comment: "Edited result",
      }),
    );
    fireEvent.click(
      slot.getByRole("button", { name: "Capture result for visual review" }),
    );
    await waitFor(() =>
      expect(slot.composer.draft.mentions).toMatchObject([{ id: "result-2" }]),
    );
    expect(records.get("result-2")?.comment).toBe("Edited result");
    expect(slot.composer.draft.attachments).toHaveLength(3);
    expect(
      slot.composer.draft.attachments.some(
        (item) => item.path === "attachments/result-1.jpg",
      ),
    ).toBe(false);
    expect(
      slot.composer.draft.attachments.some(
        (item) => item.sourceProjectId === "proj_other",
      ),
    ).toBe(true);
    await act(async () => {
      await probe.composer().submit({ experimental_data: null });
    });
    await waitFor(() => expect(readTabReferences(stateKey)?.notes).toEqual([]));
    slot.unmount();

    const restored = renderRevisionSlot(
      registration(),
      toolbarProps(fake.page),
      options,
    );

    await waitFor(() =>
      expect(
        restored.getByRole("button", {
          name: "Capture result for visual review",
        }),
      ).toBeTruthy(),
    );
    expect(readTabReferences(stateKey)?.reviews).toEqual([
      { id: `visual-${initial.id}`, revisionId: "result-2" },
    ]);
  });
  it("keeps a revised pin when its older immutable context is accepted during the edit", async () => {
    const fake = createFakePage();
    const probe = composerRegistration();
    let acceptEdit!: (value: { id: string }) => void;

    const edited = new Promise<{ id: string }>((resolve) => {
      acceptEdit = resolve;
    });

    const slot = renderSlot(
      probe.action,
      {
        threadId: "thr_1",
        tabId: "browser:1",
        url: pageAnnotation.url,
        isCompactViewport: false,
        experimental_page: fake.page,
      },
      {
        rpc: {
          saveRevision: () => ({ id: "original-revision" }),
          revise: () => edited,
        },
      },
    );

    try {
      act(() => fake.emit({ type: "annotation", annotation: pageAnnotation }));
      await waitFor(() =>
        expect(slot.inspection.composer.draft.mentions).toHaveLength(1),
      );
      act(() =>
        fake.emit({
          type: "annotation-update",
          id: pageAnnotation.id,
          comment: "Edited during send",
          revision: 1,
        }),
      );
      await waitFor(() =>
        expect(slot.inspection.rpcCalls.at(-1)?.method).toBe("revise"),
      );
      await act(async () => {
        await probe.composer().submit({ experimental_data: null });
      });
    } finally {
      await act(async () => {
        acceptEdit({ id: "edited-revision" });
        await edited;
      });
    }

    await waitFor(() =>
      expect(slot.inspection.composer.draft.mentions).toMatchObject([
        { id: "edited-revision" },
      ]),
    );
    expect(
      fake.evaluate.mock.calls.some(([expression]) =>
        expression.includes(".clearAccepted("),
      ),
    ).toBe(false);
  });

  it("keeps pins when an unrelated message is accepted or a send is rejected", async () => {
    const fake = createFakePage();
    const probe = composerRegistration();

    const slot = renderSlot(
      probe.action,
      {
        threadId: "thr_1",
        tabId: "browser:1",
        url: pageAnnotation.url,
        isCompactViewport: false,
        experimental_page: fake.page,
      },
      { rpc: { saveRevision: () => ({ id: "original-revision" }) } },
    );

    act(() => fake.emit({ type: "annotation", annotation: pageAnnotation }));
    await waitFor(() =>
      expect(slot.inspection.composer.draft.mentions).toHaveLength(1),
    );
    await slot.behavior.setComposerText("Unrelated message");
    await act(async () => {
      await probe.composer().submit({ experimental_data: null });
    });
    expect(
      fake.evaluate.mock.calls.some(([expression]) =>
        expression.includes(".clearAccepted("),
      ),
    ).toBe(false);
    await expect(
      probe.composer().submit({ experimental_data: null }),
    ).rejects.toThrow("Type a message first");
    expect(
      fake.evaluate.mock.calls.some(([expression]) =>
        expression.includes(".clearAccepted("),
      ),
    ).toBe(false);
  });

  it("activates from the toolbar and adds saved annotations to the prompt", async () => {
    const fake = createFakePage();

    const slot = renderSlot(
      registration(),
      {
        threadId: "thr_1",
        tabId: "browser:1",
        url: "http://localhost:5173/checkout",
        isCompactViewport: false,
        experimental_page: fake.page,
      },
      {
        rpc: {
          saveRevision: () => ({ id: "ann_saved" }),
          revise: () => ({ id: pageAnnotation.id }),
        },
      },
    );

    fireEvent.click(slot.getByRole("button", { name: "Annotate elements" }));
    await waitFor(() => {
      expect(
        slot
          .getByRole("button", { name: "Stop annotating" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    });
    expect(
      fake.evaluate.mock.calls.some(([expression]) =>
        expression.includes("__omnyoAgentAnnotations.activate()"),
      ),
    ).toBe(true);

    act(() => {
      fake.emit({ type: "annotation", annotation: pageAnnotation });
    });
    await waitFor(() => {
      expect(slot.inspection.composer.draft.mentions).toMatchObject([
        {
          provider: "annotation",
          id: "ann_saved",
          label: '1. button#pay "Pay now"',
        },
      ]);
    });
    expect(slot.inspection.rpcCalls).toEqual([
      {
        method: "saveRevision",
        input: {
          ...pageAnnotation,
          components: [
            { name: "SubmitButton", source: "src/SubmitButton.tsx:12" },
          ],
        },
      },
    ]);
    expect(fake.evaluate).toHaveBeenCalledWith(
      expect.stringContaining("__reactFiber$"),
      { world: "main" },
    );

    act(() => {
      fake.emit({
        type: "annotation-update",
        id: pageAnnotation.id,
        comment: "Make this blue",
      });
    });
    await waitFor(() => {
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({
        method: "revise",
        input: { id: "ann_saved", comment: "Make this blue" },
      });
    });
    expect(slot.inspection.composer.draft.mentions).toHaveLength(1);

    act(() => {
      fake.emit({ type: "state", active: false, count: 1 });
    });
    expect(
      slot
        .getByRole("button", { name: "Annotate elements" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(slot.getByTestId("agent-annotations-count").textContent).toBe("1");
  });

  it("removes deleted mentions and clears page annotations on submission, not draft clearing", async () => {
    const fake = createFakePage();
    const action = registration();
    const AnnotateAction = action.component;

    const AnnotateWithSubmit = (
      props: ExperimentalPluginBrowserToolbarActionProps,
    ) => {
      const composer = useComposer();

      return (
        <>
          <AnnotateAction {...props} />
          <button
            onClick={() => {
              void composer.submit({
                experimental_data: null,
              });
            }}
          >
            Submit test
          </button>
        </>
      );
    };

    const slot = renderSlot(
      { ...action, component: AnnotateWithSubmit },
      {
        threadId: "thr_1",
        tabId: "browser:1",
        url: "http://localhost/",
        isCompactViewport: false,
        experimental_page: fake.page,
      },
      {
        rpc: { saveRevision: () => ({ id: pageAnnotation.id }) },
        composer: {
          text: "🙂 @keep ",
          mentions: [
            {
              kind: "plugin",
              pluginId: "other-plugin",
              provider: "annotation",
              id: pageAnnotation.id,
              label: "keep",
              from: 3,
              to: 8,
            },
          ],
          attachments: [
            {
              type: "localFile",
              path: "attachments/spec.txt",
              name: "spec.txt",
              sizeBytes: 12,
            },
          ],
        },
      },
    );

    act(() => fake.emit({ type: "annotation", annotation: pageAnnotation }));
    await waitFor(() =>
      expect(slot.inspection.composer.draft.mentions).toHaveLength(2),
    );
    act(() => fake.emit({ type: "annotation-delete", id: pageAnnotation.id }));
    await waitFor(() =>
      expect(slot.inspection.composer.draft.mentions).toHaveLength(1),
    );
    expect(slot.composer.draft.text).toBe("🙂 @keep  ");
    expect(slot.composer.draft.mentions).toMatchObject([
      { pluginId: "other-plugin", from: 3, to: 8 },
    ]);
    expect(slot.composer.draft.attachments).toHaveLength(1);
    await slot.behavior.setComposerText("");
    expect(
      fake.evaluate.mock.calls.some(([expression]) =>
        expression.includes(".clearAccepted("),
      ),
    ).toBe(false);
    await slot.behavior.setComposerText("Send this");
    act(() => fake.emit({ type: "annotation", annotation: pageAnnotation }));
    await waitFor(() =>
      expect(slot.inspection.composer.draft.mentions).toHaveLength(1),
    );
    fireEvent.click(slot.getByRole("button", { name: "Submit test" }));
    await waitFor(() =>
      expect(
        fake.evaluate.mock.calls.some(([expression]) =>
          expression.includes(".clearAccepted("),
        ),
      ).toBe(true),
    );
  });

  it("ignores malformed page messages", async () => {
    const fake = createFakePage();

    const slot = renderSlot(
      registration(),
      {
        threadId: "thr_1",
        tabId: "browser:1",
        url: "http://localhost:5173/",
        isCompactViewport: false,
        experimental_page: fake.page,
      },
      { rpc: { saveRevision: () => ({ id: "ann_saved" }) } },
    );

    act(() => {
      fake.emit({ type: "annotation", annotation: { id: "x" } });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(slot.inspection.rpcCalls).toEqual([]);
    expect(slot.inspection.composer.draft.mentions).toEqual([]);
  });

  it("is disabled outside the desktop app", () => {
    const slot = renderSlot(registration(), {
      threadId: "thr_1",
      tabId: "browser:1",
      url: "https://example.com/",
      isCompactViewport: false,
      experimental_page: null,
    });

    const button = slot.getByRole("button", {
      name: "Annotate elements is available in the desktop app",
    });

    expect(button.hasAttribute("disabled")).toBe(true);
  });
});
