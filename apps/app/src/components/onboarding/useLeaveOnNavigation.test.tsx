// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLeaveOnNavigation } from "./useLeaveOnNavigation";

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={["/"]}>{children}</MemoryRouter>;
}

function renderLeaveHook() {
  const onLeave = vi.fn();

  const view = renderHook(
    () => {
      useLeaveOnNavigation(onLeave);

      return useNavigate();
    },
    { wrapper },
  );

  return { onLeave, view };
}

afterEach(() => {
  cleanup();
});

describe("useLeaveOnNavigation", () => {
  it("leaves once the route changes", () => {
    const { onLeave, view } = renderLeaveHook();
    act(() => {
      void view.result.current("/threads/thr_imported");
    });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("stays while the route is unchanged", () => {
    const { onLeave, view } = renderLeaveHook();
    view.rerender();
    expect(onLeave).not.toHaveBeenCalled();
  });
});
