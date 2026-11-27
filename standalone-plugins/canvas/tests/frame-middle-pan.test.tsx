import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HtmlFrame } from "../components/html-frame";
import { frameDocument } from "../lib/frame-document";

afterEach(cleanup);

it("forwards only validated pan messages from the owning frame", () => {
  const { container } = render(
    <HtmlFrame html="<button>Action</button>" title="Chart" canvasNavigation />,
  );

  const frame = container.querySelector("iframe");

  if (!frame?.contentWindow) throw new Error("Missing frame");
  Object.defineProperties(frame, { clientWidth: { value: 400 }, clientHeight: { value: 200 } });
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 200, 100));
  const receive = vi.fn();
  container.addEventListener("canvas-frame-pan", receive);
  const data = { canvasFramePan: { clientX: 20, clientY: 20 } };
  act(() => window.dispatchEvent(new MessageEvent("message", { source: window, data })));
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { canvasFramePan: { clientX: Infinity, clientY: 0 } },
      }),
    ),
  );
  expect(receive).not.toHaveBeenCalled();
  act(() =>
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data })),
  );
  const overlay = document.body.lastElementChild;

  if (!(overlay instanceof HTMLElement)) throw new Error("Missing drag overlay");
  overlay.dispatchEvent(new MouseEvent("pointermove", { buttons: 4, clientX: 175, clientY: 100 }));
  expect(receive).toHaveBeenCalledOnce();
  expect(receive.mock.calls[0]?.[0].detail).toEqual({ deltaX: 65, deltaY: 40 });
  overlay.dispatchEvent(new MouseEvent("pointerup"));
  expect(overlay.isConnected).toBe(false);
});

it("captures middle drags over interactive frame content without starting primary drags", () => {
  const source = frameDocument("<button>Action</button>", new Map(), "dark", true);
  const script = source.match(/<script>([\s\S]*)<\/script>/u)?.[1];

  if (!script) throw new Error("Missing bridge");
  const target = document.createElement("div");
  const postMessage = vi.fn();

  const execute = new Function(
    "document",
    "parent",
    "ResizeObserver",
    "addEventListener",
    "getComputedStyle",
    script,
  );

  execute(
    {
      body: {
        scrollHeight: 40,
        getBoundingClientRect: () => ({ height: 40 }),
        innerText: "Action",
      },
      documentElement: {},
    },
    { postMessage },
    class {
      observe() {}
    },
    target.addEventListener.bind(target),
    () => ({ marginTop: "0", marginBottom: "0" }),
  );
  postMessage.mockClear();

  const send = (type: string, button: number, x: number, y: number) => {
    const event = new MouseEvent(type, { button, clientX: x, clientY: y, cancelable: true });
    Object.defineProperty(event, "pointerId", { value: 7 });
    target.dispatchEvent(event);

    return event;
  };

  send("pointerdown", 0, 100, 100);
  send("pointermove", 0, 120, 130);
  expect(postMessage).not.toHaveBeenCalled();
  expect(send("pointerdown", 1, 100, 100).defaultPrevented).toBe(true);
  send("pointermove", 1, 130, 80);
  expect(postMessage).toHaveBeenCalledWith({ canvasFramePan: { clientX: 100, clientY: 100 } }, "*");
  send("pointerup", 1, 130, 80);
  postMessage.mockClear();
  send("pointermove", 0, 150, 100);
  expect(postMessage).not.toHaveBeenCalled();
});

it("relays wheel over form controls unless the control can scroll", () => {
  const source = frameDocument("", new Map(), "dark", true);
  const script = source.match(/<script>([\s\S]*)<\/script>/u)?.[1];

  if (!script) throw new Error("Missing bridge");
  const target = document.createElement("div");
  target.innerHTML =
    '<select><option>All</option></select><input value="a"><textarea id="short"></textarea><textarea id="long"></textarea>';
  const postMessage = vi.fn();

  const execute = new Function(
    "document",
    "parent",
    "ResizeObserver",
    "addEventListener",
    "getComputedStyle",
    script,
  );

  execute(
    {
      body: { scrollHeight: 40, getBoundingClientRect: () => ({ height: 40 }), innerText: "" },
      documentElement: {},
    },
    { postMessage },
    class {
      observe() {}
    },
    target.addEventListener.bind(target),
    () => ({ marginTop: "0", marginBottom: "0" }),
  );
  postMessage.mockClear();
  const long = target.querySelector("#long");

  if (!long) throw new Error("Missing textarea");
  Object.defineProperties(long, { scrollHeight: { value: 200 }, clientHeight: { value: 40 } });

  const wheel = (selector: string) => {
    const element = target.querySelector(selector);

    if (!element) throw new Error(`Missing ${selector}`);
    const event = new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
    element.dispatchEvent(event);

    return event.defaultPrevented;
  };

  expect(wheel("select")).toBe(true);
  expect(wheel("input")).toBe(true);
  expect(wheel("#short")).toBe(true);
  expect(postMessage).toHaveBeenCalledTimes(3);
  postMessage.mockClear();
  expect(wheel("#long")).toBe(false);
  expect(postMessage).not.toHaveBeenCalled();
});
