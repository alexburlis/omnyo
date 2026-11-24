import { describe, expect, it } from "vitest";
import type { VisualElement, VisualObservation } from "./contracts.js";
import { selectVisualElement, visualNoteText } from "./visual-selection.js";

const element: VisualElement = {
  id: "2",
  selector: "#save",
  tag: "button",
  text: "Save",
  rect: { x: 100, y: 80, width: 100, height: 40 },
  styles: { color: "red" },
};

const observation: VisualObservation = {
  id: "1a12a3f1-12de-4fbb-a011-df0905678757",
  documentId: "2a12a3f1-12de-4fbb-a011-df0905678757",
  targetId: "exact-displayed-target",
  url: "https://example.test/",
  title: "Fixture",
  viewport: {
    width: 400,
    height: 800,
    scrollX: 0,
    scrollY: 500,
    dpr: 2,
    scale: 1,
  },
  elements: [
    {
      ...element,
      id: "1",
      selector: "body",
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    element,
  ],
};

describe("frozen visual selection", () => {
  it("maps a downscaled DPR2 bitmap through letterboxing and chooses the smallest containing element", () => {
    const args = {
      observation,
      bitmap: { width: 400, height: 800 },
      bounds: { left: 20, top: 30, width: 400, height: 400 },
    };

    expect(selectVisualElement({ ...args, clientX: 195, clientY: 80 })).toEqual(
      element,
    );
    expect(
      selectVisualElement({ ...args, clientX: 30, clientY: 80 }),
    ).toBeNull();
    expect(
      selectVisualElement({ ...args, clientX: 220, clientY: 430 }),
    ).toBeNull();
  });

  it("makes image ownership and the frozen target explicit without host-local capture paths", () => {
    const text = visualNoteText({
      id: "note-1",
      comment: "Make this larger",
      observation,
      element,
      projectId: "other-project",
      path: "uploads/capture.jpg",
    });

    expect(text).toContain('"targetId":"exact-displayed-target"');
    expect(text).toContain('"projectId":"other-project"');
    expect(text).toContain('"path":"uploads/capture.jpg"');
    expect(text).toContain('"role":"before"');
  });
});
