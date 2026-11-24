// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  arriveFromHomeSend,
  homeSendTransitionName,
  runHomeSendTransition,
} from "./home-send-transition";

interface FakeTransition {
  update: () => Promise<void>;
  finish: () => void;
}

let transitions: FakeTransition[] = [];

let reducedMotion = false;

function element(): HTMLElement {
  const node = document.createElement("div");
  document.body.append(node);

  return node;
}

function onlyTransition(): FakeTransition {
  const transition = transitions[0];

  if (transition === undefined) throw new Error("No view transition started");

  return transition;
}

beforeEach(() => {
  transitions = [];
  reducedMotion = false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: reducedMotion })),
  );
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: (update: () => Promise<void>) => {
      let finish = () => {};

      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });

      transitions.push({ update, finish });

      return { finished };
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "startViewTransition");
  delete document.documentElement.dataset.homeSend;
  document.body.replaceChildren();
});

describe("runHomeSendTransition", () => {
  it("carries the Home composer to the new chat's composer under one pane name", async () => {
    const source = element();
    const target = element();
    const navigate = vi.fn();
    const name = homeSendTransitionName("pane:left");

    runHomeSendTransition({
      paneId: "pane:left",
      source,
      threadId: "pending_1",
      navigate,
    });

    expect(name).toBe("omnyo-home-send-pane-left");
    expect(source.style.viewTransitionName).toBe(name);
    expect(document.documentElement.dataset.homeSend).toBe("travel");
    expect(navigate).not.toHaveBeenCalled();

    const updated = onlyTransition().update();

    expect(navigate).toHaveBeenCalledOnce();
    expect(source.style.viewTransitionName).toBe("");

    arriveFromHomeSend("pending_1", target);
    await updated;

    expect(target.style.viewTransitionName).toBe(name);

    onlyTransition().finish();
    await Promise.resolve();
    await Promise.resolve();

    expect(target.style.viewTransitionName).toBe("");
    expect(document.documentElement.dataset.homeSend).toBeUndefined();
  });

  it("crossfades without naming either composer under reduced motion", async () => {
    reducedMotion = true;
    const source = element();
    const target = element();

    runHomeSendTransition({
      paneId: "pane",
      source,
      threadId: "pending_2",
      navigate: vi.fn(),
    });

    expect(source.style.viewTransitionName).toBe("");
    expect(document.documentElement.dataset.homeSend).toBe("reduced");

    const updated = onlyTransition().update();
    arriveFromHomeSend("pending_2", target);
    await updated;

    expect(target.style.viewTransitionName).toBe("");
  });

  it("stops holding the frame when the new chat does not arrive in time", async () => {
    vi.useFakeTimers();
    const navigate = vi.fn();

    runHomeSendTransition({
      paneId: "pane",
      source: element(),
      threadId: "pending_3",
      navigate,
    });

    const updated = onlyTransition().update();
    vi.advanceTimersByTime(150);

    await expect(updated).resolves.toBeUndefined();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("navigates at once without a Home composer or view transitions", () => {
    const navigate = vi.fn();

    runHomeSendTransition({
      paneId: "pane",
      source: null,
      threadId: "pending_4",
      navigate,
    });

    expect(navigate).toHaveBeenCalledOnce();
    expect(transitions).toHaveLength(0);

    Reflect.deleteProperty(document, "startViewTransition");

    runHomeSendTransition({
      paneId: "pane",
      source: element(),
      threadId: "pending_5",
      navigate,
    });

    expect(navigate).toHaveBeenCalledTimes(2);
  });
});
