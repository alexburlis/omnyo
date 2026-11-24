// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { makeThreadResponse } from "@omnyo/plugin-sdk/testing";
import { VisualControls } from "./visual-controls.js";
import type { PreviewFrame, VisualObservation } from "./contracts.js";

const sessionId = "1a12a3f1-12de-4fbb-a011-df0905678757";

const frame: PreviewFrame = {
  sequence: 2,
  targetId: "shown-target",
  mimeType: "image/jpeg",
  data: "/9j/",
  width: 400,
  height: 800,
  url: "https://fixture.test/",
  title: "Fixture",
};

const observation: VisualObservation = {
  id: sessionId,
  documentId: "2a12a3f1-12de-4fbb-a011-df0905678757",
  targetId: frame.targetId,
  url: frame.url,
  title: frame.title,
  viewport: {
    width: 400,
    height: 800,
    scrollX: 0,
    scrollY: 200,
    dpr: 2,
    scale: 1,
  },
  elements: [
    {
      id: "1",
      selector: "#save",
      tag: "button",
      text: "Save",
      rect: { x: 100, y: 80, width: 100, height: 40 },
      styles: {},
    },
  ],
};

const image = {
  path: "/browser-host/tmp/crop.jpg",
  hostId: "browser-host",
  data: "/9j/",
  mimeType: "image/jpeg" as const,
  width: 200,
  height: 80,
};

afterEach(cleanup);

describe("visual preview controls", () => {
  it("keeps frozen refresh usable and preserves notes and the draft after stale capture", async () => {
    const observe = vi.fn(() => ({ observation, image }));

    const inspect = vi.fn(() => {
      throw new Error("This selection changed; your notes are kept.");
    });

    const slot = renderSlot(
      {
        component: () => (
          <VisualControls
            threadId="origin-thread"
            sessionId={sessionId}
            frame={frame}
            onFrozenChange={() => {}}
          />
        ),
      },
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "origin-thread" },
          text: "Existing draft",
        },
        rpc: { observe, inspect },
      },
    );

    fireEvent.click(slot.getByRole("button", { name: "Annotate" }));
    await slot.findByAltText("Frozen browser view for annotation");
    expect(
      slot
        .getByRole("button", { name: "Refresh selection" })
        .hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.change(slot.getByLabelText("Element to annotate"), {
      target: { value: "1" },
    });
    fireEvent.change(slot.getByLabelText("Visual note"), {
      target: { value: "Increase the spacing" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Add note to chat" }));
    expect((await slot.findByRole("alert")).textContent).toContain(
      "selection changed",
    );
    expect(slot.getByLabelText("Visual note").getAttribute("aria-label")).toBe(
      "Visual note",
    );
    expect(slot.getByDisplayValue("Increase the spacing")).toBeTruthy();
    expect(slot.inspection.composer.text).toBe("Existing draft");
    expect(slot.inspection.composer.draft.attachments).toEqual([]);
    expect(observe).toHaveBeenCalledWith({
      threadId: "origin-thread",
      sessionId,
      targetId: "shown-target",
    });
  });

  it("uploads a crop to the originating project and appends an immutable note without submitting", async () => {
    const upload = vi.fn(async () => ({
      type: "localImage" as const,
      path: "uploads/result.jpg",
      name: "result.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 3,
    }));

    const slot = renderSlot(
      {
        component: () => (
          <VisualControls
            threadId="origin-thread"
            sessionId={sessionId}
            frame={frame}
            onFrozenChange={() => {}}
          />
        ),
      },
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "origin-thread" },
          text: "Existing draft",
        },
        sdk: {
          threads: {
            get: async () =>
              makeThreadResponse({
                id: "origin-thread",
                projectId: "origin-project",
              }),
          },
          projects: { attachments: { upload } },
        },
        rpc: {
          observe: () => ({ observation, image }),
          inspect: () => ({
            observation,
            element: observation.elements[0],
            image,
          }),
        },
      },
    );

    fireEvent.click(slot.getByRole("button", { name: "Annotate" }));
    await slot.findByAltText("Frozen browser view for annotation");
    fireEvent.change(slot.getByLabelText("Element to annotate"), {
      target: { value: "1" },
    });
    fireEvent.change(slot.getByLabelText("Visual note"), {
      target: { value: "Increase the spacing" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Add note to chat" }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(slot.inspection.composer.text).toContain("Increase the spacing"),
    );
    expect(slot.inspection.composer.text).toContain(
      '"projectId":"origin-project"',
    );
    expect(slot.inspection.composer.text).not.toContain("/browser-host/tmp");
    expect(slot.inspection.composer.draft.attachments).toMatchObject([
      {
        path: "uploads/result.jpg",
        sourceProjectId: "origin-project",
        type: "localImage",
      },
    ]);
    expect(slot.inspection.composer.submits).toEqual([]);
    expect(
      slot.rpcCalls.find((call) => call.method === "inspect")?.input,
    ).toMatchObject({
      targetId: "shown-target",
      observationId: observation.id,
      elementId: "1",
    });
  });
});
