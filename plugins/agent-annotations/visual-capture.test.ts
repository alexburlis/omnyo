// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  buildObservationExpression,
  captureElement,
  cropInBitmap,
  requireMatchingObservation,
  type VisualObservation,
} from "./visual-capture.js";

const observation: VisualObservation = {
  documentId: "doc",
  elementId: "element",
  url: "http://localhost/",
  viewport: { width: 1000, height: 600, scrollX: 200, scrollY: 400, dpr: 2 },
  rect: { x: 300, y: 600, width: 100, height: 40 },
  text: "Pay",
  styles: {},
};

describe("Design Mode capture", () => {
  it("matches a serialized baseline by viewport values while rejecting changed geometry", async () => {
    const capture = vi.fn(async () => {
      throw new Error("Reached native capture");
    });

    const page = {
      evaluate: async () => observation,
      onMessage: () => () => {},
      experimental_capture: capture,
    };

    const annotation = {
      id: "note",
      number: 1,
      comment: "Review",
      url: observation.url,
      title: "Fixture",
      viewport: { width: 1000, height: 600 },
      element: {
        tagName: "button",
        name: "Pay",
        selector: "#pay",
        text: "Pay",
        attributes: {},
        rect: observation.rect,
        styles: {},
      },
    };

    const baseline = {
      url: observation.url,
      rect: observation.rect,
      viewport: {
        dpr: 2,
        scrollY: 400,
        scrollX: 200,
        height: 600,
        width: 1000,
      },
    };

    await expect(captureElement(page, annotation, baseline)).rejects.toThrow(
      "Reached native capture",
    );
    await expect(
      captureElement(page, annotation, {
        ...baseline,
        viewport: { ...baseline.viewport, scrollY: 401 },
      }),
    ).rejects.toThrow("original route, scroll position and viewport");
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it("maps document coordinates into a resized bitmap independently of DPR", () => {
    expect(cropInBitmap(observation, { width: 500, height: 300 })).toEqual({
      x: 44,
      y: 94,
      width: 62,
      height: 32,
    });
    expect(
      cropInBitmap(
        { ...observation, viewport: { ...observation.viewport, dpr: 1 } },
        { width: 500, height: 300 },
      ),
    ).toEqual({ x: 44, y: 94, width: 62, height: 32 });
    expect(() =>
      cropInBitmap(
        { ...observation, rect: { ...observation.rect, y: 2000 } },
        { width: 500, height: 300 },
      ),
    ).toThrow("outside the viewport");
  });
  it("refuses reload, scroll, same-document movement and content replacement", () => {
    for (const changed of [
      { ...observation, documentId: "next" },
      { ...observation, elementId: "replacement" },
      { ...observation, rect: { ...observation.rect, x: 301 } },
      { ...observation, text: "Changed" },
      { ...observation, viewport: { ...observation.viewport, scrollY: 401 } },
    ])
      expect(() => requireMatchingObservation(observation, changed)).toThrow(
        "page changed",
      );
    expect(() =>
      requireMatchingObservation(observation, structuredClone(observation)),
    ).not.toThrow();
  });
  it("binds observations to actual element identity rather than selector text", () => {
    document.body.innerHTML = '<button id="pay">Pay</button>';
    const expression = buildObservationExpression("#pay", []);
    expect(expression).not.toContain("randomUUID");
    const evaluate = () => new Function(`return (${expression})`)();
    const first = evaluate();
    document.body.innerHTML = '<button id="pay">Pay</button>';
    const second = evaluate();
    expect(second.documentId).toBe(first.documentId);
    expect(second.elementId).not.toBe(first.elementId);
    Reflect.deleteProperty(globalThis, "__omnyoDesignObservation");
  });
});
