import { z } from "zod";
import type { ExperimentalPluginBrowserPage } from "@omnyo/plugin-sdk/app";
import type { PageAnnotation } from "./annotations.js";

const rectSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();

const observationSchema = z
  .object({
    documentId: z.string(),
    elementId: z.string(),
    url: z.string(),
    viewport: z
      .object({
        width: z.number().positive(),
        height: z.number().positive(),
        scrollX: z.number(),
        scrollY: z.number(),
        dpr: z.number().positive(),
      })
      .strict(),
    rect: rectSchema,
    text: z.string(),
    styles: z.record(z.string(), z.string()),
  })
  .strict();

export type VisualObservation = z.infer<typeof observationSchema>;

export type VisualBaseline = Pick<
  VisualObservation,
  "url" | "viewport" | "rect"
>;

function observeElement(selector: string, styleKeys: string[]) {
  const identity = () =>
    Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
      value.toString(16).padStart(8, "0"),
    ).join("");

  const key = "__omnyoDesignObservation";

  let state:
    | { documentId: string; elements: WeakMap<Element, string> }
    | undefined = Reflect.get(globalThis, key);

  if (state === undefined) {
    state = { documentId: identity(), elements: new WeakMap() };
    Reflect.set(globalThis, key, state);
  }

  const matches = document.querySelectorAll(selector);

  if (matches.length !== 1)
    throw new Error("The selected element changed. Select it again.");
  const element = matches[0];

  if (element === undefined || !element.isConnected)
    throw new Error("The selected element is unavailable.");
  const rect = element.getBoundingClientRect();
  let elementId = state.elements.get(element);

  if (elementId === undefined) {
    elementId = identity();
    state.elements.set(element, elementId);
  }

  const computed = getComputedStyle(element);

  return {
    documentId: state.documentId,
    elementId,
    url: location.href,
    viewport: {
      width: innerWidth,
      height: innerHeight,
      scrollX,
      scrollY,
      dpr: devicePixelRatio,
    },
    rect: {
      x: Math.round(rect.left + scrollX),
      y: Math.round(rect.top + scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    text: (element instanceof HTMLElement &&
    typeof element.innerText === "string"
      ? element.innerText
      : (element.textContent ?? "")
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160),
    styles: Object.fromEntries(
      styleKeys.map((key) => [key, computed.getPropertyValue(key)]),
    ),
  };
}

export function buildObservationExpression(
  selector: string,
  styleKeys: string[],
): string {
  return `(${observeElement.toString()})(${JSON.stringify(selector)},${JSON.stringify(styleKeys)})`;
}

export function cropInBitmap(
  observation: Pick<VisualObservation, "viewport" | "rect">,
  bitmap: { width: number; height: number },
) {
  const { viewport, rect } = observation;
  const x = Math.max(0, rect.x - viewport.scrollX - 12);
  const y = Math.max(0, rect.y - viewport.scrollY - 12);

  const right = Math.min(
    viewport.width,
    rect.x - viewport.scrollX + rect.width + 12,
  );

  const bottom = Math.min(
    viewport.height,
    rect.y - viewport.scrollY + rect.height + 12,
  );

  if (right <= x || bottom <= y)
    throw new Error(
      "The selected element is outside the viewport. Scroll it into view and select it again.",
    );
  const scaleX = bitmap.width / viewport.width;
  const scaleY = bitmap.height / viewport.height;

  return {
    x: Math.floor(x * scaleX),
    y: Math.floor(y * scaleY),
    width: Math.max(1, Math.ceil(right * scaleX) - Math.floor(x * scaleX)),
    height: Math.max(1, Math.ceil(bottom * scaleY) - Math.floor(y * scaleY)),
  };
}

export function requireMatchingObservation(
  before: VisualObservation,
  after: VisualObservation,
): void {
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error(
      "The page changed during capture. Your note is safe; select the element again.",
    );
}

export async function captureElement(
  page: ExperimentalPluginBrowserPage,
  annotation: PageAnnotation,
  baseline?: VisualBaseline,
) {
  if (page.experimental_capture === undefined)
    throw new Error(
      "Design Mode needs a desktop host with native capture support.",
    );

  const selector =
    baseline === undefined
      ? `[data-omnyo-annotation-${annotation.id}]`
      : annotation.element.selector;

  const expression = buildObservationExpression(
    selector,
    Object.keys(annotation.element.styles),
  );

  const before = observationSchema.parse(await page.evaluate(expression));

  if (
    baseline === undefined &&
    (before.url !== annotation.url ||
      JSON.stringify(before.rect) !== JSON.stringify(annotation.element.rect) ||
      before.text !== annotation.element.text ||
      JSON.stringify(before.styles) !==
        JSON.stringify(annotation.element.styles))
  )
    throw new Error(
      "The selected element changed. Your note is safe; select it again.",
    );

  if (
    baseline !== undefined &&
    (before.url !== baseline.url ||
      before.viewport.width !== baseline.viewport.width ||
      before.viewport.height !== baseline.viewport.height ||
      before.viewport.scrollX !== baseline.viewport.scrollX ||
      before.viewport.scrollY !== baseline.viewport.scrollY ||
      before.viewport.dpr !== baseline.viewport.dpr)
  )
    throw new Error(
      "Return to the original route, scroll position and viewport before capturing the result.",
    );
  await page.evaluate(
    `document.querySelector("omnyo-agent-annotations")?.style.setProperty("visibility","hidden")`,
  );

  try {
    const capture = await page.experimental_capture();
    const after = observationSchema.parse(await page.evaluate(expression));
    requireMatchingObservation(before, after);
    const binary = atob(capture.base64);

    if (binary.length > 8 * 1024 * 1024)
      throw new Error("The image exceeds the capture limit.");

    const bitmap = await createImageBitmap(
      new Blob(
        [Uint8Array.from(binary, (character) => character.charCodeAt(0))],
        { type: capture.mimeType },
      ),
    );

    try {
      if (bitmap.width !== capture.width || bitmap.height !== capture.height)
        throw new Error("The captured image dimensions changed.");
      const crop = cropInBitmap(baseline ?? before, bitmap);
      const canvas = document.createElement("canvas");
      canvas.width = crop.width;
      canvas.height = crop.height;
      const context = canvas.getContext("2d");

      if (context === null) throw new Error("Image capture is unavailable.");
      context.drawImage(
        bitmap,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        crop.width,
        crop.height,
      );

      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value === null
              ? reject(new Error("Image capture failed"))
              : resolve(value),
          "image/jpeg",
          0.85,
        ),
      );

      return { blob, observation: before };
    } finally {
      bitmap.close();
    }
  } finally {
    await page.evaluate(
      `document.querySelector("omnyo-agent-annotations")?.style.removeProperty("visibility")`,
    );
  }
}
