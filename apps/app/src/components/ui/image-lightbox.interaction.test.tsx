// @vitest-environment jsdom

import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MOTION_DURATION_MS } from "@omnyo/shared-ui/motion";
import { ImageLightbox } from "./image-lightbox";
import { useHorizontalDismissDrag } from "./use-horizontal-dismiss-drag";

function Preview() {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open image
      </button>
      <ImageLightbox
        imageSrc={open ? `/image-${index}.png` : null}
        imageAlt={`Image ${index}`}
        title="Image preview"
        hasMultipleImages
        onPrevious={() => setIndex(0)}
        onNext={() => setIndex(1)}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("dismisses from the backdrop or close control without hiding the app root", () => {
  const { container } = render(<Preview />);
  const trigger = screen.getByRole("button", { name: "Open image" });

  for (const target of ["backdrop", "close"]) {
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Image preview" });
    expect(dialog.parentElement).toBe(document.body);
    expect(container.closest('[inert], [aria-hidden="true"]')).toBeNull();
    fireEvent.click(
      target === "backdrop"
        ? dialog
        : screen.getByRole("button", { name: "Close image preview" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  }
});

it("keeps navigation open and restores the trigger after keyboard dismissal", () => {
  render(<Preview />);
  const trigger = screen.getByRole("button", { name: "Open image" });
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByRole("img", { name: "Image 1" })).toBeTruthy();
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expect(screen.getByRole("img", { name: "Image 0" })).toBeTruthy();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Reset image zoom" }),
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("fades the last image out after dismissal, hidden from assistive technology", () => {
  vi.useFakeTimers();
  render(<Preview />);
  fireEvent.click(screen.getByRole("button", { name: "Open image" }));
  fireEvent.click(screen.getByRole("button", { name: "Close image preview" }));

  expect(screen.queryByRole("dialog")).toBeNull();
  const exitLayer = screen.getByTestId("image-lightbox-exit");
  expect(exitLayer.getAttribute("aria-hidden")).toBe("true");
  expect(exitLayer.querySelector("img")?.getAttribute("src")).toBe(
    "/image-0.png",
  );

  act(() => {
    vi.advanceTimersByTime(MOTION_DURATION_MS.fast - 1);
  });
  expect(screen.getByTestId("image-lightbox-exit")).toBeTruthy();

  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(screen.queryByTestId("image-lightbox-exit")).toBeNull();
});

it("keeps image taps open and resets local zoom on navigation and reopening", () => {
  render(<Preview />);
  fireEvent.click(screen.getByRole("button", { name: "Open image" }));
  fireEvent.click(screen.getByRole("img", { name: "Image 0" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(
    screen.getByRole("button", { name: "Reset image zoom" }).textContent,
  ).toBe("150%");
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(
    screen.getByRole("button", { name: "Reset image zoom" }).textContent,
  ).toBe("100%");
  fireEvent.doubleClick(screen.getByRole("img", { name: "Image 1" }));
  expect(
    screen.getByRole("button", { name: "Reset image zoom" }).textContent,
  ).toBe("300%");
  fireEvent.click(screen.getByRole("button", { name: "Close image preview" }));
  fireEvent.click(screen.getByRole("button", { name: "Open image" }));
  expect(
    screen.getByRole("button", { name: "Reset image zoom" }).textContent,
  ).toBe("100%");
});

it("pinches locally, pans the enlarged image, and resets without dismissing", () => {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: PointerEventInit) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "touch";
    }
  }

  vi.stubGlobal("PointerEvent", TestPointerEvent);

  try {
    render(<Preview />);
    fireEvent.click(screen.getByRole("button", { name: "Open image" }));
    const image = screen.getByRole("img", { name: "Image 0" });
    const area = screen.getByTestId("image-zoom-surface");
    Object.defineProperties(image, {
      clientWidth: { value: 300 },
      clientHeight: { value: 300 },
    });
    Object.defineProperties(area, {
      clientWidth: { value: 400 },
      clientHeight: { value: 600 },
    });
    fireEvent.pointerDown(area, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 200,
    });
    fireEvent.pointerDown(area, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 200,
      clientY: 200,
    });
    fireEvent.pointerMove(area, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 400,
      clientY: 200,
    });
    expect(
      screen.getByRole("button", { name: "Reset image zoom" }).textContent,
    ).toBe("300%");
    fireEvent.pointerUp(area, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 400,
      clientY: 200,
    });
    const before = image.style.transform;
    fireEvent.pointerMove(area, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 140,
      clientY: 240,
    });
    expect(image.style.transform).not.toBe(before);
    fireEvent.pointerUp(area, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 140,
      clientY: 240,
    });
    fireEvent.click(area);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset image zoom" }));
    expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");

    for (let tap = 0; tap < 2; tap++) {
      fireEvent.pointerDown(area, {
        pointerId: 3,
        pointerType: "touch",
        clientX: 150,
        clientY: 200,
      });
      fireEvent.pointerUp(area, {
        pointerId: 3,
        pointerType: "touch",
        clientX: 150,
        clientY: 200,
      });
    }

    fireEvent.doubleClick(image);
    expect(
      screen.getByRole("button", { name: "Reset image zoom" }).textContent,
    ).toBe("300%");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps image panning out of the containing panel's dismiss gesture", () => {
  const onDismiss = vi.fn();
  const onProgress = vi.fn();

  function Shelf() {
    const { beginPointerDrag } = useHorizontalDismissDrag({
      direction: "right",
      dismissTiming: "immediate",
      enabled: true,
      getWidth: () => 400,
      onClear: () => {},
      onDismiss,
      onProgress,
      resetKey: "open",
      suppressClick: false,
    });

    return (
      <div data-testid="swipe-parent" onPointerDown={beginPointerDrag}>
        <Preview />
      </div>
    );
  }

  class TestPointerEvent extends MouseEvent {
    pointerId = 1;
    pointerType = "touch";
  }

  vi.stubGlobal("PointerEvent", TestPointerEvent);

  function swipe(target: HTMLElement) {
    fireEvent.pointerDown(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 200,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 300,
      clientY: 200,
    });
    fireEvent.pointerUp(window, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 300,
      clientY: 200,
    });
  }

  render(<Shelf />);
  swipe(screen.getByTestId("swipe-parent"));
  expect(onDismiss).toHaveBeenCalledOnce();
  onDismiss.mockClear();
  onProgress.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Open image" }));
  swipe(screen.getByRole("img", { name: "Image 0" }));
  expect(onDismiss).not.toHaveBeenCalled();
  expect(onProgress).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
  vi.unstubAllGlobals();
});
